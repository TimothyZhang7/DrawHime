//! 本模块管理桌面端独立 SQLite、目录设置和图库同步队列，不连接网页或独立平台数据库。

use crate::captioner::CaptionScheduler;
use crate::gallery_sync::GallerySyncScheduler;
use crate::models::{DesktopAiSettings, DesktopCaptionJobCreateInput, DesktopCaptionJobView, DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalLoraView, DesktopLocalModelView, DesktopSettings, DesktopTrainingCaptionUpdateInput, DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetView, DesktopTrainingJobCreateInput, DesktopTrainingJobView, GalleryPublicationInput, GallerySyncItem};
use crate::runtime::RuntimeController;
use crate::scheduler::LocalScheduler;
use crate::trainer::TrainingScheduler;
use crate::workload::GpuWorkloadCoordinator;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{fs, io::{BufReader, Read}, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use uuid::Uuid;

pub struct DesktopState {
    pub database: Mutex<Connection>,
    pub app_data_dir: PathBuf,
    pub database_path: PathBuf,
    pub scheduler: Option<LocalScheduler>,
    pub caption_scheduler: Option<CaptionScheduler>,
    pub training_scheduler: Option<TrainingScheduler>,
    pub gallery_sync_scheduler: Option<GallerySyncScheduler>,
    pub runtime: Arc<RuntimeController>,
    pub gpu_workload: Arc<GpuWorkloadCoordinator>,
}

impl DesktopState {
    /** 创建本地数据目录和数据库结构，任何失败都阻止桌面核心伪装为可用。 */
    pub fn initialize(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|error| format!("创建桌面数据目录失败：{error}"))?;
        let database_path = app_data_dir.join("desktop.sqlite3");
        let connection = Connection::open(&database_path).map_err(|error| format!("打开桌面数据库失败：{error}"))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS desktop_settings (id INTEGER PRIMARY KEY CHECK(id=1), theme_mode TEXT NOT NULL DEFAULT 'system', dependency_source TEXT NOT NULL DEFAULT 'auto', default_privacy TEXT NOT NULL DEFAULT 'public', model_root TEXT NOT NULL, output_root TEXT NOT NULL, runtime_root TEXT NOT NULL, upload_concurrency INTEGER NOT NULL, wifi_only INTEGER NOT NULL, bandwidth_limit_kib INTEGER, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS desktop_ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, endpoint_type TEXT NOT NULL DEFAULT 'openai_chat', base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS environment_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, report_json TEXT NOT NULL, checked_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS software_updates (version TEXT PRIMARY KEY, resource_id TEXT NOT NULL, file_name TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT);
            CREATE TABLE IF NOT EXISTS gallery_sync_queue (id TEXT PRIMARY KEY, local_task_id TEXT NOT NULL, artifact_path TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, privacy TEXT NOT NULL, status TEXT NOT NULL, uploaded_bytes INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, gallery_item_id TEXT, last_error TEXT, owner_issuer TEXT, owner_subject TEXT, server_upload_id TEXT, next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(local_task_id, artifact_sha256));
            CREATE TABLE IF NOT EXISTS local_models (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, family TEXT NOT NULL, workflow_kind TEXT NOT NULL, model_file_name TEXT NOT NULL, model_relative_path TEXT NOT NULL, model_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, model_modified_ms INTEGER NOT NULL, text_encoder_file_name TEXT, text_encoder_relative_path TEXT, text_encoder_sha256 TEXT, vae_file_name TEXT, vae_relative_path TEXT, vae_sha256 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(model_sha256, workflow_kind));
            CREATE TABLE IF NOT EXISTS local_loras (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL, modified_ms INTEGER NOT NULL, trigger_words_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS local_training_datasets (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, trigger_words_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS local_training_assets (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, file_name TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, caption TEXT, confirmed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(dataset_id,sha256), FOREIGN KEY(dataset_id) REFERENCES local_training_datasets(id));
            CREATE TABLE IF NOT EXISTS local_caption_jobs (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, asset_id TEXT, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, total_assets INTEGER NOT NULL, processed_assets INTEGER NOT NULL DEFAULT 0, succeeded_assets INTEGER NOT NULL DEFAULT 0, failed_assets INTEGER NOT NULL DEFAULT 0, skipped_assets INTEGER NOT NULL DEFAULT 0, general_threshold REAL NOT NULL, character_threshold REAL NOT NULL, include_character_tags INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES local_training_datasets(id));
            CREATE TABLE IF NOT EXISTS local_caption_job_items (job_id TEXT NOT NULL, asset_id TEXT NOT NULL, force_replace INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, caption TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,asset_id), FOREIGN KEY(job_id) REFERENCES local_caption_jobs(id), FOREIGN KEY(asset_id) REFERENCES local_training_assets(id));
            CREATE TABLE IF NOT EXISTS local_training_jobs (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, dataset_title TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, current_epoch INTEGER NOT NULL DEFAULT 0, total_epochs INTEGER NOT NULL, model_id TEXT NOT NULL, model_display_name TEXT NOT NULL, workflow_kind TEXT NOT NULL, model_file_name TEXT NOT NULL, model_relative_path TEXT NOT NULL, model_sha256 TEXT NOT NULL, model_byte_size INTEGER NOT NULL, model_modified_ms INTEGER NOT NULL, text_encoder_file_name TEXT NOT NULL, text_encoder_relative_path TEXT NOT NULL, text_encoder_sha256 TEXT NOT NULL, vae_file_name TEXT NOT NULL, vae_relative_path TEXT NOT NULL, vae_sha256 TEXT NOT NULL, parameters_json TEXT NOT NULL, trigger_words_json TEXT NOT NULL, asset_count INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, output_lora_id TEXT, error TEXT, suggestion_json TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES local_training_datasets(id), FOREIGN KEY(model_id) REFERENCES local_models(id));
            CREATE TABLE IF NOT EXISTS local_training_job_assets (job_id TEXT NOT NULL, sequence INTEGER NOT NULL, asset_id TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, caption TEXT NOT NULL, PRIMARY KEY(job_id,sequence), UNIQUE(job_id,asset_id), FOREIGN KEY(job_id) REFERENCES local_training_jobs(id), FOREIGN KEY(asset_id) REFERENCES local_training_assets(id));
            CREATE TABLE IF NOT EXISTS local_training_job_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, completed_at TEXT, UNIQUE(job_id,attempt_number), FOREIGN KEY(job_id) REFERENCES local_training_jobs(id));
            CREATE TABLE IF NOT EXISTS local_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, progress INTEGER NOT NULL, prompt TEXT NOT NULL, negative_prompt TEXT, model_id TEXT NOT NULL, model_display_name TEXT NOT NULL, workflow_kind TEXT NOT NULL, model_file_name TEXT NOT NULL, model_relative_path TEXT NOT NULL, model_sha256 TEXT NOT NULL, text_encoder_file_name TEXT, vae_file_name TEXT, width INTEGER NOT NULL, height INTEGER NOT NULL, steps INTEGER NOT NULL, cfg REAL NOT NULL, sampler_name TEXT NOT NULL, scheduler_name TEXT NOT NULL, seed INTEGER NOT NULL, privacy TEXT NOT NULL, runtime_prompt_id TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(model_id) REFERENCES local_models(id));
            CREATE TABLE IF NOT EXISTS local_job_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL, runtime_prompt_id TEXT, error TEXT, started_at TEXT NOT NULL, completed_at TEXT, UNIQUE(job_id,attempt_number), FOREIGN KEY(job_id) REFERENCES local_jobs(id));
            CREATE TABLE IF NOT EXISTS local_job_loras (job_id TEXT NOT NULL, sequence INTEGER NOT NULL, lora_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, modified_ms INTEGER NOT NULL, strength REAL NOT NULL, trigger_words_json TEXT NOT NULL, PRIMARY KEY(job_id,sequence), UNIQUE(job_id,lora_id), FOREIGN KEY(job_id) REFERENCES local_jobs(id), FOREIGN KEY(lora_id) REFERENCES local_loras(id));
            CREATE TABLE IF NOT EXISTS local_artifacts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(job_id) REFERENCES local_jobs(id));
            CREATE INDEX IF NOT EXISTS gallery_sync_status_idx ON gallery_sync_queue(status, created_at);
            CREATE INDEX IF NOT EXISTS local_jobs_status_idx ON local_jobs(status, created_at);
            CREATE INDEX IF NOT EXISTS local_training_jobs_status_idx ON local_training_jobs(status, created_at);
            CREATE INDEX IF NOT EXISTS local_training_jobs_dataset_idx ON local_training_jobs(dataset_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS local_training_assets_dataset_idx ON local_training_assets(dataset_id, created_at);").map_err(|error| format!("初始化桌面数据库失败：{error}"))?;
        let recovery_time = Utc::now().to_rfc3339();
        connection.execute("UPDATE local_job_attempts SET status='interrupted',completed_at=?1 WHERE status='running'", [&recovery_time]).map_err(|error| format!("恢复中断的本地任务尝试失败：{error}"))?;
        connection.execute("UPDATE local_jobs SET status='queued', progress=0, runtime_prompt_id=NULL, started_at=NULL, updated_at=?1 WHERE status='running'", [&recovery_time]).map_err(|error| format!("恢复中断的本地任务失败：{error}"))?;
        // 退出前已经收到取消请求的任务必须恢复为终态，避免重启后永久占用训练集活动任务索引。
        connection.execute("UPDATE local_caption_job_items SET status='cancelled',updated_at=?1 WHERE status='running' AND job_id IN (SELECT id FROM local_caption_jobs WHERE status='running' AND cancel_requested=1)", [&recovery_time]).map_err(|error| format!("恢复已取消的逐图打标状态失败：{error}"))?;
        connection.execute("UPDATE local_caption_jobs SET status='cancelled',progress=100,processed_assets=total_assets,completed_at=?1,updated_at=?1 WHERE status='running' AND cancel_requested=1", [&recovery_time]).map_err(|error| format!("恢复已取消的打标任务失败：{error}"))?;
        connection.execute("UPDATE local_caption_jobs SET status='queued',progress=0,processed_assets=0,succeeded_assets=0,failed_assets=0,skipped_assets=0,started_at=NULL,updated_at=?1 WHERE status='running' AND cancel_requested=0", [&recovery_time]).map_err(|error| format!("恢复中断的打标任务失败：{error}"))?;
        connection.execute("UPDATE local_caption_job_items SET status='queued',caption=NULL,error=NULL,updated_at=?1 WHERE status='running'", [&recovery_time]).map_err(|error| format!("恢复中断的逐图打标状态失败：{error}"))?;
        connection.execute("UPDATE local_training_job_attempts SET status='interrupted',error='桌面程序退出，训练任务已恢复排队',completed_at=?1 WHERE status='running'", [&recovery_time]).map_err(|error| format!("恢复中断的训练尝试失败：{error}"))?;
        connection.execute("UPDATE local_training_jobs SET status='cancelled',progress=100,completed_at=?1,updated_at=?1 WHERE status='running' AND cancel_requested=1", [&recovery_time]).map_err(|error| format!("恢复已取消的训练任务失败：{error}"))?;
        connection.execute("UPDATE local_training_jobs SET status='queued',progress=0,current_epoch=0,started_at=NULL,error=NULL,suggestion_json=NULL,updated_at=?1 WHERE status='running' AND cancel_requested=0", [&recovery_time]).map_err(|error| format!("恢复中断的训练任务失败：{error}"))?;
        ensure_column(&connection, "desktop_settings", "theme_mode", "TEXT NOT NULL DEFAULT 'system'")?;
        ensure_column(&connection, "desktop_settings", "dependency_source", "TEXT NOT NULL DEFAULT 'auto'")?;
        ensure_column(&connection, "local_job_loras", "relative_path", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(&connection, "local_job_loras", "byte_size", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(&connection, "local_job_loras", "modified_ms", "INTEGER NOT NULL DEFAULT 0")?;
        ensure_column(&connection, "local_training_assets", "caption_source", "TEXT")?;
        ensure_column(&connection, "gallery_sync_queue", "owner_issuer", "TEXT")?;
        ensure_column(&connection, "gallery_sync_queue", "owner_subject", "TEXT")?;
        ensure_column(&connection, "gallery_sync_queue", "server_upload_id", "TEXT")?;
        ensure_column(&connection, "gallery_sync_queue", "next_attempt_at", "TEXT")?;
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS local_caption_jobs_active_dataset_idx ON local_caption_jobs(dataset_id) WHERE status IN ('queued','running')", []).map_err(|error| format!("创建打标任务活动索引失败：{error}"))?;
        connection.execute("CREATE INDEX IF NOT EXISTS local_caption_jobs_created_idx ON local_caption_jobs(created_at DESC)", []).map_err(|error| format!("创建打标任务时间索引失败：{error}"))?;
        // 旧开发版本已经生成的 LoRA 快照补齐文件元数据，避免升级后任务失去可执行性。
        connection.execute("UPDATE local_job_loras SET relative_path=COALESCE(NULLIF(relative_path,''),(SELECT relative_path FROM local_loras WHERE id=local_job_loras.lora_id)),byte_size=CASE WHEN byte_size=0 THEN COALESCE((SELECT byte_size FROM local_loras WHERE id=local_job_loras.lora_id),0) ELSE byte_size END,modified_ms=CASE WHEN modified_ms=0 THEN COALESCE((SELECT modified_ms FROM local_loras WHERE id=local_job_loras.lora_id),0) ELSE modified_ms END", []).map_err(|error| format!("补齐任务 LoRA 快照失败：{error}"))?;
        let model_root = app_data_dir.join("models");
        let runtime_root = app_data_dir.join("runtime");
        let output_root = app_data_dir.join("outputs");
        for directory in [&model_root, &runtime_root, &output_root] { fs::create_dir_all(directory).map_err(|error| format!("创建本地目录失败：{error}"))?; }
        connection.execute("INSERT OR IGNORE INTO desktop_settings (id, theme_mode, dependency_source, default_privacy, model_root, output_root, runtime_root, upload_concurrency, wifi_only, bandwidth_limit_kib, updated_at) VALUES (1, 'system', 'auto', 'public', ?1, ?2, ?3, 2, 0, NULL, ?4)", params![path_text(&model_root), path_text(&output_root), path_text(&runtime_root), Utc::now().to_rfc3339()]).map_err(|error| format!("写入默认设置失败：{error}"))?;
        connection.execute("INSERT OR IGNORE INTO desktop_ai_settings (id, enabled, endpoint_type, base_url, model, updated_at) VALUES (1, 0, 'openai_chat', '', '', ?1)", [Utc::now().to_rfc3339()]).map_err(|error| format!("写入默认 AI 设置失败：{error}"))?;
        Ok(Self { database: Mutex::new(connection), app_data_dir: app_data_dir.to_path_buf(), database_path, scheduler: None, caption_scheduler: None, training_scheduler: None, gallery_sync_scheduler: None, runtime: Arc::new(RuntimeController::initialize(app_data_dir)?), gpu_workload: GpuWorkloadCoordinator::new() })
    }

    /** 数据库初始化完成后启动唯一后台调度线程。 */
    pub fn start_scheduler(&mut self, app: tauri::AppHandle) -> Result<(), String> {
        if self.scheduler.is_some() { return Ok(()); }
        self.scheduler = Some(LocalScheduler::start(self.database_path.clone(), self.app_data_dir.clone(), self.runtime.clone(), self.gpu_workload.clone(), app.clone())?);
        self.caption_scheduler = Some(CaptionScheduler::start(self.database_path.clone(), self.app_data_dir.clone(), app.clone())?);
        self.training_scheduler = Some(TrainingScheduler::start(self.database_path.clone(), self.app_data_dir.clone(), self.runtime.clone(), self.gpu_workload.clone(), app.clone())?);
        self.gallery_sync_scheduler = Some(GallerySyncScheduler::start(self.database_path.clone(), app)?);
        Ok(())
    }

    /** 读取唯一桌面设置记录。 */
    pub fn load_settings(&self) -> Result<DesktopSettings, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT theme_mode, dependency_source, default_privacy, model_root, output_root, runtime_root, upload_concurrency, wifi_only, bandwidth_limit_kib FROM desktop_settings WHERE id=1", [], |row| Ok(DesktopSettings { theme_mode: row.get(0)?, dependency_source: row.get(1)?, default_privacy: row.get(2)?, model_root: row.get(3)?, output_root: row.get(4)?, runtime_root: row.get(5)?, upload_concurrency: row.get(6)?, wifi_only: row.get::<_, i64>(7)? != 0, bandwidth_limit_kib: row.get(8)? })).map_err(|error| format!("读取桌面设置失败：{error}"))
    }

    /** 校验目录和上传策略后事务化更新设置。 */
    pub fn save_settings(&self, mut settings: DesktopSettings) -> Result<DesktopSettings, String> {
        if !matches!(settings.theme_mode.as_str(), "system" | "dark" | "light") { return Err("主题模式不正确".into()); }
        if !matches!(settings.dependency_source.as_str(), "auto" | "official" | "mirror") { return Err("依赖来源不正确".into()); }
        if !matches!(settings.default_privacy.as_str(), "public" | "private") { return Err("默认图库权限不正确".into()); }
        if !(1..=4).contains(&settings.upload_concurrency) { return Err("上传并发数必须是 1–4".into()); }
        // 存储目录固定跟随安装目录，前端传入的旧目录值不得把模型或作品重新写到其他磁盘位置。
        settings.model_root = path_text(&self.app_data_dir.join("models"));
        settings.output_root = path_text(&self.app_data_dir.join("outputs"));
        settings.runtime_root = path_text(&self.app_data_dir.join("runtime"));
        for path in [&settings.model_root, &settings.output_root, &settings.runtime_root] {
            if path.trim().is_empty() { return Err("本地目录不能为空".into()); }
            fs::create_dir_all(path).map_err(|error| format!("目录不可写：{path}：{error}"))?;
            let probe = Path::new(path).join(".drawhime-write-test");
            fs::write(&probe, b"ok").map_err(|error| format!("目录不可写：{path}：{error}"))?;
            fs::remove_file(probe).map_err(|error| format!("目录清理测试失败：{path}：{error}"))?;
        }
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.execute("UPDATE desktop_settings SET theme_mode=?1, dependency_source=?2, default_privacy=?3, model_root=?4, output_root=?5, runtime_root=?6, upload_concurrency=?7, wifi_only=?8, bandwidth_limit_kib=?9, updated_at=?10 WHERE id=1", params![settings.theme_mode, settings.dependency_source, settings.default_privacy, settings.model_root, settings.output_root, settings.runtime_root, settings.upload_concurrency, settings.wifi_only, settings.bandwidth_limit_kib, Utc::now().to_rfc3339()]).map_err(|error| format!("保存桌面设置失败：{error}"))?;
        drop(database);
        self.load_settings()
    }

    /** 读取不含密钥正文的 AI 辅助设置，凭据状态由调用方从 Credential Manager 合并。 */
    pub fn load_ai_settings(&self, api_key_configured: bool) -> Result<DesktopAiSettings, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT enabled, endpoint_type, base_url, model FROM desktop_ai_settings WHERE id=1", [], |row| Ok(DesktopAiSettings { enabled: row.get::<_, i64>(0)? != 0, endpoint_type: row.get(1)?, base_url: row.get(2)?, model: row.get(3)?, api_key_configured })).map_err(|error| format!("读取 AI 辅助设置失败：{error}"))
    }

    /** 持久化 AI 辅助非敏感配置，API Key 由独立凭据链路写入系统凭据库。 */
    pub fn save_ai_settings_metadata(&self, enabled: bool, endpoint_type: &str, base_url: &str, model: &str, api_key_configured: bool) -> Result<DesktopAiSettings, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.execute("UPDATE desktop_ai_settings SET enabled=?1, endpoint_type=?2, base_url=?3, model=?4, updated_at=?5 WHERE id=1", params![i64::from(enabled), endpoint_type, base_url, model, Utc::now().to_rfc3339()]).map_err(|error| format!("保存 AI 辅助设置失败：{error}"))?;
        drop(database);
        self.load_ai_settings(api_key_configured)
    }

    /** 保存脱敏环境快照并只保留最近 20 次检查。 */
    pub fn save_environment_snapshot(&self, report_json: &str, checked_at: &str) -> Result<(), String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let transaction = database.unchecked_transaction().map_err(|error| format!("开启环境快照事务失败：{error}"))?;
        transaction.execute("INSERT INTO environment_snapshots (report_json, checked_at) VALUES (?1, ?2)", params![report_json, checked_at]).map_err(|error| format!("保存环境快照失败：{error}"))?;
        transaction.execute("DELETE FROM environment_snapshots WHERE id NOT IN (SELECT id FROM environment_snapshots ORDER BY id DESC LIMIT 20)", []).map_err(|error| format!("清理环境快照失败：{error}"))?;
        transaction.commit().map_err(|error| format!("提交环境快照失败：{error}"))
    }

    /** 校验真实本地文件并按任务与哈希幂等加入网页图库同步队列。 */
    pub fn enqueue_gallery_publication(&self, input: GalleryPublicationInput) -> Result<GallerySyncItem, String> {
        if input.local_task_id.trim().is_empty() { return Err("本地任务 ID 不能为空".into()); }
        if !matches!(input.privacy.as_str(), "public" | "private") { return Err("图库权限不正确".into()); }
        let path = PathBuf::from(&input.artifact_path);
        if !path.is_file() { return Err("本地生成结果不存在".into()); }
        let sha256 = sha256_file(&path)?;
        let now = Utc::now().to_rfc3339();
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let existing: Option<String> = database.query_row("SELECT id FROM gallery_sync_queue WHERE local_task_id=?1 AND artifact_sha256=?2", params![input.local_task_id, sha256], |row| row.get(0)).optional().map_err(|error| format!("查询图库同步队列失败：{error}"))?;
        let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        database.execute("INSERT INTO gallery_sync_queue (id, local_task_id, artifact_path, artifact_sha256, privacy, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6) ON CONFLICT(local_task_id, artifact_sha256) DO UPDATE SET privacy=CASE WHEN gallery_sync_queue.privacy='private' OR excluded.privacy='private' THEN 'private' ELSE 'public' END, artifact_path=excluded.artifact_path,updated_at=excluded.updated_at", params![id, input.local_task_id, input.artifact_path, sha256, input.privacy, now]).map_err(|error| format!("写入图库同步队列失败：{error}"))?;
        drop(database);
        self.gallery_item(&id)?.ok_or_else(|| "图库同步记录写入后不存在".into())
    }

    /** 列出本机全部图库同步记录，新的记录优先。 */
    pub fn list_gallery_sync_queue(&self) -> Result<Vec<GallerySyncItem>, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let mut statement = database.prepare("SELECT id, local_task_id, artifact_path, artifact_sha256, privacy, status, uploaded_bytes, retry_count, gallery_item_id, last_error, created_at, updated_at FROM gallery_sync_queue ORDER BY created_at DESC").map_err(|error| format!("读取图库同步队列失败：{error}"))?;
        let rows = statement.query_map([], gallery_item_from_row).map_err(|error| format!("查询图库同步队列失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析图库同步队列失败：{error}"))
    }

    /** 统计尚未完成网页同步的本地作品。 */
    pub fn pending_gallery_sync_count(&self) -> Result<u64, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT COUNT(*) FROM gallery_sync_queue WHERE status NOT IN ('synced','remote_deleted')", [], |row| row.get(0)).map_err(|error| format!("统计图库同步队列失败：{error}"))
    }

    /** 按模型内容哈希幂等登记受控目录中的真实 safetensors。 */
    pub fn register_local_model(&self, model: LocalModelRegistration) -> Result<DesktopLocalModelView, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let existing: Option<String> = database.query_row("SELECT id FROM local_models WHERE model_sha256=?1 AND workflow_kind=?2", params![model.model_sha256, model.workflow_kind], |row| row.get(0)).optional().map_err(|error| format!("查询本地模型失败：{error}"))?;
        let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = Utc::now().to_rfc3339();
        database.execute("INSERT INTO local_models (id, display_name, family, workflow_kind, model_file_name, model_relative_path, model_sha256, byte_size, model_modified_ms, text_encoder_file_name, text_encoder_relative_path, text_encoder_sha256, vae_file_name, vae_relative_path, vae_sha256, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16) ON CONFLICT(model_sha256, workflow_kind) DO UPDATE SET display_name=excluded.display_name, family=excluded.family, model_file_name=excluded.model_file_name, model_relative_path=excluded.model_relative_path, byte_size=excluded.byte_size, model_modified_ms=excluded.model_modified_ms, text_encoder_file_name=excluded.text_encoder_file_name, text_encoder_relative_path=excluded.text_encoder_relative_path, text_encoder_sha256=excluded.text_encoder_sha256, vae_file_name=excluded.vae_file_name, vae_relative_path=excluded.vae_relative_path, vae_sha256=excluded.vae_sha256, updated_at=excluded.updated_at", params![id, model.display_name, model.family, model.workflow_kind, model.model_file_name, model.model_relative_path, model.model_sha256, model.byte_size, model.model_modified_ms, model.text_encoder_file_name, model.text_encoder_relative_path, model.text_encoder_sha256, model.vae_file_name, model.vae_relative_path, model.vae_sha256, now]).map_err(|error| format!("登记本地模型失败：{error}"))?;
        drop(database);
        self.local_model(&id)?.ok_or_else(|| "本地模型登记后不存在".into())
    }

    /** 返回所有已登记模型，并实时校验主文件大小和修改时间。 */
    pub fn list_local_models(&self) -> Result<Vec<DesktopLocalModelView>, String> {
        let settings = self.load_settings()?;
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let mut statement = database.prepare("SELECT id,display_name,family,workflow_kind,model_file_name,model_relative_path,model_sha256,byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,vae_file_name,vae_relative_path,created_at,updated_at FROM local_models ORDER BY updated_at DESC").map_err(|error| format!("读取本地模型列表失败：{error}"))?;
        let rows = statement.query_map([], |row| local_model_from_row(row, &settings.model_root)).map_err(|error| format!("查询本地模型列表失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析本地模型列表失败：{error}"))
    }

    /** 按内容哈希幂等登记本机 LoRA。 */
    pub fn register_local_lora(&self, lora: LocalLoraRegistration) -> Result<DesktopLocalLoraView, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let existing: Option<String> = database.query_row("SELECT id FROM local_loras WHERE sha256=?1", [&lora.sha256], |row| row.get(0)).optional().map_err(|error| format!("查询本地 LoRA 失败：{error}"))?;
        let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = Utc::now().to_rfc3339();
        let trigger_words_json = serde_json::to_string(&lora.trigger_words).map_err(|error| format!("序列化 LoRA 触发词失败：{error}"))?;
        database.execute("INSERT INTO local_loras (id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10) ON CONFLICT(sha256) DO UPDATE SET title=excluded.title,type=excluded.type,file_name=excluded.file_name,relative_path=excluded.relative_path,byte_size=excluded.byte_size,modified_ms=excluded.modified_ms,trigger_words_json=excluded.trigger_words_json,updated_at=excluded.updated_at", params![id,lora.title,lora.r#type,lora.file_name,lora.relative_path,lora.sha256,lora.byte_size,lora.modified_ms,trigger_words_json,now]).map_err(|error| format!("登记本地 LoRA 失败：{error}"))?;
        drop(database);
        self.local_lora(&id)?.ok_or_else(|| "本地 LoRA 登记后不存在".into())
    }

    /** 返回当前设备全部已登记 LoRA 和实时文件可用性。 */
    pub fn list_local_loras(&self) -> Result<Vec<DesktopLocalLoraView>, String> {
        let settings = self.load_settings()?;
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let mut statement = database.prepare("SELECT id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json,created_at,updated_at FROM local_loras ORDER BY updated_at DESC").map_err(|error| format!("读取本地 LoRA 列表失败：{error}"))?;
        let rows = statement.query_map([], |row| local_lora_from_row(row, &settings.model_root)).map_err(|error| format!("查询本地 LoRA 列表失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析本地 LoRA 列表失败：{error}"))
    }

    fn local_lora(&self, id: &str) -> Result<Option<DesktopLocalLoraView>, String> {
        let settings = self.load_settings()?;
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json,created_at,updated_at FROM local_loras WHERE id=?1", [id], |row| local_lora_from_row(row, &settings.model_root)).optional().map_err(|error| format!("读取本地 LoRA 失败：{error}"))
    }

    /** 创建持久化本地训练集，后续图片导入、打标和训练共用同一记录。 */
    pub fn create_training_dataset(&self, input: DesktopTrainingDatasetCreateInput) -> Result<DesktopTrainingDatasetView, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training_dataset::create_dataset(&database, input)
    }

    /** 返回当前设备全部训练集与真实图片摘要。 */
    pub fn list_training_datasets(&self) -> Result<Vec<DesktopTrainingDatasetView>, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training_dataset::list_datasets(&database, &self.app_data_dir)
    }

    /** 保存单张训练图片 Caption 并重新计算确认门禁。 */
    pub fn update_training_caption(&self, input: DesktopTrainingCaptionUpdateInput) -> Result<DesktopTrainingDatasetView, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training_dataset::update_caption(&database, &self.app_data_dir, input)
    }

    /** 创建持久化打标任务并立即唤醒独立 Caption Worker。 */
    pub fn create_caption_job(&self, input: DesktopCaptionJobCreateInput) -> Result<DesktopCaptionJobView, String> {
        let scheduler = self.caption_scheduler.as_ref().ok_or_else(|| "本地打标调度器尚未启动".to_string())?;
        let mut database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::captioner::create_job(&mut database, input)?;
        drop(database);
        scheduler.wake();
        Ok(job)
    }

    /** 返回最近的离线自动打标任务。 */
    pub fn list_caption_jobs(&self) -> Result<Vec<DesktopCaptionJobView>, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::captioner::list_jobs(&database)
    }

    /** 幂等请求取消排队或运行中的离线自动打标任务。 */
    pub fn cancel_caption_job(&self, id: &str) -> Result<DesktopCaptionJobView, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::captioner::cancel_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.caption_scheduler { scheduler.wake(); }
        Ok(job)
    }

    /** 固化已确认数据集和 Anima 底模后创建本地训练任务。 */
    pub fn create_training_job(&self, input: DesktopTrainingJobCreateInput) -> Result<DesktopTrainingJobView, String> {
        let scheduler = self.training_scheduler.as_ref().ok_or_else(|| "本地训练调度器尚未启动".to_string())?;
        let settings = self.load_settings()?;
        crate::environment::require_training_ready(&settings)?;
        let mut database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::training::create_job(&mut database, &self.app_data_dir, Path::new(&settings.model_root), input)?;
        drop(database);
        scheduler.wake();
        Ok(job)
    }

    /** 返回最近的持久化本地训练任务。 */
    pub fn list_training_jobs(&self) -> Result<Vec<DesktopTrainingJobView>, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training::list_jobs(&database)
    }

    /** 幂等取消排队或运行中的本地训练任务。 */
    pub fn cancel_training_job(&self, id: &str) -> Result<DesktopTrainingJobView, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::training::cancel_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.training_scheduler { scheduler.wake(); }
        Ok(job)
    }

    /** 创建持久任务后唤醒串行调度器，提交线程不等待生成完成。 */
    pub fn create_local_job(&self, input: DesktopLocalJobCreateInput) -> Result<DesktopLocalJobView, String> {
        let scheduler = self.scheduler.as_ref().ok_or_else(|| "本地调度器尚未启动".to_string())?;
        let settings = self.load_settings()?;
        crate::environment::require_inference_ready(&settings)?;
        let mut database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::scheduler::create_job(&mut database, &settings, input)?;
        drop(database);
        scheduler.wake();
        Ok(job)
    }

    /** 读取最近本地任务。 */
    pub fn list_local_jobs(&self) -> Result<Vec<DesktopLocalJobView>, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::scheduler::list_jobs(&database)
    }

    /** 请求取消任务并唤醒调度器处理状态变化。 */
    pub fn cancel_local_job(&self, id: &str) -> Result<DesktopLocalJobView, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::scheduler::cancel_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.scheduler { scheduler.wake(); }
        Ok(job)
    }

    /** Runtime 停止门禁只统计真实运行中的本地任务。 */
    pub fn running_local_job_count(&self) -> Result<u64, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT COUNT(*) FROM local_jobs WHERE status='running'", [], |row| row.get(0)).map_err(|error| format!("统计运行中本地任务失败：{error}"))
    }

    fn local_model(&self, id: &str) -> Result<Option<DesktopLocalModelView>, String> {
        let settings = self.load_settings()?;
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT id,display_name,family,workflow_kind,model_file_name,model_relative_path,model_sha256,byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,vae_file_name,vae_relative_path,created_at,updated_at FROM local_models WHERE id=?1", [id], |row| local_model_from_row(row, &settings.model_root)).optional().map_err(|error| format!("读取本地模型失败：{error}"))
    }

    fn gallery_item(&self, id: &str) -> Result<Option<GallerySyncItem>, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT id, local_task_id, artifact_path, artifact_sha256, privacy, status, uploaded_bytes, retry_count, gallery_item_id, last_error, created_at, updated_at FROM gallery_sync_queue WHERE id=?1", [id], gallery_item_from_row).optional().map_err(|error| format!("读取图库同步记录失败：{error}"))
    }
}

