//! 本模块管理训练图片自动与手动抠图、派生文件和可恢复 SQLite 任务队列。

use crate::{
    models::{
        DesktopBackgroundRemovalJobCreateInput, DesktopBackgroundRemovalJobItemView,
        DesktopBackgroundRemovalJobView, DesktopSettings, DesktopTrainingAssetVariantSelectInput,
        DesktopTrainingDatasetView, DesktopTrainingManualMaskInput,
    },
    process::hide_window,
    training_dataset,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use image::{GenericImageView, ImageFormat, ImageReader};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const MAX_MASK_BYTES: usize = 200 * 1024 * 1024;
const MAX_RUNNER_LINE_BYTES: usize = 64 * 1024;
const MAX_RUNNER_ERROR_BYTES: usize = 16 * 1024;

/** 应用生命周期内唯一的自动抠图 Worker。 */
pub struct BackgroundRemovalScheduler {
    stopping: Arc<AtomicBool>,
    wake_signal: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

struct SegmenterComponent {
    python: PathBuf,
    root: PathBuf,
    runner: PathBuf,
}

struct RemovalExecution {
    id: String,
    items: Vec<RemovalExecutionItem>,
}

struct RemovalExecutionItem {
    asset_id: String,
    source_path: PathBuf,
    output_path: PathBuf,
    output_relative_path: String,
    derivative_id: String,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerRequest {
    items: Vec<RunnerRequestItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerRequestItem {
    asset_id: String,
    source_path: String,
    output_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunnerResult {
    asset_id: String,
    output_path: Option<String>,
    error: Option<String>,
}

impl BackgroundRemovalScheduler {
    /** 启动独立 Worker，并把异常退出时的运行项恢复为排队状态。 */
    pub fn start(
        database_path: PathBuf,
        app_data_dir: PathBuf,
        app: AppHandle,
    ) -> Result<Self, String> {
        let stopping = Arc::new(AtomicBool::new(false));
        let wake_signal = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_stopping = stopping.clone();
        let worker_signal = wake_signal.clone();
        let worker = thread::Builder::new()
            .name("drawhime-background-removal".into())
            .spawn(move || {
                removal_loop(
                    &database_path,
                    &app_data_dir,
                    &app,
                    &worker_stopping,
                    &worker_signal,
                )
            })
            .map_err(|error| format!("启动自动抠图线程失败：{error}"))?;
        Ok(Self {
            stopping,
            wake_signal,
            worker: Some(worker),
        })
    }

    /** 唤醒等待中的抠图 Worker。 */
    pub fn wake(&self) {
        let (lock, condition) = &*self.wake_signal;
        if let Ok(mut pending) = lock.lock() {
            *pending = true;
            condition.notify_one();
        }
    }
}

impl Drop for BackgroundRemovalScheduler {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.wake();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/** 创建任务时只接受同一训练集内真实存在的图片。 */
pub fn create_job(
    database: &mut Connection,
    input: DesktopBackgroundRemovalJobCreateInput,
) -> Result<DesktopBackgroundRemovalJobView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    if input.asset_ids.is_empty() || input.asset_ids.len() > 200 {
        return Err("自动抠图图片数量必须是 1–200 张".into());
    }
    let unique = input.asset_ids.iter().collect::<HashSet<_>>();
    if unique.len() != input.asset_ids.len()
        || input
            .asset_ids
            .iter()
            .any(|id| validate_uuid(id, "训练图片 ID").is_err())
    {
        return Err("自动抠图图片 ID 重复或格式不正确".into());
    }
    let transaction = database
        .transaction()
        .map_err(|error| format!("开启抠图任务事务失败：{error}"))?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM local_training_datasets WHERE id=?1)",
            [&input.dataset_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取训练集失败：{error}"))?;
    if !exists {
        return Err("训练集不存在".into());
    }
    let found: u32 = transaction
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM local_training_assets WHERE dataset_id=?1 AND id IN ({})",
                std::iter::repeat_n("?", input.asset_ids.len())
                    .enumerate()
                    .map(|(index, _)| format!("?{}", index + 2))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            rusqlite::params_from_iter(
                std::iter::once(input.dataset_id.as_str())
                    .chain(input.asset_ids.iter().map(String::as_str)),
            ),
            |row| row.get(0),
        )
        .map_err(|error| format!("校验抠图图片失败：{error}"))?;
    if found as usize != input.asset_ids.len() {
        return Err("抠图任务包含不属于当前训练集的图片".into());
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    transaction.execute("INSERT INTO local_background_removal_jobs (id,dataset_id,status,total_assets,created_at,updated_at) VALUES (?1,?2,'queued',?3,?4,?4)", params![id,input.dataset_id,input.asset_ids.len() as u32,now]).map_err(|error| if error.to_string().contains("UNIQUE constraint") { "当前训练集已有未结束的抠图任务".into() } else { format!("创建抠图任务失败：{error}") })?;
    for asset_id in input.asset_ids {
        transaction.execute("INSERT INTO local_background_removal_job_items (job_id,asset_id,status,updated_at) VALUES (?1,?2,'queued',?3)", params![id,asset_id,now]).map_err(|error| format!("创建逐图抠图任务失败：{error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("提交抠图任务失败：{error}"))?;
    read_job(database, &id)?.ok_or_else(|| "抠图任务创建后不存在".into())
}

/** 返回最近的抠图任务，逐图结果可在重启后继续审计。 */
pub fn list_jobs(database: &Connection) -> Result<Vec<DesktopBackgroundRemovalJobView>, String> {
    let mut statement = database
        .prepare("SELECT id FROM local_background_removal_jobs ORDER BY created_at DESC LIMIT 100")
        .map_err(|error| format!("读取抠图任务失败：{error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询抠图任务失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析抠图任务失败：{error}"))?;
    ids.into_iter()
        .map(|id| read_job(database, &id)?.ok_or_else(|| "抠图任务读取期间消失".into()))
        .collect()
}

/** 暂停任务；运行中的子进程会在轮询点终止并保留已完成结果。 */
pub fn pause_job(
    database: &Connection,
    id: &str,
) -> Result<DesktopBackgroundRemovalJobView, String> {
    update_control(database, id, "pause")
}

/** 恢复暂停任务并把未完成图片重新放回队列。 */
pub fn resume_job(
    database: &Connection,
    id: &str,
) -> Result<DesktopBackgroundRemovalJobView, String> {
    validate_uuid(id, "抠图任务 ID")?;
    let now = Utc::now().to_rfc3339();
    database.execute("UPDATE local_background_removal_jobs SET status='queued',pause_requested=0,updated_at=?2 WHERE id=?1 AND status='paused'", params![id,now]).map_err(|error| format!("恢复抠图任务失败：{error}"))?;
    read_job(database, id)?.ok_or_else(|| "抠图任务不存在".into())
}

/** 取消任务并保留已经成功的派生文件。 */
pub fn cancel_job(
    database: &Connection,
    id: &str,
) -> Result<DesktopBackgroundRemovalJobView, String> {
    update_control(database, id, "cancel")
}

fn update_control(
    database: &Connection,
    id: &str,
    operation: &str,
) -> Result<DesktopBackgroundRemovalJobView, String> {
    validate_uuid(id, "抠图任务 ID")?;
    let now = Utc::now().to_rfc3339();
    match operation {
        "pause" => {
            database.execute("UPDATE local_background_removal_jobs SET pause_requested=1,status=CASE WHEN status='queued' THEN 'paused' ELSE status END,updated_at=?2 WHERE id=?1 AND status IN ('queued','running')", params![id,now]).map_err(|error| format!("暂停抠图任务失败：{error}"))?;
        }
        "cancel" => {
            database.execute("UPDATE local_background_removal_jobs SET cancel_requested=1,status=CASE WHEN status IN ('queued','paused') THEN 'cancelled' ELSE status END,completed_at=CASE WHEN status IN ('queued','paused') THEN ?2 ELSE completed_at END,updated_at=?2 WHERE id=?1 AND status IN ('queued','running','paused')", params![id,now]).map_err(|error| format!("取消抠图任务失败：{error}"))?;
            database.execute("UPDATE local_background_removal_job_items SET status='cancelled',updated_at=?2 WHERE job_id=?1 AND status='queued'", params![id,now]).map_err(|error| format!("取消逐图抠图任务失败：{error}"))?;
        }
        _ => return Err("未知抠图任务控制操作".into()),
    }
    read_job(database, id)?.ok_or_else(|| "抠图任务不存在".into())
}

/** 手动蒙版在核心中与原图相乘，成功后登记并选中新派生版本。 */
pub fn save_manual_mask(
    database: &mut Connection,
    app_data_dir: &Path,
    input: DesktopTrainingManualMaskInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.asset_id, "训练图片 ID")?;
    let bytes = STANDARD
        .decode(input.mask_png_base64.trim())
        .map_err(|_| "手动蒙版不是有效 Base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_MASK_BYTES {
        return Err("手动蒙版大小必须是 1B–200MiB".into());
    }
    let (relative_path, width, height): (String, u32, u32) = database.query_row("SELECT relative_path,width,height FROM local_training_assets WHERE id=?1 AND dataset_id=?2", params![input.asset_id,input.dataset_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|error| format!("读取训练图片失败：{error}"))?.ok_or_else(|| "训练图片不存在".to_string())?;
    let mask = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .map_err(|error| format!("解码手动蒙版失败：{error}"))?
        .to_luma8();
    if mask.dimensions() != (width, height) {
        return Err("手动蒙版尺寸必须与原图完全一致".into());
    }
    let source_path = app_data_dir.join(relative_path);
    let mut source = ImageReader::open(&source_path)
        .map_err(|error| format!("读取训练原图失败：{error}"))?
        .with_guessed_format()
        .map_err(|error| format!("识别训练原图失败：{error}"))?
        .decode()
        .map_err(|error| format!("解码训练原图失败：{error}"))?
        .to_rgba8();
    for (pixel, alpha) in source.pixels_mut().zip(mask.pixels()) {
        pixel.0[3] = ((u16::from(pixel.0[3]) * u16::from(alpha.0[0])) / 255) as u8;
    }
    persist_derivative(
        database,
        app_data_dir,
        &input.dataset_id,
        &input.asset_id,
        "manual",
        source,
        true,
    )?;
    training_dataset::read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 选择训练快照使用版本，空值恢复原图。 */
pub fn select_variant(
    database: &Connection,
    app_data_dir: &Path,
    input: DesktopTrainingAssetVariantSelectInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.asset_id, "训练图片 ID")?;
    if let Some(id) = &input.derivative_id {
        validate_uuid(id, "派生版本 ID")?;
        let valid: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM local_training_asset_derivatives derivative JOIN local_training_assets asset ON asset.id=derivative.asset_id WHERE derivative.id=?1 AND asset.id=?2 AND asset.dataset_id=?3)", params![id,input.asset_id,input.dataset_id], |row| row.get(0)).map_err(|error| format!("校验派生版本失败：{error}"))?;
        if !valid {
            return Err("派生版本不属于当前训练图片".into());
        }
    }
    let now = Utc::now().to_rfc3339();
    let changed = database.execute("UPDATE local_training_assets SET selected_derivative_id=?3,confirmed=0,updated_at=?4 WHERE id=?1 AND dataset_id=?2", params![input.asset_id,input.dataset_id,input.derivative_id,now]).map_err(|error| format!("选择训练图片版本失败：{error}"))?;
    if changed == 0 {
        return Err("训练图片不存在".into());
    }
    training_dataset::update_dataset_review_status(database, &input.dataset_id, &now)?;
    training_dataset::read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

fn removal_loop(
    database_path: &Path,
    app_data_dir: &Path,
    app: &AppHandle,
    stopping: &AtomicBool,
    wake_signal: &(Mutex<bool>, Condvar),
) {
    let Ok(mut database) = Connection::open(database_path) else {
        return;
    };
    let _ = database.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; UPDATE local_background_removal_job_items SET status='queued' WHERE status='running'; UPDATE local_background_removal_jobs SET status=CASE WHEN pause_requested=1 THEN 'paused' WHEN cancel_requested=1 THEN 'cancelled' ELSE 'queued' END WHERE status='running';");
    while !stopping.load(Ordering::SeqCst) {
        match claim_next_job(&mut database, app_data_dir) {
            Ok(Some(job)) => execute_job(&database, app_data_dir, app, stopping, job),
            Ok(None) => wait_for_work(wake_signal, stopping),
            Err(_) => thread::sleep(Duration::from_secs(1)),
        }
    }
}

fn claim_next_job(
    database: &mut Connection,
    app_data_dir: &Path,
) -> Result<Option<RemovalExecution>, String> {
    let transaction = database
        .transaction()
        .map_err(|error| format!("开启抠图领取事务失败：{error}"))?;
    let row = transaction.query_row("SELECT id,dataset_id FROM local_background_removal_jobs WHERE status='queued' AND pause_requested=0 AND cancel_requested=0 ORDER BY created_at ASC LIMIT 1", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().map_err(|error| format!("读取待执行抠图任务失败：{error}"))?;
    let Some((id, dataset_id)) = row else {
        transaction
            .commit()
            .map_err(|error| format!("提交空抠图领取事务失败：{error}"))?;
        return Ok(None);
    };
    let mut statement = transaction.prepare("SELECT item.asset_id,asset.relative_path,asset.width,asset.height FROM local_background_removal_job_items item JOIN local_training_assets asset ON asset.id=item.asset_id WHERE item.job_id=?1 AND item.status='queued' ORDER BY asset.created_at ASC,asset.id ASC").map_err(|error| format!("读取逐图抠图任务失败：{error}"))?;
    let rows = statement
        .query_map([&id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, u32>(3)?,
            ))
        })
        .map_err(|error| format!("查询逐图抠图任务失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析逐图抠图任务失败：{error}"))?;
    drop(statement);
    if rows.is_empty() {
        finalize_job(&transaction, &id)?;
        transaction
            .commit()
            .map_err(|error| format!("提交抠图收尾失败：{error}"))?;
        return Ok(None);
    }
    let derivative_root = app_data_dir
        .join("datasets")
        .join(&dataset_id)
        .join("derivatives");
    fs::create_dir_all(&derivative_root)
        .map_err(|error| format!("创建抠图派生目录失败：{error}"))?;
    let items = rows
        .into_iter()
        .map(|(asset_id, relative, width, height)| {
            let derivative_id = Uuid::new_v4().to_string();
            let output_path = derivative_root.join(format!("{derivative_id}.png"));
            RemovalExecutionItem {
                asset_id,
                source_path: app_data_dir.join(relative),
                output_relative_path: format!(
                    "datasets/{dataset_id}/derivatives/{derivative_id}.png"
                ),
                output_path,
                derivative_id,
                width,
                height,
            }
        })
        .collect::<Vec<_>>();
    let now = Utc::now().to_rfc3339();
    transaction.execute("UPDATE local_background_removal_jobs SET status='running',started_at=COALESCE(started_at,?2),updated_at=?2 WHERE id=?1", params![id,now]).map_err(|error| format!("领取抠图任务失败：{error}"))?;
    transaction.execute("UPDATE local_background_removal_job_items SET status='running',updated_at=?2 WHERE job_id=?1 AND status='queued'", params![id,now]).map_err(|error| format!("领取逐图抠图任务失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交抠图领取事务失败：{error}"))?;
    Ok(Some(RemovalExecution { id, items }))
}

fn execute_job(
    database: &Connection,
    app_data_dir: &Path,
    app: &AppHandle,
    stopping: &AtomicBool,
    job: RemovalExecution,
) {
    let settings = match load_settings(database) {
        Ok(value) => value,
        Err(error) => {
            fail_job(database, &job.id, &error);
            return;
        }
    };
    let component = match find_segmenter_component(&settings.runtime_root) {
        Ok(value) => value,
        Err(error) => {
            fail_job(database, &job.id, &error);
            return;
        }
    };
    let request_path = app_data_dir
        .join("background-removal-requests")
        .join(format!("{}.json", job.id));
    if let Some(parent) = request_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            fail_job(database, &job.id, &format!("创建抠图请求目录失败：{error}"));
            return;
        }
    }
    let request = RunnerRequest {
        items: job
            .items
            .iter()
            .map(|item| RunnerRequestItem {
                asset_id: item.asset_id.clone(),
                source_path: item.source_path.to_string_lossy().into_owned(),
                output_path: item.output_path.to_string_lossy().into_owned(),
            })
            .collect(),
    };
    if let Err(error) = write_json(&request_path, &request) {
        fail_job(database, &job.id, &error);
        return;
    }
    let mut command = Command::new(&component.python);
    command
        .args([
            "-I",
            component.runner.to_string_lossy().as_ref(),
            "--request",
            request_path.to_string_lossy().as_ref(),
        ])
        .current_dir(&component.root)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8:replace")
        .env("PYTHONNOUSERSITE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(error) => {
            fail_job(database, &job.id, &format!("启动离线抠图组件失败：{error}"));
            let _ = fs::remove_file(&request_path);
            return;
        }
    };
    let stderr = child.stderr.take();
    let stderr_reader = thread::spawn(move || read_limited(stderr));
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        fail_job(database, &job.id, "抠图组件没有标准输出");
        return;
    };
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        if stopping.load(Ordering::SeqCst)
            || control_state(database, &job.id).is_some_and(|state| state != "running")
        {
            let _ = child.kill();
            break;
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(read) if read <= MAX_RUNNER_LINE_BYTES => {}
            Ok(_) => {
                fail_job(database, &job.id, "抠图组件返回内容超过限制");
                let _ = child.kill();
                break;
            }
            Err(_) => {
                fail_job(database, &job.id, "读取抠图组件输出失败");
                let _ = child.kill();
                break;
            }
        }
        let result: RunnerResult = match serde_json::from_str(line.trim()) {
            Ok(value) => value,
            Err(_) => {
                fail_job(database, &job.id, "抠图组件返回了无效进度");
                let _ = child.kill();
                break;
            }
        };
        if let Some(item) = job
            .items
            .iter()
            .find(|item| item.asset_id == result.asset_id)
        {
            if let Err(error) = apply_runner_result(database, &job.id, item, result) {
                mark_item_failed(database, &job.id, &item.asset_id, &error);
            }
            refresh_job(database, &job.id);
            emit_job(database, app, &job.id);
        }
    }
    let status = child.wait();
    let stderr = stderr_reader.join().unwrap_or_default();
    let _ = fs::remove_file(&request_path);
    let state = control_state(database, &job.id).unwrap_or_default();
    if state == "running" && status.as_ref().map_or(true, |value| !value.success()) {
        fail_running_items(
            database,
            &job.id,
            if stderr.is_empty() {
                "离线抠图组件异常退出"
            } else {
                &stderr
            },
        );
    }
    settle_control_state(database, &job.id);
    refresh_job(database, &job.id);
    emit_job(database, app, &job.id);
}

fn apply_runner_result(
    database: &Connection,
    job_id: &str,
    item: &RemovalExecutionItem,
    result: RunnerResult,
) -> Result<(), String> {
    // Runner 输出路径每次都使用新 UUID；任一校验或登记失败都可安全删除，避免留下孤立文件。
    let outcome = apply_runner_result_inner(database, job_id, item, result);
    if outcome.is_err() {
        let _ = fs::remove_file(&item.output_path);
    }
    outcome
}

fn apply_runner_result_inner(
    database: &Connection,
    job_id: &str,
    item: &RemovalExecutionItem,
    result: RunnerResult,
) -> Result<(), String> {
    if let Some(error) = result.error {
        return Err(error);
    }
    if result.output_path.as_deref() != Some(item.output_path.to_string_lossy().as_ref()) {
        return Err("抠图组件返回了未授权输出路径".into());
    }
    let reader = ImageReader::open(&item.output_path)
        .map_err(|error| format!("读取抠图结果失败：{error}"))?
        .with_guessed_format()
        .map_err(|error| format!("识别抠图结果失败：{error}"))?;
    if reader.format() != Some(ImageFormat::Png) {
        return Err("抠图结果不是 PNG".into());
    }
    let image = reader
        .decode()
        .map_err(|error| format!("解码抠图结果失败：{error}"))?;
    if image.dimensions() != (item.width, item.height) || !image.color().has_alpha() {
        return Err("抠图结果尺寸或透明通道不正确".into());
    }
    let metadata = item
        .output_path
        .metadata()
        .map_err(|error| format!("读取抠图结果元数据失败：{error}"))?;
    let sha256 = sha256_file(&item.output_path)?;
    let now = Utc::now().to_rfc3339();
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启派生文件事务失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO local_training_asset_derivatives (id,asset_id,kind,source,relative_path,sha256,byte_size,width,height,created_at,updated_at) VALUES (?1,?2,'background_removed','auto',?3,?4,?5,?6,?7,?8,?8)",
            params![item.derivative_id,item.asset_id,item.output_relative_path,sha256,metadata.len(),item.width,item.height,now],
        )
        .map_err(|error| format!("登记抠图派生文件失败：{error}"))?;
    let changed = transaction
        .execute(
            "UPDATE local_background_removal_job_items SET status='succeeded',derivative_id=?3,error=NULL,updated_at=?4 WHERE job_id=?1 AND asset_id=?2 AND status='running'",
            params![job_id,item.asset_id,item.derivative_id,now],
        )
        .map_err(|error| format!("更新逐图抠图结果失败：{error}"))?;
    if changed != 1 {
        return Err("逐图抠图任务状态已经变化，结果未登记".into());
    }
    transaction
        .commit()
        .map_err(|error| format!("提交抠图派生文件失败：{error}"))
}

fn persist_derivative(
    database: &mut Connection,
    app_data_dir: &Path,
    dataset_id: &str,
    asset_id: &str,
    source_kind: &str,
    image: image::RgbaImage,
    select: bool,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let relative = format!("datasets/{dataset_id}/derivatives/{id}.png");
    let final_path = app_data_dir.join(&relative);
    let parent = final_path
        .parent()
        .ok_or_else(|| "派生文件路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建派生目录失败：{error}"))?;
    let temporary = parent.join(format!(".{id}.png.writing"));
    image
        .save_with_format(&temporary, ImageFormat::Png)
        .map_err(|error| format!("保存透明 PNG 失败：{error}"))?;
    let metadata = temporary
        .metadata()
        .map_err(|error| format!("读取派生文件失败：{error}"))?;
    let hash = sha256_file(&temporary)?;
    let (width, height) = image.dimensions();
    fs::rename(&temporary, &final_path).map_err(|error| format!("提交派生文件失败：{error}"))?;
    let transaction = database.transaction().map_err(|error| {
        let _ = fs::remove_file(&final_path);
        format!("开启派生文件事务失败：{error}")
    })?;
    let now = Utc::now().to_rfc3339();
    if let Err(error)=transaction.execute("INSERT INTO local_training_asset_derivatives (id,asset_id,kind,source,relative_path,sha256,byte_size,width,height,created_at,updated_at) VALUES (?1,?2,'background_removed',?3,?4,?5,?6,?7,?8,?9,?9)",params![id,asset_id,source_kind,relative,hash,metadata.len(),width,height,now]){let _=fs::remove_file(&final_path);return Err(format!("登记派生文件失败：{error}"));}
    if select {
        transaction.execute("UPDATE local_training_assets SET selected_derivative_id=?3,confirmed=0,updated_at=?4 WHERE id=?1 AND dataset_id=?2",params![asset_id,dataset_id,id,now]).map_err(|error|{let _=fs::remove_file(&final_path);format!("选择手动抠图版本失败：{error}")})?;
        training_dataset::update_dataset_review_status(&transaction, dataset_id, &now)?;
    }
    transaction.commit().map_err(|error| {
        let _ = fs::remove_file(&final_path);
        format!("提交派生文件事务失败：{error}")
    })?;
    Ok(id)
}

