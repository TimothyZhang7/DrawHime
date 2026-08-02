//! 本模块管理桌面端独立 SQLite、目录设置和图库同步队列，不连接网页或独立平台数据库。

use crate::ai_cleaner::AiCleanScheduler;
use crate::captioner::CaptionScheduler;
use crate::gallery_sync::GallerySyncScheduler;
use crate::models::{
    DesktopAiCleanApplyInput, DesktopAiCleanJobCreateInput, DesktopAiCleanJobView,
    DesktopAiCleanUndoInput, DesktopAiSettings, DesktopCaptionJobCreateInput,
    DesktopCaptionJobView, DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalLoraView,
    DesktopLocalModelView, DesktopLogPageView, DesktopLogQueryInput, DesktopSettings,
    DesktopTrainingBatchTagsInput, DesktopTrainingCaptionUpdateInput,
    DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetView, DesktopTrainingJobCreateInput,
    DesktopTrainingJobView, DesktopTrainingSnapshotCopyInput, DesktopTrainingSnapshotView,
    DesktopTrainingTriggerWordsUpdateInput, DesktopWebsiteModelView, GalleryPublicationInput,
    GallerySyncItem,
};
use crate::runtime::RuntimeController;
use crate::scheduler::LocalScheduler;
use crate::trainer::TrainingScheduler;
use crate::workload::GpuWorkloadCoordinator;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub struct DesktopState {
    pub database: Mutex<Connection>,
    pub app_data_dir: PathBuf,
    pub database_path: PathBuf,
    pub scheduler: Option<LocalScheduler>,
    pub caption_scheduler: Option<CaptionScheduler>,
    pub ai_clean_scheduler: Option<AiCleanScheduler>,
    pub training_scheduler: Option<TrainingScheduler>,
    pub gallery_sync_scheduler: Option<GallerySyncScheduler>,
    pub runtime: Arc<RuntimeController>,
    pub gpu_workload: Arc<GpuWorkloadCoordinator>,
}

