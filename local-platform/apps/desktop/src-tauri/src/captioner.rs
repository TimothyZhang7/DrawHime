//! 本模块实现 SQLite 为事实源的离线自动打标队列，并通过签名 Captioner 组件调用 WD14 ONNX 推理。

use crate::models::{
    DesktopCaptionJobCreateInput, DesktopCaptionJobItemView, DesktopCaptionJobView,
};
use crate::process::hide_window;
use crate::training_files::{finalize_caption_file, rollback_caption_file, stage_caption_file};
use crate::training_tags;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
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

const MAX_CAPTION_TAGS: usize = 2_000;
const MAX_RUNNER_LINE_BYTES: usize = 256 * 1024;
const MAX_RUNNER_ERROR_BYTES: usize = 16 * 1024;

/** 应用生命周期内唯一的离线打标 Worker。 */
pub struct CaptionScheduler {
    stopping: Arc<AtomicBool>,
    wake_signal: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct CaptionExecution {
    id: String,
    dataset_id: String,
    dataset_root: PathBuf,
    general_threshold: f64,
    character_threshold: f64,
    include_character_tags: bool,
    items: Vec<CaptionExecutionItem>,
}

#[derive(Clone)]
struct CaptionExecutionItem {
    asset_id: String,
    path: PathBuf,
}

struct CaptionerComponent {
    python: PathBuf,
    root: PathBuf,
    runner: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerRequest {
    general_threshold: f64,
    character_threshold: f64,
    include_character_tags: bool,
    items: Vec<RunnerRequestItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerRequestItem {
    asset_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunnerResult {
    asset_id: String,
    tags: Option<Vec<String>>,
    error: Option<String>,
}

impl CaptionScheduler {
    /** 启动独立 SQLite 连接的串行 Worker，应用退出时会保留可恢复任务。 */
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
            .name("drawhime-caption-scheduler".into())
            // ONNX 与图片预处理调用链较深，独立栈避免 GPU 高负载期间拖垮桌面主进程。
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                caption_loop(
                    &database_path,
                    &app_data_dir,
                    &app,
                    &worker_stopping,
                    &worker_signal,
                )
            })
            .map_err(|error| format!("启动离线打标线程失败：{error}"))?;
        Ok(Self {
            stopping,
            wake_signal,
            worker: Some(worker),
        })
    }