/** 已完成文件复制和哈希校验、等待写入 SQLite 的模型记录。 */
pub struct LocalModelRegistration {
    pub display_name: String,
    pub family: String,
    pub workflow_kind: String,
    pub model_file_name: String,
    pub model_relative_path: String,
    pub model_sha256: String,
    pub byte_size: u64,
    pub model_modified_ms: u64,
    pub text_encoder_file_name: Option<String>,
    pub text_encoder_relative_path: Option<String>,
    pub text_encoder_sha256: Option<String>,
    pub vae_file_name: Option<String>,
    pub vae_relative_path: Option<String>,
    pub vae_sha256: Option<String>,
}

/** 已完成安全复制、等待写入 SQLite 的 LoRA 记录。 */
pub struct LocalLoraRegistration {
    pub title: String,
    pub r#type: String,
    pub file_name: String,
    pub relative_path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub modified_ms: u64,
    pub trigger_words: Vec<String>,
}

fn local_model_from_row(row: &rusqlite::Row<'_>, model_root: &str) -> rusqlite::Result<DesktopLocalModelView> {
    let relative_path: String = row.get(5)?;
    let expected_size: u64 = row.get(7)?;
    let expected_modified_ms: u64 = row.get(8)?;
    let metadata = Path::new(model_root).join(relative_path).metadata().ok();
    let workflow_kind: String = row.get(3)?;
    let text_relative_path: Option<String> = row.get(10)?;
    let vae_relative_path: Option<String> = row.get(12)?;
    let primary_available = metadata.as_ref().is_some_and(|value| value.is_file() && value.len() == expected_size && modified_millis(value).ok() == Some(expected_modified_ms));
    let components_available = workflow_kind != "anima" || (text_relative_path.as_ref().is_some_and(|path| Path::new(model_root).join(path).is_file()) && vae_relative_path.as_ref().is_some_and(|path| Path::new(model_root).join(path).is_file()));
    Ok(DesktopLocalModelView { id: row.get(0)?, display_name: row.get(1)?, family: row.get(2)?, workflow_kind, model_file_name: row.get(4)?, model_sha256: row.get(6)?, byte_size: expected_size, text_encoder_file_name: row.get(9)?, vae_file_name: row.get(11)?, available: primary_available && components_available, created_at: row.get(13)?, updated_at: row.get(14)? })
}