impl DesktopState {
    /** 创建本地数据目录和数据库结构，任何失败都阻止桌面核心伪装为可用。 */
    pub fn initialize(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| format!("创建桌面数据目录失败：{error}"))?;
        let database_path = app_data_dir.join("desktop.sqlite3");
        let connection = Connection::open(&database_path)
            .map_err(|error| format!("打开桌面数据库失败：{error}"))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS desktop_settings (id INTEGER PRIMARY KEY CHECK(id=1), theme_mode TEXT NOT NULL DEFAULT 'system', font_scale REAL NOT NULL DEFAULT 1.1, content_font_scale REAL NOT NULL DEFAULT 1.2, default_privacy TEXT NOT NULL DEFAULT 'public', auto_upload INTEGER NOT NULL DEFAULT 1, model_root TEXT NOT NULL, output_root TEXT NOT NULL, runtime_root TEXT NOT NULL, upload_concurrency INTEGER NOT NULL, wifi_only INTEGER NOT NULL, bandwidth_limit_kib INTEGER, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS desktop_ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, endpoint_type TEXT NOT NULL DEFAULT 'openai_chat', base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS environment_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, report_json TEXT NOT NULL, checked_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS software_updates (version TEXT PRIMARY KEY, resource_id TEXT NOT NULL, file_name TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT);
            CREATE TABLE IF NOT EXISTS gallery_sync_queue (id TEXT PRIMARY KEY, local_task_id TEXT NOT NULL, artifact_path TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, privacy TEXT NOT NULL, status TEXT NOT NULL, uploaded_bytes INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, gallery_item_id TEXT, last_error TEXT, owner_issuer TEXT, owner_subject TEXT, server_upload_id TEXT, next_attempt_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(local_task_id, artifact_sha256));
            CREATE TABLE IF NOT EXISTS local_models (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, family TEXT NOT NULL, workflow_kind TEXT NOT NULL, model_file_name TEXT NOT NULL, model_relative_path TEXT NOT NULL, model_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, model_modified_ms INTEGER NOT NULL, text_encoder_file_name TEXT, text_encoder_relative_path TEXT, text_encoder_sha256 TEXT, vae_file_name TEXT, vae_relative_path TEXT, vae_sha256 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(model_sha256, workflow_kind));
            CREATE TABLE IF NOT EXISTS local_loras (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL, modified_ms INTEGER NOT NULL, trigger_words_json TEXT NOT NULL, base_model_sha256 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS local_training_datasets (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, trigger_words_json TEXT NOT NULL, status TEXT NOT NULL, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS local_training_assets (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, file_name TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, caption TEXT, selected_derivative_id TEXT, confirmed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(dataset_id,sha256), FOREIGN KEY(dataset_id) REFERENCES local_training_datasets(id));
            CREATE TABLE IF NOT EXISTS local_training_asset_derivatives (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('background_removed')), source TEXT NOT NULL CHECK(source IN ('auto','manual')), relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(asset_id) REFERENCES local_training_assets(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS local_training_asset_tags (asset_id TEXT NOT NULL, normalized_value TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('auto','ai_cleaned','manual','imported','trigger')), position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(asset_id,normalized_value), FOREIGN KEY(asset_id) REFERENCES local_training_assets(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS local_training_tag_changes (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, operation TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, FOREIGN KEY(asset_id) REFERENCES local_training_assets(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS local_caption_jobs (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, asset_id TEXT, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, total_assets INTEGER NOT NULL, processed_assets INTEGER NOT NULL DEFAULT 0, succeeded_assets INTEGER NOT NULL DEFAULT 0, failed_assets INTEGER NOT NULL DEFAULT 0, skipped_assets INTEGER NOT NULL DEFAULT 0, general_threshold REAL NOT NULL, character_threshold REAL NOT NULL, include_character_tags INTEGER NOT NULL, pause_requested INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES local_training_datasets(id));
            CREATE TABLE IF NOT EXISTS local_caption_job_items (job_id TEXT NOT NULL, asset_id TEXT NOT NULL, force_replace INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, caption TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,asset_id), FOREIGN KEY(job_id) REFERENCES local_caption_jobs(id), FOREIGN KEY(asset_id) REFERENCES local_training_assets(id));
            CREATE TABLE IF NOT EXISTS local_ai_clean_jobs (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, total_assets INTEGER NOT NULL, processed_assets INTEGER NOT NULL DEFAULT 0, succeeded_assets INTEGER NOT NULL DEFAULT 0, failed_assets INTEGER NOT NULL DEFAULT 0, training_goal TEXT NOT NULL, pause_requested INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES local_training_datasets(id));
            CREATE TABLE IF NOT EXISTS local_ai_clean_job_items (job_id TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, original_tags_json TEXT NOT NULL, proposal_json TEXT, apply_status TEXT NOT NULL DEFAULT 'pending', applied_change_id TEXT, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,asset_id), FOREIGN KEY(job_id) REFERENCES local_ai_clean_jobs(id));
            CREATE TABLE IF NOT EXISTS local_background_removal_jobs (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, total_assets INTEGER NOT NULL, processed_assets INTEGER NOT NULL DEFAULT 0, succeeded_assets INTEGER NOT NULL DEFAULT 0, failed_assets INTEGER NOT NULL DEFAULT 0, pause_requested INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES local_training_datasets(id));
            CREATE TABLE IF NOT EXISTS local_background_removal_job_items (job_id TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL, derivative_id TEXT, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(job_id,asset_id), FOREIGN KEY(job_id) REFERENCES local_background_removal_jobs(id), FOREIGN KEY(asset_id) REFERENCES local_training_assets(id), FOREIGN KEY(derivative_id) REFERENCES local_training_asset_derivatives(id));
            CREATE TABLE IF NOT EXISTS local_training_jobs (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, dataset_title TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, current_epoch INTEGER NOT NULL DEFAULT 0, total_epochs INTEGER NOT NULL, model_id TEXT NOT NULL, model_display_name TEXT NOT NULL, workflow_kind TEXT NOT NULL, model_file_name TEXT NOT NULL, model_relative_path TEXT NOT NULL, model_sha256 TEXT NOT NULL, model_byte_size INTEGER NOT NULL, model_modified_ms INTEGER NOT NULL, text_encoder_file_name TEXT NOT NULL, text_encoder_relative_path TEXT NOT NULL, text_encoder_sha256 TEXT NOT NULL, vae_file_name TEXT NOT NULL, vae_relative_path TEXT NOT NULL, vae_sha256 TEXT NOT NULL, parameters_json TEXT NOT NULL, trigger_words_json TEXT NOT NULL, asset_count INTEGER NOT NULL, use_ai_tag_processing INTEGER NOT NULL DEFAULT 0, training_goal TEXT NOT NULL DEFAULT '', preprocessing_status TEXT NOT NULL DEFAULT 'not_requested', preprocessing_progress INTEGER NOT NULL DEFAULT 100, preprocessing_error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, output_lora_id TEXT, error TEXT, suggestion_json TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES local_training_datasets(id), FOREIGN KEY(model_id) REFERENCES local_models(id));
            CREATE TABLE IF NOT EXISTS local_training_job_assets (job_id TEXT NOT NULL, sequence INTEGER NOT NULL, asset_id TEXT NOT NULL, file_name TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, caption TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', image_variant TEXT NOT NULL DEFAULT 'original', derivative_source TEXT, ai_clean_status TEXT NOT NULL DEFAULT 'not_requested', ai_clean_attempt_count INTEGER NOT NULL DEFAULT 0, ai_clean_proposal_json TEXT, ai_clean_error TEXT, PRIMARY KEY(job_id,sequence), UNIQUE(job_id,asset_id), FOREIGN KEY(job_id) REFERENCES local_training_jobs(id));
            CREATE TABLE IF NOT EXISTS local_training_job_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, completed_at TEXT, UNIQUE(job_id,attempt_number), FOREIGN KEY(job_id) REFERENCES local_training_jobs(id));
            CREATE TABLE IF NOT EXISTS local_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, progress INTEGER NOT NULL, prompt TEXT NOT NULL, negative_prompt TEXT, model_id TEXT NOT NULL, model_display_name TEXT NOT NULL, workflow_kind TEXT NOT NULL, model_file_name TEXT NOT NULL, model_relative_path TEXT NOT NULL, model_sha256 TEXT NOT NULL, text_encoder_file_name TEXT, vae_file_name TEXT, width INTEGER NOT NULL, height INTEGER NOT NULL, quality_preset TEXT NOT NULL DEFAULT 'custom', steps INTEGER NOT NULL, cfg REAL NOT NULL, sampler_name TEXT NOT NULL, scheduler_name TEXT NOT NULL, sampling_max_edge INTEGER NOT NULL DEFAULT 1536, sampling_pixel_budget INTEGER NOT NULL DEFAULT 1350000, aspect_step_threshold REAL NOT NULL DEFAULT 1.5, aspect_adjusted_steps INTEGER NOT NULL DEFAULT 34, upscale_method TEXT NOT NULL DEFAULT 'lanczos', quality_prompt_enabled INTEGER NOT NULL DEFAULT 0, quality_prefix TEXT, default_negative_enabled INTEGER NOT NULL DEFAULT 0, default_negative_prompt TEXT, seed INTEGER NOT NULL, privacy TEXT NOT NULL, runtime_prompt_id TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(model_id) REFERENCES local_models(id));
            CREATE TABLE IF NOT EXISTS local_job_attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL, runtime_prompt_id TEXT, error TEXT, started_at TEXT NOT NULL, completed_at TEXT, UNIQUE(job_id,attempt_number), FOREIGN KEY(job_id) REFERENCES local_jobs(id));
            CREATE TABLE IF NOT EXISTS local_job_loras (job_id TEXT NOT NULL, sequence INTEGER NOT NULL, lora_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, file_name TEXT NOT NULL, relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, modified_ms INTEGER NOT NULL, strength REAL NOT NULL, clip_strength REAL NOT NULL, trigger_words_json TEXT NOT NULL, PRIMARY KEY(job_id,sequence), UNIQUE(job_id,lora_id), FOREIGN KEY(job_id) REFERENCES local_jobs(id), FOREIGN KEY(lora_id) REFERENCES local_loras(id));
            CREATE TABLE IF NOT EXISTS local_artifacts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(job_id) REFERENCES local_jobs(id));
            CREATE TABLE IF NOT EXISTS desktop_logs (id TEXT PRIMARY KEY, task_id TEXT, level TEXT NOT NULL, scope TEXT NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS gallery_sync_status_idx ON gallery_sync_queue(status, created_at);
            CREATE INDEX IF NOT EXISTS local_jobs_status_idx ON local_jobs(status, created_at);
            CREATE INDEX IF NOT EXISTS local_training_jobs_status_idx ON local_training_jobs(status, created_at);
            CREATE INDEX IF NOT EXISTS local_training_jobs_dataset_idx ON local_training_jobs(dataset_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS local_training_assets_dataset_idx ON local_training_assets(dataset_id, created_at);
            CREATE INDEX IF NOT EXISTS local_training_asset_tags_source_idx ON local_training_asset_tags(asset_id, source, position);
            CREATE INDEX IF NOT EXISTS local_training_asset_derivatives_asset_idx ON local_training_asset_derivatives(asset_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS local_training_tag_changes_asset_idx ON local_training_tag_changes(asset_id, created_at DESC);").map_err(|error| format!("初始化桌面数据库失败：{error}"))?;
        connection.execute_batch("CREATE INDEX IF NOT EXISTS desktop_logs_created_idx ON desktop_logs(created_at DESC); CREATE INDEX IF NOT EXISTS desktop_logs_task_idx ON desktop_logs(task_id,created_at DESC); CREATE INDEX IF NOT EXISTS desktop_logs_level_idx ON desktop_logs(level,created_at DESC);").map_err(|error| format!("初始化桌面日志索引失败：{error}"))?;
        crate::desktop_logs::initialize_retention(&connection)?;
        connection.execute_batch("CREATE INDEX IF NOT EXISTS local_ai_clean_jobs_status_idx ON local_ai_clean_jobs(status,created_at); CREATE INDEX IF NOT EXISTS local_ai_clean_items_asset_idx ON local_ai_clean_job_items(asset_id,updated_at DESC);").map_err(|error| format!("初始化 AI 清洗索引失败：{error}"))?;
        // 训练集删除只隐藏并清理原始受管目录，历史训练任务和快照继续引用审计行。
        ensure_column(&connection, "local_training_datasets", "deleted_at", "TEXT")?;
        ensure_training_snapshot_schema(&connection)?;
        // 打标与 AI 清洗暂停状态是持久事实；旧数据库只增列，不重写任务结果。
        ensure_column(
            &connection,
            "local_caption_jobs",
            "pause_requested",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "local_ai_clean_jobs",
            "pause_requested",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        // 旧训练集升级后默认继续使用原图；派生版本只能由用户明确选择。
        ensure_column(
            &connection,
            "local_training_assets",
            "selected_derivative_id",
            "TEXT",
        )?;
        connection.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS local_background_removal_jobs_active_dataset_idx ON local_background_removal_jobs(dataset_id) WHERE status IN ('queued','running','paused'); CREATE INDEX IF NOT EXISTS local_background_removal_jobs_created_idx ON local_background_removal_jobs(created_at DESC);").map_err(|error| format!("初始化抠图任务索引失败：{error}"))?;
        // 训练任务 AI 标签处理是可恢复的快照阶段，升级只增列，不改写任何既有任务内容。
        ensure_column(
            &connection,
            "local_training_jobs",
            "use_ai_tag_processing",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "local_training_jobs",
            "training_goal",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &connection,
            "local_training_jobs",
            "preprocessing_status",
            "TEXT NOT NULL DEFAULT 'not_requested'",
        )?;
        ensure_column(
            &connection,
            "local_training_jobs",
            "preprocessing_progress",
            "INTEGER NOT NULL DEFAULT 100",
        )?;
        ensure_column(
            &connection,
            "local_training_jobs",
            "preprocessing_error",
            "TEXT",
        )?;
        ensure_column(
            &connection,
            "local_training_job_assets",
            "ai_clean_status",
            "TEXT NOT NULL DEFAULT 'not_requested'",
        )?;
        ensure_column(
            &connection,
            "local_training_job_assets",
            "ai_clean_attempt_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "local_training_job_assets",
            "ai_clean_proposal_json",
            "TEXT",
        )?;
        ensure_column(
            &connection,
            "local_training_job_assets",
            "ai_clean_error",
            "TEXT",
        )?;
        crate::training::materialize_existing_snapshots(&connection, app_data_dir)?;
        let recovery_time = Utc::now().to_rfc3339();
        connection.execute("UPDATE local_job_attempts SET status='interrupted',completed_at=?1 WHERE status='running'", [&recovery_time]).map_err(|error| format!("恢复中断的本地任务尝试失败：{error}"))?;
        connection.execute("UPDATE local_jobs SET status='queued', progress=0, runtime_prompt_id=NULL, started_at=NULL, updated_at=?1 WHERE status='running'", [&recovery_time]).map_err(|error| format!("恢复中断的本地任务失败：{error}"))?;
        // 退出前已经收到取消请求的任务必须恢复为终态，避免重启后永久占用训练集活动任务索引。
        connection.execute("UPDATE local_caption_job_items SET status='cancelled',updated_at=?1 WHERE status='running' AND job_id IN (SELECT id FROM local_caption_jobs WHERE status='running' AND cancel_requested=1)", [&recovery_time]).map_err(|error| format!("恢复已取消的逐图打标状态失败：{error}"))?;
        connection.execute("UPDATE local_caption_jobs SET status='cancelled',progress=100,processed_assets=total_assets,completed_at=?1,updated_at=?1 WHERE status='running' AND cancel_requested=1", [&recovery_time]).map_err(|error| format!("恢复已取消的打标任务失败：{error}"))?;
        connection.execute("UPDATE local_caption_jobs SET status=CASE WHEN pause_requested=1 THEN 'paused' ELSE 'queued' END,started_at=CASE WHEN pause_requested=1 THEN started_at ELSE NULL END,updated_at=?1 WHERE status='running' AND cancel_requested=0", [&recovery_time]).map_err(|error| format!("恢复中断的打标任务失败：{error}"))?;
        // AI 清洗请求在崩溃时没有保存半结果；运行项重新排队并保留既有成功建议。
        connection.execute("UPDATE local_ai_clean_job_items SET status='queued',updated_at=?1 WHERE status='running' AND job_id IN (SELECT id FROM local_ai_clean_jobs WHERE cancel_requested=0)", [&recovery_time]).map_err(|error| format!("恢复中断的逐图 AI 清洗失败：{error}"))?;
        connection.execute("UPDATE local_ai_clean_jobs SET status=CASE WHEN pause_requested=1 THEN 'paused' ELSE 'queued' END,updated_at=?1 WHERE status='running' AND cancel_requested=0", [&recovery_time]).map_err(|error| format!("恢复中断的 AI 清洗任务失败：{error}"))?;
        connection.execute("UPDATE local_ai_clean_job_items SET status='cancelled',updated_at=?1 WHERE status IN ('queued','running') AND job_id IN (SELECT id FROM local_ai_clean_jobs WHERE cancel_requested=1)", [&recovery_time]).map_err(|error| format!("恢复已取消的逐图 AI 清洗失败：{error}"))?;
        connection.execute("UPDATE local_ai_clean_jobs SET status='cancelled',progress=100,processed_assets=total_assets,completed_at=?1,updated_at=?1 WHERE status IN ('queued','running') AND cancel_requested=1", [&recovery_time]).map_err(|error| format!("恢复已取消的 AI 清洗任务失败：{error}"))?;
        // 抠图功能已移除；历史任务和派生文件保留，只把未结束任务收敛为终态。
        connection.execute("UPDATE local_background_removal_job_items SET status='cancelled',error=COALESCE(error,'抠图功能已移除'),updated_at=?1 WHERE status IN ('queued','running')", [&recovery_time]).map_err(|error| format!("收敛历史抠图任务项失败：{error}"))?;
        connection.execute("UPDATE local_background_removal_jobs SET status='cancelled',progress=100,processed_assets=total_assets,cancel_requested=1,error=COALESCE(error,'抠图功能已移除'),completed_at=?1,updated_at=?1 WHERE status IN ('queued','running','paused')", [&recovery_time]).map_err(|error| format!("收敛历史抠图任务失败：{error}"))?;
        connection.execute("UPDATE local_caption_job_items SET status='queued',caption=NULL,error=NULL,updated_at=?1 WHERE status='running'", [&recovery_time]).map_err(|error| format!("恢复中断的逐图打标状态失败：{error}"))?;
        connection.execute("UPDATE local_training_job_attempts SET status='interrupted',error='桌面程序退出，训练任务已恢复排队',completed_at=?1 WHERE status='running'", [&recovery_time]).map_err(|error| format!("恢复中断的训练尝试失败：{error}"))?;
        connection.execute("UPDATE local_training_jobs SET status='cancelled',progress=100,completed_at=?1,updated_at=?1 WHERE status='running' AND cancel_requested=1", [&recovery_time]).map_err(|error| format!("恢复已取消的训练任务失败：{error}"))?;
        connection.execute("UPDATE local_training_jobs SET status='queued',progress=0,current_epoch=0,started_at=NULL,error=NULL,suggestion_json=NULL,updated_at=?1 WHERE status='running' AND cancel_requested=0", [&recovery_time]).map_err(|error| format!("恢复中断的训练任务失败：{error}"))?;
        connection.execute("UPDATE local_training_job_assets SET ai_clean_status='queued',ai_clean_error=NULL WHERE ai_clean_status='running' AND job_id IN (SELECT id FROM local_training_jobs WHERE cancel_requested=0)", []).map_err(|error| format!("恢复中断的训练快照 AI 标签项失败：{error}"))?;
        connection.execute("UPDATE local_training_jobs SET preprocessing_status='queued',preprocessing_error=NULL,updated_at=?1 WHERE preprocessing_status='running' AND cancel_requested=0", [&recovery_time]).map_err(|error| format!("恢复中断的训练快照 AI 标签阶段失败：{error}"))?;
        ensure_column(
            &connection,
            "desktop_settings",
            "theme_mode",
            "TEXT NOT NULL DEFAULT 'system'",
        )?;
        ensure_column(
            &connection,
            "desktop_settings",
            "font_scale",
            "REAL NOT NULL DEFAULT 1.1",
        )?;
        ensure_column(
            &connection,
            "desktop_settings",
            "content_font_scale",
            "REAL NOT NULL DEFAULT 1.2",
        )?;
        ensure_column(
            &connection,
            "desktop_settings",
            "auto_upload",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        ensure_column(&connection, "local_models", "resource_group_id", "TEXT")?;
        ensure_column(
            &connection,
            "local_models",
            "generation_profile_json",
            "TEXT",
        )?;
        ensure_column(&connection, "local_loras", "base_model_sha256", "TEXT")?;
        ensure_column(
            &connection,
            "local_job_loras",
            "relative_path",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &connection,
            "local_job_loras",
            "byte_size",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            &connection,
            "local_job_loras",
            "modified_ms",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "local_job_loras", "clip_strength", "REAL")?;
        // 生成参数迁移只补列并保留旧任务原始行为，历史任务不会被静默套用质量前缀。
        ensure_column(
            &connection,
            "local_jobs",
            "quality_preset",
            "TEXT NOT NULL DEFAULT 'custom'",
        )?;
        ensure_column(
            &connection,
            "local_jobs",
            "sampling_max_edge",
            "INTEGER NOT NULL DEFAULT 1536",
        )?;
        ensure_column(
            &connection,
            "local_jobs",
            "sampling_pixel_budget",
            "INTEGER NOT NULL DEFAULT 1350000",
        )?;
        ensure_column(
            &connection,
            "local_jobs",
            "aspect_step_threshold",
            "REAL NOT NULL DEFAULT 1.5",
        )?;
        ensure_column(
            &connection,
            "local_jobs",
            "aspect_adjusted_steps",
            "INTEGER NOT NULL DEFAULT 34",
        )?;
        ensure_column(
            &connection,
            "local_jobs",
            "upscale_method",
            "TEXT NOT NULL DEFAULT 'lanczos'",
        )?;
        ensure_column(
            &connection,
            "local_jobs",
            "quality_prompt_enabled",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "local_jobs", "quality_prefix", "TEXT")?;
        ensure_column(
            &connection,
            "local_jobs",
            "default_negative_enabled",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(&connection, "local_jobs", "default_negative_prompt", "TEXT")?;
        ensure_column(
            &connection,
            "local_training_assets",
            "caption_source",
            "TEXT",
        )?;
        // 旧版本只有整段 Caption 来源；新表创建后按原值和触发词一次性无损回填。
        crate::training_tags::backfill_existing_tags(&connection)?;
        ensure_column(&connection, "gallery_sync_queue", "owner_issuer", "TEXT")?;
        ensure_column(&connection, "gallery_sync_queue", "owner_subject", "TEXT")?;
        ensure_column(
            &connection,
            "gallery_sync_queue",
            "server_upload_id",
            "TEXT",
        )?;
        ensure_column(&connection, "gallery_sync_queue", "next_attempt_at", "TEXT")?;
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS local_caption_jobs_active_dataset_idx ON local_caption_jobs(dataset_id) WHERE status IN ('queued','running')", []).map_err(|error| format!("创建打标任务活动索引失败：{error}"))?;
        connection.execute("CREATE INDEX IF NOT EXISTS local_caption_jobs_created_idx ON local_caption_jobs(created_at DESC)", []).map_err(|error| format!("创建打标任务时间索引失败：{error}"))?;
        // 旧开发版本已经生成的 LoRA 快照补齐文件元数据，避免升级后任务失去可执行性。
        connection.execute("UPDATE local_job_loras SET relative_path=COALESCE(NULLIF(relative_path,''),(SELECT relative_path FROM local_loras WHERE id=local_job_loras.lora_id)),byte_size=CASE WHEN byte_size=0 THEN COALESCE((SELECT byte_size FROM local_loras WHERE id=local_job_loras.lora_id),0) ELSE byte_size END,modified_ms=CASE WHEN modified_ms=0 THEN COALESCE((SELECT modified_ms FROM local_loras WHERE id=local_job_loras.lora_id),0) ELSE modified_ms END", []).map_err(|error| format!("补齐任务 LoRA 快照失败：{error}"))?;
        connection
            .execute(
                "UPDATE local_job_loras SET clip_strength=strength WHERE clip_strength IS NULL",
                [],
            )
            .map_err(|error| format!("补齐任务 LoRA 文本编码器强度失败：{error}"))?;
        let model_root = app_data_dir.join("models");
        let runtime_root = app_data_dir.join("runtime");
        let output_root = app_data_dir.join("outputs");
        for directory in [&model_root, &runtime_root, &output_root] {
            fs::create_dir_all(directory).map_err(|error| format!("创建本地目录失败：{error}"))?;
        }
        connection.execute("INSERT OR IGNORE INTO desktop_settings (id, theme_mode, font_scale, default_privacy, auto_upload, model_root, output_root, runtime_root, upload_concurrency, wifi_only, bandwidth_limit_kib, updated_at) VALUES (1, 'system', 1.1, 'public', 1, ?1, ?2, ?3, 2, 0, NULL, ?4)", params![path_text(&model_root), path_text(&output_root), path_text(&runtime_root), Utc::now().to_rfc3339()]).map_err(|error| format!("写入默认设置失败：{error}"))?;
        connection.execute("INSERT OR IGNORE INTO desktop_ai_settings (id, enabled, endpoint_type, base_url, model, updated_at) VALUES (1, 0, 'openai_chat', '', '', ?1)", [Utc::now().to_rfc3339()]).map_err(|error| format!("写入默认 AI 设置失败：{error}"))?;
        Ok(Self {
            database: Mutex::new(connection),
            app_data_dir: app_data_dir.to_path_buf(),
            database_path,
            scheduler: None,
            caption_scheduler: None,
            ai_clean_scheduler: None,
            training_scheduler: None,
            gallery_sync_scheduler: None,
            runtime: Arc::new(RuntimeController::initialize(app_data_dir)?),
            gpu_workload: GpuWorkloadCoordinator::new(),
        })
    }

    /** 数据库初始化完成后启动唯一后台调度线程。 */
    pub fn start_scheduler(&mut self, app: tauri::AppHandle) -> Result<(), String> {
        if self.scheduler.is_some() {
            return Ok(());
        }
        self.scheduler = Some(LocalScheduler::start(
            self.database_path.clone(),
            self.app_data_dir.clone(),
            self.runtime.clone(),
            self.gpu_workload.clone(),
            app.clone(),
        )?);
        self.caption_scheduler = Some(CaptionScheduler::start(
            self.database_path.clone(),
            self.app_data_dir.clone(),
            app.clone(),
        )?);
        self.ai_clean_scheduler = Some(AiCleanScheduler::start(
            self.database_path.clone(),
            self.app_data_dir.clone(),
            app.clone(),
        )?);
        self.training_scheduler = Some(TrainingScheduler::start(
            self.database_path.clone(),
            self.app_data_dir.clone(),
            self.runtime.clone(),
            self.gpu_workload.clone(),
            app.clone(),
        )?);
        self.gallery_sync_scheduler = Some(GallerySyncScheduler::start(
            self.database_path.clone(),
            app,
        )?);
        Ok(())
    }

    /** 读取唯一桌面设置记录。 */
    pub fn load_settings(&self) -> Result<DesktopSettings, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT theme_mode, font_scale, content_font_scale, default_privacy, auto_upload, model_root, output_root, runtime_root, upload_concurrency, wifi_only, bandwidth_limit_kib FROM desktop_settings WHERE id=1", [], |row| Ok(DesktopSettings { theme_mode: row.get(0)?, font_scale: row.get(1)?, content_font_scale: row.get(2)?, default_privacy: row.get(3)?, auto_upload: row.get::<_, i64>(4)? != 0, model_root: row.get(5)?, output_root: row.get(6)?, runtime_root: row.get(7)?, upload_concurrency: row.get(8)?, wifi_only: row.get::<_, i64>(9)? != 0, bandwidth_limit_kib: row.get(10)? })).map_err(|error| format!("读取桌面设置失败：{error}"))
    }

    /** 校验目录和上传策略后事务化更新设置。 */
    pub fn save_settings(&self, mut settings: DesktopSettings) -> Result<DesktopSettings, String> {
        if !matches!(settings.theme_mode.as_str(), "system" | "dark" | "light") {
            return Err("主题模式不正确".into());
        }
        if !settings.font_scale.is_finite()
            || !(1.0..=1.3).contains(&settings.font_scale)
            || ((settings.font_scale * 20.0).round() - settings.font_scale * 20.0).abs() > 0.001
        {
            return Err("字体大小必须是 100%–130% 的 5% 档位".into());
        }
        if !settings.content_font_scale.is_finite()
            || !(1.0..=1.6).contains(&settings.content_font_scale)
            || ((settings.content_font_scale * 20.0).round() - settings.content_font_scale * 20.0)
                .abs()
                > 0.001
        {
            return Err("内容字体大小必须是 100%–160% 的 5% 档位".into());
        }
        if !matches!(settings.default_privacy.as_str(), "public" | "private") {
            return Err("默认图库权限不正确".into());
        }
        if !(1..=4).contains(&settings.upload_concurrency) {
            return Err("上传并发数必须是 1–4".into());
        }
        // 存储目录固定跟随安装目录，前端传入的旧目录值不得把模型或作品重新写到其他磁盘位置。
        settings.model_root = path_text(&self.app_data_dir.join("models"));
        settings.output_root = path_text(&self.app_data_dir.join("outputs"));
        settings.runtime_root = path_text(&self.app_data_dir.join("runtime"));
        for path in [
            &settings.model_root,
            &settings.output_root,
            &settings.runtime_root,
        ] {
            if path.trim().is_empty() {
                return Err("本地目录不能为空".into());
            }
            fs::create_dir_all(path).map_err(|error| format!("目录不可写：{path}：{error}"))?;
            let probe = Path::new(path).join(".drawhime-write-test");
            fs::write(&probe, b"ok").map_err(|error| format!("目录不可写：{path}：{error}"))?;
            fs::remove_file(probe).map_err(|error| format!("目录清理测试失败：{path}：{error}"))?;
        }
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.execute("UPDATE desktop_settings SET theme_mode=?1, font_scale=?2, content_font_scale=?3, default_privacy=?4, auto_upload=?5, model_root=?6, output_root=?7, runtime_root=?8, upload_concurrency=?9, wifi_only=?10, bandwidth_limit_kib=?11, updated_at=?12 WHERE id=1", params![settings.theme_mode, settings.font_scale, settings.content_font_scale, settings.default_privacy, settings.auto_upload, settings.model_root, settings.output_root, settings.runtime_root, settings.upload_concurrency, settings.wifi_only, settings.bandwidth_limit_kib, Utc::now().to_rfc3339()]).map_err(|error| format!("保存桌面设置失败：{error}"))?;
        drop(database);
        self.load_settings()
    }

    /** 读取不含密钥正文的 AI 辅助设置，凭据状态由调用方从 Credential Manager 合并。 */
    pub fn load_ai_settings(&self, api_key_configured: bool) -> Result<DesktopAiSettings, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT enabled, endpoint_type, base_url, model FROM desktop_ai_settings WHERE id=1", [], |row| Ok(DesktopAiSettings { enabled: row.get::<_, i64>(0)? != 0, endpoint_type: row.get(1)?, base_url: row.get(2)?, model: row.get(3)?, api_key_configured })).map_err(|error| format!("读取 AI 辅助设置失败：{error}"))
    }

    /** 持久化 AI 辅助非敏感配置，API Key 由独立凭据链路写入系统凭据库。 */
    pub fn save_ai_settings_metadata(
        &self,
        enabled: bool,
        endpoint_type: &str,
        base_url: &str,
        model: &str,
        api_key_configured: bool,
    ) -> Result<DesktopAiSettings, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.execute("UPDATE desktop_ai_settings SET enabled=?1, endpoint_type=?2, base_url=?3, model=?4, updated_at=?5 WHERE id=1", params![i64::from(enabled), endpoint_type, base_url, model, Utc::now().to_rfc3339()]).map_err(|error| format!("保存 AI 辅助设置失败：{error}"))?;
        drop(database);
        self.load_ai_settings(api_key_configured)
    }

    /** 保存脱敏环境快照并只保留最近 20 次检查。 */
    pub fn save_environment_snapshot(
        &self,
        report_json: &str,
        checked_at: &str,
    ) -> Result<(), String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let transaction = database
            .unchecked_transaction()
            .map_err(|error| format!("开启环境快照事务失败：{error}"))?;
        transaction
            .execute(
                "INSERT INTO environment_snapshots (report_json, checked_at) VALUES (?1, ?2)",
                params![report_json, checked_at],
            )
            .map_err(|error| format!("保存环境快照失败：{error}"))?;
        transaction.execute("DELETE FROM environment_snapshots WHERE id NOT IN (SELECT id FROM environment_snapshots ORDER BY id DESC LIMIT 20)", []).map_err(|error| format!("清理环境快照失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交环境快照失败：{error}"))
    }

    /** 校验真实本地文件并按任务与哈希幂等加入网页图库同步队列。 */
    pub fn enqueue_gallery_publication(
        &self,
        input: GalleryPublicationInput,
    ) -> Result<GallerySyncItem, String> {
        if input.local_task_id.trim().is_empty() {
            return Err("本地任务 ID 不能为空".into());
        }
        if !matches!(input.privacy.as_str(), "public" | "private") {
            return Err("图库权限不正确".into());
        }
        let path = PathBuf::from(&input.artifact_path);
        if !path.is_file() {
            return Err("本地生成结果不存在".into());
        }
        let sha256 = sha256_file(&path)?;
        let now = Utc::now().to_rfc3339();
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let existing: Option<String> = database
            .query_row(
                "SELECT id FROM gallery_sync_queue WHERE local_task_id=?1 AND artifact_sha256=?2",
                params![input.local_task_id, sha256],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("查询图库同步队列失败：{error}"))?;
        let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        database.execute("INSERT INTO gallery_sync_queue (id, local_task_id, artifact_path, artifact_sha256, privacy, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6) ON CONFLICT(local_task_id, artifact_sha256) DO UPDATE SET privacy=CASE WHEN gallery_sync_queue.privacy='private' OR excluded.privacy='private' THEN 'private' ELSE 'public' END, artifact_path=excluded.artifact_path,updated_at=excluded.updated_at", params![id, input.local_task_id, input.artifact_path, sha256, input.privacy, now]).map_err(|error| format!("写入图库同步队列失败：{error}"))?;
        drop(database);
        self.gallery_item(&id)?
            .ok_or_else(|| "图库同步记录写入后不存在".into())
    }

    /** 列出本机全部图库同步记录，新的记录优先。 */
    pub fn list_gallery_sync_queue(&self) -> Result<Vec<GallerySyncItem>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let mut statement = database.prepare("SELECT id, local_task_id, artifact_path, artifact_sha256, privacy, status, uploaded_bytes, retry_count, gallery_item_id, last_error, created_at, updated_at FROM gallery_sync_queue ORDER BY created_at DESC").map_err(|error| format!("读取图库同步队列失败：{error}"))?;
        let rows = statement
            .query_map([], gallery_item_from_row)
            .map_err(|error| format!("查询图库同步队列失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析图库同步队列失败：{error}"))
    }

    /** 统计尚未完成网页同步的本地作品。 */
    pub fn pending_gallery_sync_count(&self) -> Result<u64, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT COUNT(*) FROM gallery_sync_queue WHERE status NOT IN ('synced','remote_deleted')", [], |row| row.get(0)).map_err(|error| format!("统计图库同步队列失败：{error}"))
    }

    /** 按模型内容哈希幂等登记受控目录中的真实 safetensors。 */
    pub fn register_local_model(
        &self,
        model: LocalModelRegistration,
    ) -> Result<DesktopLocalModelView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let existing: Option<String> = database
            .query_row(
                "SELECT id FROM local_models WHERE model_sha256=?1 AND workflow_kind=?2",
                params![model.model_sha256, model.workflow_kind],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("查询本地模型失败：{error}"))?;
        let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = Utc::now().to_rfc3339();
        database.execute("INSERT INTO local_models (id, display_name, family, workflow_kind, model_file_name, model_relative_path, model_sha256, byte_size, model_modified_ms, text_encoder_file_name, text_encoder_relative_path, text_encoder_sha256, vae_file_name, vae_relative_path, vae_sha256, resource_group_id, generation_profile_json, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?18) ON CONFLICT(model_sha256, workflow_kind) DO UPDATE SET display_name=excluded.display_name, family=excluded.family, model_file_name=excluded.model_file_name, model_relative_path=excluded.model_relative_path, byte_size=excluded.byte_size, model_modified_ms=excluded.model_modified_ms, text_encoder_file_name=excluded.text_encoder_file_name, text_encoder_relative_path=excluded.text_encoder_relative_path, text_encoder_sha256=excluded.text_encoder_sha256, vae_file_name=excluded.vae_file_name, vae_relative_path=excluded.vae_relative_path, vae_sha256=excluded.vae_sha256, resource_group_id=COALESCE(excluded.resource_group_id,local_models.resource_group_id), generation_profile_json=COALESCE(excluded.generation_profile_json,local_models.generation_profile_json), updated_at=excluded.updated_at", params![id, model.display_name, model.family, model.workflow_kind, model.model_file_name, model.model_relative_path, model.model_sha256, model.byte_size, model.model_modified_ms, model.text_encoder_file_name, model.text_encoder_relative_path, model.text_encoder_sha256, model.vae_file_name, model.vae_relative_path, model.vae_sha256, model.resource_group_id, model.generation_profile_json, now]).map_err(|error| format!("登记本地模型失败：{error}"))?;
        drop(database);
        self.local_model(&id)?
            .ok_or_else(|| "本地模型登记后不存在".into())
    }

