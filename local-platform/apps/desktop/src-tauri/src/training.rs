//! 本模块管理桌面 LoRA 训练任务快照、队列状态和训练产物登记，SQLite 始终是任务事实源。

use crate::models::{
    DesktopTrainingAttemptView, DesktopTrainingDatasetImportInput, DesktopTrainingDatasetView,
    DesktopTrainingJobCreateInput, DesktopTrainingJobView, DesktopTrainingParameters,
    DesktopTrainingSnapshotAssetView, DesktopTrainingSnapshotCopyInput,
    DesktopTrainingSnapshotView, DesktopTrainingSuggestionView,
};
use crate::storage::LocalLoraRegistration;
use crate::training_dataset::{self, TrainingImportAsset};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};
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
    let mut assets = read_asset_snapshots(&transaction, app_data_dir, &input.dataset_id)?;
    if !(5..=200).contains(&assets.len()) {
        return Err("训练集图片数量必须是 5–200 张".into());
    }
    for asset in &mut assets {
        asset.relative_path = materialize_snapshot_blob(
            app_data_dir,
            &asset.relative_path,
            &asset.sha256,
            asset.byte_size,
        )?;
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let parameters_json = serde_json::to_string(&input.parameters)
        .map_err(|error| format!("序列化训练参数失败：{error}"))?;
    let preprocessing_status = if input.use_ai_tag_processing {
        "queued"
    } else {
        "not_requested"
    };
    let preprocessing_progress = if input.use_ai_tag_processing { 0 } else { 100 };
    transaction.execute(
        "INSERT INTO local_training_jobs (id,dataset_id,dataset_title,title,type,status,progress,current_epoch,total_epochs,model_id,model_display_name,workflow_kind,model_file_name,model_relative_path,model_sha256,model_byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,text_encoder_sha256,vae_file_name,vae_relative_path,vae_sha256,parameters_json,trigger_words_json,asset_count,use_ai_tag_processing,training_goal,preprocessing_status,preprocessing_progress,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'queued',0,0,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?28)",
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
            input.use_ai_tag_processing,
            input.training_goal.trim(),
            preprocessing_status,
            preprocessing_progress,
            now,
        ],
    ).map_err(|error| format!("创建训练任务失败：{error}"))?;
    for (sequence, asset) in assets.iter().enumerate() {
        let tags_json = serde_json::to_string(&asset.tags)
            .map_err(|error| format!("序列化训练标签快照失败：{error}"))?;
        transaction.execute(
            "INSERT INTO local_training_job_assets (job_id,sequence,asset_id,file_name,relative_path,sha256,byte_size,caption,tags_json,image_variant,derivative_source,ai_clean_status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![id, sequence as u32, asset.id, asset.file_name, asset.relative_path, asset.sha256, asset.byte_size, asset.caption,tags_json,asset.image_variant,asset.derivative_source,preprocessing_status],
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

/** 按任务 ID 返回只读训练快照，不读取后来变化的原训练集。 */
pub fn get_snapshot(
    database: &Connection,
    app_data_dir: &Path,
    id: &str,
) -> Result<DesktopTrainingSnapshotView, String> {
    validate_uuid(id, "训练任务 ID")?;
    let row = database.query_row(
        "SELECT id,dataset_id,dataset_title,title,type,status,trigger_words_json,parameters_json,created_at FROM local_training_jobs WHERE id=?1",
        [id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        },
    ).optional().map_err(|error| format!("读取训练快照元数据失败：{error}"))?
        .ok_or_else(|| "训练任务不存在".to_string())?;
    let trigger_words =
        serde_json::from_str(&row.6).map_err(|error| format!("解析训练快照触发词失败：{error}"))?;
    let parameters =
        serde_json::from_str(&row.7).map_err(|error| format!("解析训练快照参数失败：{error}"))?;
    let mut statement = database.prepare("SELECT sequence,file_name,relative_path,sha256,byte_size,caption,tags_json,image_variant,derivative_source FROM local_training_job_assets WHERE job_id=?1 ORDER BY sequence ASC").map_err(|error| format!("读取训练快照图片失败：{error}"))?;
    let assets = statement
        .query_map([id], |asset| {
            Ok((
                asset.get::<_, u32>(0)?,
                asset.get::<_, String>(1)?,
                asset.get::<_, String>(2)?,
                asset.get::<_, String>(3)?,
                asset.get::<_, u64>(4)?,
                asset.get::<_, String>(5)?,
                asset.get::<_, String>(6)?,
                asset.get::<_, String>(7)?,
                asset.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|error| format!("查询训练快照图片失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析训练快照图片失败：{error}"))?
        .into_iter()
        .map(|asset| {
            let tags = serde_json::from_str(&asset.6)
                .map_err(|error| format!("解析训练标签快照失败：{error}"))?;
            Ok(DesktopTrainingSnapshotAssetView {
                sequence: asset.0,
                file_name: asset.1,
                path: app_data_dir.join(asset.2).to_string_lossy().into_owned(),
                sha256: asset.3,
                byte_size: asset.4,
                caption: asset.5,
                tags: crate::training_tags::to_views(tags),
                image_variant: asset.7,
                derivative_source: asset.8,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    if assets.is_empty() {
        return Err("训练任务快照没有图片".into());
    }
    Ok(DesktopTrainingSnapshotView {
        job_id: row.0,
        dataset_id: row.1,
        dataset_title: row.2,
        lora_title: row.3,
        r#type: row.4,
        status: row.5,
        trigger_words,
        parameters,
        assets,
        created_at: row.8,
    })
}

/** 把只读训练快照复制成新的可编辑训练集，绝不覆盖原训练集或任务。 */
pub fn copy_snapshot_to_dataset(
    database: &mut Connection,
    app_data_dir: &Path,
    input: DesktopTrainingSnapshotCopyInput,
) -> Result<DesktopTrainingDatasetView, String> {
    let snapshot = get_snapshot(database, app_data_dir, &input.job_id)?;
    let assets = snapshot
        .assets
        .into_iter()
        .map(|asset| {
            let tags = asset
                .tags
                .into_iter()
                .map(|tag| crate::training_tags::TrainingTag {
                    value: tag.value,
                    normalized_value: tag.normalized_value,
                    source: tag.source,
                    position: tag.position,
                })
                .collect();
            TrainingImportAsset {
                source_path: PathBuf::from(asset.path),
                original_file_name: asset.file_name,
                caption: Some(asset.caption),
                tags: Some(tags),
            }
        })
        .collect();
    training_dataset::import_dataset_snapshot(
        database,
        app_data_dir,
        DesktopTrainingDatasetImportInput {
            preview_id: input.job_id,
            title: input.title,
            r#type: snapshot.r#type,
            trigger_words: snapshot.trigger_words,
        },
        assets,
    )
}

/** 幂等取消排队或运行中的训练，已经登记成功的 LoRA 保持不变。 */
pub fn cancel_job(database: &Connection, id: &str) -> Result<DesktopTrainingJobView, String> {
    validate_uuid(id, "训练任务 ID")?;
    let status: Option<String> = database
        .query_row(
            "SELECT status FROM local_training_jobs WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取训练任务失败：{error}"))?;
    let Some(status) = status else {
        return Err("训练任务不存在".into());
    };
    let now = Utc::now().to_rfc3339();
    if status == "queued" {
        let transaction = database
            .unchecked_transaction()
            .map_err(|error| format!("开启取消排队训练事务失败：{error}"))?;
        transaction.execute("UPDATE local_training_jobs SET status='cancelled',progress=100,cancel_requested=1,preprocessing_status=CASE WHEN preprocessing_status IN ('queued','running') THEN 'failed' ELSE preprocessing_status END,preprocessing_error=CASE WHEN preprocessing_status IN ('queued','running') THEN '训练任务已取消' ELSE preprocessing_error END,completed_at=?2,updated_at=?2 WHERE id=?1 AND status='queued'", params![id,now]).map_err(|error| format!("取消排队训练任务失败：{error}"))?;
        transaction.execute("UPDATE local_training_job_assets SET ai_clean_status='cancelled',ai_clean_error='训练任务已取消' WHERE job_id=?1 AND ai_clean_status IN ('queued','running')", [id]).map_err(|error| format!("取消训练快照 AI 标签项失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交取消排队训练事务失败：{error}"))?;
    } else if status == "running" {
        database.execute("UPDATE local_training_jobs SET cancel_requested=1,updated_at=?2 WHERE id=?1 AND status='running'", params![id,now]).map_err(|error| format!("请求取消运行中训练失败：{error}"))?;
    }
    read_job(database, id)?.ok_or_else(|| "训练任务不存在".into())
}

/** 原子领取最早的排队训练任务并创建一次可审计执行尝试。 */
pub(crate) fn claim_next_job(
    database: &mut Connection,
) -> Result<Option<TrainingExecution>, String> {
    let transaction = database
        .transaction()
        .map_err(|error| format!("开启训练调度事务失败：{error}"))?;
    let id: Option<String> = transaction.query_row("SELECT id FROM local_training_jobs WHERE status='queued' AND cancel_requested=0 AND preprocessing_status IN ('not_requested','succeeded') ORDER BY created_at ASC LIMIT 1", [], |row| row.get(0)).optional().map_err(|error| format!("读取训练队列失败：{error}"))?;
    let Some(id) = id else {
        transaction
            .commit()
            .map_err(|error| format!("提交空闲训练事务失败：{error}"))?;
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339();
    if transaction.execute("UPDATE local_training_jobs SET status='running',progress=1,current_epoch=0,started_at=?2,completed_at=NULL,error=NULL,suggestion_json=NULL,updated_at=?2 WHERE id=?1 AND status='queued' AND cancel_requested=0", params![id,now]).map_err(|error| format!("领取训练任务失败：{error}"))? != 1 {
        transaction.rollback().map_err(|error| format!("回滚训练任务领取失败：{error}"))?;
        return Ok(None);
    }
    let attempt_number: u32 = transaction.query_row("SELECT COALESCE(MAX(attempt_number),0)+1 FROM local_training_job_attempts WHERE job_id=?1", [&id], |row| row.get(0)).map_err(|error| format!("计算训练尝试次数失败：{error}"))?;
    let attempt_id = Uuid::new_v4().to_string();
    transaction.execute("INSERT INTO local_training_job_attempts (id,job_id,attempt_number,status,started_at) VALUES (?1,?2,?3,'running',?4)", params![attempt_id,id,attempt_number,now]).map_err(|error| format!("创建训练尝试失败：{error}"))?;
    let execution = read_execution(&transaction, &id, &attempt_id)?;
    transaction
        .commit()
        .map_err(|error| format!("提交训练任务领取失败：{error}"))?;
    Ok(Some(execution))
}

/** 持久化训练进度，旧事件不能让任务进度或 Epoch 倒退。 */
pub(crate) fn update_progress(
    database: &Connection,
    id: &str,
    progress: u32,
    current_epoch: u32,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    database.execute("UPDATE local_training_jobs SET progress=MAX(progress,?2),current_epoch=MAX(current_epoch,?3),updated_at=?4 WHERE id=?1 AND status='running'", params![id,progress.min(99),current_epoch,now]).map_err(|error| format!("更新训练进度失败：{error}"))?;
    Ok(())
}

/** 原子登记训练产物 LoRA，并把尝试和任务一起收敛为成功。 */
pub(crate) fn finish_success(
    database: &Connection,
    job: &TrainingExecution,
    lora: LocalLoraRegistration,
) -> Result<DesktopTrainingJobView, String> {
    let now = Utc::now().to_rfc3339();
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启训练成功事务失败：{error}"))?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT id FROM local_loras WHERE sha256=?1",
            [&lora.sha256],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("检查训练 LoRA 去重失败：{error}"))?;
    let lora_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
    let trigger_words_json = serde_json::to_string(&lora.trigger_words)
        .map_err(|error| format!("序列化训练 LoRA 触发词失败：{error}"))?;
    transaction.execute("INSERT INTO local_loras (id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10) ON CONFLICT(sha256) DO UPDATE SET title=excluded.title,type=excluded.type,file_name=excluded.file_name,relative_path=excluded.relative_path,byte_size=excluded.byte_size,modified_ms=excluded.modified_ms,trigger_words_json=excluded.trigger_words_json,updated_at=excluded.updated_at", params![lora_id,lora.title,lora.r#type,lora.file_name,lora.relative_path,lora.sha256,lora.byte_size,lora.modified_ms,trigger_words_json,now]).map_err(|error| format!("登记训练 LoRA 失败：{error}"))?;
    transaction.execute("UPDATE local_training_job_attempts SET status='succeeded',error=NULL,completed_at=?2 WHERE id=?1 AND status='running'", params![job.attempt_id,now]).and_then(|_| transaction.execute("UPDATE local_training_jobs SET status='succeeded',progress=100,current_epoch=total_epochs,output_lora_id=?2,error=NULL,suggestion_json=NULL,completed_at=?3,updated_at=?3 WHERE id=?1 AND status='running'", params![job.id,lora_id,now])).map_err(|error| format!("保存训练成功终态失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交训练成功终态失败：{error}"))?;
    read_job(database, &job.id)?.ok_or_else(|| "训练成功后任务不存在".into())
}

/** 保存训练失败和可操作降档建议，禁止同一任务无限自动重试。 */
pub(crate) fn finish_failed(
    database: &Connection,
    job: &TrainingExecution,
    error: &str,
    suggestion: Option<DesktopTrainingSuggestionView>,
) -> Result<DesktopTrainingJobView, String> {
    let now = Utc::now().to_rfc3339();
    let message = sanitize_error(error);
    let suggestion_json = suggestion
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|failure| format!("序列化训练建议失败：{failure}"))?;
    let transaction = database
        .unchecked_transaction()
        .map_err(|failure| format!("开启训练失败事务失败：{failure}"))?;
    transaction.execute("UPDATE local_training_job_attempts SET status='failed',error=?2,completed_at=?3 WHERE id=?1 AND status='running'", params![job.attempt_id,message,now]).and_then(|_| transaction.execute("UPDATE local_training_jobs SET status='failed',progress=100,error=?2,suggestion_json=?3,completed_at=?4,updated_at=?4 WHERE id=?1 AND status='running'", params![job.id,message,suggestion_json,now])).map_err(|failure| format!("保存训练失败终态失败：{failure}"))?;
    transaction
        .commit()
        .map_err(|failure| format!("提交训练失败终态失败：{failure}"))?;
    read_job(database, &job.id)?.ok_or_else(|| "训练失败后任务不存在".into())
}

/** 应用正常退出时保留同一任务快照并创建下一次执行尝试。 */
pub(crate) fn requeue_interrupted(
    database: &Connection,
    job: &TrainingExecution,
) -> Result<DesktopTrainingJobView, String> {
    let now = Utc::now().to_rfc3339();
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启训练恢复事务失败：{error}"))?;
    transaction.execute("UPDATE local_training_job_attempts SET status='interrupted',error='桌面程序退出，训练任务已恢复排队',completed_at=?2 WHERE id=?1 AND status='running'", params![job.attempt_id,now]).and_then(|_| transaction.execute("UPDATE local_training_jobs SET status='queued',progress=0,current_epoch=0,started_at=NULL,error=NULL,suggestion_json=NULL,updated_at=?2 WHERE id=?1 AND status='running' AND cancel_requested=0", params![job.id,now])).map_err(|error| format!("恢复训练任务失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交训练恢复失败：{error}"))?;
    read_job(database, &job.id)?.ok_or_else(|| "恢复后的训练任务不存在".into())
}

/** 运行中取消会保留已经完成的尝试日志，但不会登记不完整产物。 */
pub(crate) fn finish_cancelled(
    database: &Connection,
    job: &TrainingExecution,
) -> Result<DesktopTrainingJobView, String> {
    let now = Utc::now().to_rfc3339();
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启训练取消事务失败：{error}"))?;
    transaction.execute("UPDATE local_training_job_attempts SET status='cancelled',completed_at=?2 WHERE id=?1 AND status='running'", params![job.attempt_id,now]).and_then(|_| transaction.execute("UPDATE local_training_jobs SET status='cancelled',progress=100,error=NULL,completed_at=?2,updated_at=?2 WHERE id=?1 AND status='running'", params![job.id,now])).map_err(|error| format!("保存训练取消终态失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交训练取消终态失败：{error}"))?;
    read_job(database, &job.id)?.ok_or_else(|| "取消后的训练任务不存在".into())
}

/** 读取任务取消标记；数据库异常时保守中止训练。 */
pub(crate) fn cancel_requested(database: &Connection, id: &str) -> bool {
    database
        .query_row(
            "SELECT cancel_requested FROM local_training_jobs WHERE id=?1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .unwrap_or(true)
}

/** 向 WebView 发送数据库已落盘的训练任务状态。 */
pub(crate) fn emit_job(database: &Connection, app: &tauri::AppHandle, id: &str) {
    use tauri::Emitter;
    if let Ok(Some(job)) = read_job(database, id) {
        let _ = app.emit("desktop-training-job-updated", job);
    }
}

fn read_execution(
    transaction: &Transaction<'_>,
    id: &str,
    attempt_id: &str,
) -> Result<TrainingExecution, String> {
    let execution = transaction.query_row("SELECT title,type,model_relative_path,model_sha256,model_byte_size,model_modified_ms,text_encoder_relative_path,text_encoder_sha256,vae_relative_path,vae_sha256,parameters_json,trigger_words_json FROM local_training_jobs WHERE id=?1", [id], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?,row.get::<_, u64>(4)?,row.get::<_, u64>(5)?,row.get::<_, String>(6)?,row.get::<_, String>(7)?,row.get::<_, String>(8)?,row.get::<_, String>(9)?,row.get::<_, String>(10)?,row.get::<_, String>(11)?))).map_err(|error| format!("读取训练执行快照失败：{error}"))?;
    let parameters = serde_json::from_str(&execution.10)
        .map_err(|error| format!("解析训练执行参数失败：{error}"))?;
    let trigger_words = serde_json::from_str(&execution.11)
        .map_err(|error| format!("解析训练执行触发词失败：{error}"))?;
    let mut statement = transaction.prepare("SELECT relative_path,sha256,byte_size,caption FROM local_training_job_assets WHERE job_id=?1 ORDER BY sequence ASC").map_err(|error| format!("读取训练图片快照失败：{error}"))?;
    let assets = statement
        .query_map([id], |row| {
            Ok(TrainingAssetExecution {
                relative_path: row.get(0)?,
                sha256: row.get(1)?,
                byte_size: row.get(2)?,
                caption: row.get(3)?,
            })
        })
        .map_err(|error| format!("查询训练图片快照失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析训练图片快照失败：{error}"))?;
    Ok(TrainingExecution {
        id: id.into(),
        attempt_id: attempt_id.into(),
        title: execution.0,
        r#type: execution.1,
        model_relative_path: execution.2,
        model_sha256: execution.3,
        model_byte_size: execution.4,
        model_modified_ms: execution.5,
        text_encoder_relative_path: execution.6,
        text_encoder_sha256: execution.7,
        vae_relative_path: execution.8,
        vae_sha256: execution.9,
        parameters,
        trigger_words,
        assets,
    })
}

fn sanitize_error(error: &str) -> String {
    error
        .lines()
        .last()
        .unwrap_or("本地训练失败")
        .trim()
        .chars()
        .take(1000)
        .collect()
}

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
    file_name: String,
    relative_path: String,
    sha256: String,
    byte_size: u64,
    caption: String,
    tags: Vec<crate::training_tags::TrainingTag>,
    image_variant: String,
    derivative_source: Option<String>,
}

/** 启动时把旧任务仍指向原训练图片的记录迁移为内容寻址快照；缺失旧文件保持原记录供审计。 */
pub(crate) fn materialize_existing_snapshots(
    database: &Connection,
    app_data_dir: &Path,
) -> Result<(), String> {
    let rows = {
        let mut statement = database.prepare("SELECT job_id,sequence,asset_id,relative_path,sha256,byte_size,tags_json FROM local_training_job_assets ORDER BY job_id,sequence").map_err(|error| format!("读取旧训练图片快照失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, u64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|error| format!("查询旧训练图片快照失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析旧训练图片快照失败：{error}"))?;
        rows
    };
    for (job_id, sequence, asset_id, relative_path, sha256, byte_size, tags_json) in rows {
        let snapshot_path = if relative_path.starts_with("training-snapshots/blobs/") {
            Some(relative_path)
        } else {
            materialize_snapshot_blob(app_data_dir, &relative_path, &sha256, byte_size).ok()
        };
        let backfilled_tags = if tags_json == "[]" {
            crate::training_tags::read_tags(database, &asset_id)
                .ok()
                .filter(|tags| !tags.is_empty())
                .and_then(|tags| serde_json::to_string(&tags).ok())
        } else {
            None
        };
        if snapshot_path.is_none() && backfilled_tags.is_none() {
            // 旧文件已经人为缺失时保留原审计记录，不阻止客户端启动或修改其他训练集。
            continue;
        }
        database.execute(
            "UPDATE local_training_job_assets SET relative_path=COALESCE(?3,relative_path),tags_json=COALESCE(?4,tags_json) WHERE job_id=?1 AND sequence=?2",
            params![job_id, sequence, snapshot_path, backfilled_tags],
        ).map_err(|error| format!("更新旧训练图片快照路径失败：{error}"))?;
    }
    Ok(())
}

/** 把训练图片复制为按 SHA-256 去重的只读快照 Blob，并返回应用数据相对路径。 */
fn materialize_snapshot_blob(
    app_data_dir: &Path,
    source_relative_path: &str,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<String, String> {
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("训练图片快照 SHA-256 不正确".into());
    }
    let source = app_data_dir.join(source_relative_path);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| matches!(value.as_str(), "png" | "jpg" | "jpeg" | "webp"))
        .ok_or_else(|| "训练图片快照扩展名不受支持".to_string())?;
    let relative = PathBuf::from("training-snapshots")
        .join("blobs")
        .join(&expected_sha256[..2])
        .join(format!("{expected_sha256}.{extension}"));
    let destination = app_data_dir.join(&relative);
    if snapshot_matches(&destination, expected_sha256, expected_size)? {
        return Ok(relative.to_string_lossy().replace('\\', "/"));
    }
    if destination.exists() {
        return Err("训练图片快照 Blob 与声明哈希冲突".into());
    }
    fs::create_dir_all(destination.parent().expect("快照 Blob 必须有父目录"))
        .map_err(|error| format!("创建训练快照目录失败：{error}"))?;
    let temporary = destination.with_file_name(format!(".{}.snapshot", Uuid::new_v4()));
    let outcome = copy_snapshot_file(&source, &temporary, expected_sha256, expected_size);
    if let Err(error) = outcome {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        if snapshot_matches(&destination, expected_sha256, expected_size)? {
            return Ok(relative.to_string_lossy().replace('\\', "/"));
        }
        return Err(format!("提交训练图片快照失败：{error}"));
    }
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn copy_snapshot_file(
    source: &Path,
    destination: &Path,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<(), String> {
    let metadata = source
        .metadata()
        .map_err(|_| "训练图片文件缺失，请重新导入并确认".to_string())?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err("训练图片文件已经变化，请重新导入并确认".into());
    }
    let mut reader =
        BufReader::new(File::open(source).map_err(|error| format!("打开训练图片失败：{error}"))?);
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| format!("创建训练图片快照失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取训练图片失败：{error}"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入训练图片快照失败：{error}"))?;
        hasher.update(&buffer[..read]);
        copied = copied.saturating_add(read as u64);
    }
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("同步训练图片快照失败：{error}"))?;
    if copied != expected_size || hex::encode(hasher.finalize()) != expected_sha256 {
        return Err("训练图片内容已经变化，请重新确认训练集".into());
    }
    Ok(())
}

fn snapshot_matches(
    path: &Path,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<bool, String> {
    let Ok(metadata) = path.metadata() else {
        return Ok(false);
    };
    if !metadata.is_file() || metadata.len() != expected_size {
        return Ok(false);
    }
    let mut reader =
        BufReader::new(File::open(path).map_err(|error| format!("读取训练图片快照失败：{error}"))?);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("校验训练图片快照失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()) == expected_sha256)
}

fn read_dataset_snapshot(
    transaction: &Transaction<'_>,
    id: &str,
) -> Result<DatasetSnapshot, String> {
    transaction
        .query_row(
            "SELECT title,type,trigger_words_json,status FROM local_training_datasets WHERE id=?1 AND deleted_at IS NULL",
            [id],
            |row| {
                Ok(DatasetSnapshot {
                    title: row.get(0)?,
                    r#type: row.get(1)?,
                    trigger_words_json: row.get(2)?,
                    status: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("读取训练集失败：{error}"))?
        .ok_or_else(|| "训练集不存在".into())
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

fn read_asset_snapshots(
    transaction: &Transaction<'_>,
    app_data_dir: &Path,
    dataset_id: &str,
) -> Result<Vec<AssetSnapshot>, String> {
    let mut statement = transaction.prepare("SELECT asset.id,asset.file_name,COALESCE(derivative.relative_path,asset.relative_path),COALESCE(derivative.sha256,asset.sha256),COALESCE(derivative.byte_size,asset.byte_size),asset.caption,CASE WHEN derivative.id IS NULL THEN 'original' ELSE 'background_removed' END,derivative.source FROM local_training_assets asset LEFT JOIN local_training_asset_derivatives derivative ON derivative.id=asset.selected_derivative_id AND derivative.asset_id=asset.id WHERE asset.dataset_id=?1 ORDER BY asset.created_at ASC,asset.id ASC").map_err(|error| format!("读取训练图片失败：{error}"))?;
    let rows = statement
        .query_map([dataset_id], |row| {
            Ok(AssetSnapshot {
                id: row.get(0)?,
                file_name: row.get(1)?,
                relative_path: row.get(2)?,
                sha256: row.get(3)?,
                byte_size: row.get(4)?,
                caption: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                tags: Vec::new(),
                image_variant: row.get(6)?,
                derivative_source: row.get(7)?,
            })
        })
        .map_err(|error| format!("查询训练图片失败：{error}"))?;
    let mut assets = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析训练图片失败：{error}"))?;
    drop(statement);
    for asset in &mut assets {
        asset.tags = crate::training_tags::read_tags(transaction, &asset.id)?;
        if asset.caption.trim().is_empty() {
            return Err("训练集仍有图片缺少 Caption".into());
        }
        let metadata = app_data_dir
            .join(&asset.relative_path)
            .metadata()
            .map_err(|_| "训练图片文件缺失，请重新导入并确认".to_string())?;
        if !metadata.is_file() || metadata.len() != asset.byte_size {
            return Err("训练图片文件已经变化，请重新导入并确认".into());
        }
    }
    Ok(assets)
}

fn validate_model_files(model_root: &Path, model: &ModelSnapshot) -> Result<(), String> {
    let main = model_root.join(&model.model_relative_path);
    let metadata = main
        .metadata()
        .map_err(|_| "训练底模文件缺失".to_string())?;
    if !metadata.is_file()
        || metadata.len() != model.model_byte_size
        || modified_millis(&metadata)? != model.model_modified_ms
    {
        return Err("训练底模文件已经变化，请重新导入".into());
    }
    for relative in [&model.text_encoder_relative_path, &model.vae_relative_path] {
        if !model_root.join(relative).is_file() {
            return Err("训练底模的文本编码器或 VAE 缺失".into());
        }
    }
    Ok(())
}

fn read_job(database: &Connection, id: &str) -> Result<Option<DesktopTrainingJobView>, String> {
    let row = database.query_row(
        "SELECT id,dataset_id,dataset_title,title,type,status,progress,current_epoch,total_epochs,model_id,model_display_name,use_ai_tag_processing,training_goal,preprocessing_status,preprocessing_progress,preprocessing_error,trigger_words_json,asset_count,parameters_json,output_lora_id,error,suggestion_json,created_at,started_at,completed_at,updated_at FROM local_training_jobs WHERE id=?1",
        [id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, u32>(6)?, row.get::<_, u32>(7)?, row.get::<_, u32>(8)?, row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, i64>(11)? != 0, row.get::<_, String>(12)?, row.get::<_, String>(13)?, row.get::<_, u32>(14)?, row.get::<_, Option<String>>(15)?, row.get::<_, String>(16)?, row.get::<_, u32>(17)?, row.get::<_, String>(18)?, row.get::<_, Option<String>>(19)?, row.get::<_, Option<String>>(20)?, row.get::<_, Option<String>>(21)?, row.get::<_, String>(22)?, row.get::<_, Option<String>>(23)?, row.get::<_, Option<String>>(24)?, row.get::<_, String>(25)?,
        )),
    ).optional().map_err(|error| format!("读取训练任务失败：{error}"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let trigger_words =
        serde_json::from_str(&row.16).map_err(|error| format!("解析训练触发词失败：{error}"))?;
    let parameters =
        serde_json::from_str(&row.18).map_err(|error| format!("解析训练参数失败：{error}"))?;
    let suggestion = row
        .21
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| format!("解析训练降档建议失败：{error}"))?;
    let queue_position = if row.5 == "queued" {
        database
            .query_row(
                "SELECT COUNT(*) FROM local_training_jobs WHERE status='queued' AND created_at<=?1",
                [&row.22],
                |value| value.get(0),
            )
            .unwrap_or(0)
    } else {
        0
    };
    Ok(Some(DesktopTrainingJobView {
        id: row.0.clone(),
        dataset_id: row.1,
        dataset_title: row.2,
        title: row.3,
        r#type: row.4,
        status: row.5,
        progress: row.6,
        queue_position,
        current_epoch: row.7,
        total_epochs: row.8,
        model_id: row.9,
        model_display_name: row.10,
        use_ai_tag_processing: row.11,
        training_goal: row.12,
        preprocessing_status: row.13,
        preprocessing_progress: row.14,
        preprocessing_error: row.15,
        trigger_words,
        asset_count: row.17,
        parameters,
        attempts: read_attempts(database, &row.0)?,
        output_lora_id: row.19,
        error: row.20,
        suggestion,
        created_at: row.22,
        started_at: row.23,
        completed_at: row.24,
        updated_at: row.25,
    }))
}

fn read_attempts(
    database: &Connection,
    job_id: &str,
) -> Result<Vec<DesktopTrainingAttemptView>, String> {
    let mut statement = database.prepare("SELECT id,attempt_number,status,error,started_at,completed_at FROM local_training_job_attempts WHERE job_id=?1 ORDER BY attempt_number ASC LIMIT 10").map_err(|error| format!("读取训练尝试失败：{error}"))?;
    let rows = statement
        .query_map([job_id], |row| {
            Ok(DesktopTrainingAttemptView {
                id: row.get(0)?,
                attempt_number: row.get(1)?,
                status: row.get(2)?,
                error: row.get(3)?,
                started_at: row.get(4)?,
                completed_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("查询训练尝试失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析训练尝试失败：{error}"))
}

fn validate_create_input(input: &DesktopTrainingJobCreateInput) -> Result<(), String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.model_id, "底模 ID")?;
    if input.title.trim().is_empty() || input.title.trim().chars().count() > 191 {
        return Err("LoRA 标题长度必须是 1–191 个字符".into());
    }
    if input.training_goal.chars().count() > 4_000 {
        return Err("训练目标不能超过 4000 个字符".into());
    }
    let parameters = &input.parameters;
    if !matches!(
        parameters.preset.as_str(),
        "quick" | "balanced" | "high_quality" | "extreme" | "custom"
    ) {
        return Err("训练预设不正确".into());
    }
    if !(8..=64).contains(&parameters.rank)
        || !(1..=64).contains(&parameters.alpha)
        || parameters.alpha > parameters.rank
    {
        return Err("Rank 或 Alpha 不正确".into());
    }
    if !(1..=20).contains(&parameters.epochs)
        || !(1..=50).contains(&parameters.repeats)
        || !(512..=1536).contains(&parameters.resolution)
        || parameters.resolution % 64 != 0
    {
        return Err("训练轮次、重复次数或分辨率不正确".into());
    }
    if !(0.000001..=0.01).contains(&parameters.learning_rate)
        || !(0.0..=0.2).contains(&parameters.warmup_ratio)
        || !(0.0..=0.3).contains(&parameters.caption_dropout_rate)
    {
        return Err("学习率、预热或 Caption Dropout 不正确".into());
    }
    if !matches!(
        parameters.lr_scheduler.as_str(),
        "constant" | "cosine" | "cosine_with_restarts"
    ) || !(1..=4).contains(&parameters.gradient_accumulation_steps)
        || parameters.keep_tokens > 10
        || parameters.seed > 2_147_483_647
    {
        return Err("训练调度器或高级参数不正确".into());
    }
    if !matches!(
        parameters.optimizer.as_str(),
        "AdamW8bit" | "AdamW" | "Adafactor"
    ) || !(1..=4).contains(&parameters.batch_size)
        || parameters
            .max_train_steps
            .is_some_and(|value| value == 0 || value > 100_000)
        || !(1..=20).contains(&parameters.save_every_epochs)
        || !matches!(parameters.mixed_precision.as_str(), "bf16" | "fp16")
        || !matches!(
            parameters.text_encoder_strategy.as_str(),
            "frozen_cached" | "frozen_recompute"
        )
        || !(0.0..=10.0).contains(&parameters.max_grad_norm)
    {
        return Err("训练优化器、Batch、精度或缓存参数不正确".into());
    }
    if parameters.bucket_enabled
        && (parameters.bucket_min_resolution < 256
            || parameters.bucket_min_resolution > parameters.bucket_max_resolution
            || parameters.bucket_max_resolution > 2_048
            || !(32..=256).contains(&parameters.bucket_resolution_steps)
            || parameters.bucket_min_resolution % parameters.bucket_resolution_steps != 0
            || parameters.bucket_max_resolution % parameters.bucket_resolution_steps != 0)
    {
        return Err("训练分桶范围或步长不正确".into());
    }
    if parameters.color_augmentation && parameters.cache_latents {
        return Err("颜色增强与 Latent 缓存不能同时启用".into());
    }
    if parameters.shuffle_caption && parameters.text_encoder_strategy == "frozen_cached" {
        return Err("随机打乱 Caption 时不能缓存 Text Encoder 输出".into());
    }
    Ok(())
}

fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{label} 不正确"))
}
fn modified_millis(metadata: &fs::Metadata) -> Result<u64, String> {
    metadata
        .modified()
        .map_err(|error| format!("读取模型修改时间失败：{error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "模型修改时间早于系统纪元".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        background_removal,
        models::{
            DesktopTrainingAssetDeleteInput, DesktopTrainingAssetVariantSelectInput,
            DesktopTrainingCaptionUpdateInput, DesktopTrainingDatasetCreateInput,
            DesktopTrainingImagesAddInput, DesktopTrainingManualMaskInput,
        },
        storage::DesktopState,
        training_dataset,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use image::{GrayImage, ImageFormat, Luma, Rgb, RgbImage};
    use sha2::{Digest, Sha256};
    use std::io::Cursor;

    #[test]
    fn training_parameters_reject_alpha_larger_than_rank() {
        let input = DesktopTrainingJobCreateInput {
            dataset_id: Uuid::new_v4().to_string(),
            model_id: Uuid::new_v4().to_string(),
            title: "测试 LoRA".into(),
            use_ai_tag_processing: false,
            training_goal: String::new(),
            parameters: crate::models::DesktopTrainingParameters {
                rank: 8,
                alpha: 16,
                epochs: 4,
                repeats: 4,
                resolution: 768,
                learning_rate: 0.0001,
                lr_scheduler: "constant".into(),
                warmup_ratio: 0.0,
                gradient_accumulation_steps: 1,
                caption_dropout_rate: 0.0,
                shuffle_caption: false,
                keep_tokens: 1,
                seed: 1,
                ..Default::default()
            },
        };
        assert!(validate_create_input(&input).is_err());
    }

    #[test]
    fn confirmed_dataset_and_anima_snapshot_create_persistent_training_job() {
        let temporary = tempfile::tempdir().expect("创建训练任务临时目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "训练快照".into(),
                r#type: "character".into(),
                trigger_words: vec!["dh_token".into()],
            })
            .expect("创建训练集");
        let source_paths = (0..5)
            .map(|index| {
                let path = temporary.path().join(format!("training-{index}.png"));
                RgbImage::from_pixel(32, 32, Rgb([index, 40, 80]))
                    .save(&path)
                    .expect("写入训练图片");
                path.to_string_lossy().into_owned()
            })
            .collect::<Vec<_>>();
        let imported = {
            let mut database = state.database.lock().expect("锁定导入数据库");
            training_dataset::add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths,
                },
            )
            .expect("导入训练图片")
        };
        for asset in &imported.assets {
            state
                .update_training_caption(DesktopTrainingCaptionUpdateInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: asset.id.clone(),
                    caption: Some("1girl, solo".into()),
                })
                .expect("保存训练 Caption");
        }
        // 第一张图片明确选择手动透明派生版本，训练任务必须把该选择固化到独立快照。
        let (selected_derivative_id, selected_derivative_path) = {
            let mask = GrayImage::from_fn(32, 32, |x, _| Luma([if x < 16 { 0 } else { 255 }]));
            let mut encoded = Cursor::new(Vec::new());
            mask.write_to(&mut encoded, ImageFormat::Png)
                .expect("编码训练快照蒙版");
            let mut database = state.database.lock().expect("锁定派生版本数据库");
            let updated = background_removal::save_manual_mask(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingManualMaskInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: imported.assets[0].id.clone(),
                    mask_png_base64: STANDARD.encode(encoded.into_inner()),
                },
            )
            .expect("保存训练快照派生版本");
            let derivative_id = updated.assets[0]
                .selected_derivative_id
                .clone()
                .expect("读取已选派生版本");
            let derivative_path = updated.assets[0]
                .derivatives
                .iter()
                .find(|derivative| derivative.id == derivative_id)
                .expect("读取已选派生文件")
                .path
                .clone();
            (derivative_id, derivative_path)
        };
        {
            let database = state.database.lock().expect("锁定确认数据库");
            training_dataset::confirm_dataset(&database, &state.app_data_dir, &dataset.id)
                .expect("确认训练集");
        }
        let settings = state.load_settings().expect("读取模型目录");
        let model_root = Path::new(&settings.model_root);
        let files = [
            ("diffusion_models", "anima.safetensors"),
            ("text_encoders", "qwen.safetensors"),
            ("vae", "vae.safetensors"),
        ];
        let mut snapshots = Vec::new();
        for (directory, file_name) in files {
            let path = model_root.join(directory).join(file_name);
            fs::create_dir_all(path.parent().expect("读取模型目录")).expect("创建模型目录");
            fs::write(&path, format!("snapshot-{file_name}")).expect("写入模型快照");
            let hash = hex::encode(Sha256::digest(fs::read(&path).expect("读取模型快照")));
            let metadata = path.metadata().expect("读取模型元数据");
            snapshots.push((
                format!("{directory}/{file_name}"),
                hash,
                metadata.len(),
                modified_millis(&metadata).expect("读取修改时间"),
            ));
        }
        let model_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let job_id = {
            let mut database = state.database.lock().expect("锁定训练数据库");
            database.execute("INSERT INTO local_models (id,display_name,family,workflow_kind,model_file_name,model_relative_path,model_sha256,byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,text_encoder_sha256,vae_file_name,vae_relative_path,vae_sha256,created_at,updated_at) VALUES (?1,'测试 Anima','anima','anima','anima.safetensors',?2,?3,?4,?5,'qwen.safetensors',?6,?7,'vae.safetensors',?8,?9,?10,?10)", params![model_id,snapshots[0].0,snapshots[0].1,snapshots[0].2,snapshots[0].3,snapshots[1].0,snapshots[1].1,snapshots[2].0,snapshots[2].1,now]).expect("登记 Anima 模型");
            let job = create_job(
                &mut database,
                &state.app_data_dir,
                model_root,
                DesktopTrainingJobCreateInput {
                    dataset_id: dataset.id.clone(),
                    model_id: model_id.clone(),
                    title: "本地角色 LoRA".into(),
                    use_ai_tag_processing: true,
                    training_goal: "固定角色身份，保留动作和背景可控性".into(),
                    parameters: valid_parameters(),
                },
            )
            .expect("创建训练任务");
            assert_eq!(job.status, "queued");
            assert!(job.use_ai_tag_processing);
            assert_eq!(job.preprocessing_status, "queued");
            assert_eq!(job.asset_count, 5);
            assert_eq!(job.trigger_words, vec!["dh_token"]);
            assert_eq!(list_jobs(&database).expect("读取训练任务").len(), 1);
            assert!(claim_next_job(&mut database)
                .expect("检查预处理门禁")
                .is_none());
            database.execute("UPDATE local_training_job_assets SET ai_clean_status='succeeded' WHERE job_id=?1", [&job.id]).expect("模拟快照 AI 标签处理完成");
            database.execute("UPDATE local_training_jobs SET preprocessing_status='succeeded',preprocessing_progress=100 WHERE id=?1", [&job.id]).expect("完成快照 AI 标签阶段");
            job.id
        };
        {
            let database = state.database.lock().expect("锁定恢复原图数据库");
            let restored = background_removal::select_variant(
                &database,
                &state.app_data_dir,
                DesktopTrainingAssetVariantSelectInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: imported.assets[0].id.clone(),
                    derivative_id: None,
                },
            )
            .expect("任务提交后恢复原图");
            assert!(restored.assets[0].selected_derivative_id.is_none());
            assert!(restored.assets[0]
                .derivatives
                .iter()
                .any(|derivative| derivative.id == selected_derivative_id));
        }
        state
            .update_training_caption(DesktopTrainingCaptionUpdateInput {
                dataset_id: dataset.id.clone(),
                asset_id: imported.assets[1].id.clone(),
                caption: Some("changed after snapshot".into()),
            })
            .expect("任务提交后继续编辑原训练集");
        {
            let database = state.database.lock().expect("锁定删除数据库");
            let updated = training_dataset::delete_asset(
                &database,
                &state.app_data_dir,
                DesktopTrainingAssetDeleteInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: imported.assets[0].id.clone(),
                },
            )
            .expect("任务提交后删除原训练图片");
            assert_eq!(updated.assets.len(), 4);
            assert!(!Path::new(&selected_derivative_path).exists());
        }
        let execution = {
            let mut database = state.database.lock().expect("锁定领取数据库");
            claim_next_job(&mut database)
                .expect("领取训练任务")
                .expect("训练任务存在")
        };
        assert_eq!(execution.id, job_id);
        assert_eq!(execution.assets.len(), 5);
        assert!(execution
            .assets
            .iter()
            .all(|asset| asset.relative_path.starts_with("training-snapshots/blobs/")));
        assert!(execution
            .assets
            .iter()
            .all(|asset| state.app_data_dir.join(&asset.relative_path).is_file()));
        assert!(execution
            .assets
            .iter()
            .all(|asset| asset.caption == "dh_token, 1girl, solo"));

        let copied = {
            let mut database = state.database.lock().expect("锁定快照复制数据库");
            let snapshot =
                get_snapshot(&database, &state.app_data_dir, &job_id).expect("读取完整训练快照");
            assert_eq!(snapshot.dataset_title, "训练快照");
            assert_eq!(snapshot.assets.len(), 5);
            assert_eq!(snapshot.assets[0].image_variant, "background_removed");
            assert_eq!(
                snapshot.assets[0].derivative_source.as_deref(),
                Some("manual")
            );
            assert!(Path::new(&snapshot.assets[0].path).is_file());
            assert!(snapshot
                .assets
                .iter()
                .all(|asset| asset.caption == "dh_token, 1girl, solo"));
            assert!(snapshot.assets.iter().all(|asset| {
                asset.tags.iter().any(|tag| tag.source == "trigger")
                    && asset.tags.iter().any(|tag| tag.source == "manual")
            }));
            training_dataset::delete_dataset(
                &database,
                &state.app_data_dir,
                crate::models::DesktopTrainingDatasetIdInput {
                    dataset_id: dataset.id.clone(),
                },
            )
            .expect("训练运行期间删除原训练集");
            assert!(training_dataset::list_datasets(&database, &state.app_data_dir)
                .expect("读取删除后的训练集")
                .iter()
                .all(|item| item.id != dataset.id));
            assert!(snapshot.assets.iter().all(|asset| Path::new(&asset.path).is_file()));
            copy_snapshot_to_dataset(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingSnapshotCopyInput {
                    job_id: job_id.clone(),
                    title: "训练快照副本".into(),
                },
            )
            .expect("复制训练快照")
        };
        assert_eq!(copied.title, "训练快照副本");
        assert_eq!(copied.assets.len(), 5);
        assert!(copied.assets.iter().all(|asset| {
            asset.caption.as_deref() == Some("dh_token, 1girl, solo")
                && asset.tags.iter().any(|tag| tag.source == "trigger")
                && asset.tags.iter().any(|tag| tag.source == "manual")
        }));

        // 快照文件缺失时，复制事务必须失败且不能留下第三个训练集或半目录。
        fs::remove_file(state.app_data_dir.join(&execution.assets[0].relative_path))
            .expect("移除测试快照 Blob");
        let dataset_directories_before = fs::read_dir(state.app_data_dir.join("datasets"))
            .expect("读取复制前训练集目录")
            .count();
        let mut database = state.database.lock().expect("锁定失败复制数据库");
        let dataset_count_before: u32 = database
            .query_row("SELECT COUNT(*) FROM local_training_datasets", [], |row| {
                row.get(0)
            })
            .expect("读取复制前训练集数量");
        assert!(copy_snapshot_to_dataset(
            &mut database,
            &state.app_data_dir,
            DesktopTrainingSnapshotCopyInput {
                job_id,
                title: "不应创建的副本".into(),
            },
        )
        .is_err());
        let dataset_count_after: u32 = database
            .query_row("SELECT COUNT(*) FROM local_training_datasets", [], |row| {
                row.get(0)
            })
            .expect("读取失败后的训练集数量");
        assert_eq!(dataset_count_after, dataset_count_before);
        assert_eq!(
            fs::read_dir(state.app_data_dir.join("datasets"))
                .expect("读取失败后的训练集目录")
                .count(),
            dataset_directories_before
        );
    }

    fn valid_parameters() -> crate::models::DesktopTrainingParameters {
        crate::models::DesktopTrainingParameters {
            rank: 16,
            alpha: 16,
            epochs: 4,
            repeats: 8,
            resolution: 768,
            learning_rate: 0.0001,
            lr_scheduler: "constant".into(),
            warmup_ratio: 0.0,
            gradient_accumulation_steps: 1,
            caption_dropout_rate: 0.0,
            shuffle_caption: false,
            keep_tokens: 1,
            seed: 1,
            ..Default::default()
        }
    }
}
