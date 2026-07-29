//! 本模块管理桌面 LoRA 训练任务快照、队列状态和训练产物登记，SQLite 始终是任务事实源。

use crate::models::{
    DesktopTrainingAttemptView, DesktopTrainingJobCreateInput, DesktopTrainingJobView,
    DesktopTrainingParameters, DesktopTrainingSuggestionView,
};
use crate::storage::LocalLoraRegistration;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::{fs, path::Path};
use uuid::Uuid;

/** 调度器领取后使用的不可变训练任务快照。 */
#[derive(Clone)]
pub(crate) struct TrainingExecution {
    pub id: String,
    pub attempt_id: String,
    pub title: String,
    pub r#type: String,
    pub model_relative_path: String,
    pub model_sha256: String,
    pub model_byte_size: u64,
    pub model_modified_ms: u64,
    pub text_encoder_relative_path: String,
    pub text_encoder_sha256: String,
    pub vae_relative_path: String,
    pub vae_sha256: String,
    pub parameters: DesktopTrainingParameters,
    pub trigger_words: Vec<String>,
    pub assets: Vec<TrainingAssetExecution>,
}

/** 单张训练图片的任务级不可变快照。 */
#[derive(Clone)]
pub(crate) struct TrainingAssetExecution {
    pub relative_path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub caption: String,
}

