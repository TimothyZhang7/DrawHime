//! 本模块注册 DrawHime Desktop 本地核心、SQLite 和环境检测命令。

mod environment;
mod models;
mod resource;
mod storage;

use models::{DesktopBootstrapView, DesktopEnvironmentReport, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopSettings, GalleryPublicationInput, GallerySyncItem};
use std::path::PathBuf;
use storage::DesktopState;
use tauri::{Manager, State};

#[tauri::command]
fn desktop_bootstrap(state: State<'_, DesktopState>) -> Result<DesktopBootstrapView, String> {
    let settings = state.load_settings()?;
    let environment = inspect_and_store(&state, &settings)?;
    let pending_gallery_sync_count = state.pending_gallery_sync_count()?;
    Ok(DesktopBootstrapView { environment, settings, pending_gallery_sync_count })
}

#[tauri::command]
fn desktop_inspect_environment(state: State<'_, DesktopState>) -> Result<DesktopEnvironmentReport, String> {
    let settings = state.load_settings()?;
    inspect_and_store(&state, &settings)
}

#[tauri::command]
fn desktop_save_settings(state: State<'_, DesktopState>, settings: DesktopSettings) -> Result<DesktopSettings, String> {
    state.save_settings(settings)
}

#[tauri::command]
fn desktop_enqueue_gallery_publication(state: State<'_, DesktopState>, input: GalleryPublicationInput) -> Result<GallerySyncItem, String> {
    state.enqueue_gallery_publication(input)
}

#[tauri::command]
fn desktop_list_gallery_sync_queue(state: State<'_, DesktopState>) -> Result<Vec<GallerySyncItem>, String> {
    state.list_gallery_sync_queue()
}

#[tauri::command]
async fn desktop_load_resource_catalog(state: State<'_, DesktopState>) -> Result<DesktopResourceCatalogView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || resource::load_catalog(&settings, &app_data_dir)).await.map_err(|error| format!("资源目录任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_download_resource(app: tauri::AppHandle, state: State<'_, DesktopState>, resource_id: String) -> Result<DesktopResourceDownloadView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || resource::download_resource(&settings, &app_data_dir, &resource_id, &app)).await.map_err(|error| format!("资源下载任务异常：{error}"))?
}

/** 检测后保存脱敏 JSON 快照，页面与诊断记录始终使用同一结论。 */
fn inspect_and_store(state: &DesktopState, settings: &DesktopSettings) -> Result<DesktopEnvironmentReport, String> {
    let report = environment::inspect_environment(settings);
    let json = serde_json::to_string(&report).map_err(|error| format!("序列化环境报告失败：{error}"))?;
    state.save_environment_snapshot(&json, &report.checked_at)?;
    Ok(report)
}

/** 启动桌面窗口并在 setup 阶段建立真实本地数据库。 */
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app.path().app_data_dir().map_err(|error| format!("读取应用数据目录失败：{error}"))?;
            let picture_dir = app.path().picture_dir().unwrap_or_else(|_| PathBuf::from(&app_data).join("pictures"));
            app.manage(DesktopState::initialize(&app_data, &picture_dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_bootstrap, desktop_inspect_environment, desktop_save_settings, desktop_enqueue_gallery_publication, desktop_list_gallery_sync_queue, desktop_load_resource_catalog, desktop_download_resource])
        .run(tauri::generate_context!())
        .expect("DrawHime Desktop 启动失败");
}