    /** 返回所有已登记模型，并实时校验主文件大小和修改时间。 */
    pub fn list_local_models(&self) -> Result<Vec<DesktopLocalModelView>, String> {
        let settings = self.load_settings()?;
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let mut statement = database.prepare("SELECT id,display_name,family,workflow_kind,model_file_name,model_relative_path,model_sha256,byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,vae_file_name,vae_relative_path,resource_group_id,generation_profile_json,created_at,updated_at FROM local_models ORDER BY updated_at DESC").map_err(|error| format!("读取本地模型列表失败：{error}"))?;
        let rows = statement
            .query_map([], |row| local_model_from_row(row, &settings.model_root))
            .map_err(|error| format!("查询本地模型列表失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析本地模型列表失败：{error}"))
    }

    /** 把 Rust 核心刚获取或从可信缓存读取的在线目录参数同步到已安装底模。 */
    pub fn sync_model_profiles(&self, models: &[DesktopWebsiteModelView]) -> Result<(), String> {
        let mut database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let transaction = database
            .transaction()
            .map_err(|error| format!("开启底模参数同步事务失败：{error}"))?;
        for model in models {
            let Some(group_id) = model.resource_group_id.as_deref() else {
                continue;
            };
            let profile = serde_json::to_string(&model.parameters)
                .map_err(|error| format!("序列化底模生成参数失败：{error}"))?;
            transaction.execute("UPDATE local_models SET generation_profile_json=?1,updated_at=?2 WHERE resource_group_id=?3", params![profile, Utc::now().to_rfc3339(), group_id]).map_err(|error| format!("同步底模生成参数失败：{error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("提交底模参数同步失败：{error}"))
    }

    /** 按内容哈希幂等登记本机 LoRA。 */
    pub fn register_local_lora(
        &self,
        lora: LocalLoraRegistration,
    ) -> Result<DesktopLocalLoraView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let existing: Option<String> = database
            .query_row(
                "SELECT id FROM local_loras WHERE sha256=?1",
                [&lora.sha256],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("查询本地 LoRA 失败：{error}"))?;
        let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = Utc::now().to_rfc3339();
        let trigger_words_json = serde_json::to_string(&lora.trigger_words)
            .map_err(|error| format!("序列化 LoRA 触发词失败：{error}"))?;
        database.execute("INSERT INTO local_loras (id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json,base_model_sha256,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11) ON CONFLICT(sha256) DO UPDATE SET title=excluded.title,type=excluded.type,file_name=excluded.file_name,relative_path=excluded.relative_path,byte_size=excluded.byte_size,modified_ms=excluded.modified_ms,trigger_words_json=excluded.trigger_words_json,base_model_sha256=COALESCE(excluded.base_model_sha256,local_loras.base_model_sha256),updated_at=excluded.updated_at", params![id,lora.title,lora.r#type,lora.file_name,lora.relative_path,lora.sha256,lora.byte_size,lora.modified_ms,trigger_words_json,lora.base_model_sha256,now]).map_err(|error| format!("登记本地 LoRA 失败：{error}"))?;
        drop(database);
        self.local_lora(&id)?
            .ok_or_else(|| "本地 LoRA 登记后不存在".into())
    }

    /** 返回当前设备全部已登记 LoRA 和实时文件可用性。 */
    pub fn list_local_loras(&self) -> Result<Vec<DesktopLocalLoraView>, String> {
        let settings = self.load_settings()?;
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let mut statement = database.prepare("SELECT id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json,base_model_sha256,created_at,updated_at FROM local_loras ORDER BY updated_at DESC").map_err(|error| format!("读取本地 LoRA 列表失败：{error}"))?;
        let rows = statement
            .query_map([], |row| local_lora_from_row(row, &settings.model_root))
            .map_err(|error| format!("查询本地 LoRA 列表失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析本地 LoRA 列表失败：{error}"))
    }

    fn local_lora(&self, id: &str) -> Result<Option<DesktopLocalLoraView>, String> {
        let settings = self.load_settings()?;
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT id,title,type,file_name,relative_path,sha256,byte_size,modified_ms,trigger_words_json,base_model_sha256,created_at,updated_at FROM local_loras WHERE id=?1", [id], |row| local_lora_from_row(row, &settings.model_root)).optional().map_err(|error| format!("读取本地 LoRA 失败：{error}"))
    }

    /** 创建持久化本地训练集，后续图片导入、打标和训练共用同一记录。 */
    pub fn create_training_dataset(
        &self,
        input: DesktopTrainingDatasetCreateInput,
    ) -> Result<DesktopTrainingDatasetView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training_dataset::create_dataset(&database, input)
    }

    /** 返回当前设备全部训练集与真实图片摘要。 */
    pub fn list_training_datasets(&self) -> Result<Vec<DesktopTrainingDatasetView>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training_dataset::list_datasets(&database, &self.app_data_dir)
    }

    /** 更新训练集触发词并返回最新完整视图。 */
    pub fn update_training_trigger_words(
        &self,
        input: DesktopTrainingTriggerWordsUpdateInput,
    ) -> Result<DesktopTrainingDatasetView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training_dataset::update_trigger_words(&database, &self.app_data_dir, input)
    }

    /** 保存单张训练图片 Caption 并重新计算确认门禁。 */
    pub fn update_training_caption(
        &self,
        input: DesktopTrainingCaptionUpdateInput,
    ) -> Result<DesktopTrainingDatasetView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training_dataset::update_caption(&database, &self.app_data_dir, input)
    }