fn read_job(
    database: &Connection,
    id: &str,
) -> Result<Option<DesktopBackgroundRemovalJobView>, String> {
    let row=database.query_row("SELECT id,dataset_id,status,progress,total_assets,processed_assets,succeeded_assets,failed_assets,error,created_at,completed_at,updated_at FROM local_background_removal_jobs WHERE id=?1",[id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,u32>(3)?,row.get::<_,u32>(4)?,row.get::<_,u32>(5)?,row.get::<_,u32>(6)?,row.get::<_,u32>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,String>(9)?,row.get::<_,Option<String>>(10)?,row.get::<_,String>(11)?))).optional().map_err(|error|format!("读取抠图任务失败：{error}"))?;
    let Some(row) = row else { return Ok(None) };
    let mut statement=database.prepare("SELECT asset_id,status,derivative_id,error,updated_at FROM local_background_removal_job_items WHERE job_id=?1 ORDER BY updated_at ASC,asset_id ASC").map_err(|error|format!("读取逐图抠图任务失败：{error}"))?;
    let items = statement
        .query_map([id], |item| {
            Ok(DesktopBackgroundRemovalJobItemView {
                asset_id: item.get(0)?,
                status: item.get(1)?,
                derivative_id: item.get(2)?,
                error: item.get(3)?,
                updated_at: item.get(4)?,
            })
        })
        .map_err(|error| format!("查询逐图抠图任务失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析逐图抠图任务失败：{error}"))?;
    Ok(Some(DesktopBackgroundRemovalJobView {
        id: row.0,
        dataset_id: row.1,
        status: row.2,
        progress: row.3,
        total_assets: row.4,
        processed_assets: row.5,
        succeeded_assets: row.6,
        failed_assets: row.7,
        items,
        error: row.8,
        created_at: row.9,
        completed_at: row.10,
        updated_at: row.11,
    }))
}