    /** 唤醒空闲 Worker，使新任务不依赖固定轮询周期。 */
    pub fn wake(&self) {
        let (lock, condition) = &*self.wake_signal;
        if let Ok(mut pending) = lock.lock() {
            *pending = true;
            condition.notify_one();
        }
    }
}

impl Drop for CaptionScheduler {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.wake();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/** 在短事务内创建批量或单图打标任务；批量任务不会覆盖人工 Caption。 */
pub fn create_job(
    database: &mut Connection,
    input: DesktopCaptionJobCreateInput,
) -> Result<DesktopCaptionJobView, String> {
    validate_create_input(&input)?;
    let transaction = database
        .transaction()
        .map_err(|error| format!("开启打标任务事务失败：{error}"))?;
    let dataset_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM local_training_datasets WHERE id=?1)",
            [&input.dataset_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取训练集失败：{error}"))?;
    if !dataset_exists {
        return Err("训练集不存在".into());
    }
    let active: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM local_caption_jobs WHERE dataset_id=?1 AND status IN ('queued','running','paused'))", [&input.dataset_id], |row| row.get(0)).map_err(|error| format!("读取活动打标任务失败：{error}"))?;
    if active {
        return Err("当前训练集已有打标任务正在排队或运行".into());
    }
    let targets = select_targets(&transaction, &input)?;
    if targets.is_empty() {
        return Err("当前训练集没有需要自动打标的图片；人工 Caption 会保持不变".into());
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    transaction.execute("INSERT INTO local_caption_jobs (id,dataset_id,asset_id,status,progress,total_assets,general_threshold,character_threshold,include_character_tags,created_at,updated_at) VALUES (?1,?2,?3,'queued',0,?4,?5,?6,?7,?8,?8)", params![id,input.dataset_id,input.asset_id,targets.len() as u32,input.general_threshold,input.character_threshold,input.include_character_tags,now]).map_err(|error| format!("创建打标任务失败：{error}"))?;
    for asset_id in &targets {
        transaction.execute("INSERT INTO local_caption_job_items (job_id,asset_id,force_replace,status,created_at,updated_at) VALUES (?1,?2,?3,'queued',?4,?4)", params![id,asset_id,input.asset_id.is_some() || input.asset_ids.is_some(),now]).map_err(|error| format!("创建逐图打标任务失败：{error}"))?;
    }
    // 打标只会改变本次任务选择的图片，因此不得让未参与批处理的已确认图片失效。
    transaction
        .execute(
            "UPDATE local_training_assets SET confirmed=0 WHERE dataset_id=?1 AND EXISTS(SELECT 1 FROM local_caption_job_items item WHERE item.job_id=?2 AND item.asset_id=local_training_assets.id)",
            params![input.dataset_id, id],
        )
        .and_then(|_| {
            transaction.execute(
                "UPDATE local_training_datasets SET status='draft',updated_at=?2 WHERE id=?1",
                params![input.dataset_id, now],
            )
        })
        .map_err(|error| format!("重置训练集确认状态失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交打标任务失败：{error}"))?;
    read_job(database, &id)?.ok_or_else(|| "打标任务创建后不存在".into())
}

/** 返回最近 100 个离线打标任务及逐图结果。 */
pub fn list_jobs(database: &Connection) -> Result<Vec<DesktopCaptionJobView>, String> {
    let mut statement = database
        .prepare("SELECT id FROM local_caption_jobs ORDER BY created_at DESC LIMIT 100")
        .map_err(|error| format!("读取打标任务列表失败：{error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询打标任务列表失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析打标任务列表失败：{error}"))?;
    ids.into_iter()
        .map(|id| read_job(database, &id)?.ok_or_else(|| "打标任务读取期间消失".into()))
        .collect()
}

/** 幂等暂停排队或运行中的打标任务，已经成功写入的 Caption 保持不变。 */
pub fn pause_job(database: &Connection, id: &str) -> Result<DesktopCaptionJobView, String> {
    update_control(database, id, "pause")
}

/** 恢复暂停的打标任务，只重新执行尚未完成的图片。 */
pub fn resume_job(database: &Connection, id: &str) -> Result<DesktopCaptionJobView, String> {
    validate_uuid(id, "打标任务 ID")?;
    let now = Utc::now().to_rfc3339();
    database.execute("UPDATE local_caption_jobs SET status='queued',pause_requested=0,updated_at=?2 WHERE id=?1 AND status='paused' AND cancel_requested=0", params![id,now]).map_err(|error| format!("恢复打标任务失败：{error}"))?;
    read_job(database, id)?.ok_or_else(|| "打标任务不存在".into())
}

/** 幂等取消排队或运行中的打标任务，已经成功写入的 Caption 不回滚。 */
pub fn cancel_job(database: &Connection, id: &str) -> Result<DesktopCaptionJobView, String> {
    update_control(database, id, "cancel")
}

fn update_control(
    database: &Connection,
    id: &str,
    operation: &str,
) -> Result<DesktopCaptionJobView, String> {
    validate_uuid(id, "打标任务 ID")?;
    let now = Utc::now().to_rfc3339();
    let transaction = database.unchecked_transaction().map_err(|error| format!("开启打标任务控制事务失败：{error}"))?;
    let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM local_caption_jobs WHERE id=?1)", [id], |row| row.get(0)).map_err(|error| format!("读取打标任务失败：{error}"))?;
    if !exists {
        return Err("打标任务不存在".into());
    }
    match operation {
        "pause" => {
            transaction.execute("UPDATE local_caption_jobs SET pause_requested=1,status=CASE WHEN status='queued' THEN 'paused' ELSE status END,updated_at=?2 WHERE id=?1 AND status IN ('queued','running')", params![id,now]).map_err(|error| format!("暂停打标任务失败：{error}"))?;
        }
        "cancel" => {
            transaction.execute("UPDATE local_caption_jobs SET cancel_requested=1,pause_requested=0,status=CASE WHEN status IN ('queued','paused') THEN 'cancelled' ELSE status END,completed_at=CASE WHEN status IN ('queued','paused') THEN ?2 ELSE completed_at END,updated_at=?2 WHERE id=?1 AND status IN ('queued','running','paused')", params![id,now]).map_err(|error| format!("取消打标任务失败：{error}"))?;
            transaction.execute("UPDATE local_caption_job_items SET status='cancelled',updated_at=?2 WHERE job_id=?1 AND status='queued'", params![id,now]).map_err(|error| format!("取消等待中的逐图打标任务失败：{error}"))?;
            refresh_job_counts(&transaction, id, &now)?;
        }
        _ => return Err("未知打标任务控制操作".into()),
    }
    transaction.commit().map_err(|error| format!("提交打标任务控制失败：{error}"))?;
    read_job(database, id)?.ok_or_else(|| "打标任务不存在".into())
}

fn caption_loop(
    database_path: &Path,
    app_data_dir: &Path,
    app: &AppHandle,
    stopping: &AtomicBool,
    wake_signal: &(Mutex<bool>, Condvar),
) {
    let Ok(mut database) = Connection::open(database_path) else {
        return;
    };
    let _ = database.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    while !stopping.load(Ordering::SeqCst) {
        match claim_next_job(&mut database, app_data_dir) {
            Ok(Some(job)) => execute_job(&database, app_data_dir, app, stopping, job),
            Ok(None) => wait_for_work(wake_signal, stopping),
            Err(_) => thread::sleep(Duration::from_secs(2)),
        }
    }
}

fn claim_next_job(
    database: &mut Connection,
    app_data_dir: &Path,
) -> Result<Option<CaptionExecution>, String> {
    let transaction = database
        .transaction()
        .map_err(|error| format!("开启打标调度事务失败：{error}"))?;
    let id: Option<String> = transaction.query_row("SELECT id FROM local_caption_jobs WHERE status='queued' AND pause_requested=0 AND cancel_requested=0 ORDER BY created_at ASC LIMIT 1", [], |row| row.get(0)).optional().map_err(|error| format!("读取打标队列失败：{error}"))?;
    let Some(id) = id else {
        transaction
            .commit()
            .map_err(|error| format!("提交空闲打标事务失败：{error}"))?;
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339();
    if transaction.execute("UPDATE local_caption_jobs SET status='running',started_at=COALESCE(started_at,?2),updated_at=?2 WHERE id=?1 AND status='queued' AND pause_requested=0 AND cancel_requested=0", params![id,now]).map_err(|error| format!("领取打标任务失败：{error}"))? != 1 { transaction.rollback().map_err(|error| format!("回滚打标任务领取失败：{error}"))?; return Ok(None); }
    transaction.execute("UPDATE local_caption_job_items SET status='running',updated_at=?2 WHERE job_id=?1 AND status='queued'", params![id,now]).map_err(|error| format!("领取逐图打标任务失败：{error}"))?;
    refresh_job_counts(&transaction, &id, &now)?;
    let execution = read_execution(&transaction, app_data_dir, &id)?;
    transaction
        .commit()
        .map_err(|error| format!("提交打标任务领取失败：{error}"))?;
    Ok(Some(execution))
}

fn execute_job(
    database: &Connection,
    app_data_dir: &Path,
    app: &AppHandle,
    stopping: &AtomicBool,
    job: CaptionExecution,
) {
    emit_job(database, app, &job.id);
    let outcome = execute_runner(database, app_data_dir, app, stopping, &job);
    match outcome {
        Ok(()) => finish_from_items(database, app, &job.id),
        Err(ExecutionStop::Application) => requeue_interrupted(database, app, &job.id),
        Err(ExecutionStop::Paused) => finish_paused(database, app, &job.id),
        Err(ExecutionStop::Cancelled) => finish_cancelled(database, app, &job.id),
        Err(ExecutionStop::Failed(error)) => finish_failed(database, app, &job.id, &error),
    }
}

enum ExecutionStop {
    Application,
    Paused,
    Cancelled,
    Failed(String),
}

fn execute_runner(
    database: &Connection,
    app_data_dir: &Path,
    app: &AppHandle,
    stopping: &AtomicBool,
    job: &CaptionExecution,
) -> Result<(), ExecutionStop> {
    if job.items.is_empty() {
        return Ok(());
    }
    let runtime_root = load_runtime_root(database).map_err(ExecutionStop::Failed)?;
    let component = find_captioner_component(&runtime_root).map_err(ExecutionStop::Failed)?;
    let request_directory = app_data_dir.join("caption-requests");
    fs::create_dir_all(&request_directory)
        .map_err(|error| ExecutionStop::Failed(format!("创建打标请求目录失败：{error}")))?;
    let request_path = request_directory.join(format!("{}.json", job.id));
    let request = RunnerRequest {
        general_threshold: job.general_threshold,
        character_threshold: job.character_threshold,
        include_character_tags: job.include_character_tags,
        items: job
            .items
            .iter()
            .map(|item| RunnerRequestItem {
                asset_id: item.asset_id.clone(),
                path: item.path.to_string_lossy().into_owned(),
            })
            .collect(),
    };
    write_request(&request_path, &request).map_err(ExecutionStop::Failed)?;
    let mut command = Command::new(&component.python);
    hide_window(&mut command);
    let mut child = command
        .args([
            "-I",
            component.runner.to_string_lossy().as_ref(),
            "--request",
            request_path.to_string_lossy().as_ref(),
        ])
        .current_dir(&component.root)
        .env("PYTHONUTF8", "1")
        .env("PYTHONNOUSERSITE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ExecutionStop::Failed(format!("启动离线打标组件失败：{error}")))?;
    let stderr = child.stderr.take();
    let stderr_reader = thread::spawn(move || read_limited_stderr(stderr));
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| ExecutionStop::Failed("离线打标组件没有标准输出".into()))?,
    );
    let expected: HashMap<_, _> = job
        .items
        .iter()
        .map(|item| (item.asset_id.as_str(), item))
        .collect();
    let mut line = String::new();
    loop {
        line.clear();
        let read = stdout
            .read_line(&mut line)
            .map_err(|error| ExecutionStop::Failed(format!("读取离线打标结果失败：{error}")))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_RUNNER_LINE_BYTES {
            let _ = child.kill();
            return Err(ExecutionStop::Failed("离线打标组件单条结果超过限制".into()));
        }
        if stopping.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&request_path);
            return Err(ExecutionStop::Application);
        }
        if control_state(database, &job.id).as_deref() == Some("cancelled") {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&request_path);
            return Err(ExecutionStop::Cancelled);
        }
        if control_state(database, &job.id).as_deref() == Some("paused") {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&request_path);
            return Err(ExecutionStop::Paused);
        }
        let result: RunnerResult = serde_json::from_str(line.trim())
            .map_err(|_| ExecutionStop::Failed("离线打标组件返回了无效结果".into()))?;
        let item = expected
            .get(result.asset_id.as_str())
            .ok_or_else(|| ExecutionStop::Failed("离线打标组件返回了任务外图片".into()))?;
        apply_runner_result(database, job, item, result).map_err(ExecutionStop::Failed)?;
        emit_job(database, app, &job.id);
    }
    let status = child
        .wait()
        .map_err(|error| ExecutionStop::Failed(format!("等待离线打标组件退出失败：{error}")))?;
    let stderr = stderr_reader.join().unwrap_or_default();
    let _ = fs::remove_file(&request_path);
    if stopping.load(Ordering::SeqCst) {
        return Err(ExecutionStop::Application);
    }
    if control_state(database, &job.id).as_deref() == Some("cancelled") {
        return Err(ExecutionStop::Cancelled);
    }
    if control_state(database, &job.id).as_deref() == Some("paused") {
        return Err(ExecutionStop::Paused);
    }
    if !status.success() {
        return Err(ExecutionStop::Failed(redact_runner_error(
            &stderr,
            &component,
            &request_path,
            status.code(),
        )));
    }
    Ok(())
}

