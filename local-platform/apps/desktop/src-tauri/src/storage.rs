//! 本模块管理桌面端独立 SQLite、目录设置和图库同步队列，不连接网页或独立平台数据库。

use crate::models::{DesktopSettings, GalleryPublicationInput, GallerySyncItem};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{fs, io::{BufReader, Read}, path::{Path, PathBuf}, sync::Mutex};
use uuid::Uuid;

pub struct DesktopState {
    pub database: Mutex<Connection>,
    pub app_data_dir: PathBuf,
}

impl DesktopState {
    /** 创建本地数据目录和数据库结构，任何失败都阻止桌面核心伪装为可用。 */
    pub fn initialize(app_data_dir: &Path, picture_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|error| format!("创建桌面数据目录失败：{error}"))?;
        let connection = Connection::open(app_data_dir.join("desktop.sqlite3")).map_err(|error| format!("打开桌面数据库失败：{error}"))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS desktop_settings (id INTEGER PRIMARY KEY CHECK(id=1), theme_mode TEXT NOT NULL DEFAULT 'system', dependency_source TEXT NOT NULL DEFAULT 'auto', default_privacy TEXT NOT NULL, model_root TEXT NOT NULL, output_root TEXT NOT NULL, runtime_root TEXT NOT NULL, upload_concurrency INTEGER NOT NULL, wifi_only INTEGER NOT NULL, bandwidth_limit_kib INTEGER, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS environment_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, report_json TEXT NOT NULL, checked_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS gallery_sync_queue (id TEXT PRIMARY KEY, local_task_id TEXT NOT NULL, artifact_path TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, privacy TEXT NOT NULL, status TEXT NOT NULL, uploaded_bytes INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, gallery_item_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(local_task_id, artifact_sha256));
            CREATE INDEX IF NOT EXISTS gallery_sync_status_idx ON gallery_sync_queue(status, created_at);").map_err(|error| format!("初始化桌面数据库失败：{error}"))?;
        ensure_column(&connection, "desktop_settings", "theme_mode", "TEXT NOT NULL DEFAULT 'system'")?;
        ensure_column(&connection, "desktop_settings", "dependency_source", "TEXT NOT NULL DEFAULT 'auto'")?;
        let model_root = app_data_dir.join("models");
        let runtime_root = app_data_dir.join("runtime");
        let output_root = picture_dir.join("DrawHime");
        for directory in [&model_root, &runtime_root, &output_root] { fs::create_dir_all(directory).map_err(|error| format!("创建本地目录失败：{error}"))?; }
        connection.execute("INSERT OR IGNORE INTO desktop_settings (id, theme_mode, dependency_source, default_privacy, model_root, output_root, runtime_root, upload_concurrency, wifi_only, bandwidth_limit_kib, updated_at) VALUES (1, 'system', 'auto', 'private', ?1, ?2, ?3, 2, 0, NULL, ?4)", params![path_text(&model_root), path_text(&output_root), path_text(&runtime_root), Utc::now().to_rfc3339()]).map_err(|error| format!("写入默认设置失败：{error}"))?;
        Ok(Self { database: Mutex::new(connection), app_data_dir: app_data_dir.to_path_buf() })
    }

    /** 读取唯一桌面设置记录。 */
    pub fn load_settings(&self) -> Result<DesktopSettings, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT theme_mode, dependency_source, default_privacy, model_root, output_root, runtime_root, upload_concurrency, wifi_only, bandwidth_limit_kib FROM desktop_settings WHERE id=1", [], |row| Ok(DesktopSettings { theme_mode: row.get(0)?, dependency_source: row.get(1)?, default_privacy: row.get(2)?, model_root: row.get(3)?, output_root: row.get(4)?, runtime_root: row.get(5)?, upload_concurrency: row.get(6)?, wifi_only: row.get::<_, i64>(7)? != 0, bandwidth_limit_kib: row.get(8)? })).map_err(|error| format!("读取桌面设置失败：{error}"))
    }

    /** 校验目录和上传策略后事务化更新设置。 */
    pub fn save_settings(&self, settings: DesktopSettings) -> Result<DesktopSettings, String> {
        if !matches!(settings.theme_mode.as_str(), "system" | "dark" | "light") { return Err("主题模式不正确".into()); }
        if !matches!(settings.dependency_source.as_str(), "auto" | "official" | "mirror") { return Err("依赖来源不正确".into()); }
        if !matches!(settings.default_privacy.as_str(), "public" | "private") { return Err("默认图库权限不正确".into()); }
        if !(1..=4).contains(&settings.upload_concurrency) { return Err("上传并发数必须是 1–4".into()); }
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
        database.execute("INSERT INTO gallery_sync_queue (id, local_task_id, artifact_path, artifact_sha256, privacy, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6) ON CONFLICT(local_task_id, artifact_sha256) DO UPDATE SET privacy=excluded.privacy, artifact_path=excluded.artifact_path, updated_at=excluded.updated_at", params![id, input.local_task_id, input.artifact_path, sha256, input.privacy, now]).map_err(|error| format!("写入图库同步队列失败：{error}"))?;
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

    fn gallery_item(&self, id: &str) -> Result<Option<GallerySyncItem>, String> {
        let database = self.database.lock().map_err(|_| "桌面数据库锁已损坏".to_string())?;
        database.query_row("SELECT id, local_task_id, artifact_path, artifact_sha256, privacy, status, uploaded_bytes, retry_count, gallery_item_id, last_error, created_at, updated_at FROM gallery_sync_queue WHERE id=?1", [id], gallery_item_from_row).optional().map_err(|error| format!("读取图库同步记录失败：{error}"))
    }
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
fn sha256_file(path: &Path) -> Result<String, String> { let file = fs::File::open(path).map_err(|error| format!("读取本地结果失败：{error}"))?; let mut reader = BufReader::new(file); let mut hasher = Sha256::new(); let mut buffer = [0_u8; 1024 * 1024]; loop { let read = reader.read(&mut buffer).map_err(|error| format!("计算文件哈希失败：{error}"))?; if read == 0 { break; } hasher.update(&buffer[..read]); } Ok(hex::encode(hasher.finalize())) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_gallery_queue_are_persistent_and_idempotent() {
        let temporary = tempfile::tempdir().expect("创建临时目录");
        let state = DesktopState::initialize(temporary.path(), temporary.path()).expect("初始化数据库");
        let mut settings = state.load_settings().expect("读取设置");
        assert_eq!(settings.theme_mode, "system");
        assert_eq!(settings.dependency_source, "auto");
        assert_eq!(settings.default_privacy, "private");
        settings.default_privacy = "public".into();
        assert_eq!(state.save_settings(settings).expect("保存设置").default_privacy, "public");
        let artifact = temporary.path().join("result.webp");
        fs::write(&artifact, b"verified-local-result").expect("写入结果");
        let first = state.enqueue_gallery_publication(GalleryPublicationInput { local_task_id: "local-task-1".into(), artifact_path: path_text(&artifact), privacy: "private".into() }).expect("加入队列");
        let second = state.enqueue_gallery_publication(GalleryPublicationInput { local_task_id: "local-task-1".into(), artifact_path: path_text(&artifact), privacy: "public".into() }).expect("幂等更新队列");
        assert_eq!(first.id, second.id);
        assert_eq!(second.privacy, "public");
        assert_eq!(state.pending_gallery_sync_count().expect("统计队列"), 1);
    }
}