/** 在短事务内固化已确认训练集、Anima 模型和全部训练参数。 */
pub fn create_job(
    database: &mut Connection,
    app_data_dir: &Path,
    model_root: &Path,
    input: DesktopTrainingJobCreateInput,
) -> Result<DesktopTrainingJobView, String> {
    validate_create_input(&input)?;
    let transaction = database
        .transaction()
        .map_err(|error| format!("开启训练任务事务失败：{error}"))?;
    let dataset = read_dataset_snapshot(&transaction, &input.dataset_id)?;
    if dataset.status != "confirmed" {
        return Err("训练集尚未完成逐图确认".into());
    }
    let model = read_model_snapshot(&transaction, &input.model_id)?;
    if model.workflow_kind != "anima" {
        return Err("首版本地训练只接受 Anima 底模".into());
    }
    validate_model_files(model_root, &model)?;
    let assets = read_asset_snapshots(&transaction, app_data_dir, &input.dataset_id)?;
    if !(5..=200).contains(&assets.len()) {
        return Err("训练集图片数量必须是 5–200 张".into());
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let parameters_json = serde_json::to_string(&input.parameters)
        .map_err(|error| format!("序列化训练参数失败：{error}"))?;
    transaction.execute(
        "INSERT INTO local_training_jobs (id,dataset_id,dataset_title,title,type,status,progress,current_epoch,total_epochs,model_id,model_display_name,workflow_kind,model_file_name,model_relative_path,model_sha256,model_byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,text_encoder_sha256,vae_file_name,vae_relative_path,vae_sha256,parameters_json,trigger_words_json,asset_count,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'queued',0,0,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?24)",
        params![
            id,
            input.dataset_id,
            dataset.title,
            input.title.trim(),
            dataset.r#type,
            input.parameters.epochs,
            input.model_id,
            model.display_name,
            model.workflow_kind,
            model.model_file_name,
            model.model_relative_path,
            model.model_sha256,
            model.model_byte_size,
            model.model_modified_ms,
            model.text_encoder_file_name,
            model.text_encoder_relative_path,
            model.text_encoder_sha256,
            model.vae_file_name,
            model.vae_relative_path,
            model.vae_sha256,
            parameters_json,
            dataset.trigger_words_json,
            assets.len() as u32,
            now,
        ],
    ).map_err(|error| format!("创建训练任务失败：{error}"))?;
    for (sequence, asset) in assets.iter().enumerate() {
        transaction.execute(
            "INSERT INTO local_training_job_assets (job_id,sequence,asset_id,relative_path,sha256,byte_size,caption) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![id, sequence as u32, asset.id, asset.relative_path, asset.sha256, asset.byte_size, asset.caption],
        ).map_err(|error| format!("固化训练图片快照失败：{error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("提交训练任务失败：{error}"))?;
    read_job(database, &id)?.ok_or_else(|| "训练任务创建后不存在".into())
}

/** 返回最近 100 个本地训练任务和全部执行尝试。 */
pub fn list_jobs(database: &Connection) -> Result<Vec<DesktopTrainingJobView>, String> {
    let mut statement = database
        .prepare("SELECT id FROM local_training_jobs ORDER BY created_at DESC LIMIT 100")
        .map_err(|error| format!("读取训练任务列表失败：{error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询训练任务列表失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析训练任务列表失败：{error}"))?;
    ids.into_iter()
        .map(|id| read_job(database, &id)?.ok_or_else(|| "训练任务读取期间消失".into()))
        .collect()
}

/** 幂等取消排队或运行中的训练，已经登记成功的 LoRA 保持不变。 */
pub fn cancel_job(database: &Connection, id: &str) -> Result<DesktopTrainingJobView, String> {
    validate_uuid(id, "训练任务 ID")?;
    let status: Option<String> = database
        .query_row("SELECT status FROM local_training_jobs WHERE id=?1", [id], |row| row.get(0))
        .optional()
        .map_err(|error| format!("读取训练任务失败：{error}"))?;
    let Some(status) = status else { return Err("训练任务不存在".into()); };
    let now = Utc::now().to_rfc3339();
    if status == "queued" {
        database.execute("UPDATE local_training_jobs SET status='cancelled',progress=100,cancel_requested=1,completed_at=?2,updated_at=?2 WHERE id=?1 AND status='queued'", params![id,now]).map_err(|error| format!("取消排队训练任务失败：{error}"))?;
    } else if status == "running" {
        database.execute("UPDATE local_training_jobs SET cancel_requested=1,updated_at=?2 WHERE id=?1 AND status='running'", params![id,now]).map_err(|error| format!("请求取消运行中训练失败：{error}"))?;
    }
    read_job(database, id)?.ok_or_else(|| "训练任务不存在".into())
}

/** 原子领取最早的排队训练任务并创建一次可审计执行尝试。 */
pub(crate) fn claim_next_job(database: &mut Connection) -> Result<Option<TrainingExecution>, String> {
    let transaction = database.transaction().map_err(|error| format!("开启训练调度事务失败：{error}"))?;
    let id: Option<String> = transaction.query_row("SELECT id FROM local_training_jobs WHERE status='queued' AND cancel_requested=0 ORDER BY created_at ASC LIMIT 1", [], |row| row.get(0)).optional().map_err(|error| format!("读取训练队列失败：{error}"))?;
    let Some(id) = id else { transaction.commit().map_err(|error| format!("提交空闲训练事务失败：{error}"))?; return Ok(None); };
    let now = Utc::now().to_rfc3339();
    if transaction.execute("UPDATE local_training_jobs SET status='running',progress=1,current_epoch=0,started_at=?2,completed_at=NULL,error=NULL,suggestion_json=NULL,updated_at=?2 WHERE id=?1 AND status='queued' AND cancel_requested=0", params![id,now]).map_err(|error| format!("领取训练任务失败：{error}"))? != 1 {
        transaction.rollback().map_err(|error| format!("回滚训练任务领取失败：{error}"))?;
        return Ok(None);
    }
    let attempt_number: u32 = transaction.query_row("SELECT COALESCE(MAX(attempt_number),0)+1 FROM local_training_job_attempts WHERE job_id=?1", [&id], |row| row.get(0)).map_err(|error| format!("计算训练尝试次数失败：{error}"))?;
    let attempt_id = Uuid::new_v4().to_string();
    transaction.execute("INSERT INTO local_training_job_attempts (id,job_id,attempt_number,status,started_at) VALUES (?1,?2,?3,'running',?4)", params![attempt_id,id,attempt_number,now]).map_err(|error| format!("创建训练尝试失败：{error}"))?;
    let execution = read_execution(&transaction, &id, &attempt_id)?;
    transaction.commit().map_err(|error| format!("提交训练任务领取失败：{error}"))?;
    Ok(Some(execution))
}

/** 持久化训练进度，旧事件不能让任务进度或 Epoch 倒退。 */
pub(crate) fn update_progress(database: &Connection, id: &str, progress: u32, current_epoch: u32) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    database.execute("UPDATE local_training_jobs SET progress=MAX(progress,?2),current_epoch=MAX(current_epoch,?3),updated_at=?4 WHERE id=?1 AND status='running'", params![id,progress.min(99),current_epoch,now]).map_err(|error| format!("更新训练进度失败：{error}"))?;
    Ok(())
}

/** 原子登记训练产物 LoRA，并把尝试和任务一起收敛为成功。 */
pub(crate) fn finish_success(database: &Connection, job: &TrainingExecution, lora: LocalLoraRegistration) -> Result<DesktopTrainingJobView, String> {
    let now = Utc::now().to_rfc3339();
    let transaction = database.unchecked_transaction().map_err(|error| format!("开启训练成功事务失败：{error}"))?;
    let existing: Option<String> = transaction.query_row("SELECT id FROM local_loras WHERE sha256=?1", [&lora.sha256], |row| row.get(0)).optional().map_err(|error| format!("检查训练 LoRA 去重失败：{error}"))?;
    let lora_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
    let trigger_words_json = serde_json::to_string(&lora.trigger_words).map_err(|error| format!("序列化训练 LoRA 触发词失败：{error}"))?;
    transaction.execute("INSERT INTO local_loras (id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10) ON CONFLICT(sha256) DO UPDATE SET title=excluded.title,type=excluded.type,file_name=excluded.file_name,relative_path=excluded.relative_path,byte_size=excluded.byte_size,modified_ms=excluded.modified_ms,trigger_words_json=excluded.trigger_words_json,updated_at=excluded.updated_at", params![lora_id,lora.title,lora.r#type,lora.file_name,lora.relative_path,lora.sha256,lora.byte_size,lora.modified_ms,trigger_words_json,now]).map_err(|error| format!("登记训练 LoRA 失败：{error}"))?;
    transaction.execute("UPDATE local_training_job_attempts SET status='succeeded',error=NULL,completed_at=?2 WHERE id=?1 AND status='running'", params![job.attempt_id,now]).and_then(|_| transaction.execute("UPDATE local_training_jobs SET status='succeeded',progress=100,current_epoch=total_epochs,output_lora_id=?2,error=NULL,suggestion_json=NULL,completed_at=?3,updated_at=?3 WHERE id=?1 AND status='running'", params![job.id,lora_id,now])).map_err(|error| format!("保存训练成功终态失败：{error}"))?;
    transaction.commit().map_err(|error| format!("提交训练成功终态失败：{error}"))?;
    read_job(database, &job.id)?.ok_or_else(|| "训练成功后任务不存在".into())
}

/** 保存训练失败和可操作降档建议，禁止同一任务无限自动重试。 */
pub(crate) fn finish_failed(database: &Connection, job: &TrainingExecution, error: &str, suggestion: Option<DesktopTrainingSuggestionView>) -> Result<DesktopTrainingJobView, String> {
    let now = Utc::now().to_rfc3339();
    let message = sanitize_error(error);
    let suggestion_json = suggestion.as_ref().map(serde_json::to_string).transpose().map_err(|failure| format!("序列化训练建议失败：{failure}"))?;
    let transaction = database.unchecked_transaction().map_err(|failure| format!("开启训练失败事务失败：{failure}"))?;
    transaction.execute("UPDATE local_training_job_attempts SET status='failed',error=?2,completed_at=?3 WHERE id=?1 AND status='running'", params![job.attempt_id,message,now]).and_then(|_| transaction.execute("UPDATE local_training_jobs SET status='failed',progress=100,error=?2,suggestion_json=?3,completed_at=?4,updated_at=?4 WHERE id=?1 AND status='running'", params![job.id,message,suggestion_json,now])).map_err(|failure| format!("保存训练失败终态失败：{failure}"))?;
    transaction.commit().map_err(|failure| format!("提交训练失败终态失败：{failure}"))?;
    read_job(database, &job.id)?.ok_or_else(|| "训练失败后任务不存在".into())
}

/** 应用正常退出时保留同一任务快照并创建下一次执行尝试。 */
pub(crate) fn requeue_interrupted(database: &Connection, job: &TrainingExecution) -> Result<DesktopTrainingJobView, String> {
    let now = Utc::now().to_rfc3339();
    let transaction = database.unchecked_transaction().map_err(|error| format!("开启训练恢复事务失败：{error}"))?;
    transaction.execute("UPDATE local_training_job_attempts SET status='interrupted',error='桌面程序退出，训练任务已恢复排队',completed_at=?2 WHERE id=?1 AND status='running'", params![job.attempt_id,now]).and_then(|_| transaction.execute("UPDATE local_training_jobs SET status='queued',progress=0,current_epoch=0,started_at=NULL,error=NULL,suggestion_json=NULL,updated_at=?2 WHERE id=?1 AND status='running' AND cancel_requested=0", params![job.id,now])).map_err(|error| format!("恢复训练任务失败：{error}"))?;
    transaction.commit().map_err(|error| format!("提交训练恢复失败：{error}"))?;
    read_job(database, &job.id)?.ok_or_else(|| "恢复后的训练任务不存在".into())
}

/** 运行中取消会保留已经完成的尝试日志，但不会登记不完整产物。 */
pub(crate) fn finish_cancelled(database: &Connection, job: &TrainingExecution) -> Result<DesktopTrainingJobView, String> {
    let now = Utc::now().to_rfc3339();
    let transaction = database.unchecked_transaction().map_err(|error| format!("开启训练取消事务失败：{error}"))?;
    transaction.execute("UPDATE local_training_job_attempts SET status='cancelled',completed_at=?2 WHERE id=?1 AND status='running'", params![job.attempt_id,now]).and_then(|_| transaction.execute("UPDATE local_training_jobs SET status='cancelled',progress=100,error=NULL,completed_at=?2,updated_at=?2 WHERE id=?1 AND status='running'", params![job.id,now])).map_err(|error| format!("保存训练取消终态失败：{error}"))?;
    transaction.commit().map_err(|error| format!("提交训练取消终态失败：{error}"))?;
    read_job(database, &job.id)?.ok_or_else(|| "取消后的训练任务不存在".into())
}

/** 读取任务取消标记；数据库异常时保守中止训练。 */
pub(crate) fn cancel_requested(database: &Connection, id: &str) -> bool {
    database.query_row("SELECT cancel_requested FROM local_training_jobs WHERE id=?1", [id], |row| row.get::<_, i64>(0)).map(|value| value != 0).unwrap_or(true)
}

/** 向 WebView 发送数据库已落盘的训练任务状态。 */
pub(crate) fn emit_job(database: &Connection, app: &tauri::AppHandle, id: &str) {
    use tauri::Emitter;
    if let Ok(Some(job)) = read_job(database, id) { let _ = app.emit("desktop-training-job-updated", job); }
}

fn read_execution(transaction: &Transaction<'_>, id: &str, attempt_id: &str) -> Result<TrainingExecution, String> {
    let execution = transaction.query_row("SELECT title,type,model_relative_path,model_sha256,model_byte_size,model_modified_ms,text_encoder_relative_path,text_encoder_sha256,vae_relative_path,vae_sha256,parameters_json,trigger_words_json FROM local_training_jobs WHERE id=?1", [id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?,row.get::<_, u64>(4)?,row.get::<_, u64>(5)?,row.get::<_, String>(6)?,row.get::<_, String>(7)?,row.get::<_, String>(8)?,row.get::<_, String>(9)?,row.get::<_, String>(10)?,row.get::<_, String>(11)?))).map_err(|error| format!("读取训练执行快照失败：{error}"))?;
    let parameters = serde_json::from_str(&execution.10).map_err(|error| format!("解析训练执行参数失败：{error}"))?;
    let trigger_words = serde_json::from_str(&execution.11).map_err(|error| format!("解析训练执行触发词失败：{error}"))?;
    let mut statement = transaction.prepare("SELECT relative_path,sha256,byte_size,caption FROM local_training_job_assets WHERE job_id=?1 ORDER BY sequence ASC").map_err(|error| format!("读取训练图片快照失败：{error}"))?;
    let assets = statement.query_map([id], |row| Ok(TrainingAssetExecution { relative_path: row.get(0)?, sha256: row.get(1)?, byte_size: row.get(2)?, caption: row.get(3)? })).map_err(|error| format!("查询训练图片快照失败：{error}"))?.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析训练图片快照失败：{error}"))?;
    Ok(TrainingExecution { id: id.into(), attempt_id: attempt_id.into(), title: execution.0, r#type: execution.1, model_relative_path: execution.2, model_sha256: execution.3, model_byte_size: execution.4, model_modified_ms: execution.5, text_encoder_relative_path: execution.6, text_encoder_sha256: execution.7, vae_relative_path: execution.8, vae_sha256: execution.9, parameters, trigger_words, assets })
}

fn sanitize_error(error: &str) -> String { error.lines().last().unwrap_or("本地训练失败").trim().chars().take(1000).collect() }

#[derive(Clone)]
struct DatasetSnapshot {
    title: String,
    r#type: String,
    trigger_words_json: String,
    status: String,
}

#[derive(Clone)]
struct ModelSnapshot {
    display_name: String,
    workflow_kind: String,
    model_file_name: String,
    model_relative_path: String,
    model_sha256: String,
    model_byte_size: u64,
    model_modified_ms: u64,
    text_encoder_file_name: String,
    text_encoder_relative_path: String,
    text_encoder_sha256: String,
    vae_file_name: String,
    vae_relative_path: String,
    vae_sha256: String,
}

#[derive(Clone)]
struct AssetSnapshot {
    id: String,
    relative_path: String,
    sha256: String,
    byte_size: u64,
    caption: String,
}

fn read_dataset_snapshot(transaction: &Transaction<'_>, id: &str) -> Result<DatasetSnapshot, String> {
    transaction.query_row(
        "SELECT title,type,trigger_words_json,status FROM local_training_datasets WHERE id=?1",
        [id],
        |row| Ok(DatasetSnapshot { title: row.get(0)?, r#type: row.get(1)?, trigger_words_json: row.get(2)?, status: row.get(3)? }),
    ).optional().map_err(|error| format!("读取训练集失败：{error}"))?.ok_or_else(|| "训练集不存在".into())
}

fn read_model_snapshot(transaction: &Transaction<'_>, id: &str) -> Result<ModelSnapshot, String> {
    transaction.query_row(
        "SELECT display_name,workflow_kind,model_file_name,model_relative_path,model_sha256,byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,text_encoder_sha256,vae_file_name,vae_relative_path,vae_sha256 FROM local_models WHERE id=?1",
        [id],
        |row| Ok(ModelSnapshot {
            display_name: row.get(0)?, workflow_kind: row.get(1)?, model_file_name: row.get(2)?, model_relative_path: row.get(3)?, model_sha256: row.get(4)?, model_byte_size: row.get(5)?, model_modified_ms: row.get(6)?,
            text_encoder_file_name: row.get::<_, Option<String>>(7)?.ok_or_else(|| rusqlite::Error::InvalidQuery)?,
            text_encoder_relative_path: row.get::<_, Option<String>>(8)?.ok_or_else(|| rusqlite::Error::InvalidQuery)?,
            text_encoder_sha256: row.get::<_, Option<String>>(9)?.ok_or_else(|| rusqlite::Error::InvalidQuery)?,
            vae_file_name: row.get::<_, Option<String>>(10)?.ok_or_else(|| rusqlite::Error::InvalidQuery)?,
            vae_relative_path: row.get::<_, Option<String>>(11)?.ok_or_else(|| rusqlite::Error::InvalidQuery)?,
            vae_sha256: row.get::<_, Option<String>>(12)?.ok_or_else(|| rusqlite::Error::InvalidQuery)?,
        }),
    ).optional().map_err(|error| format!("读取训练底模失败：{error}"))?.ok_or_else(|| "训练底模不存在或缺少 Anima 组件".into())
}

fn read_asset_snapshots(transaction: &Transaction<'_>, app_data_dir: &Path, dataset_id: &str) -> Result<Vec<AssetSnapshot>, String> {
    let mut statement = transaction.prepare("SELECT id,relative_path,sha256,byte_size,caption FROM local_training_assets WHERE dataset_id=?1 ORDER BY created_at ASC,id ASC").map_err(|error| format!("读取训练图片失败：{error}"))?;
    let rows = statement.query_map([dataset_id], |row| Ok(AssetSnapshot { id: row.get(0)?, relative_path: row.get(1)?, sha256: row.get(2)?, byte_size: row.get(3)?, caption: row.get::<_, Option<String>>(4)?.unwrap_or_default() })).map_err(|error| format!("查询训练图片失败：{error}"))?;
    let assets = rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析训练图片失败：{error}"))?;
    for asset in &assets {
        if asset.caption.trim().is_empty() { return Err("训练集仍有图片缺少 Caption".into()); }
        let metadata = app_data_dir.join(&asset.relative_path).metadata().map_err(|_| "训练图片文件缺失，请重新导入并确认".to_string())?;
        if !metadata.is_file() || metadata.len() != asset.byte_size { return Err("训练图片文件已经变化，请重新导入并确认".into()); }
    }
    Ok(assets)
}

fn validate_model_files(model_root: &Path, model: &ModelSnapshot) -> Result<(), String> {
    let main = model_root.join(&model.model_relative_path);
    let metadata = main.metadata().map_err(|_| "训练底模文件缺失".to_string())?;
    if !metadata.is_file() || metadata.len() != model.model_byte_size || modified_millis(&metadata)? != model.model_modified_ms { return Err("训练底模文件已经变化，请重新导入".into()); }
    for relative in [&model.text_encoder_relative_path, &model.vae_relative_path] {
        if !model_root.join(relative).is_file() { return Err("训练底模的文本编码器或 VAE 缺失".into()); }
    }
    Ok(())
}

fn read_job(database: &Connection, id: &str) -> Result<Option<DesktopTrainingJobView>, String> {
    let row = database.query_row(
        "SELECT id,dataset_id,dataset_title,title,type,status,progress,current_epoch,total_epochs,model_id,model_display_name,trigger_words_json,asset_count,parameters_json,output_lora_id,error,suggestion_json,created_at,started_at,completed_at,updated_at FROM local_training_jobs WHERE id=?1",
        [id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, u32>(6)?, row.get::<_, u32>(7)?, row.get::<_, u32>(8)?, row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?, row.get::<_, u32>(12)?, row.get::<_, String>(13)?, row.get::<_, Option<String>>(14)?, row.get::<_, Option<String>>(15)?, row.get::<_, Option<String>>(16)?, row.get::<_, String>(17)?, row.get::<_, Option<String>>(18)?, row.get::<_, Option<String>>(19)?, row.get::<_, String>(20)?,
        )),
    ).optional().map_err(|error| format!("读取训练任务失败：{error}"))?;
    let Some(row) = row else { return Ok(None); };
    let trigger_words = serde_json::from_str(&row.11).map_err(|error| format!("解析训练触发词失败：{error}"))?;
    let parameters = serde_json::from_str(&row.13).map_err(|error| format!("解析训练参数失败：{error}"))?;
    let suggestion = row.16.as_deref().map(serde_json::from_str).transpose().map_err(|error| format!("解析训练降档建议失败：{error}"))?;
    let queue_position = if row.5 == "queued" { database.query_row("SELECT COUNT(*) FROM local_training_jobs WHERE status='queued' AND created_at<=?1", [&row.17], |value| value.get(0)).unwrap_or(0) } else { 0 };
    Ok(Some(DesktopTrainingJobView {
        id: row.0.clone(), dataset_id: row.1, dataset_title: row.2, title: row.3, r#type: row.4, status: row.5, progress: row.6, queue_position, current_epoch: row.7, total_epochs: row.8, model_id: row.9, model_display_name: row.10, trigger_words, asset_count: row.12, parameters, attempts: read_attempts(database, &row.0)?, output_lora_id: row.14, error: row.15, suggestion, created_at: row.17, started_at: row.18, completed_at: row.19, updated_at: row.20,
    }))
}

fn read_attempts(database: &Connection, job_id: &str) -> Result<Vec<DesktopTrainingAttemptView>, String> {
    let mut statement = database.prepare("SELECT id,attempt_number,status,error,started_at,completed_at FROM local_training_job_attempts WHERE job_id=?1 ORDER BY attempt_number ASC LIMIT 10").map_err(|error| format!("读取训练尝试失败：{error}"))?;
    let rows = statement.query_map([job_id], |row| Ok(DesktopTrainingAttemptView { id: row.get(0)?, attempt_number: row.get(1)?, status: row.get(2)?, error: row.get(3)?, started_at: row.get(4)?, completed_at: row.get(5)? })).map_err(|error| format!("查询训练尝试失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析训练尝试失败：{error}"))
}

fn validate_create_input(input: &DesktopTrainingJobCreateInput) -> Result<(), String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.model_id, "底模 ID")?;
    if input.title.trim().is_empty() || input.title.trim().chars().count() > 191 { return Err("LoRA 标题长度必须是 1–191 个字符".into()); }
    let parameters = &input.parameters;
    if !(8..=64).contains(&parameters.rank) || !(1..=64).contains(&parameters.alpha) || parameters.alpha > parameters.rank { return Err("Rank 或 Alpha 不正确".into()); }
    if !(1..=20).contains(&parameters.epochs) || !(1..=50).contains(&parameters.repeats) || !(512..=1536).contains(&parameters.resolution) || parameters.resolution % 64 != 0 { return Err("训练轮次、重复次数或分辨率不正确".into()); }
    if !(0.000001..=0.01).contains(&parameters.learning_rate) || !(0.0..=0.2).contains(&parameters.warmup_ratio) || !(0.0..=0.3).contains(&parameters.caption_dropout_rate) { return Err("学习率、预热或 Caption Dropout 不正确".into()); }
    if !matches!(parameters.lr_scheduler.as_str(), "constant" | "cosine" | "cosine_with_restarts") || !(1..=4).contains(&parameters.gradient_accumulation_steps) || parameters.keep_tokens > 10 || parameters.seed > 2_147_483_647 { return Err("训练调度器或高级参数不正确".into()); }
    Ok(())
}

fn validate_uuid(value: &str, label: &str) -> Result<(), String> { Uuid::parse_str(value).map(|_| ()).map_err(|_| format!("{label} 不正确")) }
fn modified_millis(metadata: &fs::Metadata) -> Result<u64, String> { metadata.modified().map_err(|error| format!("读取模型修改时间失败：{error}"))?.duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_millis() as u64).map_err(|_| "模型修改时间早于系统纪元".to_string()) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{models::{DesktopTrainingCaptionUpdateInput, DesktopTrainingDatasetCreateInput, DesktopTrainingImagesAddInput}, storage::DesktopState, training_dataset};
    use image::{Rgb, RgbImage};
    use sha2::{Digest, Sha256};

    #[test]
    fn training_parameters_reject_alpha_larger_than_rank() {
        let input = DesktopTrainingJobCreateInput {
            dataset_id: Uuid::new_v4().to_string(), model_id: Uuid::new_v4().to_string(), title: "测试 LoRA".into(),
            parameters: crate::models::DesktopTrainingParameters { rank: 8, alpha: 16, epochs: 4, repeats: 4, resolution: 768, learning_rate: 0.0001, lr_scheduler: "constant".into(), warmup_ratio: 0.0, gradient_accumulation_steps: 1, caption_dropout_rate: 0.0, shuffle_caption: false, keep_tokens: 1, seed: 1 },
        };
        assert!(validate_create_input(&input).is_err());
    }

    #[test]
    fn confirmed_dataset_and_anima_snapshot_create_persistent_training_job() {
        let temporary = tempfile::tempdir().expect("创建训练任务临时目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state.create_training_dataset(DesktopTrainingDatasetCreateInput { title: "训练快照".into(), r#type: "character".into(), trigger_words: vec!["dh_token".into()] }).expect("创建训练集");
        let source_paths = (0..5).map(|index| { let path = temporary.path().join(format!("training-{index}.png")); RgbImage::from_pixel(32, 32, Rgb([index, 40, 80])).save(&path).expect("写入训练图片"); path.to_string_lossy().into_owned() }).collect::<Vec<_>>();
        let imported = { let mut database = state.database.lock().expect("锁定导入数据库"); training_dataset::add_images(&mut database, &state.app_data_dir, DesktopTrainingImagesAddInput { dataset_id: dataset.id.clone(), source_paths }).expect("导入训练图片") };
        for asset in &imported.assets { state.update_training_caption(DesktopTrainingCaptionUpdateInput { dataset_id: dataset.id.clone(), asset_id: asset.id.clone(), caption: Some("1girl, solo".into()) }).expect("保存训练 Caption"); }
        { let database = state.database.lock().expect("锁定确认数据库"); training_dataset::confirm_dataset(&database, &state.app_data_dir, &dataset.id).expect("确认训练集"); }
        let settings = state.load_settings().expect("读取模型目录");
        let model_root = Path::new(&settings.model_root);
        let files = [("diffusion_models", "anima.safetensors"), ("text_encoders", "qwen.safetensors"), ("vae", "vae.safetensors")];
        let mut snapshots = Vec::new();
        for (directory, file_name) in files {
            let path = model_root.join(directory).join(file_name); fs::create_dir_all(path.parent().expect("读取模型目录")).expect("创建模型目录"); fs::write(&path, format!("snapshot-{file_name}")).expect("写入模型快照");
            let hash = hex::encode(Sha256::digest(fs::read(&path).expect("读取模型快照"))); let metadata = path.metadata().expect("读取模型元数据"); snapshots.push((format!("{directory}/{file_name}"), hash, metadata.len(), modified_millis(&metadata).expect("读取修改时间")));
        }
        let model_id = Uuid::new_v4().to_string(); let now = Utc::now().to_rfc3339();
        { let mut database = state.database.lock().expect("锁定训练数据库"); database.execute("INSERT INTO local_models (id,display_name,family,workflow_kind,model_file_name,model_relative_path,model_sha256,byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,text_encoder_sha256,vae_file_name,vae_relative_path,vae_sha256,created_at,updated_at) VALUES (?1,'测试 Anima','anima','anima','anima.safetensors',?2,?3,?4,?5,'qwen.safetensors',?6,?7,'vae.safetensors',?8,?9,?10,?10)", params![model_id,snapshots[0].0,snapshots[0].1,snapshots[0].2,snapshots[0].3,snapshots[1].0,snapshots[1].1,snapshots[2].0,snapshots[2].1,now]).expect("登记 Anima 模型"); let job = create_job(&mut database, &state.app_data_dir, model_root, DesktopTrainingJobCreateInput { dataset_id: dataset.id.clone(), model_id: model_id.clone(), title: "本地角色 LoRA".into(), parameters: valid_parameters() }).expect("创建训练任务"); assert_eq!(job.status, "queued"); assert_eq!(job.asset_count, 5); assert_eq!(job.trigger_words, vec!["dh_token"]); assert_eq!(list_jobs(&database).expect("读取训练任务").len(), 1); }
    }

    fn valid_parameters() -> crate::models::DesktopTrainingParameters { crate::models::DesktopTrainingParameters { rank: 16, alpha: 16, epochs: 4, repeats: 8, resolution: 768, learning_rate: 0.0001, lr_scheduler: "constant".into(), warmup_ratio: 0.0, gradient_accumulation_steps: 1, caption_dropout_rate: 0.0, shuffle_caption: false, keep_tokens: 1, seed: 1 } }
}