fn apply_runner_result(
    database: &Connection,
    job: &CaptionExecution,
    item: &CaptionExecutionItem,
    result: RunnerResult,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启逐图打标事务失败：{error}"))?;
    if let Some(error) = result.error {
        let error = sanitize_item_error(&error);
        transaction.execute("UPDATE local_caption_job_items SET status='failed',error=?3,updated_at=?4 WHERE job_id=?1 AND asset_id=?2 AND status='running'", params![job.id,item.asset_id,error,now]).map_err(|failure| format!("保存逐图打标错误失败：{failure}"))?;
    } else {
        let auto_values = validate_runner_tags(result.tags.unwrap_or_default())?;
        let trigger_words = load_trigger_words(&transaction, &job.dataset_id)?;
        let current_tags = training_tags::read_tags(&transaction, &item.asset_id)?;
        let tags = training_tags::reconcile_auto_tags(&current_tags, auto_values, &trigger_words)?;
        let caption = training_tags::caption_from_tags(&tags)
            .ok_or_else(|| "自动 Caption 为空".to_string())?;
        if caption.chars().count() > 10_000 {
            return Err("自动 Caption 超过 10000 个字符".into());
        }
        let caption_source = training_tags::aggregate_source(&tags);
        let file_swap = stage_caption_file(&job.dataset_root, &item.path, Some(&caption))?;
        let outcome = (|| {
            training_tags::replace_tags(
                &transaction,
                &item.asset_id,
                &tags,
                "automatic_retag",
                Some("离线自动打标"),
                &now,
            )?;
            let changed = transaction.execute("UPDATE local_training_assets SET caption=?3,caption_source=?4,confirmed=0,updated_at=?5 WHERE id=?1 AND dataset_id=?2", params![item.asset_id,job.dataset_id,caption,caption_source,now]).map_err(|error| format!("保存自动 Caption 失败：{error}"))?;
            if changed != 1 {
                return Err("训练图片不存在，自动结果未保存".into());
            }
            transaction.execute("UPDATE local_caption_job_items SET status='succeeded',caption=?3,error=NULL,updated_at=?4 WHERE job_id=?1 AND asset_id=?2 AND status='running'", params![job.id,item.asset_id,caption,now]).map_err(|error| format!("保存逐图打标状态失败：{error}"))?;
            update_dataset_review_status(&transaction, &job.dataset_id, &now)?;
            refresh_job_counts(&transaction, &job.id, &now)?;
            transaction
                .commit()
                .map_err(|error| format!("提交逐图打标结果失败：{error}"))
        })();
        if let Err(error) = outcome {
            rollback_caption_file(file_swap);
            return Err(error);
        }
        finalize_caption_file(file_swap);
        return Ok(());
    }
    refresh_job_counts(&transaction, &job.id, &now)?;
    transaction
        .commit()
        .map_err(|error| format!("提交逐图打标结果失败：{error}"))
}