    /** 在一个文件与 SQLite 事务中批量添加或删除标签。 */
    pub fn batch_update_training_tags(
        &self,
        input: DesktopTrainingBatchTagsInput,
    ) -> Result<DesktopTrainingDatasetView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training_dataset::batch_update_tags(&database, &self.app_data_dir, input)
    }

    /** 创建持久化打标任务并立即唤醒独立 Caption Worker。 */
    pub fn create_caption_job(
        &self,
        input: DesktopCaptionJobCreateInput,
    ) -> Result<DesktopCaptionJobView, String> {
        let scheduler = self
            .caption_scheduler
            .as_ref()
            .ok_or_else(|| "本地打标调度器尚未启动".to_string())?;
        let mut database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::captioner::create_job(&mut database, input)?;
        drop(database);
        scheduler.wake();
        Ok(job)
    }

    /** 返回最近的离线自动打标任务。 */
    pub fn list_caption_jobs(&self) -> Result<Vec<DesktopCaptionJobView>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::captioner::list_jobs(&database)
    }

    /** 暂停打标任务并唤醒 Worker 收敛运行中的组件。 */
    pub fn pause_caption_job(&self, id: &str) -> Result<DesktopCaptionJobView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::captioner::pause_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.caption_scheduler {
            scheduler.wake();
        }
        Ok(job)
    }

    /** 恢复暂停的打标任务并立即唤醒 Worker。 */
    pub fn resume_caption_job(&self, id: &str) -> Result<DesktopCaptionJobView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::captioner::resume_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.caption_scheduler {
            scheduler.wake();
        }
        Ok(job)
    }

    /** 幂等请求取消排队或运行中的离线自动打标任务。 */
    pub fn cancel_caption_job(&self, id: &str) -> Result<DesktopCaptionJobView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::captioner::cancel_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.caption_scheduler {
            scheduler.wake();
        }
        Ok(job)
    }

    /** 创建只生成建议的 AI 标签清洗任务，并唤醒独立网络 Worker。 */
    pub fn create_ai_clean_job(
        &self,
        input: DesktopAiCleanJobCreateInput,
    ) -> Result<DesktopAiCleanJobView, String> {
        let scheduler = self
            .ai_clean_scheduler
            .as_ref()
            .ok_or_else(|| "AI 清洗调度器尚未启动".to_string())?;
        let settings = self.load_ai_settings(crate::ai_assist::api_key_configured()?)?;
        if !settings.enabled || !settings.api_key_configured {
            return Err("请先在设置中启用并测试 AI 辅助".into());
        }
        let mut database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::ai_cleaner::create_job(&mut database, input)?;
        drop(database);
        scheduler.wake();
        Ok(job)
    }

    /** 返回最近的持久化 AI 标签清洗任务。 */
    pub fn list_ai_clean_jobs(&self) -> Result<Vec<DesktopAiCleanJobView>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::ai_cleaner::list_jobs(&database)
    }

    /** 暂停 AI 清洗任务并保留已经完成的建议。 */
    pub fn pause_ai_clean_job(&self, id: &str) -> Result<DesktopAiCleanJobView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::ai_cleaner::pause_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.ai_clean_scheduler {
            scheduler.wake();
        }
        Ok(job)
    }

    /** 恢复暂停的 AI 清洗任务并立即唤醒 Worker。 */
    pub fn resume_ai_clean_job(&self, id: &str) -> Result<DesktopAiCleanJobView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::ai_cleaner::resume_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.ai_clean_scheduler {
            scheduler.wake();
        }
        Ok(job)
    }

    /** 幂等取消 AI 标签清洗任务并唤醒 Worker 收敛状态。 */
    pub fn cancel_ai_clean_job(&self, id: &str) -> Result<DesktopAiCleanJobView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::ai_cleaner::cancel_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.ai_clean_scheduler {
            scheduler.wake();
        }
        Ok(job)
    }

    /** 应用用户确认的 AI 标签建议并返回更新后的训练集。 */
    pub fn apply_ai_clean(
        &self,
        input: DesktopAiCleanApplyInput,
    ) -> Result<DesktopTrainingDatasetView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::ai_cleaner::apply_proposal(&database, &self.app_data_dir, input)
    }

    /** 撤销未被后续编辑覆盖的最近一次 AI 标签清洗。 */
    pub fn undo_ai_clean(
        &self,
        input: DesktopAiCleanUndoInput,
    ) -> Result<DesktopTrainingDatasetView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::ai_cleaner::undo_proposal(&database, &self.app_data_dir, input)
    }

    /** 固化已确认数据集和 Anima 底模后创建本地训练任务。 */
    pub fn create_training_job(
        &self,
        input: DesktopTrainingJobCreateInput,
    ) -> Result<DesktopTrainingJobView, String> {
        let scheduler = self
            .training_scheduler
            .as_ref()
            .ok_or_else(|| "本地训练调度器尚未启动".to_string())?;
        // 创建训练快照前确认用户已经启动本地核心，避免绕过页面直接把任务塞入后台队列。
        self.require_task_runtime_ready()?;
        let settings = self.load_settings()?;
        crate::environment::require_training_ready(&settings)?;
        let mut database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::training::create_job(
            &mut database,
            &self.app_data_dir,
            Path::new(&settings.model_root),
            input,
        )?;
        drop(database);
        if job.use_ai_tag_processing {
            self.ai_clean_scheduler
                .as_ref()
                .ok_or_else(|| "AI 标签处理调度器尚未启动".to_string())?
                .wake();
        } else {
            scheduler.wake();
        }
        Ok(job)
    }

    /** 返回最近的持久化本地训练任务。 */
    pub fn list_training_jobs(&self) -> Result<Vec<DesktopTrainingJobView>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training::list_jobs(&database)
    }

    /** 读取任务创建时冻结的训练快照，历史内容不跟随原训练集变化。 */
    pub fn get_training_snapshot(&self, id: &str) -> Result<DesktopTrainingSnapshotView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training::get_snapshot(&database, &self.app_data_dir, id)
    }

    /** 从只读任务快照复制新的可编辑训练集，不覆盖任何现有数据。 */
    pub fn copy_training_snapshot(
        &self,
        input: DesktopTrainingSnapshotCopyInput,
    ) -> Result<DesktopTrainingDatasetView, String> {
        let mut database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::training::copy_snapshot_to_dataset(&mut database, &self.app_data_dir, input)
    }

    /** 幂等取消排队或运行中的本地训练任务。 */
    pub fn cancel_training_job(&self, id: &str) -> Result<DesktopTrainingJobView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::training::cancel_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.training_scheduler {
            scheduler.wake();
        }
        if let Some(scheduler) = &self.ai_clean_scheduler {
            scheduler.wake();
        }
        Ok(job)
    }

    /** 创建持久任务后唤醒串行调度器，提交线程不等待生成完成。 */
    pub fn create_local_job(
        &self,
        input: DesktopLocalJobCreateInput,
    ) -> Result<DesktopLocalJobView, String> {
        let scheduler = self
            .scheduler
            .as_ref()
            .ok_or_else(|| "本地调度器尚未启动".to_string())?;
        // Tauri 命令是最终安全边界，不能只依赖前端按钮状态阻止未启动核心时提交。
        self.require_task_runtime_ready()?;
        let settings = self.load_settings()?;
        crate::environment::require_inference_ready(&settings)?;
        let mut database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::scheduler::create_job(&mut database, &settings, input)?;
        drop(database);
        scheduler.wake();
        Ok(job)
    }

    /** 生成与训练提交共用的真实 Runtime 健康门禁。 */
    fn require_task_runtime_ready(&self) -> Result<(), String> {
        self.runtime
            .endpoint()
            .map(|_| ())
            .map_err(|_| "本地核心未启动或不可用，请先在“启动”页面启动核心".to_string())
    }

    /** 读取最近本地任务。 */
    pub fn list_local_jobs(&self) -> Result<Vec<DesktopLocalJobView>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::scheduler::list_jobs(&database)
    }

    /** 按时间、任务和级别分页读取桌面结构化日志。 */
    pub fn list_logs(&self, input: DesktopLogQueryInput) -> Result<DesktopLogPageView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::desktop_logs::list_logs(&database, input)
    }

    /** 写入不含用户提示词、密钥和私有路径的桌面日志。 */
    pub fn append_log(
        &self,
        task_id: Option<&str>,
        level: &str,
        scope: &str,
        event: &str,
        message: &str,
        details: Option<&str>,
    ) -> Result<(), String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::desktop_logs::append_log(&database, task_id, level, scope, event, message, details)
    }

    /** 为独立预览读取最新一条任务，避免加载完整记录页数据。 */
    pub fn latest_local_job(&self) -> Result<Option<DesktopLocalJobView>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        crate::scheduler::latest_job(&database)
    }

    /** 请求取消任务并唤醒调度器处理状态变化。 */
    pub fn cancel_local_job(&self, id: &str) -> Result<DesktopLocalJobView, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        let job = crate::scheduler::cancel_job(&database, id)?;
        drop(database);
        if let Some(scheduler) = &self.scheduler {
            scheduler.wake();
        }
        Ok(job)
    }

    /** Runtime 停止门禁只统计真实运行中的本地任务。 */
    pub fn running_local_job_count(&self) -> Result<u64, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database
            .query_row(
                "SELECT COUNT(*) FROM local_jobs WHERE status='running'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("统计运行中本地任务失败：{error}"))
    }

    fn local_model(&self, id: &str) -> Result<Option<DesktopLocalModelView>, String> {
        let settings = self.load_settings()?;
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT id,display_name,family,workflow_kind,model_file_name,model_relative_path,model_sha256,byte_size,model_modified_ms,text_encoder_file_name,text_encoder_relative_path,vae_file_name,vae_relative_path,resource_group_id,generation_profile_json,created_at,updated_at FROM local_models WHERE id=?1", [id], |row| local_model_from_row(row, &settings.model_root)).optional().map_err(|error| format!("读取本地模型失败：{error}"))
    }

    fn gallery_item(&self, id: &str) -> Result<Option<GallerySyncItem>, String> {
        let database = self
            .database
            .lock()
            .map_err(|_| "桌面数据库锁已损坏".to_string())?;
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
    pub resource_group_id: Option<String>,
    pub generation_profile_json: Option<String>,
}

