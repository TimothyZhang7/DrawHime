//! 本模块实现 SQLite 为事实源的本地单卡串行调度器，负责任务恢复、取消、ComfyUI 执行和产物入队。

use crate::{
    auth,
    generation::{self, GenerationFailure, GenerationLora, GenerationRequest, GenerationResult},
    models::{
        DesktopLocalArtifactView, DesktopLocalJobAttemptView, DesktopLocalJobCreateInput,
        DesktopLocalJobLoraView, DesktopLocalJobParametersView, DesktopLocalJobView,
        DesktopLocalLoraSelectionInput, DesktopSettings,
    },
    runtime::RuntimeController,
    workload::GpuWorkloadCoordinator,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/** 应用生命周期内唯一的本地串行 Worker。 */
pub struct LocalScheduler {
    stopping: Arc<AtomicBool>,
    wake_signal: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct LocalJobExecution {
    id: String,
    attempt_id: String,
    workflow_kind: String,
    model_file_name: String,
    model_relative_path: String,
    model_sha256: String,
    model_byte_size: u64,
    model_modified_ms: u64,
    text_encoder_file_name: Option<String>,
    vae_file_name: Option<String>,
    prompt: String,
    negative_prompt: Option<String>,
    width: u32,
    height: u32,
    steps: u32,
    cfg: f64,
    sampler_name: String,
    scheduler_name: String,
    sampling_max_edge: u32,
    sampling_pixel_budget: u32,
    aspect_step_threshold: f64,
    aspect_adjusted_steps: u32,
    upscale_method: String,
    quality_prompt_enabled: bool,
    quality_prefix: Option<String>,
    default_negative_enabled: bool,
    default_negative_prompt: Option<String>,
    seed: u32,
    privacy: String,
    loras: Vec<LocalJobLoraExecution>,
}

/** 调度器执行期间使用的任务级 LoRA 文件快照。 */
#[derive(Clone)]
struct LocalJobLoraExecution {
    id: String,
    title: String,
    r#type: String,
    file_name: String,
    relative_path: String,
    sha256: String,
    byte_size: u64,
    modified_ms: u64,
    strength: f64,
    clip_strength: f64,
    trigger_words: Vec<String>,
}

/** 创建任务时由桌面核心解析并固化的最终生成参数。 */
struct ResolvedGenerationParameters {
    quality_preset: String,
    steps: u32,
    cfg: f64,
    sampler_name: String,
    scheduler_name: String,
    sampling_max_edge: u32,
    sampling_pixel_budget: u32,
    aspect_step_threshold: f64,
    aspect_adjusted_steps: u32,
    upscale_method: String,
    quality_prompt_enabled: bool,
    quality_prefix: Option<String>,
    default_negative_enabled: bool,
    default_negative_prompt: Option<String>,
}

impl LocalScheduler {
    /** 启动独立 SQLite 连接的后台 Worker；线程异常不会把页面伪装为任务成功。 */
    pub fn start(
        database_path: PathBuf,
        app_data_dir: PathBuf,
        runtime: Arc<RuntimeController>,
        gpu_workload: Arc<GpuWorkloadCoordinator>,
        app: AppHandle,
    ) -> Result<Self, String> {
        let stopping = Arc::new(AtomicBool::new(false));
        let wake_signal = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_stopping = stopping.clone();
        let worker_signal = wake_signal.clone();
        let worker = thread::Builder::new()
            .name("drawhime-local-scheduler".into())
            .spawn(move || {
                scheduler_loop(
                    &database_path,
                    &app_data_dir,
                    &runtime,
                    &gpu_workload,
                    &app,
                    &worker_stopping,
                    &worker_signal,
                )
            })
            .map_err(|error| format!("启动本地调度线程失败：{error}"))?;
        Ok(Self {
            stopping,
            wake_signal,
            worker: Some(worker),
        })
    }

    /** 唤醒空闲 Worker，新任务无需等待固定轮询周期。 */
    pub fn wake(&self) {
        let (lock, condition) = &*self.wake_signal;
        if let Ok(mut pending) = lock.lock() {
            *pending = true;
            condition.notify_one();
        }
    }
}

impl Drop for LocalScheduler {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.wake();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/** 在短事务内创建任务并固化模型与采样参数，页面可立即获得排队记录。 */
pub fn create_job(
    database: &mut Connection,
    settings: &DesktopSettings,
    input: DesktopLocalJobCreateInput,
) -> Result<DesktopLocalJobView, String> {
    validate_job_input(&input)?;
    let transaction = database.transaction().map_err(|error| format!("开启本地任务事务失败：{error}"))?;
    let model = transaction.query_row("SELECT display_name,workflow_kind,model_file_name,model_relative_path,model_sha256,byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,vae_file_name,vae_relative_path FROM local_models WHERE id=?1", [&input.model_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, u64>(5)?, row.get::<_, u64>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?, row.get::<_, Option<String>>(10)?))).optional().map_err(|error| format!("读取任务底模失败：{error}"))?.ok_or_else(|| "所选本地模型不存在".to_string())?;
    validate_registered_asset(&model.3, &model.2, if model.1 == "anima" { "diffusion_models" } else { "checkpoints" })?;
    if model.1 == "anima" {
        validate_registered_asset(model.8.as_deref().ok_or_else(|| "Anima 模型缺少文本编码器路径".to_string())?, model.7.as_deref().ok_or_else(|| "Anima 模型缺少文本编码器文件名".to_string())?, "text_encoders")?;
        validate_registered_asset(model.10.as_deref().ok_or_else(|| "Anima 模型缺少 VAE 路径".to_string())?, model.9.as_deref().ok_or_else(|| "Anima 模型缺少 VAE 文件名".to_string())?, "vae")?;
    }
    validate_model_snapshot(
        settings,
        &model.3,
        model.5,
        model.6,
        model.8.as_deref(),
        model.10.as_deref(),
        &model.1,
    )?;
    let loras = selected_lora_snapshots(&transaction, settings, &input.loras)?;
    // 非自定义预设必须由核心按实际底模重新解析，避免旧页面或篡改请求降低质量档语义。
    let parameters = resolve_generation_parameters(&input, &model.1, &model.2);
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let seed = input.seed.unwrap_or_else(random_seed);
    transaction.execute("INSERT INTO local_jobs (id,status,progress,prompt,negative_prompt,model_id,model_display_name,workflow_kind,model_file_name,model_relative_path,model_sha256,text_encoder_file_name,vae_file_name,width,height,quality_preset,steps,cfg,sampler_name,scheduler_name,sampling_max_edge,sampling_pixel_budget,aspect_step_threshold,aspect_adjusted_steps,upscale_method,quality_prompt_enabled,quality_prefix,default_negative_enabled,default_negative_prompt,seed,privacy,created_at,updated_at) VALUES (?1,'queued',0,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?30)", params![id, input.prompt.trim(), input.negative_prompt.as_deref().map(str::trim).filter(|value| !value.is_empty()), input.model_id, model.0, model.1, model.2, model.3, model.4, model.7, model.9, input.width, input.height, parameters.quality_preset, parameters.steps, parameters.cfg, parameters.sampler_name, parameters.scheduler_name, parameters.sampling_max_edge, parameters.sampling_pixel_budget, parameters.aspect_step_threshold, parameters.aspect_adjusted_steps, parameters.upscale_method, parameters.quality_prompt_enabled, parameters.quality_prefix, parameters.default_negative_enabled, parameters.default_negative_prompt, seed, input.privacy, now]).map_err(|error| format!("创建本地任务失败：{error}"))?;
    for (sequence, lora) in loras.iter().enumerate() {
        let trigger_words_json = serde_json::to_string(&lora.trigger_words).map_err(|error| format!("序列化任务 LoRA 触发词失败：{error}"))?;
        transaction.execute("INSERT INTO local_job_loras (job_id,sequence,lora_id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,strength,clip_strength,trigger_words_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)", params![id, sequence, lora.id, lora.title, lora.r#type, lora.file_name, lora.relative_path, lora.sha256, lora.byte_size, lora.modified_ms, lora.strength, lora.clip_strength, trigger_words_json]).map_err(|error| format!("保存任务 LoRA 快照失败：{error}"))?;
    }
    transaction.commit().map_err(|error| format!("提交本地任务事务失败：{error}"))?;
    read_job(database, &id)?.ok_or_else(|| "本地任务创建后不存在".into())
}

/** 返回最近 100 个本地任务，后续图库级数据使用分页接口扩展。 */
pub fn list_jobs(database: &Connection) -> Result<Vec<DesktopLocalJobView>, String> {
    let mut statement = database
        .prepare(&job_query("ORDER BY j.created_at DESC LIMIT 100"))
        .map_err(|error| format!("读取本地任务列表失败：{error}"))?;
    let rows = statement
        .query_map([], job_from_row)
        .map_err(|error| format!("查询本地任务列表失败：{error}"))?;
    let mut jobs = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析本地任务列表失败：{error}"))?;
    for job in &mut jobs {
        job.loras = read_job_loras(database, &job.id)?;
        job.attempts = read_attempts(database, &job.id)?;
    }
    Ok(jobs)
}

/** 排队任务直接进入取消终态，运行中任务只写取消标记并由 Worker 中断对应 prompt。 */
pub fn cancel_job(database: &Connection, id: &str) -> Result<DesktopLocalJobView, String> {
    let now = Utc::now().to_rfc3339();
    let status: Option<String> = database
        .query_row("SELECT status FROM local_jobs WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| format!("读取取消任务失败：{error}"))?;
    let status = status.ok_or_else(|| "本地任务不存在".to_string())?;
    if status == "queued" {
        database.execute("UPDATE local_jobs SET status='cancelled',progress=0,cancel_requested=1,completed_at=?2,updated_at=?2 WHERE id=?1 AND status='queued'", params![id, now]).map_err(|error| format!("取消排队任务失败：{error}"))?;
    } else if status == "running" {
        database.execute("UPDATE local_jobs SET cancel_requested=1,updated_at=?2 WHERE id=?1 AND status='running'", params![id, now]).map_err(|error| format!("请求取消运行任务失败：{error}"))?;
    }
    read_job(database, id)?.ok_or_else(|| "本地任务取消后不存在".into())
}

fn scheduler_loop(
    database_path: &Path,
    app_data_dir: &Path,
    runtime: &RuntimeController,
    gpu_workload: &Arc<GpuWorkloadCoordinator>,
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
        let Some(gpu_guard) = gpu_workload.acquire(stopping) else { break; };
        match claim_next_job(&mut database) {
            Ok(Some(job)) => { execute_job(&database, app_data_dir, runtime, app, stopping, job); drop(gpu_guard); }
            Ok(None) => { drop(gpu_guard); wait_for_work(wake_signal, stopping); }
            Err(_) => { drop(gpu_guard); thread::sleep(Duration::from_secs(2)); }
        }
    }
}

fn claim_next_job(database: &mut Connection) -> Result<Option<LocalJobExecution>, String> {
    let transaction = database
        .transaction()
        .map_err(|error| format!("开启本地调度事务失败：{error}"))?;
    let id: Option<String> = transaction.query_row("SELECT id FROM local_jobs WHERE status='queued' AND cancel_requested=0 ORDER BY created_at ASC LIMIT 1", [], |row| row.get(0)).optional().map_err(|error| format!("读取本地队列失败：{error}"))?;
    let Some(id) = id else {
        transaction
            .commit()
            .map_err(|error| format!("提交空闲调度事务失败：{error}"))?;
        return Ok(None);
    };
    let now = Utc::now().to_rfc3339();
    if transaction.execute("UPDATE local_jobs SET status='running',progress=1,started_at=?2,updated_at=?2 WHERE id=?1 AND status='queued' AND cancel_requested=0", params![id, now]).map_err(|error| format!("领取本地任务失败：{error}"))? != 1 { transaction.rollback().map_err(|error| format!("回滚任务领取失败：{error}"))?; return Ok(None); }
    let attempt_number: u32 = transaction
        .query_row(
            "SELECT COALESCE(MAX(attempt_number),0)+1 FROM local_job_attempts WHERE job_id=?1",
            [&id],
            |row| row.get(0),
        )
        .map_err(|error| format!("计算本地任务尝试次数失败：{error}"))?;
    let attempt_id = Uuid::new_v4().to_string();
    transaction.execute("INSERT INTO local_job_attempts (id,job_id,attempt_number,status,started_at) VALUES (?1,?2,?3,'running',?4)", params![attempt_id, id, attempt_number, now]).map_err(|error| format!("创建本地任务尝试失败：{error}"))?;
    let mut job = execution_from_transaction(&transaction, &id)?;
    job.attempt_id = attempt_id;
    transaction
        .commit()
        .map_err(|error| format!("提交任务领取失败：{error}"))?;
    Ok(Some(job))
}

fn execute_job(
    database: &Connection,
    app_data_dir: &Path,
    runtime: &RuntimeController,
    app: &AppHandle,
    stopping: &AtomicBool,
    job: LocalJobExecution,
) {
    emit_job(database, app, &job.id);
    let outcome = (|| {
        let settings = load_settings(database)?;
        validate_execution_model(database, &settings, &job)?;
        validate_execution_loras(&settings, &job.loras)?;
        runtime
            .self_test(&settings, app_data_dir)
            .map_err(GenerationFailure::Failed)?;
        update_progress(database, &job.id, 5)?;
        emit_job(database, app, &job.id);
        let endpoint = runtime.endpoint().map_err(GenerationFailure::Failed)?;
        let request = GenerationRequest {
            job_id: job.id.clone(),
            workflow_kind: job.workflow_kind.clone(),
            model_file_name: job.model_file_name.clone(),
            text_encoder_file_name: job.text_encoder_file_name.clone(),
            vae_file_name: job.vae_file_name.clone(),
            loras: job.loras.iter().map(|lora| GenerationLora { file_name: lora.file_name.clone(), strength: lora.strength, clip_strength: lora.clip_strength }).collect(),
            prompt: job.prompt.clone(),
            negative_prompt: job.negative_prompt.clone(),
            width: job.width,
            height: job.height,
            steps: job.steps,
            cfg: job.cfg,
            sampler_name: job.sampler_name.clone(),
            scheduler_name: job.scheduler_name.clone(),
            sampling_max_edge: job.sampling_max_edge,
            sampling_pixel_budget: job.sampling_pixel_budget,
            aspect_step_threshold: job.aspect_step_threshold,
            aspect_adjusted_steps: job.aspect_adjusted_steps,
            upscale_method: job.upscale_method.clone(),
            quality_prompt_enabled: job.quality_prompt_enabled,
            quality_prefix: job.quality_prefix.clone(),
            default_negative_enabled: job.default_negative_enabled,
            default_negative_prompt: job.default_negative_prompt.clone(),
            seed: job.seed,
            output_root: PathBuf::from(&settings.output_root),
            runtime_output_root: app_data_dir.join("runtime-state").join("comfy-output"),
        };
        let result = generation::generate_image(
            &endpoint,
            request,
            |prompt_id| {
                let now = Utc::now().to_rfc3339();
                let transaction = database
                    .unchecked_transaction()
                    .map_err(|error| format!("开启 Runtime ID 事务失败：{error}"))?;
                transaction.execute("UPDATE local_jobs SET runtime_prompt_id=?2,progress=10,updated_at=?3 WHERE id=?1 AND status='running'", params![job.id, prompt_id, now]).map_err(|error| format!("保存 Runtime 任务 ID 失败：{error}"))?;
                transaction.execute("UPDATE local_job_attempts SET runtime_prompt_id=?2 WHERE id=?1 AND status='running'", params![job.attempt_id, prompt_id]).map_err(|error| format!("保存尝试 Runtime ID 失败：{error}"))?;
                transaction
                    .commit()
                    .map_err(|error| format!("提交 Runtime ID 事务失败：{error}"))?;
                emit_job(database, app, &job.id);
                Ok(())
            },
            || stopping.load(Ordering::SeqCst) || cancel_requested(database, &job.id),
        )?;
        Ok((result, settings.auto_upload))
    })();
    match outcome {
        Ok((result, auto_upload)) => finish_success(database, app, &job, result, auto_upload),
        Err(GenerationFailure::Cancelled) if stopping.load(Ordering::SeqCst) => {
            requeue_interrupted(database, app, &job.id)
        }
        Err(GenerationFailure::Cancelled) => finish_cancelled(database, app, &job.id),
        Err(GenerationFailure::Failed(error)) => finish_failed(database, app, &job.id, &error),
    }
}

fn finish_success(
    database: &Connection,
    app: &AppHandle,
    job: &LocalJobExecution,
    result: GenerationResult,
    auto_upload: bool,
) {
    let now = Utc::now().to_rfc3339();
    let transaction = match database.unchecked_transaction() {
        Ok(transaction) => transaction,
        Err(error) => {
            finish_failed(
                database,
                app,
                &job.id,
                &format!("保存任务终态失败：{error}"),
            );
            return;
        }
    };
    let artifact_id = Uuid::new_v4().to_string();
    let gallery_id = Uuid::new_v4().to_string();
    // 自动上传只作用于已经保存会话且设置开启的用户；未登录或关闭开关时仍完整保存本地产物。
    let publish_to_gallery = auto_upload && auth::has_stored_session().unwrap_or(false);
    let inserted = transaction.execute("INSERT INTO local_artifacts (id,job_id,path,sha256,byte_size,mime_type,width,height,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![artifact_id, job.id, result.path, result.sha256, result.byte_size, result.mime_type, result.width, result.height, now]).and_then(|_| {
        if publish_to_gallery {
            transaction.execute("INSERT INTO gallery_sync_queue (id,local_task_id,artifact_path,artifact_sha256,privacy,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'queued',?6,?6) ON CONFLICT(local_task_id,artifact_sha256) DO UPDATE SET privacy=excluded.privacy,artifact_path=excluded.artifact_path,updated_at=excluded.updated_at", params![gallery_id, job.id, result.path, result.sha256, job.privacy, now])
        } else { Ok(0) }
    }).and_then(|_| transaction.execute("UPDATE local_job_attempts SET status='succeeded',runtime_prompt_id=?2,error=NULL,completed_at=?3 WHERE id=?1 AND status='running'", params![job.attempt_id, result.runtime_prompt_id, now])).and_then(|_| transaction.execute("UPDATE local_jobs SET status='succeeded',progress=100,runtime_prompt_id=?2,error=NULL,completed_at=?3,updated_at=?3 WHERE id=?1 AND status='running'", params![job.id, result.runtime_prompt_id, now]));
    if inserted.is_err() || transaction.commit().is_err() {
        finish_failed(database, app, &job.id, "保存本地产物终态失败");
        return;
    }
    emit_job(database, app, &job.id);
}

fn finish_failed(database: &Connection, app: &AppHandle, id: &str, error: &str) {
    let message = error.chars().take(1000).collect::<String>();
    let now = Utc::now().to_rfc3339();
    let _ = database.execute("UPDATE local_job_attempts SET status='failed',error=?2,completed_at=?3 WHERE job_id=?1 AND status='running'", params![id, message, now]);
    let _ = database.execute("UPDATE local_jobs SET status='failed',progress=0,error=?2,completed_at=?3,updated_at=?3 WHERE id=?1 AND status='running'", params![id, message, now]);
    emit_job(database, app, id);
}

fn finish_cancelled(database: &Connection, app: &AppHandle, id: &str) {
    let now = Utc::now().to_rfc3339();
    let _ = database.execute("UPDATE local_job_attempts SET status='cancelled',completed_at=?2 WHERE job_id=?1 AND status='running'", params![id, now]);
    let _ = database.execute("UPDATE local_jobs SET status='cancelled',progress=0,error=NULL,completed_at=?2,updated_at=?2 WHERE id=?1 AND status='running'", params![id, now]);
    emit_job(database, app, id);
}

fn requeue_interrupted(database: &Connection, app: &AppHandle, id: &str) {
    let now = Utc::now().to_rfc3339();
    let _ = database.execute("UPDATE local_job_attempts SET status='interrupted',completed_at=?2 WHERE job_id=?1 AND status='running'", params![id, now]);
    let _ = database.execute("UPDATE local_jobs SET status='queued',progress=0,runtime_prompt_id=NULL,started_at=NULL,error=NULL,cancel_requested=0,updated_at=?2 WHERE id=?1 AND status='running'", params![id, now]);
    emit_job(database, app, id);
}

fn execution_from_transaction(
    transaction: &Transaction<'_>,
    id: &str,
) -> Result<LocalJobExecution, String> {
    let mut job = transaction.query_row("SELECT j.id,j.workflow_kind,j.model_file_name,j.model_relative_path,j.model_sha256,m.byte_size,m.model_modified_ms,j.text_encoder_file_name,j.vae_file_name,j.prompt,j.negative_prompt,j.width,j.height,j.steps,j.cfg,j.sampler_name,j.scheduler_name,j.sampling_max_edge,j.sampling_pixel_budget,j.aspect_step_threshold,j.aspect_adjusted_steps,j.upscale_method,j.quality_prompt_enabled,j.quality_prefix,j.default_negative_enabled,j.default_negative_prompt,j.seed,j.privacy FROM local_jobs j JOIN local_models m ON m.id=j.model_id WHERE j.id=?1", [id], |row| Ok(LocalJobExecution { id: row.get(0)?, attempt_id: String::new(), workflow_kind: row.get(1)?, model_file_name: row.get(2)?, model_relative_path: row.get(3)?, model_sha256: row.get(4)?, model_byte_size: row.get(5)?, model_modified_ms: row.get(6)?, text_encoder_file_name: row.get(7)?, vae_file_name: row.get(8)?, prompt: row.get(9)?, negative_prompt: row.get(10)?, width: row.get(11)?, height: row.get(12)?, steps: row.get(13)?, cfg: row.get(14)?, sampler_name: row.get(15)?, scheduler_name: row.get(16)?, sampling_max_edge: row.get(17)?, sampling_pixel_budget: row.get(18)?, aspect_step_threshold: row.get(19)?, aspect_adjusted_steps: row.get(20)?, upscale_method: row.get(21)?, quality_prompt_enabled: row.get::<_, i64>(22)? != 0, quality_prefix: row.get(23)?, default_negative_enabled: row.get::<_, i64>(24)? != 0, default_negative_prompt: row.get(25)?, seed: row.get(26)?, privacy: row.get(27)?, loras: Vec::new() })).map_err(|error| format!("读取任务执行快照失败：{error}"))?;
    job.loras = execution_loras(transaction, id)?;
    Ok(job)
}

fn validate_job_input(input: &DesktopLocalJobCreateInput) -> Result<(), String> {
    if input.prompt.trim().is_empty() || input.prompt.chars().count() > 100_000 {
        return Err("提示词长度不正确".into());
    }
    if input
        .negative_prompt
        .as_ref()
        .is_some_and(|value| value.chars().count() > 100_000)
    {
        return Err("负面提示词超过 100000 字符".into());
    }
    if !(64..=1536).contains(&input.width)
        || !(64..=1536).contains(&input.height)
        || input.width % 8 != 0
        || input.height % 8 != 0
    {
        return Err("生成宽高必须是 64–1536 范围内的 8 倍数".into());
    }
    if !matches!(input.quality_preset.as_str(), "fast" | "quality" | "extreme" | "custom") {
        return Err("生成质量预设不受支持".into());
    }
    if !(1..=80).contains(&input.steps) || !(0.1..=20.0).contains(&input.cfg) {
        return Err("采样步数或 CFG 超出范围".into());
    }
    if !matches!(input.sampler_name.as_str(), "er_sde" | "euler" | "euler_ancestral")
        || !matches!(input.scheduler_name.as_str(), "normal" | "simple")
    {
        return Err("采样器或调度器不受支持".into());
    }
    if !(512..=2048).contains(&input.sampling_max_edge)
        || !(262_144..=4_194_304).contains(&input.sampling_pixel_budget)
        || !(1.0..=4.0).contains(&input.aspect_step_threshold)
        || !(1..=80).contains(&input.aspect_adjusted_steps)
        || !matches!(input.upscale_method.as_str(), "nearest-exact" | "bilinear" | "area" | "bicubic" | "lanczos")
    {
        return Err("高级采样参数超出支持范围".into());
    }
    if !matches!(input.privacy.as_str(), "public" | "private") {
        return Err("图库权限不正确".into());
    }
    if input.loras.iter().any(|lora| !(-2.0..=2.0).contains(&lora.strength) || !lora.strength.is_finite() || !(-2.0..=2.0).contains(&lora.clip_strength) || !lora.clip_strength.is_finite()) {
        return Err("LoRA 模型与 CLIP 强度必须在 -2–2 之间".into());
    }
    let unique_ids = input.loras.iter().map(|lora| lora.id.as_str()).collect::<std::collections::HashSet<_>>();
    if unique_ids.len() != input.loras.len() { return Err("同一 LoRA 不能重复选择".into()); }
    Ok(())
}

/** 质量档完整复刻当前生产 GPU 的平衡质量参数，快速和极致只调整采样预算与步数。 */
fn resolve_generation_parameters(input: &DesktopLocalJobCreateInput, workflow_kind: &str, model_file_name: &str) -> ResolvedGenerationParameters {
    let (model_cfg, sampler, scheduler, prefix, negative) = model_quality_profile(workflow_kind, model_file_name);
    let distilled_anima = workflow_kind == "anima" && model_file_name.to_ascii_lowercase().contains("anima8step");
    let (steps, adjusted_steps, max_edge, pixel_budget) = match (distilled_anima, input.quality_preset.as_str()) {
        (true, "fast") => (8, 8, 1280, 786_432),
        (true, "quality") => (12, 12, 1536, 1_350_000),
        (true, "extreme") => (30, 30, 1536, 1_350_000),
        (false, "fast") => (20, 18, 1280, 786_432),
        (false, "quality") => (37, 34, 1536, 1_350_000),
        (false, "extreme") => (45, 42, 1792, 2_073_600),
        _ => (input.steps, input.aspect_adjusted_steps, input.sampling_max_edge, input.sampling_pixel_budget),
    };
    let custom = input.quality_preset == "custom";
    let quality_prompt_enabled = if custom { input.quality_prompt_enabled } else { true };
    let default_negative_enabled = if custom { input.default_negative_enabled } else { true };
    ResolvedGenerationParameters {
        quality_preset: input.quality_preset.clone(),
        steps,
        cfg: if custom { input.cfg } else { model_cfg },
        sampler_name: if custom { input.sampler_name.clone() } else { sampler.into() },
        scheduler_name: if custom { input.scheduler_name.clone() } else { scheduler.into() },
        sampling_max_edge: max_edge,
        sampling_pixel_budget: pixel_budget,
        aspect_step_threshold: if custom { input.aspect_step_threshold } else { 1.5 },
        // 极端画幅只能减少或保持步数，任务快照直接保存 Runtime 最终会使用的值。
        aspect_adjusted_steps: adjusted_steps.min(steps),
        upscale_method: if custom { input.upscale_method.clone() } else { "lanczos".into() },
        quality_prompt_enabled,
        quality_prefix: quality_prompt_enabled.then(|| prefix.into()),
        default_negative_enabled,
        default_negative_prompt: default_negative_enabled.then(|| negative.into()),
    }
}

/** 根据正式模型目录返回与服务器一致的 CFG、采样器和提示词质量配置。 */
fn model_quality_profile(workflow_kind: &str, model_file_name: &str) -> (f64, &'static str, &'static str, &'static str, &'static str) {
    const NEGATIVE: &str = "worst quality, low quality, score_1, score_2, score_3, artist name";
    let file_name = model_file_name.to_ascii_lowercase();
    if workflow_kind != "anima" {
        return (5.0, "euler", "normal", "masterpiece, best quality", NEGATIVE);
    }
    if file_name.contains("anima8step") {
        return (1.0, "euler_ancestral", "normal", "masterpiece, best quality, score_7, safe, very aesthetic, ultra detailed, pale skin, fair skin, high contrast", NEGATIVE);
    }
    if file_name.contains("realskin") {
        return (4.0, "euler_ancestral", "normal", "best quality, score_7, score_9, very aesthetic, ultra detailed, fair skin, high contrast, photorealistic, raw photo, photo background", NEGATIVE);
    }
    if file_name.contains("3dharem") {
        return (4.0, "euler_ancestral", "normal", "best quality, score_7, score_9, very aesthetic, ultra detailed, high contrast", NEGATIVE);
    }
    if file_name.contains("waianima") {
        return (4.5, "euler_ancestral", "normal", "masterpiece, best quality, score_7", "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, lowres, censor");
    }
    if file_name.contains("bulldozer") {
        return (4.0, "er_sde", "simple", "masterpiece, best quality, score_7, very aesthetic", "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, sepia, muscular female");
    }
    (4.0, "er_sde", "simple", "masterpiece, best quality, score_7", NEGATIVE)
}

/** 在创建任务的同一事务中读取并校验 LoRA，标题变化不会改写历史任务快照。 */
fn selected_lora_snapshots(transaction: &Transaction<'_>, settings: &DesktopSettings, selections: &[DesktopLocalLoraSelectionInput]) -> Result<Vec<LocalJobLoraExecution>, String> {
    let mut snapshots = Vec::with_capacity(selections.len());
    let mut content_hashes = std::collections::HashSet::new();
    for selection in selections {
        let lora = transaction.query_row("SELECT id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json FROM local_loras WHERE id=?1", [&selection.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, u64>(6)?, row.get::<_, u64>(7)?, row.get::<_, String>(8)?))).optional().map_err(|error| format!("读取所选 LoRA 失败：{error}"))?.ok_or_else(|| "所选 LoRA 不存在".to_string())?;
        if !content_hashes.insert(lora.5.clone()) { return Err("不能选择内容相同的多个 LoRA".into()); }
        validate_registered_asset(&lora.4, &lora.3, "loras")?;
        validate_lora_snapshot(settings, &lora.4, lora.6, lora.7)?;
        let trigger_words = serde_json::from_str(&lora.8).map_err(|error| format!("解析 LoRA 触发词失败：{error}"))?;
        snapshots.push(LocalJobLoraExecution { id: lora.0, title: lora.1, r#type: lora.2, file_name: lora.3, relative_path: lora.4, sha256: lora.5, byte_size: lora.6, modified_ms: lora.7, strength: selection.strength, clip_strength: selection.clip_strength, trigger_words });
    }
    Ok(snapshots)
}

fn validate_model_snapshot(
    settings: &DesktopSettings,
    model_relative_path: &str,
    byte_size: u64,
    modified_ms: u64,
    text_relative_path: Option<&str>,
    vae_relative_path: Option<&str>,
    workflow_kind: &str,
) -> Result<(), String> {
    let root = Path::new(&settings.model_root);
    let path = controlled_join(root, model_relative_path)?;
    let metadata = path
        .metadata()
        .map_err(|_| "底模文件不存在，请重新导入".to_string())?;
    if !metadata.is_file()
        || metadata.len() != byte_size
        || metadata_modified_ms(&metadata)? != modified_ms
    {
        return Err("底模文件已变化，请重新导入后提交".into());
    }
    if workflow_kind == "anima" {
        for relative in [text_relative_path, vae_relative_path] {
            let relative = relative.ok_or_else(|| "Anima 模型登记缺少组件".to_string())?;
            if !controlled_join(root, relative)?.is_file() {
                return Err("Anima 模型组件不存在，请重新导入".into());
            }
        }
    }
    Ok(())
}

/** 校验 LoRA 仍是创建任务时登记的同一文件，禁止静默使用被替换的权重。 */
fn validate_lora_snapshot(settings: &DesktopSettings, relative_path: &str, byte_size: u64, modified_ms: u64) -> Result<(), String> {
    let path = controlled_join(Path::new(&settings.model_root), relative_path)?;
    let metadata = path.metadata().map_err(|_| "LoRA 文件不存在，请重新导入".to_string())?;
    if !metadata.is_file() || metadata.len() != byte_size || metadata_modified_ms(&metadata)? != modified_ms {
        return Err("LoRA 文件已变化，请重新导入后提交".into());
    }
    Ok(())
}

fn validate_execution_model(
    database: &Connection,
    settings: &DesktopSettings,
    job: &LocalJobExecution,
) -> Result<(), GenerationFailure> {
    let current: Option<(String, u64, u64, Option<String>, Option<String>)> = database.query_row("SELECT model_sha256,byte_size,model_modified_ms,text_encoder_relative_path,vae_relative_path FROM local_models WHERE model_sha256=?1", [&job.model_sha256], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional().map_err(|error| GenerationFailure::Failed(format!("读取执行模型失败：{error}")))?;
    let (_, size, modified, text, vae) =
        current.ok_or_else(|| GenerationFailure::Failed("任务底模登记已不存在".into()))?;
    if size != job.model_byte_size || modified != job.model_modified_ms {
        return Err(GenerationFailure::Failed(
            "任务底模在排队期间发生变化".into(),
        ));
    }
    validate_registered_asset(&job.model_relative_path, &job.model_file_name, if job.workflow_kind == "anima" { "diffusion_models" } else { "checkpoints" }).map_err(GenerationFailure::Failed)?;
    if job.workflow_kind == "anima" {
        validate_registered_asset(text.as_deref().ok_or_else(|| GenerationFailure::Failed("任务文本编码器登记已不存在".into()))?, job.text_encoder_file_name.as_deref().ok_or_else(|| GenerationFailure::Failed("任务缺少文本编码器文件名".into()))?, "text_encoders").map_err(GenerationFailure::Failed)?;
        validate_registered_asset(vae.as_deref().ok_or_else(|| GenerationFailure::Failed("任务 VAE 登记已不存在".into()))?, job.vae_file_name.as_deref().ok_or_else(|| GenerationFailure::Failed("任务缺少 VAE 文件名".into()))?, "vae").map_err(GenerationFailure::Failed)?;
    }
    validate_model_snapshot(
        settings,
        &job.model_relative_path,
        size,
        modified,
        text.as_deref(),
        vae.as_deref(),
        &job.workflow_kind,
    )
    .map_err(GenerationFailure::Failed)
}

/** 任务领取后再次校验全部 LoRA 快照，排队期间被替换的文件不会进入 Runtime。 */
fn validate_execution_loras(settings: &DesktopSettings, loras: &[LocalJobLoraExecution]) -> Result<(), GenerationFailure> {
    for lora in loras {
        validate_registered_asset(&lora.relative_path, &lora.file_name, "loras").map_err(GenerationFailure::Failed)?;
        validate_lora_snapshot(settings, &lora.relative_path, lora.byte_size, lora.modified_ms).map_err(GenerationFailure::Failed)?;
    }
    Ok(())
}

/** 确保校验过的受控文件与最终写入 ComfyUI 节点的文件名严格指向同一资源。 */
fn validate_registered_asset(relative: &str, file_name: &str, category: &str) -> Result<(), String> {
    let relative_path = Path::new(relative);
    let file_path = Path::new(file_name);
    if file_path.components().count() != 1
        || !matches!(file_path.components().next(), Some(std::path::Component::Normal(_)))
        || relative_path.parent() != Some(Path::new(category))
        || relative_path.file_name() != file_path.file_name()
    {
        return Err(format!("模型登记路径与 Runtime 文件名不一致：{category}"));
    }
    Ok(())
}

fn controlled_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("模型登记路径不安全".into());
    }
    Ok(root.join(path))
}

fn load_settings(database: &Connection) -> Result<DesktopSettings, GenerationFailure> {
    database.query_row("SELECT theme_mode,font_scale,dependency_source,default_privacy,auto_upload,model_root,output_root,runtime_root,upload_concurrency,wifi_only,bandwidth_limit_kib FROM desktop_settings WHERE id=1", [], |row| Ok(DesktopSettings { theme_mode: row.get(0)?, font_scale: row.get(1)?, dependency_source: row.get(2)?, default_privacy: row.get(3)?, auto_upload: row.get::<_, i64>(4)? != 0, model_root: row.get(5)?, output_root: row.get(6)?, runtime_root: row.get(7)?, upload_concurrency: row.get(8)?, wifi_only: row.get::<_, i64>(9)? != 0, bandwidth_limit_kib: row.get(10)? })).map_err(|error| GenerationFailure::Failed(format!("读取本地调度设置失败：{error}")))
}

fn read_job(database: &Connection, id: &str) -> Result<Option<DesktopLocalJobView>, String> {
    let mut job = database
        .query_row(&job_query("WHERE j.id=?1"), [id], job_from_row)
        .optional()
        .map_err(|error| format!("读取本地任务失败：{error}"))?;
    if let Some(job) = &mut job {
        job.loras = read_job_loras(database, id)?;
        job.attempts = read_attempts(database, id)?;
    }
    Ok(job)
}

/** 读取任务创建时固化的 LoRA 外显与强度，不回查可变标题。 */
fn read_job_loras(database: &Connection, job_id: &str) -> Result<Vec<DesktopLocalJobLoraView>, String> {
    let mut statement = database.prepare("SELECT lora_id,title,type,file_name,sha256,strength,clip_strength,trigger_words_json FROM local_job_loras WHERE job_id=?1 ORDER BY sequence ASC").map_err(|error| format!("读取任务 LoRA 快照失败：{error}"))?;
    let rows = statement.query_map([job_id], |row| {
        let trigger_words_json: String = row.get(7)?;
        let trigger_words = serde_json::from_str(&trigger_words_json).map_err(|error| rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error)))?;
        Ok(DesktopLocalJobLoraView { id: row.get(0)?, title: row.get(1)?, r#type: row.get(2)?, file_name: row.get(3)?, sha256: row.get(4)?, strength: row.get(5)?, clip_strength: row.get(6)?, trigger_words })
    }).map_err(|error| format!("查询任务 LoRA 快照失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析任务 LoRA 快照失败：{error}"))
}

/** 调度领取时读取包含文件元数据的 LoRA 执行快照。 */
fn execution_loras(transaction: &Transaction<'_>, job_id: &str) -> Result<Vec<LocalJobLoraExecution>, String> {
    let mut statement = transaction.prepare("SELECT lora_id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,strength,clip_strength,trigger_words_json FROM local_job_loras WHERE job_id=?1 ORDER BY sequence ASC").map_err(|error| format!("读取执行 LoRA 快照失败：{error}"))?;
    let rows = statement.query_map([job_id], |row| {
        let trigger_words_json: String = row.get(10)?;
        let trigger_words = serde_json::from_str(&trigger_words_json).map_err(|error| rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(error)))?;
        Ok(LocalJobLoraExecution { id: row.get(0)?, title: row.get(1)?, r#type: row.get(2)?, file_name: row.get(3)?, relative_path: row.get(4)?, sha256: row.get(5)?, byte_size: row.get(6)?, modified_ms: row.get(7)?, strength: row.get(8)?, clip_strength: row.get(9)?, trigger_words })
    }).map_err(|error| format!("查询执行 LoRA 快照失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析执行 LoRA 快照失败：{error}"))
}

fn read_attempts(
    database: &Connection,
    job_id: &str,
) -> Result<Vec<DesktopLocalJobAttemptView>, String> {
    let mut statement = database.prepare("SELECT id,attempt_number,status,runtime_prompt_id,error,started_at,completed_at FROM local_job_attempts WHERE job_id=?1 ORDER BY attempt_number ASC").map_err(|error| format!("读取任务尝试失败：{error}"))?;
    let rows = statement
        .query_map([job_id], |row| {
            Ok(DesktopLocalJobAttemptView {
                id: row.get(0)?,
                attempt_number: row.get(1)?,
                status: row.get(2)?,
                runtime_prompt_id: row.get(3)?,
                error: row.get(4)?,
                started_at: row.get(5)?,
                completed_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("查询任务尝试失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析任务尝试失败：{error}"))
}

fn job_query(suffix: &str) -> String {
    format!("SELECT j.id,j.status,j.progress,j.prompt,j.negative_prompt,j.model_id,j.model_display_name,j.model_sha256,j.width,j.height,j.quality_preset,j.steps,j.cfg,j.sampler_name,j.scheduler_name,j.sampling_max_edge,j.sampling_pixel_budget,j.aspect_step_threshold,j.aspect_adjusted_steps,j.upscale_method,j.quality_prompt_enabled,j.quality_prefix,j.default_negative_enabled,j.default_negative_prompt,j.seed,j.privacy,j.runtime_prompt_id,j.error,j.created_at,j.started_at,j.completed_at,j.updated_at,a.path,a.sha256,a.byte_size,a.mime_type,a.width,a.height FROM local_jobs j LEFT JOIN local_artifacts a ON a.job_id=j.id {suffix}")
}

fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DesktopLocalJobView> {
    let artifact_path: Option<String> = row.get(32)?;
    let artifact = if let Some(path) = artifact_path {
        Some(DesktopLocalArtifactView {
            path,
            sha256: row.get(33)?,
            byte_size: row.get(34)?,
            mime_type: row.get(35)?,
            width: row.get(36)?,
            height: row.get(37)?,
        })
    } else {
        None
    };
    Ok(DesktopLocalJobView {
        id: row.get(0)?,
        status: row.get(1)?,
        progress: row.get(2)?,
        prompt: row.get(3)?,
        negative_prompt: row.get(4)?,
        model_id: row.get(5)?,
        model_display_name: row.get(6)?,
        model_sha256: row.get(7)?,
        parameters: DesktopLocalJobParametersView {
            width: row.get(8)?,
            height: row.get(9)?,
            quality_preset: row.get(10)?,
            steps: row.get(11)?,
            cfg: row.get(12)?,
            sampler_name: row.get(13)?,
            scheduler_name: row.get(14)?,
            sampling_max_edge: row.get(15)?,
            sampling_pixel_budget: row.get(16)?,
            aspect_step_threshold: row.get(17)?,
            aspect_adjusted_steps: row.get(18)?,
            upscale_method: row.get(19)?,
            quality_prompt_enabled: row.get::<_, i64>(20)? != 0,
            quality_prefix: row.get(21)?,
            default_negative_enabled: row.get::<_, i64>(22)? != 0,
            default_negative_prompt: row.get(23)?,
            seed: row.get(24)?,
        },
        privacy: row.get(25)?,
        runtime_prompt_id: row.get(26)?,
        error: row.get(27)?,
        loras: Vec::new(),
        attempts: Vec::new(),
        artifact,
        created_at: row.get(28)?,
        started_at: row.get(29)?,
        completed_at: row.get(30)?,
        updated_at: row.get(31)?,
    })
}

fn update_progress(
    database: &Connection,
    id: &str,
    progress: u32,
) -> Result<(), GenerationFailure> {
    database
        .execute(
            "UPDATE local_jobs SET progress=?2,updated_at=?3 WHERE id=?1 AND status='running'",
            params![id, progress, Utc::now().to_rfc3339()],
        )
        .map_err(|error| GenerationFailure::Failed(format!("更新本地任务进度失败：{error}")))?;
    Ok(())
}

fn cancel_requested(database: &Connection, id: &str) -> bool {
    database
        .query_row(
            "SELECT cancel_requested FROM local_jobs WHERE id=?1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .unwrap_or(true)
}

fn emit_job(database: &Connection, app: &AppHandle, id: &str) {
    if let Ok(Some(job)) = read_job(database, id) {
        let _ = app.emit("desktop-local-job-updated", job);
    }
}

fn wait_for_work(signal: &(Mutex<bool>, Condvar), stopping: &AtomicBool) {
    let (lock, condition) = signal;
    let Ok(pending) = lock.lock() else {
        thread::sleep(Duration::from_secs(1));
        return;
    };
    let Ok((mut pending, _)) =
        condition.wait_timeout_while(pending, Duration::from_secs(2), |pending| {
            !*pending && !stopping.load(Ordering::SeqCst)
        })
    else {
        return;
    };
    *pending = false;
}

fn metadata_modified_ms(metadata: &fs::Metadata) -> Result<u64, String> {
    metadata
        .modified()
        .map_err(|error| format!("读取模型修改时间失败：{error}"))?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "模型修改时间早于系统纪元".to_string())
}

fn random_seed() -> u32 {
    (Uuid::new_v4().as_u128() % 2_147_483_648) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{DesktopState, LocalLoraRegistration, LocalModelRegistration};

    #[test]
    fn job_validation_keeps_dimensions_aligned_and_conditioning_separate() {
        let input = DesktopLocalJobCreateInput {
            model_id: Uuid::new_v4().to_string(),
            prompt: "subject".into(),
            negative_prompt: Some("bad anatomy".into()),
            width: 1024,
            height: 1536,
            quality_preset: "custom".into(),
            steps: 20,
            cfg: 5.0,
            sampler_name: "euler".into(),
            scheduler_name: "normal".into(),
            sampling_max_edge: 1536,
            sampling_pixel_budget: 1_350_000,
            aspect_step_threshold: 1.5,
            aspect_adjusted_steps: 18,
            upscale_method: "lanczos".into(),
            quality_prompt_enabled: true,
            default_negative_enabled: true,
            seed: Some(1),
            loras: Vec::new(),
            privacy: "private".into(),
        };
        assert!(validate_job_input(&input).is_ok());
        let mut invalid = input;
        invalid.width = 1025;
        assert!(validate_job_input(&invalid).is_err());
    }

    #[test]
    fn runtime_asset_name_must_match_the_validated_registered_path() {
        assert!(validate_registered_asset("diffusion_models/anima.safetensors", "anima.safetensors", "diffusion_models").is_ok());
        assert!(validate_registered_asset("loras/character.safetensors", "style.safetensors", "loras").is_err());
        assert!(validate_registered_asset("other/style.safetensors", "style.safetensors", "loras").is_err());
        assert!(validate_registered_asset("loras/nested/style.safetensors", "style.safetensors", "loras").is_err());
    }

    #[test]
    fn quality_preset_matches_production_anima_profile() {
        let mut input = DesktopLocalJobCreateInput {
            model_id: Uuid::new_v4().to_string(), prompt: "subject".into(), negative_prompt: None,
            width: 1024, height: 1024, quality_preset: "quality".into(), steps: 1, cfg: 1.0,
            sampler_name: "euler".into(), scheduler_name: "normal".into(), sampling_max_edge: 512,
            sampling_pixel_budget: 262_144, aspect_step_threshold: 4.0, aspect_adjusted_steps: 1,
            upscale_method: "nearest-exact".into(), quality_prompt_enabled: false, default_negative_enabled: false,
            seed: None, loras: Vec::new(), privacy: "public".into(),
        };
        let base = resolve_generation_parameters(&input, "anima", "anima-base-v1.0.safetensors");
        assert_eq!((base.steps, base.aspect_adjusted_steps, base.sampling_max_edge, base.sampling_pixel_budget), (37, 34, 1536, 1_350_000));
        assert_eq!((base.cfg, base.sampler_name.as_str(), base.scheduler_name.as_str()), (4.0, "er_sde", "simple"));
        assert!(base.quality_prompt_enabled && base.default_negative_enabled);
        input.quality_preset = "extreme".into();
        let real_skin = resolve_generation_parameters(&input, "anima", "miaomiaoRealskin_anima11.safetensors");
        assert_eq!((real_skin.steps, real_skin.cfg, real_skin.sampler_name.as_str()), (45, 4.0, "euler_ancestral"));
        input.quality_preset = "quality".into();
        let distilled = resolve_generation_parameters(&input, "anima", "miaomiaoHarem_anima8Step10.safetensors");
        assert_eq!((distilled.steps, distilled.aspect_adjusted_steps, distilled.cfg, distilled.sampler_name.as_str(), distilled.scheduler_name.as_str()), (12, 12, 1.0, "euler_ancestral", "normal"));
    }

    #[test]
    fn queued_job_is_persistent_and_cancellable() {
        let temporary = tempfile::tempdir().expect("创建本地任务临时目录");
        let state =
            DesktopState::initialize(temporary.path()).expect("初始化桌面数据库");
        let settings = state.load_settings().expect("读取设置");
        let model_path = Path::new(&settings.model_root)
            .join("checkpoints")
            .join("test.safetensors");
        fs::create_dir_all(model_path.parent().expect("模型父目录")).expect("创建模型目录");
        fs::write(&model_path, b"registered-model").expect("写入登记模型");
        let metadata = model_path.metadata().expect("读取模型元数据");
        let model = state
            .register_local_model(LocalModelRegistration {
                display_name: "测试底模".into(),
                family: "test".into(),
                workflow_kind: "checkpoint".into(),
                model_file_name: "test.safetensors".into(),
                model_relative_path: "checkpoints/test.safetensors".into(),
                model_sha256: "a".repeat(64),
                byte_size: metadata.len(),
                model_modified_ms: metadata_modified_ms(&metadata).expect("读取修改时间"),
                text_encoder_file_name: None,
                text_encoder_relative_path: None,
                text_encoder_sha256: None,
                vae_file_name: None,
                vae_relative_path: None,
                vae_sha256: None,
            })
            .expect("登记模型");
        let lora_path = Path::new(&settings.model_root).join("loras").join("style.safetensors");
        fs::create_dir_all(lora_path.parent().expect("LoRA 父目录")).expect("创建 LoRA 目录");
        fs::write(&lora_path, b"registered-lora").expect("写入登记 LoRA");
        let lora_metadata = lora_path.metadata().expect("读取 LoRA 元数据");
        let lora = state.register_local_lora(LocalLoraRegistration { title: "测试画风".into(), r#type: "style".into(), file_name: "style.safetensors".into(), relative_path: "loras/style.safetensors".into(), sha256: "b".repeat(64), byte_size: lora_metadata.len(), modified_ms: metadata_modified_ms(&lora_metadata).expect("读取 LoRA 修改时间"), trigger_words: vec!["test_style".into()] }).expect("登记 LoRA");
        let input = DesktopLocalJobCreateInput {
            model_id: model.id,
            prompt: "subject".into(),
            negative_prompt: Some("bad anatomy".into()),
            width: 1200,
            height: 800,
            quality_preset: "custom".into(),
            steps: 29,
            cfg: 6.25,
            sampler_name: "euler_ancestral".into(),
            scheduler_name: "simple".into(),
            sampling_max_edge: 1408,
            sampling_pixel_budget: 1_234_567,
            aspect_step_threshold: 1.7,
            aspect_adjusted_steps: 24,
            upscale_method: "bicubic".into(),
            quality_prompt_enabled: false,
            default_negative_enabled: true,
            seed: Some(7),
            loras: vec![DesktopLocalLoraSelectionInput { id: lora.id, strength: 0.75, clip_strength: 0.6 }],
            privacy: "private".into(),
        };
        let mut database = state.database.lock().expect("锁定数据库");
        let created = create_job(&mut database, &settings, input).expect("创建持久任务");
        assert_eq!(created.status, "queued");
        assert_eq!(created.loras.len(), 1);
        assert_eq!(created.loras[0].title, "测试画风");
        assert_eq!(created.loras[0].strength, 0.75);
        assert_eq!(created.loras[0].clip_strength, 0.6);
        assert_eq!((created.parameters.width, created.parameters.height), (1200, 800));
        assert_eq!(created.parameters.quality_preset, "custom");
        assert_eq!((created.parameters.steps, created.parameters.aspect_adjusted_steps), (29, 24));
        assert_eq!(created.parameters.cfg, 6.25);
        assert_eq!(created.parameters.sampler_name, "euler_ancestral");
        assert_eq!(created.parameters.scheduler_name, "simple");
        assert_eq!(created.parameters.sampling_max_edge, 1408);
        assert_eq!(created.parameters.sampling_pixel_budget, 1_234_567);
        assert_eq!(created.parameters.aspect_step_threshold, 1.7);
        assert_eq!(created.parameters.upscale_method, "bicubic");
        assert!(!created.parameters.quality_prompt_enabled);
        assert!(created.parameters.default_negative_enabled);
        assert_eq!(created.prompt, "subject");
        assert_eq!(created.negative_prompt.as_deref(), Some("bad anatomy"));
        assert_eq!(created.privacy, "private");
        let execution = {
            let transaction = database.unchecked_transaction().expect("开启执行快照读取事务");
            execution_from_transaction(&transaction, &created.id).expect("读取完整执行快照")
        };
        assert_eq!(execution.model_file_name, "test.safetensors");
        assert_eq!((execution.width, execution.height, execution.steps), (1200, 800, 29));
        assert_eq!((execution.cfg, execution.seed), (6.25, 7));
        assert_eq!(execution.loras.len(), 1);
        assert_eq!(execution.loras[0].file_name, "style.safetensors");
        assert_eq!((execution.loras[0].strength, execution.loras[0].clip_strength), (0.75, 0.6));
        database.execute("UPDATE local_loras SET title='新标题' WHERE id=?1", [&created.loras[0].id]).expect("更新 LoRA 标题");
        assert_eq!(read_job(&database, &created.id).expect("重读任务").expect("任务存在").loras[0].title, "测试画风");
        assert_eq!(list_jobs(&database).expect("读取任务").len(), 1);
        assert_eq!(
            cancel_job(&database, &created.id).expect("取消任务").status,
            "cancelled"
        );
        drop(database);
    }
}