fn finish_from_items(database: &Connection, app: &AppHandle, id: &str) {
    let now = Utc::now().to_rfc3339();
    let transaction = match database.unchecked_transaction() {
        Ok(value) => value,
        Err(_) => return,
    };
    let _ = transaction.execute("UPDATE local_caption_job_items SET status='failed',error='离线打标组件未返回该图片结果',updated_at=?2 WHERE job_id=?1 AND status='running'", params![id,now]);
    let _ = refresh_job_counts(&transaction, id, &now);
    let failed: u32 = transaction
        .query_row(
            "SELECT failed_assets FROM local_caption_jobs WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap_or(1);
    let status = if failed > 0 { "failed" } else { "succeeded" };
    let error = (failed > 0).then_some("部分图片自动打标失败，请查看逐图状态");
    let _ = transaction.execute("UPDATE local_caption_jobs SET status=?2,progress=100,error=?3,completed_at=?4,updated_at=?4 WHERE id=?1", params![id,status,error,now]);
    let _ = transaction.commit();
    emit_job(database, app, id);
}

fn finish_failed(database: &Connection, app: &AppHandle, id: &str, error: &str) {
    let now = Utc::now().to_rfc3339();
    let safe_error = sanitize_item_error(error);
    if let Ok(transaction) = database.unchecked_transaction() {
        let _ = transaction.execute("UPDATE local_caption_job_items SET status='failed',error=?2,updated_at=?3 WHERE job_id=?1 AND status='running'", params![id,safe_error,now]);
        let _ = refresh_job_counts(&transaction, id, &now);
        let _ = transaction.execute("UPDATE local_caption_jobs SET status='failed',progress=100,error=?2,completed_at=?3,updated_at=?3 WHERE id=?1", params![id,safe_error,now]);
        let _ = transaction.commit();
    }
    emit_job(database, app, id);
}

fn finish_cancelled(database: &Connection, app: &AppHandle, id: &str) {
    let now = Utc::now().to_rfc3339();
    if let Ok(transaction) = database.unchecked_transaction() {
        let _ = transaction.execute("UPDATE local_caption_job_items SET status='cancelled',updated_at=?2 WHERE job_id=?1 AND status='running'", params![id,now]);
        let _ = refresh_job_counts(&transaction, id, &now);
        let _ = transaction.execute("UPDATE local_caption_jobs SET status='cancelled',progress=100,completed_at=?2,updated_at=?2 WHERE id=?1", params![id,now]);
        let _ = transaction.commit();
    }
    emit_job(database, app, id);
}

fn finish_paused(database: &Connection, app: &AppHandle, id: &str) {
    let now = Utc::now().to_rfc3339();
    if let Ok(transaction) = database.unchecked_transaction() {
        let _ = transaction.execute("UPDATE local_caption_job_items SET status='queued',error=NULL,updated_at=?2 WHERE job_id=?1 AND status='running'", params![id,now]);
        let _ = refresh_job_counts(&transaction, id, &now);
        let _ = transaction.execute("UPDATE local_caption_jobs SET status='paused',updated_at=?2 WHERE id=?1 AND pause_requested=1 AND cancel_requested=0", params![id,now]);
        let _ = transaction.commit();
    }
    emit_job(database, app, id);
}

fn requeue_interrupted(database: &Connection, app: &AppHandle, id: &str) {
    let now = Utc::now().to_rfc3339();
    if let Ok(transaction) = database.unchecked_transaction() {
        let _ = transaction.execute("UPDATE local_caption_job_items SET status='queued',error=NULL,updated_at=?2 WHERE job_id=?1 AND status='running'", params![id,now]);
        let _ = refresh_job_counts(&transaction, id, &now);
        let _ = transaction.execute("UPDATE local_caption_jobs SET status=CASE WHEN pause_requested=1 THEN 'paused' ELSE 'queued' END,started_at=CASE WHEN pause_requested=1 THEN started_at ELSE NULL END,updated_at=?2 WHERE id=?1 AND cancel_requested=0", params![id,now]);
        let _ = transaction.commit();
    }
    emit_job(database, app, id);
}

fn select_targets(
    transaction: &Transaction<'_>,
    input: &DesktopCaptionJobCreateInput,
) -> Result<Vec<String>, String> {
    if input.asset_id.is_some() && input.asset_ids.is_some() {
        return Err("单图 ID 与批量图片 ID 不能同时提交".into());
    }
    if let Some(asset_id) = &input.asset_id {
        validate_uuid(asset_id, "训练图片 ID")?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM local_training_assets WHERE id=?1 AND dataset_id=?2)",
                params![asset_id, input.dataset_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("读取训练图片失败：{error}"))?;
        return if exists {
            Ok(vec![asset_id.clone()])
        } else {
            Err("训练图片不存在".into())
        };
    }
    if let Some(asset_ids) = &input.asset_ids {
        if asset_ids.is_empty() || asset_ids.len() > 200 {
            return Err("批量自动打标必须选择 1–200 张图片".into());
        }
        let mut unique = HashSet::new();
        for asset_id in asset_ids {
            validate_uuid(asset_id, "训练图片 ID")?;
            if !unique.insert(asset_id) {
                return Err("批量自动打标包含重复图片".into());
            }
            let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM local_training_assets WHERE id=?1 AND dataset_id=?2)", params![asset_id,input.dataset_id], |row| row.get(0)).map_err(|error| format!("读取批量训练图片失败：{error}"))?;
            if !exists {
                return Err("批量自动打标包含不存在的图片".into());
            }
        }
        return Ok(asset_ids.clone());
    }
    let mut statement = transaction.prepare("SELECT asset.id FROM local_training_assets asset WHERE asset.dataset_id=?1 AND NOT EXISTS(SELECT 1 FROM local_training_asset_tags tag WHERE tag.asset_id=asset.id AND tag.source IN ('manual','imported','ai_cleaned')) ORDER BY asset.created_at ASC,asset.id ASC").map_err(|error| format!("读取待打标图片失败：{error}"))?;
    let targets = statement
        .query_map([&input.dataset_id], |row| row.get(0))
        .map_err(|error| format!("查询待打标图片失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析待打标图片失败：{error}"))?;
    Ok(targets)
}

