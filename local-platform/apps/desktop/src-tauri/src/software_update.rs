//! 本模块实现签名 NSIS 软件更新、离线包导入、持久化应用状态和可信缓存回滚。

use crate::{
    models::{
        DesktopOfflineUpdateImportInput, DesktopResourceManifestItem,
        DesktopSoftwareUpdateView, DesktopSettings,
    },
    resource,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rusqlite::{params, Connection};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const APPLY_STALE_MINUTES: i64 = 30;
const UPDATE_HELPER_SCRIPT: &str = r#"@echo off
setlocal
chcp 65001 >nul
title DrawHime 更新助手
set "INSTALLER=%DRAWHIME_UPDATE_INSTALLER%"
set "EXPECTED_HASH=%DRAWHIME_UPDATE_SHA256%"
set "RESULT_PATH=%DRAWHIME_UPDATE_RESULT%"
set "RELAUNCH_PATH=%DRAWHIME_UPDATE_RELAUNCH%"
echo.
echo [DrawHime] 正在准备软件更新，请保留此窗口。
echo [1/4] 重新校验安装包...
set "DH_INSTALLER=%INSTALLER%"
for /f "usebackq delims=" %%H in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "(Get-FileHash -LiteralPath $env:DH_INSTALLER -Algorithm SHA256).Hash.ToLowerInvariant()"`) do set "ACTUAL_HASH=%%H"
if /I not "%ACTUAL_HASH%"=="%EXPECTED_HASH%" (
  > "%RESULT_PATH%" echo 97
  echo [失败] 安装包校验未通过，更新已经停止。
  pause
  exit /b 97
)
echo [2/4] 等待 DrawHime 主程序退出...
timeout /t 3 /nobreak >nul
echo [3/4] 正在安装新版本，请勿关闭窗口...
start "" /wait "%INSTALLER%" /S
set "INSTALL_EXIT=%ERRORLEVEL%"
> "%RESULT_PATH%" echo %INSTALL_EXIT%
if not "%INSTALL_EXIT%"=="0" (
  echo [失败] 安装器退出码 %INSTALL_EXIT%。
  pause
  exit /b %INSTALL_EXIT%
)
echo [4/4] 安装完成，正在重新启动 DrawHime...
if exist "%RELAUNCH_PATH%" (
  start "" "%RELAUNCH_PATH%"
) else (
  echo [提示] 原程序路径不存在，请从开始菜单启动 DrawHime。
  pause
  exit /b 0
)
timeout /t 2 /nobreak >nul
exit /b 0
"#;

#[derive(Clone)]
struct UpdateRecord {
    version: String,
    file_name: String,
    sha256: String,
    byte_size: u64,
}

struct TrustedUpdate {
    record: UpdateRecord,
    item: DesktopResourceManifestItem,
}

/** 检查在线签名清单并以实际运行版本收敛上次更新状态。 */
pub fn status(
    database_path: &Path,
    app_data_dir: &Path,
) -> Result<DesktopSoftwareUpdateView, String> {
    let database = open_database(database_path)?;
    reconcile_applying_records(&database, app_data_dir, CURRENT_VERSION, Utc::now())?;
    build_status(&database, app_data_dir)
}

/** 使用统一依赖来源策略下载最新更新并保存原始签名信封。 */
pub fn download(
    database_path: &Path,
    app_data_dir: &Path,
    settings: &DesktopSettings,
    app: &tauri::AppHandle,
) -> Result<DesktopSoftwareUpdateView, String> {
    let item = latest_online_update()?.ok_or_else(|| "稳定通道当前没有软件更新包".to_string())?;
    if compare_versions(&item.version, CURRENT_VERSION)? <= 0 {
        return status(database_path, app_data_dir);
    }
    let progress = resource::download_resource(settings, app_data_dir, &item.id, app)?;
    if progress.status != "downloaded" {
        return Err("软件更新包尚未完整下载".into());
    }
    resource::persist_online_application_envelope(app_data_dir, &item)?;
    upsert_record(
        &open_database(database_path)?,
        &item,
        "online",
        "downloaded",
        None,
    )?;
    status(database_path, app_data_dir)
}

/** 导入离线安装包和签名信封，版本门禁与在线更新保持一致。 */
pub fn import_offline(
    database_path: &Path,
    app_data_dir: &Path,
    input: DesktopOfflineUpdateImportInput,
) -> Result<DesktopSoftwareUpdateView, String> {
    let item = resource::import_offline_application(
        app_data_dir,
        Path::new(&input.installer_path),
        Path::new(&input.envelope_path),
    )?;
    if compare_versions(&item.version, CURRENT_VERSION)? <= 0 {
        return Err("离线更新版本必须高于当前版本".into());
    }
    upsert_record(
        &open_database(database_path)?,
        &item,
        "offline",
        "downloaded",
        None,
    )?;
    status(database_path, app_data_dir)
}

/** 应用最新可信版本；辅助进程延迟启动，主应用退出后 NSIS 才替换文件。 */
pub fn apply(
    database_path: &Path,
    app_data_dir: &Path,
    relaunch_path: &Path,
) -> Result<DesktopSoftwareUpdateView, String> {
    let database = open_database(database_path)?;
    reconcile_applying_records(&database, app_data_dir, CURRENT_VERSION, Utc::now())?;
    let trusted = latest_trusted_update(&database, app_data_dir, |order| order > 0)?
        .ok_or_else(|| "没有已验证的软件更新包".to_string())?;
    let mut view = build_status(&database, app_data_dir)?;
    launch_record(&database, app_data_dir, &trusted.record, relaunch_path)?;
    view.status = "applying".into();
    view.latest_version = Some(trusted.record.version);
    Ok(view)
}

/** 使用仍可重新验签的上一版本安装包执行回滚。 */
pub fn rollback(
    database_path: &Path,
    app_data_dir: &Path,
    relaunch_path: &Path,
) -> Result<DesktopSoftwareUpdateView, String> {
    let database = open_database(database_path)?;
    reconcile_applying_records(&database, app_data_dir, CURRENT_VERSION, Utc::now())?;
    let trusted = latest_trusted_update(&database, app_data_dir, |order| order < 0)?
        .ok_or_else(|| "没有保留可信的上一版本安装包".to_string())?;
    let mut view = build_status(&database, app_data_dir)?;
    launch_record(&database, app_data_dir, &trusted.record, relaunch_path)?;
    view.status = "applying".into();
    view.latest_version = Some(trusted.record.version);
    Ok(view)
}

fn build_status(
    database: &Connection,
    app_data_dir: &Path,
) -> Result<DesktopSoftwareUpdateView, String> {
    let trusted_local = latest_trusted_update(database, app_data_dir, |order| order > 0)?;
    let rollback_version = latest_trusted_update(database, app_data_dir, |order| order < 0)?
        .map(|value| value.record.version);
    match latest_online_update() {
        Ok(online) => build_available_view(
            app_data_dir,
            online,
            trusted_local,
            rollback_version,
            None,
        ),
        Err(error) => build_available_view(
            app_data_dir,
            None,
            trusted_local,
            rollback_version,
            Some(error),
        ),
    }
}

fn build_available_view(
    app_data_dir: &Path,
    online: Option<DesktopResourceManifestItem>,
    trusted_local: Option<TrustedUpdate>,
    rollback_version: Option<String>,
    channel_error: Option<String>,
) -> Result<DesktopSoftwareUpdateView, String> {
    // 用户明确导入或已经下载的可信版本优先进入应用流程，完成重启后再提示更高在线版本。
    if let Some(trusted) = trusted_local {
        let metadata = trusted.item.application_update.as_ref();
        return Ok(DesktopSoftwareUpdateView {
            current_version: CURRENT_VERSION.into(),
            latest_version: Some(trusted.record.version),
            status: "downloaded".into(),
            mandatory: metadata.is_some_and(|value| value.mandatory),
            release_notes: metadata.map(|value| value.release_notes.clone()),
            byte_size: trusted.record.byte_size,
            downloaded_bytes: trusted.record.byte_size,
            rollback_version,
            error: channel_error,
        });
    }
    if let Some(item) = online {
        let available = compare_versions(&item.version, CURRENT_VERSION)? > 0;
        let metadata = item.application_update.as_ref();
        return Ok(DesktopSoftwareUpdateView {
            current_version: CURRENT_VERSION.into(),
            latest_version: Some(item.version.clone()),
            status: if available { "available" } else { "up_to_date" }.into(),
            mandatory: metadata.is_some_and(|value| value.mandatory),
            release_notes: metadata.map(|value| value.release_notes.clone()),
            byte_size: item.byte_size,
            downloaded_bytes: if available {
                partial_bytes(app_data_dir, &item)
            } else {
                0
            },
            rollback_version,
            error: channel_error,
        });
    }
    Ok(DesktopSoftwareUpdateView {
        current_version: CURRENT_VERSION.into(),
        latest_version: None,
        status: if channel_error.is_some() {
            "unavailable"
        } else {
            "up_to_date"
        }
        .into(),
        mandatory: false,
        release_notes: None,
        byte_size: 0,
        downloaded_bytes: 0,
        rollback_version,
        error: channel_error,
    })
}

fn launch_record(
    database: &Connection,
    app_data_dir: &Path,
    record: &UpdateRecord,
    relaunch_path: &Path,
) -> Result<(), String> {
    let installer = app_data_dir.join("resource-cache").join(&record.file_name);
    let envelope = resource::offline_envelope_path(&installer);
    let item = resource::verify_offline_application(&installer, &envelope)?;
    if !record_matches_item(record, &item) {
        return Err("更新缓存与持久化记录不一致".into());
    }
    let metadata = item
        .application_update
        .as_ref()
        .ok_or_else(|| "更新包缺少版本门禁".to_string())?;
    if compare_versions(CURRENT_VERSION, &metadata.minimum_version)? < 0
        && compare_versions(&item.version, CURRENT_VERSION)? > 0
    {
        return Err(format!(
            "当前版本低于直接升级下限 {}，请使用完整安装包更新",
            metadata.minimum_version
        ));
    }
    let helper = app_data_dir.join(format!("apply-update-{}.cmd", record.version));
    let result_path = apply_result_path(app_data_dir, &record.version);
    fs::write(&helper, UPDATE_HELPER_SCRIPT)
        .map_err(|error| format!("写入更新辅助脚本失败：{error}"))?;
    if result_path.exists() {
        fs::remove_file(&result_path)
            .map_err(|error| format!("清理旧更新结果失败：{error}"))?;
    }
    database
        .execute(
            "UPDATE software_updates SET status='applying',error=NULL,updated_at=?2 WHERE version=?1",
            params![record.version, Utc::now().to_rfc3339()],
        )
        .map_err(|error| format!("保存更新应用状态失败：{error}"))?;
    let mut command = Command::new("cmd.exe");
    #[cfg(target_os = "windows")]
    command.creation_flags(0x00000010);
    command
        .args([
            "/D",
            "/S",
            "/C",
        ])
        .arg(format!("call \"{}\"", helper.display()))
        .env("DRAWHIME_UPDATE_INSTALLER", &installer)
        .env("DRAWHIME_UPDATE_SHA256", &record.sha256)
        .env("DRAWHIME_UPDATE_RESULT", &result_path)
        .env("DRAWHIME_UPDATE_RELAUNCH", relaunch_path)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command.spawn().map_err(|error| {
        let message = format!("启动更新程序失败：{error}");
        let _ = database.execute(
            "UPDATE software_updates SET status='failed',error=?2,updated_at=?3 WHERE version=?1",
            params![record.version, message, Utc::now().to_rfc3339()],
        );
        message
    })?;
    Ok(())
}

fn latest_online_update() -> Result<Option<DesktopResourceManifestItem>, String> {
    let payload = resource::verified_manifest()?;
    if payload.channel != "stable" {
        return Err("软件更新仅接受稳定通道签名清单".into());
    }
    let mut items: Vec<_> = payload
        .resources
        .into_iter()
        .filter(|item| {
            item.kind == "application"
                && item.os == "windows"
                && item.arch == std::env::consts::ARCH
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(version_parts(&item.version)));
    Ok(items.into_iter().next())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let database = Connection::open(path)
        .map_err(|error| format!("打开软件更新数据库失败：{error}"))?;
    database
        .execute_batch("PRAGMA busy_timeout=5000;")
        .map_err(|error| format!("初始化软件更新数据库失败：{error}"))?;
    Ok(database)
}

fn upsert_record(
    database: &Connection,
    item: &DesktopResourceManifestItem,
    source: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    database
        .execute(
            "INSERT INTO software_updates(version,resource_id,file_name,sha256,byte_size,source,status,error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9) ON CONFLICT(version) DO UPDATE SET resource_id=excluded.resource_id,file_name=excluded.file_name,sha256=excluded.sha256,byte_size=excluded.byte_size,source=excluded.source,status=excluded.status,error=excluded.error,updated_at=excluded.updated_at",
            params![item.version, item.id, item.file_name, item.sha256, item.byte_size, source, status, error, now],
        )
        .map_err(|failure| format!("保存软件更新记录失败：{failure}"))?;
    Ok(())
}

fn update_records(database: &Connection) -> Result<Vec<UpdateRecord>, String> {
    let mut statement = database
        .prepare(
            "SELECT version,file_name,sha256,byte_size FROM software_updates WHERE status IN ('downloaded','staged','applied','failed')",
        )
        .map_err(|error| format!("读取软件更新记录失败：{error}"))?;
    let records = statement
        .query_map([], record_from_row)
        .map_err(|error| format!("查询软件更新记录失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析软件更新记录失败：{error}"))?;
    Ok(records)
}

fn latest_trusted_update<F: Fn(i8) -> bool>(
    database: &Connection,
    app_data_dir: &Path,
    accept_order: F,
) -> Result<Option<TrustedUpdate>, String> {
    let mut trusted = Vec::new();
    for record in update_records(database)? {
        let Ok(order) = compare_versions(&record.version, CURRENT_VERSION) else {
            continue;
        };
        if !accept_order(order) {
            continue;
        }
        let installer = app_data_dir.join("resource-cache").join(&record.file_name);
        let envelope = resource::offline_envelope_path(&installer);
        let Ok(item) = resource::verify_offline_application(&installer, &envelope) else {
            continue;
        };
        if record_matches_item(&record, &item) {
            trusted.push(TrustedUpdate { record, item });
        }
    }
    trusted.sort_by_key(|value| std::cmp::Reverse(version_parts(&value.record.version)));
    Ok(trusted.into_iter().next())
}

fn reconcile_applying_records(
    database: &Connection,
    app_data_dir: &Path,
    current_version: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let mut statement = database
        .prepare("SELECT version,updated_at FROM software_updates WHERE status='applying'")
        .map_err(|error| format!("读取待确认软件更新失败：{error}"))?;
    let applying = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("查询待确认软件更新失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析待确认软件更新失败：{error}"))?;
    drop(statement);
    for (version, updated_at) in applying {
        if version == current_version {
            database
                .execute(
                    "UPDATE software_updates SET status='applied',error=NULL,applied_at=?2,updated_at=?2 WHERE version=?1 AND status='applying'",
                    params![version, now.to_rfc3339()],
                )
                .map_err(|error| format!("确认软件更新终态失败：{error}"))?;
            continue;
        }
        let result_path = apply_result_path(app_data_dir, &version);
        let exit_code = fs::read_to_string(&result_path)
            .ok()
            .and_then(|value| value.trim().parse::<i32>().ok());
        let stale = DateTime::parse_from_rfc3339(&updated_at)
            .map(|value| now.signed_duration_since(value.with_timezone(&Utc)) >= ChronoDuration::minutes(APPLY_STALE_MINUTES))
            .unwrap_or(true);
        let error = match exit_code {
            Some(0) => Some("安装器已结束，但当前运行版本未更新".to_string()),
            Some(code) => Some(format!("安装器退出码 {code}")),
            None if stale => Some("软件更新在规定时间内未完成".to_string()),
            None => None,
        };
        if let Some(error) = error {
            database
                .execute(
                    "UPDATE software_updates SET status='failed',error=?2,updated_at=?3 WHERE version=?1 AND status='applying'",
                    params![version, error, now.to_rfc3339()],
                )
                .map_err(|failure| format!("保存软件更新失败终态失败：{failure}"))?;
        }
    }
    Ok(())
}

fn record_matches_item(record: &UpdateRecord, item: &DesktopResourceManifestItem) -> bool {
    item.version == record.version
        && item.file_name == record.file_name
        && item.sha256 == record.sha256
        && item.byte_size == record.byte_size
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UpdateRecord> {
    Ok(UpdateRecord {
        version: row.get(0)?,
        file_name: row.get(1)?,
        sha256: row.get(2)?,
        byte_size: row.get(3)?,
    })
}

fn apply_result_path(app_data_dir: &Path, version: &str) -> std::path::PathBuf {
    app_data_dir.join(format!("apply-update-{version}.result"))
}

fn partial_bytes(app_data_dir: &Path, item: &DesktopResourceManifestItem) -> u64 {
    let target = resource::cached_resource_path(app_data_dir, item);
    target
        .with_file_name(format!(
            "{}.part",
            target.file_name().unwrap_or_default().to_string_lossy()
        ))
        .metadata()
        .map(|value| value.len())
        .unwrap_or(0)
}

fn version_parts(value: &str) -> (u64, u64, u64) {
    checked_version(value).unwrap_or((0, 0, 0))
}

fn compare_versions(left: &str, right: &str) -> Result<i8, String> {
    let left_parts = checked_version(left)?;
    let right_parts = checked_version(right)?;
    Ok(if left_parts > right_parts {
        1
    } else if left_parts < right_parts {
        -1
    } else {
        0
    })
}

fn checked_version(value: &str) -> Result<(u64, u64, u64), String> {
    let values = value
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| format!("软件版本格式不正确：{value}"))?;
    if values.len() != 3 {
        return Err(format!("软件版本格式不正确：{value}"));
    }
    Ok((values[0], values[1], values[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_update_table(database: &Connection) {
        database
            .execute_batch(
                "CREATE TABLE software_updates (version TEXT PRIMARY KEY, resource_id TEXT NOT NULL, file_name TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT);",
            )
            .expect("创建软件更新测试表");
    }

    #[test]
    fn semantic_versions_compare_numerically() {
        assert_eq!(
            compare_versions("0.10.0", "0.9.9").expect("比较版本"),
            1
        );
        assert_eq!(
            compare_versions("1.0.0", "1.0.0").expect("比较相同版本"),
            0
        );
        assert!(compare_versions("1.0", "1.0.0").is_err());
    }

    #[test]
    fn applying_state_converges_only_from_actual_running_version() {
        let temporary = tempfile::tempdir().expect("创建更新状态测试目录");
        let database = Connection::open_in_memory().expect("创建更新状态测试数据库");
        create_update_table(&database);
        let now = Utc::now();
        database.execute(
            "INSERT INTO software_updates(version,resource_id,file_name,sha256,byte_size,source,status,created_at,updated_at) VALUES('1.2.3','application.desktop','update.exe',?1,10,'online','applying',?2,?2)",
            params!["a".repeat(64), now.to_rfc3339()],
        ).expect("写入待确认更新");
        reconcile_applying_records(&database, temporary.path(), "1.2.3", now)
            .expect("按运行版本确认更新");
        let status: String = database
            .query_row(
                "SELECT status FROM software_updates WHERE version='1.2.3'",
                [],
                |row| row.get(0),
            )
            .expect("读取更新状态");
        assert_eq!(status, "applied");
    }

    #[test]
    fn applying_state_does_not_fail_before_helper_finishes() {
        let temporary = tempfile::tempdir().expect("创建更新等待测试目录");
        let database = Connection::open_in_memory().expect("创建更新等待测试数据库");
        create_update_table(&database);
        let now = Utc::now();
        database.execute(
            "INSERT INTO software_updates(version,resource_id,file_name,sha256,byte_size,source,status,created_at,updated_at) VALUES('1.2.4','application.desktop','update.exe',?1,10,'online','applying',?2,?2)",
            params!["a".repeat(64), now.to_rfc3339()],
        ).expect("写入正在执行的更新");
        reconcile_applying_records(&database, temporary.path(), "1.2.3", now)
            .expect("保留正在执行状态");
        let status: String = database
            .query_row(
                "SELECT status FROM software_updates WHERE version='1.2.4'",
                [],
                |row| row.get(0),
            )
            .expect("读取更新状态");
        assert_eq!(status, "applying");
    }

    #[test]
    fn applying_state_records_real_installer_exit_code() {
        let temporary = tempfile::tempdir().expect("创建更新退出码测试目录");
        let database = Connection::open_in_memory().expect("创建更新退出码测试数据库");
        create_update_table(&database);
        let now = Utc::now();
        database.execute(
            "INSERT INTO software_updates(version,resource_id,file_name,sha256,byte_size,source,status,created_at,updated_at) VALUES('1.2.5','application.desktop','update.exe',?1,10,'online','applying',?2,?2)",
            params!["a".repeat(64), now.to_rfc3339()],
        ).expect("写入待确认更新");
        fs::write(apply_result_path(temporary.path(), "1.2.5"), "1603").expect("写入安装器退出码");
        reconcile_applying_records(&database, temporary.path(), "1.2.4", now).expect("收敛安装器失败状态");
        let (status, error): (String, Option<String>) = database.query_row("SELECT status,error FROM software_updates WHERE version='1.2.5'", [], |row| Ok((row.get(0)?, row.get(1)?))).expect("读取安装器失败状态");
        assert_eq!(status, "failed");
        assert_eq!(error.as_deref(), Some("安装器退出码 1603"));
    }

    #[test]
    fn applying_state_marks_missing_result_failed_only_after_deadline() {
        let temporary = tempfile::tempdir().expect("创建更新超时测试目录");
        let database = Connection::open_in_memory().expect("创建更新超时测试数据库");
        create_update_table(&database);
        let now = Utc::now();
        let stale_at = (now - ChronoDuration::minutes(APPLY_STALE_MINUTES + 1)).to_rfc3339();
        database.execute(
            "INSERT INTO software_updates(version,resource_id,file_name,sha256,byte_size,source,status,created_at,updated_at) VALUES('1.2.6','application.desktop','update.exe',?1,10,'online','applying',?2,?2)",
            params!["a".repeat(64), stale_at],
        ).expect("写入超时更新");
        reconcile_applying_records(&database, temporary.path(), "1.2.5", now).expect("收敛更新超时状态");
        let (status, error): (String, Option<String>) = database.query_row("SELECT status,error FROM software_updates WHERE version='1.2.6'", [], |row| Ok((row.get(0)?, row.get(1)?))).expect("读取更新超时状态");
        assert_eq!(status, "failed");
        assert_eq!(error.as_deref(), Some("软件更新在规定时间内未完成"));
    }

    #[test]
    fn visible_update_helper_reports_progress_and_relaunches() {
        assert!(UPDATE_HELPER_SCRIPT.contains("title DrawHime 更新助手"));
        assert!(UPDATE_HELPER_SCRIPT.contains("[1/4]"));
        assert!(UPDATE_HELPER_SCRIPT.contains("start \"\" /wait \"%INSTALLER%\" /S"));
        assert!(UPDATE_HELPER_SCRIPT.contains("start \"\" \"%RELAUNCH_PATH%\""));
    }
}
