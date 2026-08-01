//! 本模块实现 SQLite 为事实源的 AI 标签清洗队列，并把结果直接写回用户选中的训练集。

use crate::{
    ai_assist,
    models::{
        DesktopAiCleanApplyInput, DesktopAiCleanJobCreateInput, DesktopAiCleanJobItemView,
        DesktopAiCleanJobView, DesktopAiCleanProposal, DesktopAiCleanUndoInput, DesktopAiSettings,
        DesktopTrainingDatasetView,
    },
    training_dataset,
    training_files::{finalize_caption_file, rollback_caption_file, stage_caption_file},
    training_tags::{self, TrainingTag},
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const MAX_ATTEMPTS: u32 = 3;

/** 应用生命周期内唯一的 AI 清洗串行 Worker，避免上游并发和限流失控。 */
pub struct AiCleanScheduler {
    stopping: Arc<AtomicBool>,
    wake_signal: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

struct CleanExecutionItem {
    job_id: String,
    dataset_id: String,
    asset_id: String,
    image_path: PathBuf,
    dataset_type: String,
    trigger_words: Vec<String>,
    training_goal: String,
    original_tags: Vec<String>,
    attempt_count: u32,
}

/** 训练提交后仅处理任务快照的 AI 清洗项，绝不引用或修改原训练集。 */
struct SnapshotCleanExecutionItem {
    job_id: String,
    sequence: u32,
    image_path: PathBuf,
    dataset_type: String,
    trigger_words: Vec<String>,
    training_goal: String,
    original_tags: Vec<TrainingTag>,
    attempt_count: u32,
}

impl AiCleanScheduler {
    /** 启动独立数据库连接的 AI 清洗 Worker，重启后继续未完成批次。 */
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
            .name("drawhime-ai-clean-scheduler".into())
            .stack_size(4 * 1024 * 1024)
            .spawn(move || {
                clean_loop(
                    &database_path,
                    &app_data_dir,
                    &app,
                    &worker_stopping,
                    &worker_signal,
                )
            })
            .map_err(|error| format!("启动 AI 清洗线程失败：{error}"))?;
        Ok(Self {
            stopping,
            wake_signal,
            worker: Some(worker),
        })
    }

    /** 唤醒空闲 Worker，使新批次立即开始。 */
    pub fn wake(&self) {
        let (lock, condition) = &*self.wake_signal;
        if let Ok(mut pending) = lock.lock() {
            *pending = true;
            condition.notify_one();
        }
    }
}

impl Drop for AiCleanScheduler {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.wake();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/** 创建只生成建议的单图或批量 AI 清洗任务。 */
pub fn create_job(
    database: &mut Connection,
    input: DesktopAiCleanJobCreateInput,
) -> Result<DesktopAiCleanJobView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    if input.asset_ids.is_empty() || input.asset_ids.len() > 200 {
        return Err("AI 清洗必须选择 1–200 张图片".into());
    }
    if input.training_goal.chars().count() > 4_000 {
        return Err("训练目标不能超过 4000 个字符".into());
    }
    let mut unique = HashSet::new();
    for id in &input.asset_ids {
        validate_uuid(id, "训练图片 ID")?;
        if !unique.insert(id) {
            return Err("AI 清洗选择中包含重复图片".into());
        }
    }
    let transaction = database
        .transaction()
        .map_err(|error| format!("开启 AI 清洗任务事务失败：{error}"))?;
    let active: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM local_ai_clean_jobs WHERE dataset_id=?1 AND status IN ('queued','running','paused'))", [&input.dataset_id], |row| row.get(0)).map_err(|error| format!("检查活动 AI 清洗任务失败：{error}"))?;
    if active {
        return Err("当前训练集已有 AI 清洗任务正在运行".into());
    }
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
    let mut snapshots = Vec::with_capacity(input.asset_ids.len());
    for asset_id in &input.asset_ids {
        let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM local_training_assets WHERE id=?1 AND dataset_id=?2 AND caption IS NOT NULL AND TRIM(caption)<>'')", params![asset_id,input.dataset_id], |row| row.get(0)).map_err(|error| format!("读取 AI 清洗图片失败：{error}"))?;
        if !exists {
            return Err("所选图片不存在或尚未打标".into());
        }
        let tags = training_tags::read_tags(&transaction, asset_id)?;
        if tags.is_empty() {
            return Err("所选图片没有逐标签记录".into());
        }
        snapshots.push((
            asset_id,
            serde_json::to_string(&tags.iter().map(|tag| tag.value.clone()).collect::<Vec<_>>())
                .map_err(|error| format!("序列化原标签失败：{error}"))?,
        ));
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    transaction.execute("INSERT INTO local_ai_clean_jobs (id,dataset_id,status,progress,total_assets,training_goal,created_at,updated_at) VALUES (?1,?2,'queued',0,?3,?4,?5,?5)", params![id,input.dataset_id,snapshots.len() as u32,input.training_goal.trim(),now]).map_err(|error| format!("创建 AI 清洗任务失败：{error}"))?;
    for (asset_id, original_tags_json) in snapshots {
        transaction.execute("INSERT INTO local_ai_clean_job_items (job_id,asset_id,status,attempt_count,original_tags_json,apply_status,updated_at) VALUES (?1,?2,'queued',0,?3,'pending',?4)", params![id,asset_id,original_tags_json,now]).map_err(|error| format!("创建逐图 AI 清洗任务失败：{error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("提交 AI 清洗任务失败：{error}"))?;
    read_job(database, &id)?.ok_or_else(|| "AI 清洗任务创建后不存在".into())
}

/** 返回最近 100 个 AI 清洗任务及完整结构化建议。 */
pub fn list_jobs(database: &Connection) -> Result<Vec<DesktopAiCleanJobView>, String> {
    let mut statement = database
        .prepare("SELECT id FROM local_ai_clean_jobs ORDER BY created_at DESC LIMIT 100")
        .map_err(|error| format!("读取 AI 清洗任务列表失败：{error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询 AI 清洗任务失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析 AI 清洗任务失败：{error}"))?;
    ids.into_iter()
        .map(|id| read_job(database, &id)?.ok_or_else(|| "AI 清洗任务读取期间消失".into()))
        .collect()
}

/** 幂等暂停 AI 清洗任务，已生成的逐图建议继续保留。 */
pub fn pause_job(database: &Connection, id: &str) -> Result<DesktopAiCleanJobView, String> {
    update_control(database, id, "pause")
}

/** 恢复暂停的 AI 清洗任务，只处理尚未完成的图片。 */
pub fn resume_job(database: &Connection, id: &str) -> Result<DesktopAiCleanJobView, String> {
    validate_uuid(id, "AI 清洗任务 ID")?;
    let now = Utc::now().to_rfc3339();
    database.execute("UPDATE local_ai_clean_jobs SET status='queued',pause_requested=0,updated_at=?2 WHERE id=?1 AND status='paused' AND cancel_requested=0", params![id,now]).map_err(|error| format!("恢复 AI 清洗任务失败：{error}"))?;
    read_job(database, id)?.ok_or_else(|| "AI 清洗任务不存在".into())
}

/** 幂等取消排队或运行中的 AI 清洗任务，已经生成的建议继续保留。 */
pub fn cancel_job(database: &Connection, id: &str) -> Result<DesktopAiCleanJobView, String> {
    update_control(database, id, "cancel")
}

fn update_control(
    database: &Connection,
    id: &str,
    operation: &str,
) -> Result<DesktopAiCleanJobView, String> {
    validate_uuid(id, "AI 清洗任务 ID")?;
    let now = Utc::now().to_rfc3339();
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启取消 AI 清洗事务失败：{error}"))?;
    let status: Option<String> = transaction
        .query_row(
            "SELECT status FROM local_ai_clean_jobs WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取 AI 清洗任务失败：{error}"))?;
    let Some(status) = status else {
        return Err("AI 清洗任务不存在".into());
    };
    match operation {
        "pause" if matches!(status.as_str(), "queued" | "running") => {
            transaction.execute("UPDATE local_ai_clean_jobs SET pause_requested=1,status=CASE WHEN status='queued' THEN 'paused' ELSE status END,updated_at=?2 WHERE id=?1", params![id,now]).map_err(|error| format!("暂停 AI 清洗失败：{error}"))?;
        }
        "cancel" if matches!(status.as_str(), "queued" | "running" | "paused") => {
            transaction.execute("UPDATE local_ai_clean_jobs SET cancel_requested=1,pause_requested=0,status=CASE WHEN status IN ('queued','paused') THEN 'cancelled' ELSE status END,completed_at=CASE WHEN status IN ('queued','paused') THEN ?2 ELSE completed_at END,updated_at=?2 WHERE id=?1", params![id,now]).map_err(|error| format!("请求取消 AI 清洗失败：{error}"))?;
            transaction.execute("UPDATE local_ai_clean_job_items SET status='cancelled',updated_at=?2 WHERE job_id=?1 AND status='queued'", params![id,now]).map_err(|error| format!("取消等待中的逐图 AI 清洗失败：{error}"))?;
            refresh_job(&transaction, id, &now)?;
        }
        "pause" | "cancel" => {}
        _ => return Err("未知 AI 清洗任务控制操作".into()),
    }
    transaction
        .commit()
        .map_err(|error| format!("提交取消 AI 清洗失败：{error}"))?;
    read_job(database, id)?.ok_or_else(|| "AI 清洗任务不存在".into())
}

/** 应用用户接受的 AI 建议，并把数据库和 Caption 文件作为一个可回滚操作提交。 */
pub fn apply_proposal(
    database: &Connection,
    app_data_dir: &Path,
    input: DesktopAiCleanApplyInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.job_id, "AI 清洗任务 ID")?;
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.asset_id, "训练图片 ID")?;
    let (relative_path, trigger_json, proposal_json, item_status, apply_status): (String, String, String, String, String) = database.query_row("SELECT asset.relative_path,dataset.trigger_words_json,item.proposal_json,item.status,item.apply_status FROM local_ai_clean_job_items item JOIN local_ai_clean_jobs job ON job.id=item.job_id JOIN local_training_assets asset ON asset.id=item.asset_id JOIN local_training_datasets dataset ON dataset.id=asset.dataset_id WHERE item.job_id=?1 AND item.asset_id=?2 AND job.dataset_id=?3 AND asset.dataset_id=?3", params![input.job_id,input.asset_id,input.dataset_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional().map_err(|error| format!("读取 AI 清洗建议失败：{error}"))?.ok_or_else(|| "AI 清洗建议不存在".to_string())?;
    if item_status != "succeeded" || !matches!(apply_status.as_str(), "pending" | "undone") {
        return Err("当前 AI 清洗建议不可应用".into());
    }
    let proposal: DesktopAiCleanProposal = serde_json::from_str(&proposal_json)
        .map_err(|error| format!("解析 AI 清洗建议失败：{error}"))?;
    let current = training_tags::read_tags(database, &input.asset_id)?;
    ensure_original_unchanged(&current, &proposal.original_tags)?;
    validate_accepted_suggestions(&proposal, &input.remove_tags, &input.add_tags)?;
    let triggers: Vec<String> = serde_json::from_str(&trigger_json)
        .map_err(|error| format!("解析训练触发词失败：{error}"))?;
    let tags = training_tags::reconcile_ai_clean_tags(
        &current,
        &input.remove_tags,
        &input.add_tags,
        &triggers,
    )?;
    save_applied_tags(
        database,
        app_data_dir,
        &input.dataset_id,
        &input.asset_id,
        &relative_path,
        &tags,
        Some((&input.job_id, "applied", None)),
    )?;
    training_dataset::read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 撤销最近应用的 AI 清洗；检测到后续人工编辑时拒绝覆盖。 */
pub fn undo_proposal(
    database: &Connection,
    app_data_dir: &Path,
    input: DesktopAiCleanUndoInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.job_id, "AI 清洗任务 ID")?;
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.asset_id, "训练图片 ID")?;
    let (relative_path, change_id, apply_status): (String, Option<String>, String) = database.query_row("SELECT asset.relative_path,item.applied_change_id,item.apply_status FROM local_ai_clean_job_items item JOIN local_ai_clean_jobs job ON job.id=item.job_id JOIN local_training_assets asset ON asset.id=item.asset_id WHERE item.job_id=?1 AND item.asset_id=?2 AND job.dataset_id=?3 AND asset.dataset_id=?3", params![input.job_id,input.asset_id,input.dataset_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|error| format!("读取 AI 清洗撤销记录失败：{error}"))?.ok_or_else(|| "AI 清洗记录不存在".to_string())?;
    if apply_status != "applied" {
        return Err("当前 AI 清洗没有可撤销的应用记录".into());
    }
    let change_id = change_id.ok_or_else(|| "AI 清洗变更记录缺失".to_string())?;
    let (before_json, after_json): (String, String) = database.query_row("SELECT before_json,after_json FROM local_training_tag_changes WHERE id=?1 AND asset_id=?2 AND operation='ai_clean_apply'", params![change_id,input.asset_id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|error| format!("读取 AI 清洗变更历史失败：{error}"))?.ok_or_else(|| "AI 清洗变更历史不存在".to_string())?;
    let current = training_tags::read_tags(database, &input.asset_id)?;
    let current_json =
        serde_json::to_string(&current).map_err(|error| format!("序列化当前标签失败：{error}"))?;
    if current_json != after_json {
        return Err("应用 AI 清洗后标签已经继续修改，不能覆盖后续内容".into());
    }
    let before: Vec<TrainingTag> = serde_json::from_str(&before_json)
        .map_err(|error| format!("解析 AI 清洗前标签失败：{error}"))?;
    save_applied_tags(
        database,
        app_data_dir,
        &input.dataset_id,
        &input.asset_id,
        &relative_path,
        &before,
        Some((&input.job_id, "undone", None)),
    )?;
    training_dataset::read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

fn clean_loop(
    database_path: &Path,
    app_data_dir: &Path,
    app: &AppHandle,
    stopping: &AtomicBool,
    wake_signal: &(Mutex<bool>, Condvar),
) {
    let Ok(database) = Connection::open(database_path) else {
        return;
    };
    let _ = database.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    while !stopping.load(Ordering::SeqCst) {
        match claim_next_item(&database, app_data_dir) {
            Ok(Some(item)) => execute_item(&database, app_data_dir, app, stopping, item),
            Ok(None) => match claim_next_snapshot_item(&database, app_data_dir) {
                Ok(Some(item)) => execute_snapshot_item(&database, app, stopping, item),
                Ok(None) => wait_for_work(wake_signal, stopping),
                Err(_) => thread::sleep(Duration::from_secs(2)),
            },
            Err(_) => thread::sleep(Duration::from_secs(2)),
        }
    }
}

/** 原子领取训练任务快照中的一张图片，快照阶段与原训练集清洗队列相互独立。 */
fn claim_next_snapshot_item(
    database: &Connection,
    app_data_dir: &Path,
) -> Result<Option<SnapshotCleanExecutionItem>, String> {
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启训练快照 AI 标签领取事务失败：{error}"))?;
    let row: Option<(String, u32, String, String, String, String, String, u32)> = transaction.query_row("SELECT job.id,asset.sequence,asset.relative_path,job.type,job.trigger_words_json,job.training_goal,asset.tags_json,asset.ai_clean_attempt_count FROM local_training_jobs job JOIN local_training_job_assets asset ON asset.job_id=job.id WHERE job.status='queued' AND job.cancel_requested=0 AND job.preprocessing_status IN ('queued','running') AND asset.ai_clean_status='queued' ORDER BY job.created_at ASC,asset.sequence ASC LIMIT 1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?))).optional().map_err(|error| format!("读取训练快照 AI 标签队列失败：{error}"))?;
    let Some(row) = row else {
        transaction
            .commit()
            .map_err(|error| format!("提交空闲训练快照 AI 标签事务失败：{error}"))?;
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339();
    transaction.execute("UPDATE local_training_jobs SET preprocessing_status='running',updated_at=?2 WHERE id=?1 AND preprocessing_status IN ('queued','running')", params![row.0,now]).map_err(|error| format!("领取训练快照 AI 标签阶段失败：{error}"))?;
    if transaction.execute("UPDATE local_training_job_assets SET ai_clean_status='running',ai_clean_attempt_count=ai_clean_attempt_count+1,ai_clean_error=NULL WHERE job_id=?1 AND sequence=?2 AND ai_clean_status='queued'", params![row.0,row.1]).map_err(|error| format!("领取逐图训练快照 AI 标签失败：{error}"))? != 1 {
        transaction.rollback().map_err(|error| format!("回滚训练快照 AI 标签领取失败：{error}"))?;
        return Ok(None);
    }
    transaction
        .commit()
        .map_err(|error| format!("提交训练快照 AI 标签领取事务失败：{error}"))?;
    Ok(Some(SnapshotCleanExecutionItem {
        job_id: row.0,
        sequence: row.1,
        image_path: app_data_dir.join(row.2),
        dataset_type: row.3,
        trigger_words: serde_json::from_str(&row.4)
            .map_err(|error| format!("解析训练快照触发词失败：{error}"))?,
        training_goal: row.5,
        original_tags: serde_json::from_str(&row.6)
            .map_err(|error| format!("解析训练快照原标签失败：{error}"))?,
        attempt_count: row.7 + 1,
    }))
}

fn claim_next_item(
    database: &Connection,
    app_data_dir: &Path,
) -> Result<Option<CleanExecutionItem>, String> {
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启 AI 清洗领取事务失败：{error}"))?;
    let row: Option<(String, String, String, String, String, String, String, String, u32)> = transaction.query_row("SELECT job.id,job.dataset_id,item.asset_id,asset.relative_path,dataset.type,dataset.trigger_words_json,job.training_goal,item.original_tags_json,item.attempt_count FROM local_ai_clean_jobs job JOIN local_ai_clean_job_items item ON item.job_id=job.id JOIN local_training_assets asset ON asset.id=item.asset_id JOIN local_training_datasets dataset ON dataset.id=job.dataset_id WHERE job.status IN ('queued','running') AND job.pause_requested=0 AND job.cancel_requested=0 AND item.status='queued' ORDER BY job.created_at ASC,item.rowid ASC LIMIT 1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?))).optional().map_err(|error| format!("读取 AI 清洗队列失败：{error}"))?;
    let Some(row) = row else {
        transaction
            .commit()
            .map_err(|error| format!("提交空闲 AI 清洗事务失败：{error}"))?;
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339();
    if transaction.execute("UPDATE local_ai_clean_jobs SET status='running',started_at=COALESCE(started_at,?2),updated_at=?2 WHERE id=?1 AND pause_requested=0 AND cancel_requested=0", params![row.0,now]).map_err(|error| format!("领取 AI 清洗任务失败：{error}"))? != 1 {
        transaction.rollback().map_err(|error| format!("回滚 AI 清洗任务领取失败：{error}"))?;
        return Ok(None);
    }
    if transaction.execute("UPDATE local_ai_clean_job_items SET status='running',attempt_count=attempt_count+1,error=NULL,updated_at=?3 WHERE job_id=?1 AND asset_id=?2 AND status='queued'", params![row.0,row.2,now]).map_err(|error| format!("领取逐图 AI 清洗失败：{error}"))? != 1 { transaction.rollback().map_err(|error| format!("回滚 AI 清洗领取失败：{error}"))?; return Ok(None); }
    transaction
        .commit()
        .map_err(|error| format!("提交 AI 清洗领取事务失败：{error}"))?;
    Ok(Some(CleanExecutionItem {
        job_id: row.0,
        dataset_id: row.1,
        asset_id: row.2,
        image_path: app_data_dir.join(row.3),
        dataset_type: row.4,
        trigger_words: serde_json::from_str(&row.5)
            .map_err(|error| format!("解析训练触发词失败：{error}"))?,
        training_goal: row.6,
        original_tags: serde_json::from_str(&row.7)
            .map_err(|error| format!("解析原标签快照失败：{error}"))?,
        attempt_count: row.8 + 1,
    }))
}

fn execute_item(
    database: &Connection,
    app_data_dir: &Path,
    app: &AppHandle,
    stopping: &AtomicBool,
    item: CleanExecutionItem,
) {
    emit_job(database, app, &item.job_id);
    if stopping.load(Ordering::SeqCst) {
        requeue_running(database, &item);
        return;
    }
    let result = load_ai_settings(database).and_then(|settings| {
        let current = training_tags::read_tags(database, &item.asset_id)?;
        ensure_original_unchanged(&current, &item.original_tags)?;
        ai_assist::clean_training_tags(
            &settings,
            &item.image_path,
            &item.dataset_type,
            &item.trigger_words,
            &item.training_goal,
            &item.original_tags,
        )
    });
    if stopping.load(Ordering::SeqCst) {
        requeue_running(database, &item);
        return;
    }
    let now = Utc::now().to_rfc3339();
    let control = control_state(database, &item.job_id);
    if control.as_deref() == Some("cancelled") {
        let _ = database.execute("UPDATE local_ai_clean_job_items SET status='cancelled',updated_at=?3 WHERE job_id=?1 AND asset_id=?2 AND status='running'", params![item.job_id,item.asset_id,now]);
    } else if control.as_deref() == Some("paused") {
        requeue_running(database, &item);
        emit_job(database, app, &item.job_id);
        return;
    } else if let Ok(proposal) = result {
        if let Err(error) = apply_direct_proposal(database, app_data_dir, &item, &proposal) {
            finish_item_error(database, &item, &error, &now);
        }
    } else if let Err(error) = result {
        finish_item_error(database, &item, &error, &now);
    }
    let _ = refresh_job(database, &item.job_id, &now);
    emit_job(database, app, &item.job_id);
}

/** AI 结果通过本地边界校验后直接原子写回训练集，不再要求用户逐图应用建议。 */
fn apply_direct_proposal(
    database: &Connection,
    app_data_dir: &Path,
    item: &CleanExecutionItem,
    proposal: &DesktopAiCleanProposal,
) -> Result<(), String> {
    let current = training_tags::read_tags(database, &item.asset_id)?;
    ensure_original_unchanged(&current, &item.original_tags)?;
    let tags = reconcile_proposal_tags(&current, &item.trigger_words, proposal)?;
    let proposal_json = serde_json::to_string(proposal)
        .map_err(|error| format!("序列化 AI 清洗结果失败：{error}"))?;
    let relative_path: String = database
        .query_row(
            "SELECT relative_path FROM local_training_assets WHERE id=?1 AND dataset_id=?2",
            params![item.asset_id, item.dataset_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取 AI 清洗图片失败：{error}"))?
        .ok_or_else(|| "训练图片不存在".to_string())?;
    save_applied_tags(
        database,
        app_data_dir,
        &item.dataset_id,
        &item.asset_id,
        &relative_path,
        &tags,
        Some((&item.job_id, "applied", Some(&proposal_json))),
    )
}

fn finish_item_error(database: &Connection, item: &CleanExecutionItem, error: &str, now: &str) {
    let status = if item.attempt_count < MAX_ATTEMPTS {
        "queued"
    } else {
        "failed"
    };
    let _ = database.execute("UPDATE local_ai_clean_job_items SET status=?3,error=?4,updated_at=?5 WHERE job_id=?1 AND asset_id=?2 AND status='running'", params![item.job_id,item.asset_id,status,sanitize_error(error),now]);
}

/** 执行训练快照 AI 清洗并直接固化最终标签，原训练集和同名 TXT 始终保持不变。 */
fn execute_snapshot_item(
    database: &Connection,
    app: &AppHandle,
    stopping: &AtomicBool,
    item: SnapshotCleanExecutionItem,
) {
    crate::training::emit_job(database, app, &item.job_id);
    if stopping.load(Ordering::SeqCst) {
        requeue_snapshot_item(database, &item);
        return;
    }
    let original_values = item
        .original_tags
        .iter()
        .map(|tag| tag.value.clone())
        .collect::<Vec<_>>();
    let result = load_ai_settings(database).and_then(|settings| {
        ai_assist::clean_training_tags(
            &settings,
            &item.image_path,
            &item.dataset_type,
            &item.trigger_words,
            &item.training_goal,
            &original_values,
        )
    });
    if stopping.load(Ordering::SeqCst) {
        requeue_snapshot_item(database, &item);
        return;
    }
    let now = Utc::now().to_rfc3339();
    let cancelled = training_cancel_requested(database, &item.job_id);
    if cancelled {
        let _ = database.execute("UPDATE local_training_job_assets SET ai_clean_status='cancelled',ai_clean_error='任务已取消' WHERE job_id=?1 AND sequence=?2 AND ai_clean_status='running'", params![item.job_id,item.sequence]);
    } else if let Ok(proposal) = result {
        match apply_snapshot_proposal(&item.original_tags, &item.trigger_words, &proposal) {
            Ok((caption, tags_json, proposal_json)) => {
                let _ = database.execute("UPDATE local_training_job_assets SET caption=?3,tags_json=?4,ai_clean_status='succeeded',ai_clean_proposal_json=?5,ai_clean_error=NULL WHERE job_id=?1 AND sequence=?2 AND ai_clean_status='running'", params![item.job_id,item.sequence,caption,tags_json,proposal_json]);
            }
            Err(error) => finish_snapshot_item_error(database, &item, &error),
        }
    } else if let Err(error) = result {
        finish_snapshot_item_error(database, &item, &error);
    }
    let _ = refresh_snapshot_job(database, &item.job_id, &now);
    crate::training::emit_job(database, app, &item.job_id);
}

/** 将 AI 最终标签映射回逐标签来源；触发词强制保留，新增项标记为 AI_CLEANED。 */
fn apply_snapshot_proposal(
    original: &[TrainingTag],
    trigger_words: &[String],
    proposal: &DesktopAiCleanProposal,
) -> Result<(String, String, String), String> {
    let tags = reconcile_proposal_tags(original, trigger_words, proposal)?;
    let caption = training_tags::caption_from_tags(&tags)
        .ok_or_else(|| "AI 清洗后的训练快照标签不能为空".to_string())?;
    let tags_json =
        serde_json::to_string(&tags).map_err(|error| format!("序列化训练快照标签失败：{error}"))?;
    let proposal_json = serde_json::to_string(proposal)
        .map_err(|error| format!("序列化训练快照 AI 建议失败：{error}"))?;
    Ok((caption, tags_json, proposal_json))
}

/** 按 AI 最终标签重建逐标签来源，触发词无论上游是否返回都必须保留。 */
fn reconcile_proposal_tags(
    original: &[TrainingTag],
    trigger_words: &[String],
    proposal: &DesktopAiCleanProposal,
) -> Result<Vec<TrainingTag>, String> {
    let final_keys = proposal
        .final_tags
        .iter()
        .map(|tag| training_tags::normalize_tag(tag))
        .collect::<HashSet<_>>();
    let original_keys = original
        .iter()
        .map(|tag| tag.normalized_value.clone())
        .collect::<HashSet<_>>();
    let remove = original
        .iter()
        .filter(|tag| tag.source != "trigger" && !final_keys.contains(&tag.normalized_value))
        .map(|tag| tag.value.clone())
        .collect::<Vec<_>>();
    let add = proposal
        .final_tags
        .iter()
        .filter(|tag| !original_keys.contains(&training_tags::normalize_tag(tag)))
        .cloned()
        .collect::<Vec<_>>();
    training_tags::reconcile_ai_clean_tags(original, &remove, &add, trigger_words)
}

fn finish_snapshot_item_error(
    database: &Connection,
    item: &SnapshotCleanExecutionItem,
    error: &str,
) {
    let status = if item.attempt_count < MAX_ATTEMPTS {
        "queued"
    } else {
        "failed"
    };
    let _ = database.execute("UPDATE local_training_job_assets SET ai_clean_status=?3,ai_clean_error=?4 WHERE job_id=?1 AND sequence=?2 AND ai_clean_status='running'", params![item.job_id,item.sequence,status,sanitize_error(error)]);
}

/** 汇总任务快照处理进度；最终失败会终结训练任务，避免永久占用队列。 */
fn refresh_snapshot_job(database: &Connection, id: &str, now: &str) -> Result<(), String> {
    let (total, queued, running, succeeded, failed, cancelled): (u32,u32,u32,u32,u32,u32) = database.query_row("SELECT COUNT(*),SUM(ai_clean_status='queued'),SUM(ai_clean_status='running'),SUM(ai_clean_status='succeeded'),SUM(ai_clean_status='failed'),SUM(ai_clean_status='cancelled') FROM local_training_job_assets WHERE job_id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).map_err(|error| format!("统计训练快照 AI 标签进度失败：{error}"))?;
    let processed = succeeded + failed + cancelled;
    let progress = if total == 0 {
        100
    } else {
        processed * 100 / total
    };
    let terminal = queued == 0 && running == 0;
    let status = if !terminal {
        if running > 0 {
            "running"
        } else {
            "queued"
        }
    } else if failed > 0 || cancelled > 0 {
        "failed"
    } else {
        "succeeded"
    };
    let error = if terminal && failed > 0 {
        Some("部分训练快照图片的 AI 标签处理失败")
    } else if terminal && cancelled > 0 {
        Some("训练任务已取消")
    } else {
        None
    };
    database.execute("UPDATE local_training_jobs SET preprocessing_status=?2,preprocessing_progress=?3,preprocessing_error=?4,status=CASE WHEN ?5 AND ?6>0 AND status='queued' THEN 'failed' ELSE status END,progress=CASE WHEN ?5 AND ?6>0 AND status='queued' THEN 100 ELSE progress END,error=CASE WHEN ?5 AND ?6>0 AND status='queued' THEN ?4 ELSE error END,completed_at=CASE WHEN ?5 AND ?6>0 AND status='queued' THEN ?7 ELSE completed_at END,updated_at=?7 WHERE id=?1", params![id,status,progress,error,terminal,failed,now]).map_err(|failure| format!("更新训练快照 AI 标签阶段失败：{failure}"))?;
    Ok(())
}

fn training_cancel_requested(database: &Connection, id: &str) -> bool {
    database
        .query_row(
            "SELECT cancel_requested FROM local_training_jobs WHERE id=?1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .unwrap_or(true)
}

fn requeue_snapshot_item(database: &Connection, item: &SnapshotCleanExecutionItem) {
    let _ = database.execute("UPDATE local_training_job_assets SET ai_clean_status='queued' WHERE job_id=?1 AND sequence=?2 AND ai_clean_status='running'", params![item.job_id,item.sequence]);
    let _ = database.execute("UPDATE local_training_jobs SET preprocessing_status='queued' WHERE id=?1 AND cancel_requested=0", [&item.job_id]);
}

fn refresh_job(database: &Connection, id: &str, now: &str) -> Result<(), String> {
    let (total, queued, running, succeeded, failed, cancelled): (u32,u32,u32,u32,u32,u32) = database.query_row("SELECT COUNT(*),SUM(status='queued'),SUM(status='running'),SUM(status='succeeded'),SUM(status='failed'),SUM(status='cancelled') FROM local_ai_clean_job_items WHERE job_id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).map_err(|error| format!("统计 AI 清洗进度失败：{error}"))?;
    let processed = succeeded + failed + cancelled;
    let progress = if total == 0 {
        100
    } else {
        processed * 100 / total
    };
    let (pause_requested, cancel_requested): (bool, bool) = database
        .query_row(
            "SELECT pause_requested,cancel_requested FROM local_ai_clean_jobs WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("读取 AI 清洗控制状态失败：{error}"))?;
    let terminal = queued == 0 && running == 0;
    let status = if pause_requested && !terminal {
        "paused"
    } else if !terminal {
        if running > 0 {
            "running"
        } else {
            "queued"
        }
    } else if cancel_requested || cancelled > 0 {
        "cancelled"
    } else if failed > 0 {
        "failed"
    } else {
        "succeeded"
    };
    let error = (terminal && failed > 0).then_some("部分图片 AI 清洗失败，请查看逐图错误");
    database.execute("UPDATE local_ai_clean_jobs SET status=?2,progress=?3,processed_assets=?4,succeeded_assets=?5,failed_assets=?6,error=?7,completed_at=CASE WHEN ?8 THEN ?9 ELSE NULL END,updated_at=?9 WHERE id=?1", params![id,status,progress,processed,succeeded,failed,error,terminal,now]).map_err(|failure| format!("更新 AI 清洗进度失败：{failure}"))?;
    Ok(())
}

fn read_job(database: &Connection, id: &str) -> Result<Option<DesktopAiCleanJobView>, String> {
    let row: Option<(String,String,String,u32,u32,u32,u32,u32,String,Option<String>,String,Option<String>,String)> = database.query_row("SELECT id,dataset_id,status,progress,total_assets,processed_assets,succeeded_assets,failed_assets,training_goal,error,created_at,completed_at,updated_at FROM local_ai_clean_jobs WHERE id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?,row.get(10)?,row.get(11)?,row.get(12)?))).optional().map_err(|error| format!("读取 AI 清洗任务失败：{error}"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut statement = database.prepare("SELECT asset_id,status,attempt_count,proposal_json,apply_status,error,updated_at FROM local_ai_clean_job_items WHERE job_id=?1 ORDER BY rowid ASC").map_err(|error| format!("读取逐图 AI 清洗失败：{error}"))?;
    let items = statement
        .query_map([id], |item| {
            Ok((
                item.get::<_, String>(0)?,
                item.get::<_, String>(1)?,
                item.get::<_, u32>(2)?,
                item.get::<_, Option<String>>(3)?,
                item.get::<_, String>(4)?,
                item.get::<_, Option<String>>(5)?,
                item.get::<_, String>(6)?,
            ))
        })
        .map_err(|error| format!("查询逐图 AI 清洗失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析逐图 AI 清洗失败：{error}"))?
        .into_iter()
        .map(|item| {
            Ok(DesktopAiCleanJobItemView {
                asset_id: item.0,
                status: item.1,
                attempt_count: item.2,
                proposal: item
                    .3
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()
                    .map_err(|error| format!("解析 AI 清洗建议失败：{error}"))?,
                apply_status: item.4,
                error: item.5,
                updated_at: item.6,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Some(DesktopAiCleanJobView {
        id: row.0,
        dataset_id: row.1,
        status: row.2,
        progress: row.3,
        total_assets: row.4,
        processed_assets: row.5,
        succeeded_assets: row.6,
        failed_assets: row.7,
        training_goal: row.8,
        items,
        error: row.9,
        created_at: row.10,
        completed_at: row.11,
        updated_at: row.12,
    }))
}

fn load_ai_settings(database: &Connection) -> Result<DesktopAiSettings, String> {
    let configured = ai_assist::api_key_configured()?;
    database
        .query_row(
            "SELECT enabled,endpoint_type,base_url,model FROM desktop_ai_settings WHERE id=1",
            [],
            |row| {
                Ok(DesktopAiSettings {
                    enabled: row.get::<_, i64>(0)? != 0,
                    endpoint_type: row.get(1)?,
                    base_url: row.get(2)?,
                    model: row.get(3)?,
                    api_key_configured: configured,
                })
            },
        )
        .map_err(|error| format!("读取 AI 清洗设置失败：{error}"))
}

fn save_applied_tags(
    database: &Connection,
    app_data_dir: &Path,
    dataset_id: &str,
    asset_id: &str,
    relative_path: &str,
    tags: &[TrainingTag],
    item_update: Option<(&str, &str, Option<&str>)>,
) -> Result<(), String> {
    let caption = training_tags::caption_from_tags(tags)
        .ok_or_else(|| "AI 清洗后的标签不能为空".to_string())?;
    let caption_source = training_tags::aggregate_source(tags);
    let dataset_root = app_data_dir.join("datasets").join(dataset_id);
    let image_path = app_data_dir.join(relative_path);
    if !image_path.starts_with(&dataset_root) {
        return Err("训练图片存储路径不受控".into());
    }
    let file_swap = stage_caption_file(&dataset_root, &image_path, Some(&caption))?;
    let now = Utc::now().to_rfc3339();
    let outcome = (|| {
        let transaction = database
            .unchecked_transaction()
            .map_err(|error| format!("开启 AI 清洗应用事务失败：{error}"))?;
        let operation = if item_update.is_some_and(|(_, status, _)| status == "undone") {
            "ai_clean_undo"
        } else {
            "ai_clean_apply"
        };
        let change_reason = if item_update.is_some_and(|(_, _, proposal)| proposal.is_some()) {
            "AI 按用户选择的清洗预设直接更新"
        } else {
            "用户确认 AI 标签清洗"
        };
        let change_id = training_tags::replace_tags(
            &transaction,
            asset_id,
            tags,
            operation,
            Some(change_reason),
            &now,
        )?;
        if transaction.execute("UPDATE local_training_assets SET caption=?3,caption_source=?4,confirmed=0,updated_at=?5 WHERE id=?1 AND dataset_id=?2", params![asset_id,dataset_id,caption,caption_source,now]).map_err(|error| format!("保存 AI 清洗标签失败：{error}"))? != 1 { return Err("训练图片不存在".into()); }
        if let Some((job_id, apply_status, proposal_json)) = item_update {
            let changed = if let Some(proposal_json) = proposal_json {
                transaction.execute("UPDATE local_ai_clean_job_items SET status='succeeded',proposal_json=?5,apply_status=?3,applied_change_id=?4,error=NULL,updated_at=?6 WHERE job_id=?1 AND asset_id=?2 AND status='running'", params![job_id,asset_id,apply_status,change_id,proposal_json,now])
            } else {
                transaction.execute("UPDATE local_ai_clean_job_items SET apply_status=?3,applied_change_id=CASE WHEN ?3='applied' THEN ?4 ELSE NULL END,updated_at=?5 WHERE job_id=?1 AND asset_id=?2", params![job_id,asset_id,apply_status,change_id,now])
            }.map_err(|error| format!("保存 AI 清洗应用状态失败：{error}"))?;
            if changed != 1 {
                return Err("AI 清洗任务状态已经变化，请重新执行".into());
            }
        }
        transaction
            .execute(
                "UPDATE local_training_assets SET confirmed=0 WHERE dataset_id=?1",
                [dataset_id],
            )
            .map_err(|error| format!("重置训练集确认状态失败：{error}"))?;
        training_dataset::update_dataset_review_status(&transaction, dataset_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("提交 AI 清洗标签失败：{error}"))
    })();
    if let Err(error) = outcome {
        rollback_caption_file(file_swap);
        return Err(error);
    }
    finalize_caption_file(file_swap);
    Ok(())
}

fn ensure_original_unchanged(current: &[TrainingTag], original: &[String]) -> Result<(), String> {
    let current_keys = current
        .iter()
        .map(|tag| tag.normalized_value.clone())
        .collect::<Vec<_>>();
    let original_keys = original
        .iter()
        .map(|tag| training_tags::normalize_tag(tag))
        .collect::<Vec<_>>();
    if current_keys != original_keys {
        return Err("AI 清洗分析后标签已经变化，请重新分析".into());
    }
    Ok(())
}

fn validate_accepted_suggestions(
    proposal: &DesktopAiCleanProposal,
    remove: &[String],
    add: &[String],
) -> Result<(), String> {
    let allowed_remove = proposal
        .remove
        .iter()
        .chain(proposal.keep.iter())
        .map(|item| training_tags::normalize_tag(&item.tag))
        .collect::<HashSet<_>>();
    let allowed_add = proposal
        .add
        .iter()
        .map(|item| training_tags::normalize_tag(&item.tag))
        .collect::<HashSet<_>>();
    if remove
        .iter()
        .any(|tag| !allowed_remove.contains(&training_tags::normalize_tag(tag)))
        || add
            .iter()
            .any(|tag| !allowed_add.contains(&training_tags::normalize_tag(tag)))
    {
        return Err("提交内容包含不属于当前 AI 建议的标签".into());
    }
    Ok(())
}

fn control_state(database: &Connection, id: &str) -> Option<String> {
    database
        .query_row(
            "SELECT CASE WHEN cancel_requested=1 THEN 'cancelled' WHEN pause_requested=1 THEN 'paused' ELSE status END FROM local_ai_clean_jobs WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .ok()
}
fn requeue_running(database: &Connection, item: &CleanExecutionItem) {
    let now = Utc::now().to_rfc3339();
    let _=database.execute("UPDATE local_ai_clean_job_items SET status='queued',updated_at=?3 WHERE job_id=?1 AND asset_id=?2 AND status='running'",params![item.job_id,item.asset_id,now]);
    let _=database.execute("UPDATE local_ai_clean_jobs SET status=CASE WHEN pause_requested=1 THEN 'paused' ELSE 'queued' END,updated_at=?2 WHERE id=?1 AND status='running'",params![item.job_id,now]);
}
fn emit_job(database: &Connection, app: &AppHandle, id: &str) {
    if let Ok(Some(job)) = read_job(database, id) {
        let _ = app.emit("desktop-ai-clean-job-updated", job);
    }
}
fn wait_for_work(signal: &(Mutex<bool>, Condvar), stopping: &AtomicBool) {
    let (lock, condition) = signal;
    if let Ok(pending) = lock.lock() {
        let _ = condition
            .wait_timeout_while(pending, Duration::from_secs(2), |value| {
                !*value && !stopping.load(Ordering::SeqCst)
            })
            .map(|(mut value, _)| *value = false);
    }
}
fn sanitize_error(error: &str) -> String {
    error
        .replace('\r', " ")
        .replace('\n', " ")
        .chars()
        .take(1000)
        .collect()
}
fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{label} 不正确"))
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
    };
    use image::{Rgb, RgbImage};
    use std::fs;

    #[test]
    fn direct_ai_clean_syncs_caption_preserves_trigger_and_can_be_undone() {
        let temporary = tempfile::tempdir().expect("创建 AI 清洗临时目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "AI 清洗测试".into(),
                r#type: "character".into(),
                trigger_words: vec!["clean_token".into()],
            })
            .expect("创建训练集");
        let source = temporary.path().join("clean-source.png");
        RgbImage::from_pixel(32, 32, Rgb([40, 80, 120]))
            .save(&source)
            .expect("写入训练图片");
        let imported = {
            let mut database = state.database.lock().expect("锁定训练数据库");
            training_dataset::add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths: vec![source.to_string_lossy().into_owned()],
                },
            )
            .expect("导入训练图片")
        };
        let asset_id = imported.assets[0].id.clone();
        let updated = state
            .update_training_caption(DesktopTrainingCaptionUpdateInput {
                dataset_id: dataset.id.clone(),
                asset_id: asset_id.clone(),
                caption: Some("blue hair, solo".into()),
            })
            .expect("保存原标签");
        let asset = updated
            .assets
            .iter()
            .find(|item| item.id == asset_id)
            .expect("读取训练图片");
        let proposal = DesktopAiCleanProposal {
            original_tags: vec!["clean_token".into(), "blue hair".into(), "solo".into()],
            keep: vec![
                crate::models::DesktopAiCleanTagSuggestion {
                    tag: "clean_token".into(),
                    reason: "训练触发词".into(),
                },
                crate::models::DesktopAiCleanTagSuggestion {
                    tag: "solo".into(),
                    reason: "主体数量".into(),
                },
            ],
            remove: vec![crate::models::DesktopAiCleanTagSuggestion {
                tag: "blue hair".into(),
                reason: "绑定身份".into(),
            }],
            add: vec![crate::models::DesktopAiCleanTagSuggestion {
                tag: "indoors".into(),
                reason: "背景可控".into(),
            }],
            final_tags: vec!["clean_token".into(), "solo".into(), "indoors".into()],
        };
        let job_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        {
            let database = state.database.lock().expect("锁定 AI 清洗数据库");
            database.execute("INSERT INTO local_ai_clean_jobs (id,dataset_id,status,progress,total_assets,training_goal,created_at,updated_at) VALUES (?1,?2,'running',0,1,'固定身份',?3,?3)", params![job_id,dataset.id,now]).expect("登记 AI 清洗任务");
            database.execute("INSERT INTO local_ai_clean_job_items (job_id,asset_id,status,attempt_count,original_tags_json,apply_status,updated_at) VALUES (?1,?2,'running',1,?3,'pending',?4)", params![job_id,asset_id,serde_json::to_string(&proposal.original_tags).expect("序列化原标签"),now]).expect("登记运行中的 AI 清洗图片");
            apply_direct_proposal(
                &database,
                &state.app_data_dir,
                &CleanExecutionItem {
                    job_id: job_id.clone(),
                    dataset_id: dataset.id.clone(),
                    asset_id: asset_id.clone(),
                    image_path: PathBuf::from(&asset.path),
                    dataset_type: "character".into(),
                    trigger_words: vec!["clean_token".into()],
                    training_goal: "固定身份".into(),
                    original_tags: proposal.original_tags.clone(),
                    attempt_count: 1,
                },
                &proposal,
            )
            .expect("直接应用 AI 清洗");
            let applied = training_dataset::read_dataset_with_assets(
                &database,
                &state.app_data_dir,
                &dataset.id,
            )
            .expect("读取直接清洗结果");
            let applied_asset = applied
                .assets
                .iter()
                .find(|item| item.id == asset_id)
                .expect("读取应用结果");
            assert_eq!(
                applied_asset.caption.as_deref(),
                Some("clean_token, solo, indoors")
            );
            assert!(applied_asset
                .tags
                .iter()
                .any(|tag| tag.value == "indoors" && tag.source == "ai_cleaned"));
            let item_state: (String, String) = database.query_row("SELECT status,apply_status FROM local_ai_clean_job_items WHERE job_id=?1 AND asset_id=?2", params![job_id,asset_id], |row| Ok((row.get(0)?,row.get(1)?))).expect("读取直接清洗状态");
            assert_eq!(item_state, ("succeeded".into(), "applied".into()));
            assert_eq!(
                fs::read_to_string(Path::new(&asset.path).with_extension("txt"))
                    .expect("读取同步 Caption"),
                "clean_token, solo, indoors"
            );
            let undone = undo_proposal(
                &database,
                &state.app_data_dir,
                DesktopAiCleanUndoInput {
                    job_id: job_id.clone(),
                    dataset_id: dataset.id.clone(),
                    asset_id: asset_id.clone(),
                },
            )
            .expect("撤销 AI 清洗");
            assert_eq!(
                undone
                    .assets
                    .iter()
                    .find(|item| item.id == asset_id)
                    .and_then(|item| item.caption.as_deref()),
                Some("clean_token, blue hair, solo")
            );
            assert_eq!(
                fs::read_to_string(Path::new(&asset.path).with_extension("txt"))
                    .expect("读取撤销 Caption"),
                "clean_token, blue hair, solo"
            );
        }
    }

    /** 训练快照清洗强制保留触发词，并只把 AI 新增项标记为 AI_CLEANED。 */
    #[test]
    fn snapshot_cleaning_preserves_trigger_and_marks_added_source() {
        let trigger_words = vec!["snapshot_token".to_string()];
        let original =
            training_tags::initial_tags(Some("blue hair, solo"), "manual", &trigger_words)
                .expect("创建训练快照原标签");
        let proposal = DesktopAiCleanProposal {
            original_tags: vec!["snapshot_token".into(), "blue hair".into(), "solo".into()],
            keep: vec![crate::models::DesktopAiCleanTagSuggestion {
                tag: "solo".into(),
                reason: "保留主体数量控制".into(),
            }],
            remove: vec![crate::models::DesktopAiCleanTagSuggestion {
                tag: "blue hair".into(),
                reason: "绑定角色身份".into(),
            }],
            add: vec![crate::models::DesktopAiCleanTagSuggestion {
                tag: "indoors".into(),
                reason: "补充可控背景".into(),
            }],
            // 故意省略触发词，验证本地安全边界仍会强制保留它。
            final_tags: vec!["solo".into(), "indoors".into()],
        };
        let (caption, tags_json, _) =
            apply_snapshot_proposal(&original, &trigger_words, &proposal).expect("应用快照建议");
        let tags: Vec<TrainingTag> = serde_json::from_str(&tags_json).expect("解析快照标签");
        assert_eq!(caption, "snapshot_token, solo, indoors");
        assert!(tags
            .iter()
            .any(|tag| tag.value == "snapshot_token" && tag.source == "trigger"));
        assert!(tags
            .iter()
            .any(|tag| tag.value == "indoors" && tag.source == "ai_cleaned"));
        assert!(!tags.iter().any(|tag| tag.value == "blue hair"));
    }

    /** AI 清洗暂停后不再领取图片，恢复与取消均保持同一持久任务。 */
    #[test]
    fn queued_ai_clean_job_supports_pause_resume_and_cancel() {
        let temporary = tempfile::tempdir().expect("创建 AI 清洗控制目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "AI 清洗控制".into(),
                r#type: "character".into(),
                trigger_words: vec!["clean_control".into()],
            })
            .expect("创建训练集");
        let source = temporary.path().join("ai-clean-control.png");
        RgbImage::from_pixel(32, 32, Rgb([32, 64, 96]))
            .save(&source)
            .expect("写入 AI 清洗控制图片");
        let imported = {
            let mut database = state.database.lock().expect("锁定训练数据库");
            training_dataset::add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths: vec![source.to_string_lossy().into_owned()],
                },
            )
            .expect("导入 AI 清洗控制图片")
        };
        state
            .update_training_caption(DesktopTrainingCaptionUpdateInput {
                dataset_id: dataset.id.clone(),
                asset_id: imported.assets[0].id.clone(),
                caption: Some("solo, standing".into()),
            })
            .expect("保存 AI 清洗原标签");
        let mut database = state.database.lock().expect("锁定 AI 清洗任务数据库");
        let job = create_job(
            &mut database,
            DesktopAiCleanJobCreateInput {
                dataset_id: dataset.id,
                asset_ids: vec![imported.assets[0].id.clone()],
                training_goal: "保留动作变量".into(),
            },
        )
        .expect("创建 AI 清洗控制任务");
        assert_eq!(
            pause_job(&database, &job.id).expect("暂停 AI 清洗").status,
            "paused"
        );
        assert!(claim_next_item(&database, &state.app_data_dir)
            .expect("检查暂停队列")
            .is_none());
        assert_eq!(
            resume_job(&database, &job.id).expect("恢复 AI 清洗").status,
            "queued"
        );
        let cancelled = cancel_job(&database, &job.id).expect("取消 AI 清洗");
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.items[0].status, "cancelled");
    }
}
