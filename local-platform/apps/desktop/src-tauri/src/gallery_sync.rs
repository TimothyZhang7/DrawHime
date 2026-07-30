//! 本模块实现桌面作品到网站图库的账号隔离、断点分片上传、重试和终态同步。

use crate::{
    auth::{self, DesktopSessionError},
    models::GallerySyncItem,
    process::hide_window,
};
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::{blocking::{Client, Response}, StatusCode};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

const DEFAULT_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/** 应用生命周期内唯一的图库同步 Worker。 */
pub struct GallerySyncScheduler {
    stopping: Arc<AtomicBool>,
    wake_signal: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct PendingPublication {
    id: String,
    local_task_id: String,
    artifact_path: String,
    artifact_sha256: String,
    privacy: String,
    retry_count: u32,
    owner_issuer: Option<String>,
    owner_subject: Option<String>,
    server_upload_id: Option<String>,
    prompt: String,
    negative_prompt: Option<String>,
    model_display_name: String,
    width: u32,
    height: u32,
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
    seed: u32,
    byte_size: u64,
    mime_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadView {
    id: String,
    status: String,
    received_bytes: u64,
    chunk_size_bytes: usize,
    main_gallery_item_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> { ok: bool, data: Option<T>, code: Option<String>, message: Option<String> }

enum SyncFailure { WaitingAuth(String), WaitingNetwork(String), Retryable(String), Final(String) }

impl GallerySyncScheduler {
    /** 启动独立数据库连接的图库同步线程，主线程和本地任务成功状态都不等待网络。 */
    pub fn start(database_path: PathBuf, app: AppHandle) -> Result<Self, String> {
        let stopping = Arc::new(AtomicBool::new(false));
        let wake_signal = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_stopping = stopping.clone();
        let worker_signal = wake_signal.clone();
        let worker = thread::Builder::new().name("drawhime-gallery-sync".into()).spawn(move || {
            sync_loop(&database_path, &app, &worker_stopping, &worker_signal);
        }).map_err(|error| format!("启动图库同步线程失败：{error}"))?;
        Ok(Self { stopping, wake_signal, worker: Some(worker) })
    }

    /** 唤醒图库 Worker，新增队列无需等待下一轮轮询。 */
    pub fn wake(&self) {
        let (lock, condition) = &*self.wake_signal;
        if let Ok(mut pending) = lock.lock() { *pending = true; condition.notify_one(); }
    }
}

impl Drop for GallerySyncScheduler {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.wake();
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

/** 每轮只处理一个队列项，失败按持久化截止时间退避，应用重启后继续。 */
fn sync_loop(database_path: &Path, app: &AppHandle, stopping: &AtomicBool, signal: &(Mutex<bool>, Condvar)) {
    while !stopping.load(Ordering::SeqCst) {
        let result = Connection::open(database_path)
            .map_err(|error| format!("打开图库同步数据库失败：{error}"))
            .and_then(|database| {
                database.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;").map_err(|error| format!("初始化图库同步数据库失败：{error}"))?;
                process_next(&database, app)
            });
        if let Err(error) = result { eprintln!("图库同步线程：{error}"); }
        let (lock, condition) = signal;
        if let Ok(pending) = lock.lock() { let _ = condition.wait_timeout_while(pending, Duration::from_secs(3), |value| !*value); }
        if let Ok(mut pending) = lock.lock() { *pending = false; }
    }
}

/** 领取最早可重试记录并执行一次完整上传或补偿发布。 */
fn process_next(database: &Connection, app: &AppHandle) -> Result<(), String> {
    // 用户关闭自动上传时保留既有队列和本地图片，重新开启后由同一 Worker 继续断点同步。
    let auto_upload = database.query_row("SELECT auto_upload FROM desktop_settings WHERE id=1", [], |row| Ok(row.get::<_, i64>(0)? != 0)).map_err(|error| format!("读取图库自动上传设置失败：{error}"))?;
    if !auto_upload { return Ok(()); }
    let now = Utc::now().to_rfc3339();
    let id: Option<String> = database.query_row(
        "SELECT id FROM gallery_sync_queue WHERE status IN ('queued','waiting_network','waiting_auth','failed_retryable','uploading','committing') AND (next_attempt_at IS NULL OR next_attempt_at<=?1) ORDER BY created_at ASC LIMIT 1",
        [&now], |row| row.get(0),
    ).optional().map_err(|error| format!("读取图库同步队列失败：{error}"))?;
    let Some(id) = id else { return Ok(()); };
    let publication = read_pending(database, &id)?;
    match synchronize(database, &publication) {
        Ok(upload) => {
            let status = if upload.status == "remote_deleted" { "remote_deleted" } else { "synced" };
            database.execute("UPDATE gallery_sync_queue SET status=?2,uploaded_bytes=?3,gallery_item_id=?4,last_error=NULL,next_attempt_at=NULL,updated_at=?5 WHERE id=?1", params![publication.id, status, publication.byte_size, upload.main_gallery_item_id, Utc::now().to_rfc3339()]).map_err(|error| format!("写入图库同步终态失败：{error}"))?;
        }
        Err(SyncFailure::WaitingAuth(message)) => schedule(database, &publication, "waiting_auth", message, false, 20)?,
        Err(SyncFailure::WaitingNetwork(message)) => schedule(database, &publication, "waiting_network", message, false, 10)?,
        Err(SyncFailure::Retryable(message)) => {
            let delay = (5_u64.saturating_mul(2_u64.saturating_pow(publication.retry_count.min(6)))).min(300);
            schedule(database, &publication, "failed_retryable", message, true, delay)?;
        }
        Err(SyncFailure::Final(message)) => schedule(database, &publication, "failed_final", message, true, 0)?,
    }
    emit_item(database, app, &publication.id)
}

/** 校验账号归属和本地原图后，按服务端真实偏移上传并提交。 */
fn synchronize(database: &Connection, publication: &PendingPublication) -> Result<UploadView, SyncFailure> {
    if wifi_only(database) && !wifi_connected() { return Err(SyncFailure::WaitingNetwork("当前未连接 Wi-Fi，已按本机设置暂停图库同步".into())); }
    let session = match auth::authenticated_session() {
        Ok(Some(session)) => session,
        Ok(None) => return Err(SyncFailure::WaitingAuth("请先连接该作品所属的绘图姬账号".into())),
        Err(DesktopSessionError::Network) => return Err(SyncFailure::WaitingNetwork("账号服务当前不可达".into())),
        Err(DesktopSessionError::Service(message)) => return Err(SyncFailure::Retryable(message)),
    };
    if let (Some(issuer), Some(subject)) = (&publication.owner_issuer, &publication.owner_subject) {
        if issuer != &session.identity.issuer || subject != &session.identity.subject { return Err(SyncFailure::WaitingAuth("该作品已绑定其他绘图姬账号".into())); }
    } else {
        database.execute("UPDATE gallery_sync_queue SET owner_issuer=?2,owner_subject=?3,updated_at=?4 WHERE id=?1 AND owner_subject IS NULL", params![publication.id, session.identity.issuer, session.identity.subject, Utc::now().to_rfc3339()]).map_err(|error| SyncFailure::Retryable(format!("绑定图库账号失败：{error}")))?;
    }
    verify_artifact(publication)?;
    let client = Client::builder().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(45)).user_agent("DrawHime-Desktop/0.1").build().map_err(|error| SyncFailure::Retryable(format!("创建图库网络客户端失败：{error}")))?;
    let mut upload = if let Some(upload_id) = &publication.server_upload_id {
        request_upload(&client, "GET", &format!("/v1/desktop/gallery/uploads/{upload_id}"), &session.token, None)?
    } else {
        let created = create_upload(database, publication, &client, &session.token)?;
        created
    };
    if upload.status == "published" || upload.status == "remote_deleted" { return Ok(upload); }
    let mut file = File::open(&publication.artifact_path).map_err(|_| SyncFailure::Final("本地原图已经不存在".into()))?;
    let total = publication.byte_size;
    while upload.received_bytes < total {
        let chunk_bytes = upload.chunk_size_bytes.clamp(1, DEFAULT_CHUNK_BYTES);
        let wanted = usize::try_from((total - upload.received_bytes).min(chunk_bytes as u64)).map_err(|_| SyncFailure::Final("作品分片长度不正确".into()))?;
        let mut chunk = vec![0_u8; wanted];
        file.seek(SeekFrom::Start(upload.received_bytes)).map_err(|error| SyncFailure::Final(format!("定位本地原图失败：{error}")))?;
        file.read_exact(&mut chunk).map_err(|error| SyncFailure::Final(format!("读取本地原图失败：{error}")))?;
        let started = Instant::now();
        upload = put_chunk(&client, &upload.id, upload.received_bytes, chunk, &session.token)?;
        database.execute("UPDATE gallery_sync_queue SET status='uploading',uploaded_bytes=?2,server_upload_id=?3,last_error=NULL,updated_at=?4 WHERE id=?1", params![publication.id, upload.received_bytes, upload.id, Utc::now().to_rfc3339()]).map_err(|error| SyncFailure::Retryable(format!("保存图库上传断点失败：{error}")))?;
        throttle(database, wanted as u64, started);
    }
    database.execute("UPDATE gallery_sync_queue SET status='committing',updated_at=?2 WHERE id=?1", params![publication.id, Utc::now().to_rfc3339()]).map_err(|error| SyncFailure::Retryable(format!("保存图库提交状态失败：{error}")))?;
    request_upload(&client, "POST", &format!("/v1/desktop/gallery/uploads/{}/complete", upload.id), &session.token, None)
}

/** 创建上传会话并把服务端 ID 和真实偏移写回 SQLite。 */
fn create_upload(database: &Connection, publication: &PendingPublication, client: &Client, token: &str) -> Result<UploadView, SyncFailure> {
    let loras = read_lora_parameters(database, &publication.local_task_id).map_err(SyncFailure::Retryable)?;
    let parameters = json!({
        "width": publication.width, "height": publication.height, "qualityPreset": publication.quality_preset,
        "steps": publication.steps, "cfg": publication.cfg,
        "samplerName": publication.sampler_name, "schedulerName": publication.scheduler_name, "seed": publication.seed,
        "samplingMaxEdge": publication.sampling_max_edge, "samplingPixelBudget": publication.sampling_pixel_budget,
        "aspectStepThreshold": publication.aspect_step_threshold, "aspectAdjustedSteps": publication.aspect_adjusted_steps,
        "upscaleMethod": publication.upscale_method, "qualityPromptEnabled": publication.quality_prompt_enabled,
        "qualityPrefix": publication.quality_prefix, "defaultNegativeEnabled": publication.default_negative_enabled,
        "defaultNegativePrompt": publication.default_negative_prompt,
        // 本机导入 LoRA 尚未必对应网站仓库版本，使用独立审计键避免生成失效详情链接。
        "desktopLoraSelections": loras,
    });
    let file_name = Path::new(&publication.artifact_path).file_name().and_then(|value| value.to_str()).unwrap_or("drawhime-desktop.webp");
    let body = json!({
        "localTaskId": publication.local_task_id, "artifactSha256": publication.artifact_sha256, "fileName": file_name,
        "mimeType": publication.mime_type, "byteSize": publication.byte_size, "width": publication.width, "height": publication.height,
        "privacy": publication.privacy, "effectivePrompt": publication.prompt, "negativePrompt": publication.negative_prompt,
        "modelDisplayName": publication.model_display_name, "parameters": parameters,
    });
    let upload = request_upload(client, "POST", "/v1/desktop/gallery/uploads", token, Some(body))?;
    database.execute("UPDATE gallery_sync_queue SET server_upload_id=?2,uploaded_bytes=?3,status='uploading',last_error=NULL,updated_at=?4 WHERE id=?1", params![publication.id, upload.id, upload.received_bytes, Utc::now().to_rfc3339()]).map_err(|error| SyncFailure::Retryable(format!("保存图库上传会话失败：{error}")))?;
    Ok(upload)
}

/** 调用 JSON 上传控制端点并保留鉴权、网络和可重试错误语义。 */
fn request_upload(client: &Client, method: &str, path: &str, token: &str, body: Option<Value>) -> Result<UploadView, SyncFailure> {
    let builder = match method { "POST" => client.post(auth::api_url(path)), _ => client.get(auth::api_url(path)) };
    let builder = if let Some(body) = body { builder.json(&body) } else { builder };
    parse_upload_response(builder.bearer_auth(token).send())
}

/** 上传一个有界分片，服务端返回的新偏移是后续读取的唯一依据。 */
fn put_chunk(client: &Client, upload_id: &str, offset: u64, chunk: Vec<u8>, token: &str) -> Result<UploadView, SyncFailure> {
    let length = chunk.len();
    parse_upload_response(client.put(auth::api_url(&format!("/v1/desktop/gallery/uploads/{upload_id}"))).bearer_auth(token).header("x-upload-offset", offset).header("content-length", length).body(chunk).send())
}

/** 解析统一 API 信封，禁止把服务端错误页或密钥写入同步记录。 */
fn parse_upload_response(result: Result<Response, reqwest::Error>) -> Result<UploadView, SyncFailure> {
    let response = result.map_err(|error| if error.is_connect() || error.is_timeout() { SyncFailure::WaitingNetwork("图库服务连接超时".into()) } else { SyncFailure::Retryable("图库网络请求失败".into()) })?;
    let status = response.status();
    let payload: ApiEnvelope<UploadView> = response.json().map_err(|_| SyncFailure::Retryable("图库服务返回格式不正确".into()))?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { return Err(SyncFailure::WaitingAuth(payload.message.unwrap_or_else(|| "桌面账号授权已失效".into()))); }
    if !status.is_success() || !payload.ok {
        let message = payload.message.or(payload.code).unwrap_or_else(|| format!("图库服务 HTTP {}", status.as_u16()));
        return Err(if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::CONFLICT { SyncFailure::Retryable(message) } else { SyncFailure::Final(message) });
    }
    payload.data.ok_or_else(|| SyncFailure::Retryable("图库服务没有返回上传状态".into()))
}

/** 从 SQLite 读取任务和产物快照，不读取或上传参考图、模型、LoRA 文件。 */
fn read_pending(database: &Connection, id: &str) -> Result<PendingPublication, String> {
    database.query_row("SELECT q.id,q.local_task_id,q.artifact_path,q.artifact_sha256,q.privacy,q.retry_count,q.owner_issuer,q.owner_subject,q.server_upload_id,j.prompt,j.negative_prompt,j.model_display_name,j.width,j.height,j.quality_preset,j.steps,j.cfg,j.sampler_name,j.scheduler_name,j.sampling_max_edge,j.sampling_pixel_budget,j.aspect_step_threshold,j.aspect_adjusted_steps,j.upscale_method,j.quality_prompt_enabled,j.quality_prefix,j.default_negative_enabled,j.default_negative_prompt,j.seed,a.byte_size,a.mime_type FROM gallery_sync_queue q JOIN local_jobs j ON j.id=q.local_task_id JOIN local_artifacts a ON a.job_id=j.id WHERE q.id=?1", [id], |row| Ok(PendingPublication { id: row.get(0)?, local_task_id: row.get(1)?, artifact_path: row.get(2)?, artifact_sha256: row.get(3)?, privacy: row.get(4)?, retry_count: row.get(5)?, owner_issuer: row.get(6)?, owner_subject: row.get(7)?, server_upload_id: row.get(8)?, prompt: row.get(9)?, negative_prompt: row.get(10)?, model_display_name: row.get(11)?, width: row.get(12)?, height: row.get(13)?, quality_preset: row.get(14)?, steps: row.get(15)?, cfg: row.get(16)?, sampler_name: row.get(17)?, scheduler_name: row.get(18)?, sampling_max_edge: row.get(19)?, sampling_pixel_budget: row.get(20)?, aspect_step_threshold: row.get(21)?, aspect_adjusted_steps: row.get(22)?, upscale_method: row.get(23)?, quality_prompt_enabled: row.get::<_, i64>(24)? != 0, quality_prefix: row.get(25)?, default_negative_enabled: row.get::<_, i64>(26)? != 0, default_negative_prompt: row.get(27)?, seed: row.get(28)?, byte_size: row.get(29)?, mime_type: row.get(30)? })).map_err(|error| format!("读取图库任务快照失败：{error}"))
}

/** 只把 LoRA 名称、类型和权重写入图库参数，不上传本机模型文件。 */
fn read_lora_parameters(database: &Connection, task_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = database.prepare("SELECT lora_id,title,type,strength,clip_strength FROM local_job_loras WHERE job_id=?1 ORDER BY sequence ASC").map_err(|error| format!("读取任务 LoRA 失败：{error}"))?;
    let rows = statement.query_map([task_id], |row| Ok(json!({ "id": row.get::<_, String>(0)?, "title": row.get::<_, String>(1)?, "type": row.get::<_, String>(2)?, "strength": row.get::<_, f64>(3)?, "clipStrength": row.get::<_, f64>(4)? }))).map_err(|error| format!("查询任务 LoRA 失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析任务 LoRA 失败：{error}"))
}

/** 上传前再次核对本地文件大小和 SHA-256，源文件变化时保留记录并停止提交。 */
fn verify_artifact(publication: &PendingPublication) -> Result<(), SyncFailure> {
    let metadata = fs::metadata(&publication.artifact_path).map_err(|_| SyncFailure::Final("本地原图已经不存在".into()))?;
    if !metadata.is_file() || metadata.len() != publication.byte_size { return Err(SyncFailure::Final("本地原图字节数已经变化".into())); }
    let file = File::open(&publication.artifact_path).map_err(|_| SyncFailure::Final("本地原图读取失败".into()))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop { let read = reader.read(&mut buffer).map_err(|_| SyncFailure::Final("本地原图读取失败".into()))?; if read == 0 { break; } hasher.update(&buffer[..read]); }
    if hex::encode(hasher.finalize()) != publication.artifact_sha256 { return Err(SyncFailure::Final("本地原图 SHA-256 已经变化".into())); }
    Ok(())
}

/** 按用户设置的上行限速延迟当前分片，不影响本地生成和训练。 */
fn throttle(database: &Connection, bytes: u64, started: Instant) {
    let limit: Option<u64> = database.query_row("SELECT bandwidth_limit_kib FROM desktop_settings WHERE id=1", [], |row| row.get(0)).ok().flatten();
    let Some(limit) = limit.filter(|value| *value > 0) else { return; };
    let expected = Duration::from_secs_f64(bytes as f64 / (limit as f64 * 1024.0));
    if expected > started.elapsed() { thread::sleep(expected - started.elapsed()); }
}

/** 读取仅 Wi-Fi 上传策略；数据库异常时保持默认不限网络，避免永久卡住本地队列。 */
fn wifi_only(database: &Connection) -> bool { database.query_row("SELECT wifi_only FROM desktop_settings WHERE id=1", [], |row| row.get::<_, i64>(0)).map(|value| value != 0).unwrap_or(false) }

/** 使用 Windows 自带 WLAN 状态确认真实 Wi-Fi 连接，不依赖第三方常驻服务。 */
#[cfg(windows)]
fn wifi_connected() -> bool {
    let output = hide_window(&mut std::process::Command::new("netsh")).args(["wlan", "show", "interfaces"]).output();
    let Ok(output) = output else { return false; };
    if !output.status.success() { return false; }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().any(|line| {
        let trimmed = line.trim();
        trimmed.starts_with("SSID") && !trimmed.starts_with("BSSID") && trimmed.split_once(':').is_some_and(|(_, value)| !value.trim().is_empty())
    })
}

/** 非 Windows 测试构建没有 WLAN 系统接口，返回未连接以尊重仅 Wi-Fi 策略。 */
#[cfg(not(windows))]
fn wifi_connected() -> bool { false }

/** 持久化等待或失败状态以及下一次退避截止时间。 */
fn schedule(database: &Connection, publication: &PendingPublication, status: &str, message: String, increment_retry: bool, delay_seconds: u64) -> Result<(), String> {
    let retry_count = publication.retry_count + u32::from(increment_retry);
    let next_attempt = if delay_seconds == 0 { None } else { Some((Utc::now() + ChronoDuration::seconds(delay_seconds as i64)).to_rfc3339()) };
    database.execute("UPDATE gallery_sync_queue SET status=?2,retry_count=?3,last_error=?4,next_attempt_at=?5,updated_at=?6 WHERE id=?1", params![publication.id, status, retry_count, message, next_attempt, Utc::now().to_rfc3339()]).map_err(|error| format!("保存图库重试状态失败：{error}"))?;
    Ok(())
}

/** 向 WebView 推送不含账号主体和服务器上传 ID 的最新队列视图。 */
fn emit_item(database: &Connection, app: &AppHandle, id: &str) -> Result<(), String> {
    let item = database.query_row("SELECT id,local_task_id,artifact_path,artifact_sha256,privacy,status,uploaded_bytes,retry_count,gallery_item_id,last_error,created_at,updated_at FROM gallery_sync_queue WHERE id=?1", [id], |row| Ok(GallerySyncItem { id: row.get(0)?, local_task_id: row.get(1)?, artifact_path: row.get(2)?, artifact_sha256: row.get(3)?, privacy: row.get(4)?, status: row.get(5)?, uploaded_bytes: row.get(6)?, retry_count: row.get(7)?, gallery_item_id: row.get(8)?, last_error: row.get(9)?, created_at: row.get(10)?, updated_at: row.get(11)? })).map_err(|error| format!("读取图库同步事件失败：{error}"))?;
    app.emit("desktop-gallery-sync-updated", item).map_err(|error| format!("发送图库同步事件失败：{error}"))
}