fn refresh_job(database: &Connection, id: &str) {
    let now = Utc::now().to_rfc3339();
    let _=database.execute("UPDATE local_background_removal_jobs SET processed_assets=(SELECT COUNT(*) FROM local_background_removal_job_items WHERE job_id=?1 AND status IN ('succeeded','failed','cancelled')),succeeded_assets=(SELECT COUNT(*) FROM local_background_removal_job_items WHERE job_id=?1 AND status='succeeded'),failed_assets=(SELECT COUNT(*) FROM local_background_removal_job_items WHERE job_id=?1 AND status='failed'),progress=CASE WHEN total_assets=0 THEN 0 ELSE (SELECT COUNT(*)*100/total_assets FROM local_background_removal_job_items WHERE job_id=?1 AND status IN ('succeeded','failed','cancelled')) END,updated_at=?2 WHERE id=?1",params![id,now]);
    let _ = finalize_job(database, id);
}
fn finalize_job(database: &Connection, id: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    database.execute("UPDATE local_background_removal_jobs SET status=CASE WHEN failed_assets>0 THEN 'failed' ELSE 'succeeded' END,completed_at=?2,updated_at=?2 WHERE id=?1 AND status='running' AND NOT EXISTS(SELECT 1 FROM local_background_removal_job_items WHERE job_id=?1 AND status IN ('queued','running'))",params![id,now]).map_err(|error|format!("完成抠图任务失败：{error}"))?;
    Ok(())
}
fn fail_job(database: &Connection, id: &str, error: &str) {
    let safe = error.chars().take(1000).collect::<String>();
    let now = Utc::now().to_rfc3339();
    let _=database.execute("UPDATE local_background_removal_jobs SET status='failed',error=?2,completed_at=?3,updated_at=?3 WHERE id=?1",params![id,safe,now]);
    let _=database.execute("UPDATE local_background_removal_job_items SET status='failed',error=?2,updated_at=?3 WHERE job_id=?1 AND status IN ('queued','running')",params![id,safe,now]);
}
fn fail_running_items(database: &Connection, id: &str, error: &str) {
    let safe = error.chars().take(1000).collect::<String>();
    let now = Utc::now().to_rfc3339();
    let _=database.execute("UPDATE local_background_removal_job_items SET status='failed',error=?2,updated_at=?3 WHERE job_id=?1 AND status='running'",params![id,safe,now]);
}
fn mark_item_failed(database: &Connection, job_id: &str, asset_id: &str, error: &str) {
    let safe = error.chars().take(1000).collect::<String>();
    let now = Utc::now().to_rfc3339();
    let _=database.execute("UPDATE local_background_removal_job_items SET status='failed',error=?3,updated_at=?4 WHERE job_id=?1 AND asset_id=?2",params![job_id,asset_id,safe,now]);
}
fn control_state(database: &Connection, id: &str) -> Option<String> {
    database.query_row("SELECT CASE WHEN cancel_requested=1 THEN 'cancelled' WHEN pause_requested=1 THEN 'paused' ELSE status END FROM local_background_removal_jobs WHERE id=?1",[id],|row|row.get(0)).ok()
}
fn settle_control_state(database: &Connection, id: &str) {
    let now = Utc::now().to_rfc3339();
    if let Some(state) = control_state(database, id) {
        if state == "paused" {
            let _=database.execute("UPDATE local_background_removal_job_items SET status='queued',updated_at=?2 WHERE job_id=?1 AND status='running'",params![id,now]);
            let _=database.execute("UPDATE local_background_removal_jobs SET status='paused',updated_at=?2 WHERE id=?1",params![id,now]);
        } else if state == "cancelled" {
            let _=database.execute("UPDATE local_background_removal_job_items SET status='cancelled',updated_at=?2 WHERE job_id=?1 AND status IN ('queued','running')",params![id,now]);
            let _=database.execute("UPDATE local_background_removal_jobs SET status='cancelled',completed_at=?2,updated_at=?2 WHERE id=?1",params![id,now]);
        }
    }
}
fn emit_job(database: &Connection, app: &AppHandle, id: &str) {
    if let Ok(Some(job)) = read_job(database, id) {
        let _ = app.emit("desktop-background-removal-job-updated", job);
    }
}
fn wait_for_work(signal: &(Mutex<bool>, Condvar), stopping: &AtomicBool) {
    let (lock, condition) = signal;
    if let Ok(pending) = lock.lock() {
        if !*pending && !stopping.load(Ordering::SeqCst) {
            let _ = condition.wait_timeout(pending, Duration::from_secs(2));
        }
    }
}
fn load_settings(database: &Connection) -> Result<DesktopSettings, String> {
    database.query_row("SELECT theme_mode,font_scale,default_privacy,auto_upload,model_root,output_root,runtime_root,upload_concurrency,wifi_only,bandwidth_limit_kib FROM desktop_settings WHERE id=1",[],|row|Ok(DesktopSettings{theme_mode:row.get(0)?,font_scale:row.get(1)?,default_privacy:row.get(2)?,auto_upload:row.get::<_,i64>(3)?!=0,model_root:row.get(4)?,output_root:row.get(5)?,runtime_root:row.get(6)?,upload_concurrency:row.get(7)?,wifi_only:row.get::<_,i64>(8)?!=0,bandwidth_limit_kib:row.get(9)?})).map_err(|error|format!("读取抠图运行设置失败：{error}"))
}
fn find_segmenter_component(runtime_root: &str) -> Result<SegmenterComponent, String> {
    let root = Path::new(runtime_root);
    let python = root
        .join("current")
        .join("python_embeded")
        .join("python.exe");
    if !python.is_file() {
        return Err("本地 Runtime 的私有 Python 尚未安装".into());
    }
    let components = root.join("components").join("segmenter");
    let mut candidates = fs::read_dir(&components)
        .map_err(|_| "离线抠图组件尚未安装，请先在资源页安装".to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    candidates.sort();
    for candidate in candidates.into_iter().rev() {
        if candidate.join(".drawhime-resource.json").is_file()
            && candidate.join("runner.py").is_file()
            && candidate.join("u2net.onnx").is_file()
            && candidate
                .join("site-packages")
                .join("onnxruntime")
                .join("__init__.py")
                .is_file()
        {
            return Ok(SegmenterComponent {
                python,
                runner: candidate.join("runner.py"),
                root: candidate,
            });
        }
    }
    Err("离线抠图组件安装不完整，请重新安装".into())
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| format!("序列化抠图请求失败：{error}"))?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("创建抠图请求失败：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("保存抠图请求失败：{error}"))
}
fn read_limited(stderr: Option<impl Read>) -> String {
    let Some(mut stderr) = stderr else {
        return String::new();
    };
    let mut buffer = Vec::new();
    let _ = stderr
        .by_ref()
        .take(MAX_RUNNER_ERROR_BYTES as u64)
        .read_to_end(&mut buffer);
    String::from_utf8_lossy(&buffer)
        .trim()
        .chars()
        .take(1000)
        .collect()
}
fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("读取派生文件失败：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("校验派生文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}
fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{label}格式不正确"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{
            DesktopTrainingDatasetCreateInput, DesktopTrainingImagesAddInput,
            DesktopTrainingManualMaskInput,
        },
        storage::DesktopState,
    };
    use image::{GrayImage, Luma, Rgb, RgbImage};
    use std::io::Cursor;

    /** 创建仅含一张真实图片的训练集，供派生版本和任务状态测试复用。 */
    fn create_single_asset(
        temporary: &tempfile::TempDir,
    ) -> (DesktopState, DesktopTrainingDatasetView) {
        let state = DesktopState::initialize(temporary.path()).expect("初始化抠图测试状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "抠图测试".into(),
                r#type: "character".into(),
                trigger_words: vec!["dh_mask".into()],
            })
            .expect("创建抠图测试训练集");
        let source = temporary.path().join("mask-source.png");
        RgbImage::from_pixel(32, 32, Rgb([120, 80, 40]))
            .save(&source)
            .expect("写入抠图测试原图");
        let imported = {
            let mut database = state.database.lock().expect("锁定抠图测试数据库");
            training_dataset::add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id,
                    source_paths: vec![source.to_string_lossy().into_owned()],
                },
            )
            .expect("导入抠图测试图片")
        };
        (state, imported)
    }

    /** 把灰度蒙版编码为核心接口实际接受的 PNG Base64。 */
    fn encode_mask(mask: &GrayImage) -> String {
        let mut bytes = Cursor::new(Vec::new());
        mask.write_to(&mut bytes, ImageFormat::Png)
            .expect("编码测试蒙版");
        STANDARD.encode(bytes.into_inner())
    }

    #[test]
    fn manual_mask_rejects_mismatched_dimensions_without_derivative() {
        let temporary = tempfile::tempdir().expect("创建蒙版尺寸测试目录");
        let (state, dataset) = create_single_asset(&temporary);
        let mask = GrayImage::from_pixel(1, 1, Luma([255]));
        let mut database = state.database.lock().expect("锁定蒙版尺寸测试数据库");
        let error = save_manual_mask(
            &mut database,
            &state.app_data_dir,
            DesktopTrainingManualMaskInput {
                dataset_id: dataset.id,
                asset_id: dataset.assets[0].id.clone(),
                mask_png_base64: encode_mask(&mask),
            },
        )
        .expect_err("尺寸不一致的蒙版必须失败");
        assert!(error.contains("尺寸必须与原图完全一致"));
        let count: u32 = database
            .query_row(
                "SELECT COUNT(*) FROM local_training_asset_derivatives",
                [],
                |row| row.get(0),
            )
            .expect("读取派生记录数量");
        assert_eq!(count, 0);
    }

    #[test]
    fn manual_mask_creates_transparent_png_and_can_restore_original() {
        let temporary = tempfile::tempdir().expect("创建手动抠图测试目录");
        let (state, dataset) = create_single_asset(&temporary);
        assert!(dataset.assets[0].selected_derivative_id.is_none());
        let original_path = PathBuf::from(&dataset.assets[0].path);
        let original_bytes = fs::read(&original_path).expect("读取手动抠图原图");
        let mask = GrayImage::from_fn(32, 32, |x, _| Luma([if x < 16 { 0 } else { 255 }]));
        let updated = {
            let mut database = state.database.lock().expect("锁定手动抠图数据库");
            save_manual_mask(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingManualMaskInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: dataset.assets[0].id.clone(),
                    mask_png_base64: encode_mask(&mask),
                },
            )
            .expect("保存手动抠图")
        };
        let asset = &updated.assets[0];
        let derivative_id = asset
            .selected_derivative_id
            .clone()
            .expect("手动抠图应自动选中派生版本");
        let derivative = asset
            .derivatives
            .iter()
            .find(|item| item.id == derivative_id)
            .expect("读取手动抠图派生版本");
        let pixels = image::open(&derivative.path)
            .expect("读取手动抠图 PNG")
            .to_rgba8();
        assert_eq!(pixels.get_pixel(0, 0).0[3], 0);
        assert_eq!(pixels.get_pixel(31, 0).0[3], 255);
        assert_eq!(
            fs::read(&original_path).expect("复核手动抠图原图"),
            original_bytes
        );

        let restored = {
            let database = state.database.lock().expect("锁定版本恢复数据库");
            select_variant(
                &database,
                &state.app_data_dir,
                DesktopTrainingAssetVariantSelectInput {
                    dataset_id: dataset.id,
                    asset_id: asset.id.clone(),
                    derivative_id: None,
                },
            )
            .expect("恢复训练原图")
        };
        assert!(restored.assets[0].selected_derivative_id.is_none());
        assert!(Path::new(&derivative.path).is_file());
    }

    #[test]
    fn invalid_runner_output_is_removed_and_never_registered() {
        let temporary = tempfile::tempdir().expect("创建 Runner 输出测试目录");
        let (state, dataset) = create_single_asset(&temporary);
        let job = {
            let mut database = state.database.lock().expect("锁定 Runner 任务数据库");
            create_job(
                &mut database,
                DesktopBackgroundRemovalJobCreateInput {
                    dataset_id: dataset.id.clone(),
                    asset_ids: vec![dataset.assets[0].id.clone()],
                },
            )
            .expect("创建 Runner 测试任务")
        };
        let output_path = state
            .app_data_dir
            .join("datasets")
            .join(&dataset.id)
            .join("derivatives")
            .join("invalid-rgb.png");
        fs::create_dir_all(output_path.parent().expect("读取输出目录")).expect("创建输出目录");
        RgbImage::from_pixel(32, 32, Rgb([1, 2, 3]))
            .save(&output_path)
            .expect("写入无透明通道 PNG");
        let derivative_id = Uuid::new_v4().to_string();
        let item = RemovalExecutionItem {
            asset_id: dataset.assets[0].id.clone(),
            source_path: PathBuf::from(&dataset.assets[0].path),
            output_path: output_path.clone(),
            output_relative_path: format!("datasets/{}/derivatives/invalid-rgb.png", dataset.id),
            derivative_id,
            width: 32,
            height: 32,
        };
        let database = state.database.lock().expect("锁定 Runner 输出数据库");
        database
            .execute(
                "UPDATE local_background_removal_jobs SET status='running' WHERE id=?1",
                [&job.id],
            )
            .expect("设置 Runner 任务状态");
        database
            .execute(
                "UPDATE local_background_removal_job_items SET status='running' WHERE job_id=?1",
                [&job.id],
            )
            .expect("设置 Runner 图片状态");
        assert!(apply_runner_result(
            &database,
            &job.id,
            &item,
            RunnerResult {
                asset_id: item.asset_id.clone(),
                output_path: Some(output_path.to_string_lossy().into_owned()),
                error: None,
            },
        )
        .is_err());
        assert!(!output_path.exists());
        let count: u32 = database
            .query_row(
                "SELECT COUNT(*) FROM local_training_asset_derivatives",
                [],
                |row| row.get(0),
            )
            .expect("读取 Runner 派生记录数量");
        assert_eq!(count, 0);
    }

    #[test]
    fn queued_background_job_supports_pause_resume_and_cancel() {
        let temporary = tempfile::tempdir().expect("创建抠图控制测试目录");
        let (state, dataset) = create_single_asset(&temporary);
        let mut database = state.database.lock().expect("锁定抠图控制数据库");
        let job = create_job(
            &mut database,
            DesktopBackgroundRemovalJobCreateInput {
                dataset_id: dataset.id,
                asset_ids: vec![dataset.assets[0].id.clone()],
            },
        )
        .expect("创建抠图控制任务");
        assert_eq!(
            pause_job(&database, &job.id).expect("暂停抠图任务").status,
            "paused"
        );
        assert_eq!(
            resume_job(&database, &job.id).expect("恢复抠图任务").status,
            "queued"
        );
        let cancelled = cancel_job(&database, &job.id).expect("取消抠图任务");
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.items[0].status, "cancelled");
    }
}