fn local_lora_from_row(row: &rusqlite::Row<'_>, model_root: &str) -> rusqlite::Result<DesktopLocalLoraView> {
    let relative_path: String = row.get(4)?;
    let expected_size: u64 = row.get(6)?;
    let expected_modified_ms: u64 = row.get(7)?;
    let metadata = Path::new(model_root).join(relative_path).metadata().ok();
    let trigger_words_json: String = row.get(8)?;
    let trigger_words = serde_json::from_str(&trigger_words_json).map_err(|error| rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error)))?;
    let available = metadata.as_ref().is_some_and(|value| value.is_file() && value.len() == expected_size && modified_millis(value).ok() == Some(expected_modified_ms));
    Ok(DesktopLocalLoraView { id: row.get(0)?, title: row.get(1)?, r#type: row.get(2)?, file_name: row.get(3)?, sha256: row.get(5)?, byte_size: expected_size, trigger_words, available, created_at: row.get(9)?, updated_at: row.get(10)? })
}

fn gallery_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GallerySyncItem> { Ok(GallerySyncItem { id: row.get(0)?, local_task_id: row.get(1)?, artifact_path: row.get(2)?, artifact_sha256: row.get(3)?, privacy: row.get(4)?, status: row.get(5)?, uploaded_bytes: row.get(6)?, retry_count: row.get(7)?, gallery_item_id: row.get(8)?, last_error: row.get(9)?, created_at: row.get(10)?, updated_at: row.get(11)? }) }
/** 旧版本数据库按列幂等迁移，升级不会覆盖已有目录、隐私或同步队列。 */
fn ensure_column(database: &Connection, table: &str, column: &str, definition: &str) -> Result<(), String> {
    let mut statement = database.prepare(&format!("PRAGMA table_info({table})")).map_err(|error| format!("读取桌面数据库结构失败：{error}"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| format!("查询桌面数据库字段失败：{error}"))?.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析桌面数据库字段失败：{error}"))?;
    if !columns.iter().any(|item| item == column) { database.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), []).map_err(|error| format!("升级桌面数据库失败：{error}"))?; }
    Ok(())
}
fn path_text(path: &Path) -> String { path.to_string_lossy().into_owned() }
fn modified_millis(metadata: &fs::Metadata) -> Result<u64, String> { metadata.modified().map_err(|error| format!("读取模型修改时间失败：{error}"))?.duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_millis() as u64).map_err(|_| "模型修改时间早于系统纪元".to_string()) }
fn sha256_file(path: &Path) -> Result<String, String> { let file = fs::File::open(path).map_err(|error| format!("读取本地结果失败：{error}"))?; let mut reader = BufReader::new(file); let mut hasher = Sha256::new(); let mut buffer = [0_u8; 1024 * 1024]; loop { let read = reader.read(&mut buffer).map_err(|error| format!("计算文件哈希失败：{error}"))?; if read == 0 { break; } hasher.update(&buffer[..read]); } Ok(hex::encode(hasher.finalize())) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_gallery_queue_are_persistent_and_idempotent() {
        let temporary = tempfile::tempdir().expect("创建临时目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化数据库");
        let mut settings = state.load_settings().expect("读取设置");
        assert_eq!(settings.theme_mode, "system");
        assert_eq!(settings.dependency_source, "auto");
        assert_eq!(settings.default_privacy, "public");
        settings.default_privacy = "public".into();
        assert_eq!(state.save_settings(settings).expect("保存设置").default_privacy, "public");
        let artifact = temporary.path().join("result.webp");
        fs::write(&artifact, b"verified-local-result").expect("写入结果");
        let first = state.enqueue_gallery_publication(GalleryPublicationInput { local_task_id: "local-task-1".into(), artifact_path: path_text(&artifact), privacy: "private".into() }).expect("加入队列");
        let second = state.enqueue_gallery_publication(GalleryPublicationInput { local_task_id: "local-task-1".into(), artifact_path: path_text(&artifact), privacy: "public".into() }).expect("幂等更新队列");
        assert_eq!(first.id, second.id);
        // 同一产物的隐私冲突始终保留更严格的私有状态。
        assert_eq!(second.privacy, "private");
        assert_eq!(state.pending_gallery_sync_count().expect("统计队列"), 1);
    }

    #[test]
    fn restart_finishes_caption_job_with_pending_cancellation() {
        let temporary = tempfile::tempdir().expect("创建取消恢复临时目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化数据库");
        let dataset_id = Uuid::new_v4().to_string();
        let asset_id = Uuid::new_v4().to_string();
        let job_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        {
            let database = state.database.lock().expect("锁定取消恢复数据库");
            database.execute("INSERT INTO local_training_datasets (id,title,type,trigger_words_json,status,created_at,updated_at) VALUES (?1,'恢复测试','character','[]','draft',?2,?2)", params![dataset_id,now]).expect("创建恢复测试训练集");
            database.execute("INSERT INTO local_training_assets (id,dataset_id,file_name,relative_path,sha256,byte_size,width,height,caption,confirmed,created_at,updated_at) VALUES (?1,?2,'sample.png','sample.png',?3,1,1,1,NULL,0,?4,?4)", params![asset_id,dataset_id,"a".repeat(64),now]).expect("创建恢复测试图片");
            database.execute("INSERT INTO local_caption_jobs (id,dataset_id,status,progress,total_assets,general_threshold,character_threshold,include_character_tags,cancel_requested,created_at,started_at,updated_at) VALUES (?1,?2,'running',0,1,0.35,0.85,0,1,?3,?3,?3)", params![job_id,dataset_id,now]).expect("创建待取消打标任务");
            database.execute("INSERT INTO local_caption_job_items (job_id,asset_id,status,created_at,updated_at) VALUES (?1,?2,'running',?3,?3)", params![job_id,asset_id,now]).expect("创建待取消逐图任务");
        }
        drop(state);

        let restored = DesktopState::initialize(temporary.path()).expect("重新初始化数据库");
        let database = restored.database.lock().expect("锁定恢复后的数据库");
        let job = crate::captioner::list_jobs(&database).expect("读取恢复后的任务").into_iter().find(|item| item.id == job_id).expect("找到恢复后的任务");
        assert_eq!(job.status, "cancelled");
        assert_eq!(job.progress, 100);
        assert_eq!(job.processed_assets, 1);
        assert_eq!(job.items[0].status, "cancelled");
    }
}