/** 已完成安全复制、等待写入 SQLite 的 LoRA 记录。 */
pub struct LocalLoraRegistration {
    pub title: String,
    pub r#type: String,
    pub file_name: String,
    pub relative_path: String,
    pub sha256: String,
    pub base_model_sha256: Option<String>,
    pub byte_size: u64,
    pub modified_ms: u64,
    pub trigger_words: Vec<String>,
}

fn local_model_from_row(
    row: &rusqlite::Row<'_>,
    model_root: &str,
) -> rusqlite::Result<DesktopLocalModelView> {
    let relative_path: String = row.get(5)?;
    let expected_size: u64 = row.get(7)?;
    let expected_modified_ms: u64 = row.get(8)?;
    let metadata = Path::new(model_root).join(relative_path).metadata().ok();
    let workflow_kind: String = row.get(3)?;
    let text_relative_path: Option<String> = row.get(10)?;
    let vae_relative_path: Option<String> = row.get(12)?;
    let primary_available = metadata.as_ref().is_some_and(|value| {
        value.is_file()
            && value.len() == expected_size
            && modified_millis(value).ok() == Some(expected_modified_ms)
    });
    let components_available = workflow_kind != "anima"
        || (text_relative_path
            .as_ref()
            .is_some_and(|path| Path::new(model_root).join(path).is_file())
            && vae_relative_path
                .as_ref()
                .is_some_and(|path| Path::new(model_root).join(path).is_file()));
    let profile_json: Option<String> = row.get(14)?;
    let generation_profile = profile_json
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    14,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .transpose()?;
    Ok(DesktopLocalModelView {
        id: row.get(0)?,
        display_name: row.get(1)?,
        family: row.get(2)?,
        workflow_kind,
        model_file_name: row.get(4)?,
        resource_group_id: row.get(13)?,
        generation_profile,
        model_sha256: row.get(6)?,
        byte_size: expected_size,
        text_encoder_file_name: row.get(9)?,
        vae_file_name: row.get(11)?,
        available: primary_available && components_available,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn local_lora_from_row(
    row: &rusqlite::Row<'_>,
    model_root: &str,
) -> rusqlite::Result<DesktopLocalLoraView> {
    let relative_path: String = row.get(4)?;
    let expected_size: u64 = row.get(6)?;
    let expected_modified_ms: u64 = row.get(7)?;
    let metadata = Path::new(model_root).join(relative_path).metadata().ok();
    let trigger_words_json: String = row.get(8)?;
    let trigger_words = serde_json::from_str(&trigger_words_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let available = metadata.as_ref().is_some_and(|value| {
        value.is_file()
            && value.len() == expected_size
            && modified_millis(value).ok() == Some(expected_modified_ms)
    });
    Ok(DesktopLocalLoraView {
        id: row.get(0)?,
        title: row.get(1)?,
        r#type: row.get(2)?,
        file_name: row.get(3)?,
        sha256: row.get(5)?,
        base_model_sha256: row.get(9)?,
        byte_size: expected_size,
        trigger_words,
        available,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn gallery_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GallerySyncItem> {
    Ok(GallerySyncItem {
        id: row.get(0)?,
        local_task_id: row.get(1)?,
        artifact_path: row.get(2)?,
        artifact_sha256: row.get(3)?,
        privacy: row.get(4)?,
        status: row.get(5)?,
        uploaded_bytes: row.get(6)?,
        retry_count: row.get(7)?,
        gallery_item_id: row.get(8)?,
        last_error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}
/** 旧版本数据库按列幂等迁移，升级不会覆盖已有目录、隐私或同步队列。 */
fn ensure_column(
    database: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = database
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("读取桌面数据库结构失败：{error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("查询桌面数据库字段失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析桌面数据库字段失败：{error}"))?;
    if !columns.iter().any(|item| item == column) {
        database
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| format!("升级桌面数据库失败：{error}"))?;
    }
    Ok(())
}

/** 旧版任务图片表外键绑定原训练集；升级时重建为只绑定任务的独立快照表。 */
fn ensure_training_snapshot_schema(database: &Connection) -> Result<(), String> {
    let has_asset_foreign_key = {
        let mut statement = database
            .prepare("PRAGMA foreign_key_list(local_training_job_assets)")
            .map_err(|error| format!("读取训练快照外键失败：{error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(2))
            .map_err(|error| format!("查询训练快照外键失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析训练快照外键失败：{error}"))?;
        rows.iter().any(|table| table == "local_training_assets")
    };
    if has_asset_foreign_key {
        let transaction = database
            .unchecked_transaction()
            .map_err(|error| format!("开启训练快照结构迁移失败：{error}"))?;
        transaction.execute_batch(
            "CREATE TABLE local_training_job_assets_v2 (
            job_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            asset_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            caption TEXT NOT NULL,
            tags_json TEXT NOT NULL DEFAULT '[]',
            image_variant TEXT NOT NULL DEFAULT 'original',
            derivative_source TEXT,
            PRIMARY KEY(job_id,sequence),
            UNIQUE(job_id,asset_id),
            FOREIGN KEY(job_id) REFERENCES local_training_jobs(id)
        );
        INSERT INTO local_training_job_assets_v2 (job_id,sequence,asset_id,file_name,relative_path,sha256,byte_size,caption,tags_json)
            SELECT snapshot.job_id,snapshot.sequence,snapshot.asset_id,
                   COALESCE((SELECT asset.file_name FROM local_training_assets asset WHERE asset.id=snapshot.asset_id),'training-image'),
                   snapshot.relative_path,snapshot.sha256,snapshot.byte_size,snapshot.caption,'[]'
            FROM local_training_job_assets snapshot;
        DROP TABLE local_training_job_assets;
        ALTER TABLE local_training_job_assets_v2 RENAME TO local_training_job_assets;"
        ).map_err(|error| format!("迁移训练快照结构失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交训练快照结构迁移失败：{error}"))?;
    }
    ensure_column(
        database,
        "local_training_job_assets",
        "file_name",
        "TEXT NOT NULL DEFAULT 'training-image'",
    )?;
    ensure_column(
        database,
        "local_training_job_assets",
        "tags_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        database,
        "local_training_job_assets",
        "image_variant",
        "TEXT NOT NULL DEFAULT 'original'",
    )?;
    ensure_column(
        database,
        "local_training_job_assets",
        "derivative_source",
        "TEXT",
    )
}
fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn modified_millis(metadata: &fs::Metadata) -> Result<u64, String> {
    metadata
        .modified()
        .map_err(|error| format!("读取模型修改时间失败：{error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "模型修改时间早于系统纪元".to_string())
}
fn sha256_file(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| format!("读取本地结果失败：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("计算文件哈希失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopped_runtime_blocks_new_gpu_tasks() {
        let temporary = tempfile::tempdir().expect("创建 Runtime 门禁测试目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        assert_eq!(
            state
                .require_task_runtime_ready()
                .expect_err("停止状态必须拒绝任务"),
            "本地核心未启动或不可用，请先在“启动”页面启动核心"
        );
    }

    #[test]
    fn legacy_generation_jobs_gain_quality_columns_without_data_loss() {
        let temporary = tempfile::tempdir().expect("创建旧数据库迁移临时目录");
        let database_path = temporary.path().join("desktop.sqlite3");
        let database = Connection::open(&database_path).expect("创建旧数据库");
        database.execute_batch("CREATE TABLE local_jobs (id TEXT PRIMARY KEY,status TEXT NOT NULL,progress INTEGER NOT NULL,prompt TEXT NOT NULL,negative_prompt TEXT,model_id TEXT NOT NULL,model_display_name TEXT NOT NULL,workflow_kind TEXT NOT NULL,model_file_name TEXT NOT NULL,model_relative_path TEXT NOT NULL,model_sha256 TEXT NOT NULL,text_encoder_file_name TEXT,vae_file_name TEXT,width INTEGER NOT NULL,height INTEGER NOT NULL,steps INTEGER NOT NULL,cfg REAL NOT NULL,sampler_name TEXT NOT NULL,scheduler_name TEXT NOT NULL,seed INTEGER NOT NULL,privacy TEXT NOT NULL,runtime_prompt_id TEXT,error TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,started_at TEXT,completed_at TEXT,updated_at TEXT NOT NULL); CREATE TABLE local_job_loras (job_id TEXT NOT NULL,sequence INTEGER NOT NULL,lora_id TEXT NOT NULL,title TEXT NOT NULL,type TEXT NOT NULL,file_name TEXT NOT NULL,relative_path TEXT NOT NULL DEFAULT '',sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL DEFAULT 0,modified_ms INTEGER NOT NULL DEFAULT 0,strength REAL NOT NULL,trigger_words_json TEXT NOT NULL,PRIMARY KEY(job_id,sequence),UNIQUE(job_id,lora_id));").expect("创建旧版生成表");
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        database.execute("INSERT INTO local_jobs (id,status,progress,prompt,model_id,model_display_name,workflow_kind,model_file_name,model_relative_path,model_sha256,width,height,steps,cfg,sampler_name,scheduler_name,seed,privacy,created_at,updated_at) VALUES (?1,'failed',0,'legacy prompt','legacy-model','旧底模','checkpoint','legacy.safetensors','checkpoints/legacy.safetensors',?2,1024,1024,20,5,'euler','normal',7,'private',?3,?3)", params![id, "a".repeat(64), now]).expect("写入旧任务");
        drop(database);

        let state = DesktopState::initialize(temporary.path()).expect("迁移旧数据库");
        let jobs = state.list_local_jobs().expect("读取迁移后的任务");
        let job = jobs.iter().find(|job| job.id == id).expect("旧任务仍存在");
        assert_eq!(job.prompt, "legacy prompt");
        assert_eq!(job.parameters.quality_preset, "custom");
        assert!(!job.parameters.quality_prompt_enabled);
        assert!(!job.parameters.default_negative_enabled);
    }

    #[test]
    fn settings_and_gallery_queue_are_persistent_and_idempotent() {
        let temporary = tempfile::tempdir().expect("创建临时目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化数据库");
        let mut settings = state.load_settings().expect("读取设置");
        assert_eq!(settings.theme_mode, "system");
        assert!((settings.font_scale - 1.1).abs() < f64::EPSILON);
        assert!((settings.content_font_scale - 1.2).abs() < f64::EPSILON);
        assert_eq!(settings.default_privacy, "public");
        assert!(settings.auto_upload);
        settings.default_privacy = "public".into();
        settings.auto_upload = false;
        settings.font_scale = 1.2;
        settings.content_font_scale = 1.4;
        let saved = state.save_settings(settings).expect("保存设置");
        assert_eq!(saved.default_privacy, "public");
        assert!(!saved.auto_upload);
        assert!((saved.font_scale - 1.2).abs() < f64::EPSILON);
        assert!((saved.content_font_scale - 1.4).abs() < f64::EPSILON);
        let artifact = temporary.path().join("result.webp");
        fs::write(&artifact, b"verified-local-result").expect("写入结果");
        let first = state
            .enqueue_gallery_publication(GalleryPublicationInput {
                local_task_id: "local-task-1".into(),
                artifact_path: path_text(&artifact),
                privacy: "private".into(),
            })
            .expect("加入队列");
        let second = state
            .enqueue_gallery_publication(GalleryPublicationInput {
                local_task_id: "local-task-1".into(),
                artifact_path: path_text(&artifact),
                privacy: "public".into(),
            })
            .expect("幂等更新队列");
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
        let job = crate::captioner::list_jobs(&database)
            .expect("读取恢复后的任务")
            .into_iter()
            .find(|item| item.id == job_id)
            .expect("找到恢复后的任务");
        assert_eq!(job.status, "cancelled");
        assert_eq!(job.progress, 100);
        assert_eq!(job.processed_assets, 1);
        assert_eq!(job.items[0].status, "cancelled");
    }
}