fn read_execution(
    transaction: &Transaction<'_>,
    app_data_dir: &Path,
    id: &str,
) -> Result<CaptionExecution, String> {
    let (dataset_id, general_threshold, character_threshold, include_character_tags): (String, f64, f64, bool) = transaction.query_row("SELECT dataset_id,general_threshold,character_threshold,include_character_tags FROM local_caption_jobs WHERE id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get::<_, i64>(3)? != 0))).map_err(|error| format!("读取打标任务参数失败：{error}"))?;
    let dataset_root = app_data_dir.join("datasets").join(&dataset_id);
    let mut statement = transaction.prepare("SELECT item.asset_id,asset.relative_path FROM local_caption_job_items item JOIN local_training_assets asset ON asset.id=item.asset_id WHERE item.job_id=?1 AND item.status='running' ORDER BY asset.created_at ASC,asset.id ASC").map_err(|error| format!("读取逐图打标任务失败：{error}"))?;
    let items = statement
        .query_map([id], |row| {
            let relative: String = row.get(1)?;
            Ok(CaptionExecutionItem {
                asset_id: row.get(0)?,
                path: app_data_dir.join(relative),
            })
        })
        .map_err(|error| format!("查询逐图打标任务失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析逐图打标任务失败：{error}"))?;
    Ok(CaptionExecution {
        id: id.into(),
        dataset_id,
        dataset_root,
        general_threshold,
        character_threshold,
        include_character_tags,
        items,
    })
}

fn read_job(database: &Connection, id: &str) -> Result<Option<DesktopCaptionJobView>, String> {
    let row = database.query_row("SELECT id,dataset_id,asset_id,status,progress,total_assets,processed_assets,succeeded_assets,failed_assets,skipped_assets,general_threshold,character_threshold,include_character_tags,error,created_at,started_at,completed_at,updated_at FROM local_caption_jobs WHERE id=?1", [id], |row| Ok(DesktopCaptionJobView { id: row.get(0)?, dataset_id: row.get(1)?, asset_id: row.get(2)?, status: row.get(3)?, progress: row.get(4)?, total_assets: row.get(5)?, processed_assets: row.get(6)?, succeeded_assets: row.get(7)?, failed_assets: row.get(8)?, skipped_assets: row.get(9)?, general_threshold: row.get(10)?, character_threshold: row.get(11)?, include_character_tags: row.get::<_, i64>(12)? != 0, error: row.get(13)?, items: Vec::new(), created_at: row.get(14)?, started_at: row.get(15)?, completed_at: row.get(16)?, updated_at: row.get(17)? })).optional().map_err(|error| format!("读取打标任务失败：{error}"))?;
    let Some(mut job) = row else {
        return Ok(None);
    };
    let mut statement = database.prepare("SELECT asset_id,status,caption,error FROM local_caption_job_items WHERE job_id=?1 ORDER BY created_at ASC,asset_id ASC").map_err(|error| format!("读取逐图打标状态失败：{error}"))?;
    job.items = statement
        .query_map([id], |row| {
            Ok(DesktopCaptionJobItemView {
                asset_id: row.get(0)?,
                status: row.get(1)?,
                caption: row.get(2)?,
                error: row.get(3)?,
            })
        })
        .map_err(|error| format!("查询逐图打标状态失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析逐图打标状态失败：{error}"))?;
    Ok(Some(job))
}

fn refresh_job_counts(database: &Connection, id: &str, now: &str) -> Result<(), String> {
    let (total, processed, succeeded, failed, skipped): (u32,u32,u32,u32,u32) = database.query_row("SELECT COUNT(*),SUM(CASE WHEN status IN ('succeeded','failed','skipped','cancelled') THEN 1 ELSE 0 END),SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) FROM local_caption_job_items WHERE job_id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(|error| format!("统计打标进度失败：{error}"))?;
    let progress = if total == 0 {
        0
    } else {
        processed.saturating_mul(100) / total
    };
    database.execute("UPDATE local_caption_jobs SET progress=?2,total_assets=?3,processed_assets=?4,succeeded_assets=?5,failed_assets=?6,skipped_assets=?7,updated_at=?8 WHERE id=?1", params![id,progress,total,processed,succeeded,failed,skipped,now]).map_err(|error| format!("更新打标进度失败：{error}"))?;
    Ok(())
}

fn load_trigger_words(database: &Connection, dataset_id: &str) -> Result<Vec<String>, String> {
    let json: String = database
        .query_row(
            "SELECT trigger_words_json FROM local_training_datasets WHERE id=?1",
            [dataset_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取训练触发词失败：{error}"))?;
    serde_json::from_str(&json).map_err(|error| format!("解析训练触发词失败：{error}"))
}

fn update_dataset_review_status(
    database: &Connection,
    dataset_id: &str,
    now: &str,
) -> Result<(), String> {
    let (count, missing): (u32, u32) = database.query_row("SELECT COUNT(*),SUM(CASE WHEN caption IS NULL OR TRIM(caption)='' THEN 1 ELSE 0 END) FROM local_training_assets WHERE dataset_id=?1", [dataset_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|error| format!("统计训练集 Caption 失败：{error}"))?;
    let status = if count >= 5 && missing == 0 {
        "review_ready"
    } else {
        "draft"
    };
    database
        .execute(
            "UPDATE local_training_datasets SET status=?2,updated_at=?3 WHERE id=?1",
            params![dataset_id, status, now],
        )
        .map_err(|error| format!("更新训练集阶段失败：{error}"))?;
    Ok(())
}

/** 查找经过资源安装标记验证且文件完整的最新 Captioner 组件。 */
fn find_captioner_component(runtime_root: &str) -> Result<CaptionerComponent, String> {
    let runtime_root = Path::new(runtime_root);
    let python = runtime_root
        .join("current")
        .join("python_embeded")
        .join("python.exe");
    if !python.is_file() {
        return Err("本地 Runtime 的私有 Python 尚未安装".into());
    }
    let components_root = runtime_root.join("components").join("captioner");
    let mut candidates = fs::read_dir(&components_root)
        .map_err(|_| "离线打标组件尚未安装，请先在资源安装页完成安装".to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect::<Vec<_>>();
    candidates.sort_by_key(|entry| entry.metadata().and_then(|value| value.modified()).ok());
    for entry in candidates.into_iter().rev() {
        let root = entry.path();
        if root.join(".drawhime-resource.json").is_file()
            && root.join("runner.py").is_file()
            && root.join("model.onnx").is_file()
            && root.join("selected_tags.csv").is_file()
            && root
                .join("site-packages")
                .join("onnxruntime")
                .join("__init__.py")
                .is_file()
        {
            return Ok(CaptionerComponent {
                python,
                runner: root.join("runner.py"),
                root,
            });
        }
    }
    Err("离线打标组件文件不完整，请在资源安装页执行修复".into())
}

fn write_request(path: &Path, request: &RunnerRequest) -> Result<(), String> {
    let temporary = path.with_extension("json.writing");
    let mut file =
        File::create(&temporary).map_err(|error| format!("创建打标请求失败：{error}"))?;
    serde_json::to_writer(&mut file, request)
        .map_err(|error| format!("序列化打标请求失败：{error}"))?;
    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("保存打标请求失败：{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("提交打标请求失败：{error}"))
}

fn read_limited_stderr(stderr: Option<impl Read>) -> String {
    let Some(mut stderr) = stderr else {
        return String::new();
    };
    let mut bytes = Vec::new();
    let _ = stderr
        .by_ref()
        .take(MAX_RUNNER_ERROR_BYTES as u64)
        .read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn redact_runner_error(
    stderr: &str,
    component: &CaptionerComponent,
    request_path: &Path,
    code: Option<i32>,
) -> String {
    let mut text = stderr
        .replace(component.root.to_string_lossy().as_ref(), "<CAPTIONER>")
        .replace(request_path.to_string_lossy().as_ref(), "<REQUEST>");
    text = text
        .lines()
        .last()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(500)
        .collect();
    if text.is_empty() {
        format!("离线打标组件退出码 {}", code.unwrap_or(-1))
    } else {
        format!("离线打标组件失败：{text}")
    }
}

fn validate_create_input(input: &DesktopCaptionJobCreateInput) -> Result<(), String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    if !(0.05..=0.95).contains(&input.general_threshold)
        || !(0.05..=0.99).contains(&input.character_threshold)
    {
        return Err("自动打标阈值超出允许范围".into());
    }
    if input.asset_id.is_some() && input.asset_ids.is_some() {
        return Err("单图 ID 与批量图片 ID 不能同时提交".into());
    }
    Ok(())
}

fn validate_runner_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.is_empty() || tags.len() > MAX_CAPTION_TAGS {
        return Err("离线打标结果为空或标签数量超过限制".into());
    }
    if tags.iter().any(|tag| {
        tag.trim().is_empty() || tag.chars().count() > 200 || tag.contains(['\r', '\n', '\0'])
    }) {
        return Err("离线打标结果包含无效标签".into());
    }
    Ok(tags)
}

fn sanitize_item_error(error: &str) -> String {
    error
        .lines()
        .last()
        .unwrap_or("离线打标失败")
        .trim()
        .chars()
        .take(500)
        .collect()
}
fn load_runtime_root(database: &Connection) -> Result<String, String> {
    database
        .query_row(
            "SELECT runtime_root FROM desktop_settings WHERE id=1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取 Runtime 目录失败：{error}"))
}
fn control_state(database: &Connection, id: &str) -> Option<String> {
    database
        .query_row(
            "SELECT CASE WHEN cancel_requested=1 THEN 'cancelled' WHEN pause_requested=1 THEN 'paused' ELSE status END FROM local_caption_jobs WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .ok()
}
fn emit_job(database: &Connection, app: &AppHandle, id: &str) {
    if let Ok(Some(job)) = read_job(database, id) {
        let _ = app.emit("desktop-caption-job-updated", job);
    }
}
fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{label} 不正确"))
}
fn wait_for_work(wake_signal: &(Mutex<bool>, Condvar), stopping: &AtomicBool) {
    let (lock, condition) = wake_signal;
    if let Ok(pending) = lock.lock() {
        if !*pending && !stopping.load(Ordering::SeqCst) {
            let _ = condition.wait_timeout(pending, Duration::from_secs(2));
        }
    }
    if let Ok(mut pending) = lock.lock() {
        *pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{
            DesktopTrainingCaptionUpdateInput, DesktopTrainingDatasetCreateInput,
            DesktopTrainingImagesAddInput,
        },
        storage::DesktopState,
        training_dataset,
    };
    use image::{Rgb, RgbImage};

    #[test]
    fn batch_caption_job_preserves_manual_caption_and_applies_trigger_words() {
        let temporary = tempfile::tempdir().expect("创建打标测试目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "打标测试".into(),
                r#type: "character".into(),
                trigger_words: vec!["dh_unique".into()],
            })
            .expect("创建训练集");
        let sources = (0..5)
            .map(|index| {
                let path = temporary.path().join(format!("caption-{index}.png"));
                RgbImage::from_pixel(64, 64, Rgb([index, 40, 80]))
                    .save(&path)
                    .expect("写入测试图片");
                path.to_string_lossy().into_owned()
            })
            .collect();
        let imported = {
            let mut database = state.database.lock().expect("锁定数据库");
            training_dataset::add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths: sources,
                },
            )
            .expect("导入测试图片")
        };
        state
            .update_training_caption(DesktopTrainingCaptionUpdateInput {
                dataset_id: dataset.id.clone(),
                asset_id: imported.assets[0].id.clone(),
                caption: Some("manual identity".into()),
            })
            .expect("保存人工 Caption");
        let job = {
            let mut database = state.database.lock().expect("锁定数据库");
            create_job(
                &mut database,
                DesktopCaptionJobCreateInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: None,
                    asset_ids: None,
                    general_threshold: 0.35,
                    character_threshold: 0.85,
                    include_character_tags: false,
                },
            )
            .expect("创建批量打标任务")
        };
        assert_eq!(job.items.len(), 4);
        assert!(!job
            .items
            .iter()
            .any(|item| item.asset_id == imported.assets[0].id));
        let item = CaptionExecutionItem {
            asset_id: job.items[0].asset_id.clone(),
            path: PathBuf::from(
                imported
                    .assets
                    .iter()
                    .find(|asset| asset.id == job.items[0].asset_id)
                    .expect("找到待自动打标图片")
                    .path
                    .clone(),
            ),
        };
        let execution = CaptionExecution {
            id: job.id.clone(),
            dataset_id: dataset.id.clone(),
            dataset_root: state.app_data_dir.join("datasets").join(&dataset.id),
            general_threshold: 0.35,
            character_threshold: 0.85,
            include_character_tags: false,
            items: vec![item.clone()],
        };
        {
            let database = state.database.lock().expect("锁定数据库");
            database.execute("UPDATE local_caption_job_items SET status='running' WHERE job_id=?1 AND asset_id=?2", params![job.id,item.asset_id]).expect("模拟领取任务");
            apply_runner_result(
                &database,
                &execution,
                &item,
                RunnerResult {
                    asset_id: item.asset_id.clone(),
                    tags: Some(vec!["1girl".into(), "solo".into()]),
                    error: None,
                },
            )
            .expect("写入自动 Caption");
        }
        let restored = state.list_training_datasets().expect("恢复训练集");
        assert_eq!(
            restored[0].assets[0].caption.as_deref(),
            Some("dh_unique, manual identity")
        );
        assert_eq!(restored[0].assets[0].tags[0].source, "trigger");
        assert_eq!(restored[0].assets[0].tags[1].source, "manual");
        assert_eq!(
            fs::read_to_string(Path::new(&restored[0].assets[0].path).with_extension("txt"))
                .expect("读取人工 Caption 文件"),
            "dh_unique, manual identity"
        );
        let tagged = restored[0]
            .assets
            .iter()
            .find(|asset| asset.id == item.asset_id)
            .expect("读取自动打标图片");
        assert_eq!(tagged.caption.as_deref(), Some("dh_unique, 1girl, solo"));
        assert_eq!(tagged.caption_source.as_deref(), Some("auto"));
        assert_eq!(
            tagged
                .tags
                .iter()
                .map(|tag| tag.source.as_str())
                .collect::<Vec<_>>(),
            vec!["trigger", "auto", "auto"]
        );
        assert_eq!(
            fs::read_to_string(Path::new(&tagged.path).with_extension("txt"))
                .expect("读取自动 Caption 文件"),
            "dh_unique, 1girl, solo"
        );
    }

    /** 单图连续重新打标只替换旧 AUTO 标签，不覆盖人工标签和触发词。 */
    #[test]
    fn single_retag_replaces_only_auto_tags() {
        let temporary = tempfile::tempdir().expect("创建单图重打标测试目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "来源保护".into(),
                r#type: "character".into(),
                trigger_words: vec!["protected_trigger".into()],
            })
            .expect("创建训练集");
        let source = temporary.path().join("retag.png");
        RgbImage::from_pixel(64, 64, Rgb([12, 34, 56]))
            .save(&source)
            .expect("写入测试图片");
        let imported = {
            let mut database = state.database.lock().expect("锁定数据库");
            training_dataset::add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths: vec![source.to_string_lossy().into_owned()],
                },
            )
            .expect("导入测试图片")
        };
        let asset = &imported.assets[0];
        state
            .update_training_caption(DesktopTrainingCaptionUpdateInput {
                dataset_id: dataset.id.clone(),
                asset_id: asset.id.clone(),
                caption: Some("manual feature".into()),
            })
            .expect("写入人工标签");
        let job = {
            let mut database = state.database.lock().expect("锁定数据库");
            create_job(
                &mut database,
                DesktopCaptionJobCreateInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: Some(asset.id.clone()),
                    asset_ids: None,
                    general_threshold: 0.35,
                    character_threshold: 0.85,
                    include_character_tags: false,
                },
            )
            .expect("创建单图打标任务")
        };
        let item = CaptionExecutionItem {
            asset_id: asset.id.clone(),
            path: PathBuf::from(&asset.path),
        };
        let execution = CaptionExecution {
            id: job.id.clone(),
            dataset_id: dataset.id.clone(),
            dataset_root: state.app_data_dir.join("datasets").join(&dataset.id),
            general_threshold: 0.35,
            character_threshold: 0.85,
            include_character_tags: false,
            items: vec![item.clone()],
        };
        for tags in [
            vec!["old automatic".into(), "solo".into()],
            vec!["new automatic".into(), "standing".into()],
        ] {
            let database = state.database.lock().expect("锁定数据库");
            database.execute("UPDATE local_caption_job_items SET status='running' WHERE job_id=?1 AND asset_id=?2", params![job.id,item.asset_id]).expect("模拟领取单图任务");
            apply_runner_result(
                &database,
                &execution,
                &item,
                RunnerResult {
                    asset_id: item.asset_id.clone(),
                    tags: Some(tags),
                    error: None,
                },
            )
            .expect("写入单图自动标签");
        }
        let restored = state.list_training_datasets().expect("读取重打标结果");
        let tags = &restored[0].assets[0].tags;
        assert!(tags
            .iter()
            .any(|tag| tag.value == "manual feature" && tag.source == "manual"));
        assert!(tags
            .iter()
            .any(|tag| tag.value == "protected_trigger" && tag.source == "trigger"));
        assert!(tags
            .iter()
            .any(|tag| tag.value == "new automatic" && tag.source == "auto"));
        assert!(!tags.iter().any(|tag| tag.value == "old automatic"));
        let history_count: u32 = state
            .database
            .lock()
            .expect("锁定历史数据库")
            .query_row(
                "SELECT COUNT(*) FROM local_training_tag_changes WHERE asset_id=?1",
                [&asset.id],
                |row| row.get(0),
            )
            .expect("统计标签变更历史");
        assert_eq!(history_count, 3);
    }

    /** 批量重打标只创建用户选择的任务项，并且不改变未选图片的确认状态。 */
    #[test]
    fn selected_batch_caption_targets_only_requested_assets() {
        let temporary = tempfile::tempdir().expect("创建批量选择测试目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "批量选择".into(),
                r#type: "character".into(),
                trigger_words: vec!["batch_trigger".into()],
            })
            .expect("创建训练集");
        let sources = (0..3)
            .map(|index| {
                let path = temporary.path().join(format!("selected-{index}.png"));
                RgbImage::from_pixel(64, 64, Rgb([index, 90, 120]))
                    .save(&path)
                    .expect("写入批量选择图片");
                path.to_string_lossy().into_owned()
            })
            .collect();
        let imported = {
            let mut database = state.database.lock().expect("锁定数据库");
            training_dataset::add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths: sources,
                },
            )
            .expect("导入批量选择图片")
        };
        {
            let database = state.database.lock().expect("锁定确认状态数据库");
            database
                .execute(
                    "UPDATE local_training_assets SET confirmed=1 WHERE dataset_id=?1",
                    [&dataset.id],
                )
                .expect("预置图片确认状态");
        }
        let selected_ids = vec![imported.assets[0].id.clone(), imported.assets[2].id.clone()];
        let job = {
            let mut database = state.database.lock().expect("锁定任务数据库");
            create_job(
                &mut database,
                DesktopCaptionJobCreateInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: None,
                    asset_ids: Some(selected_ids.clone()),
                    general_threshold: 0.35,
                    character_threshold: 0.85,
                    include_character_tags: false,
                },
            )
            .expect("创建选择性批量打标任务")
        };
        assert_eq!(
            job.items
                .iter()
                .map(|item| item.asset_id.clone())
                .collect::<Vec<_>>(),
            selected_ids
        );
        let confirmed = {
            let database = state.database.lock().expect("锁定结果数据库");
            imported
                .assets
                .iter()
                .map(|asset| {
                    database
                        .query_row(
                            "SELECT confirmed FROM local_training_assets WHERE id=?1",
                            [&asset.id],
                            |row| row.get::<_, i64>(0),
                        )
                        .expect("读取图片确认状态")
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(confirmed, vec![0, 1, 0]);
    }

    /** 打标控制状态持久化，暂停任务不能被重复领取，恢复后仍只保留未完成项。 */
    #[test]
    fn queued_caption_job_supports_pause_resume_and_cancel() {
        let temporary = tempfile::tempdir().expect("创建打标控制测试目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state.create_training_dataset(DesktopTrainingDatasetCreateInput { title: "打标控制".into(), r#type: "character".into(), trigger_words: vec![] }).expect("创建训练集");
        let source = temporary.path().join("caption-control.png");
        RgbImage::from_pixel(32, 32, Rgb([24, 48, 72])).save(&source).expect("写入打标控制图片");
        let imported = {
            let mut database = state.database.lock().expect("锁定打标控制数据库");
            training_dataset::add_images(&mut database, &state.app_data_dir, DesktopTrainingImagesAddInput { dataset_id: dataset.id.clone(), source_paths: vec![source.to_string_lossy().into_owned()] }).expect("导入打标控制图片")
        };
        let mut database = state.database.lock().expect("锁定打标任务数据库");
        let job = create_job(&mut database, DesktopCaptionJobCreateInput { dataset_id: dataset.id, asset_id: Some(imported.assets[0].id.clone()), asset_ids: None, general_threshold: 0.35, character_threshold: 0.85, include_character_tags: false }).expect("创建打标控制任务");
        assert_eq!(pause_job(&database, &job.id).expect("暂停打标任务").status, "paused");
        assert!(claim_next_job(&mut database, &state.app_data_dir).expect("检查暂停队列").is_none());
        assert_eq!(resume_job(&database, &job.id).expect("恢复打标任务").status, "queued");
        let cancelled = cancel_job(&database, &job.id).expect("取消打标任务");
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.items[0].status, "cancelled");
    }
}
