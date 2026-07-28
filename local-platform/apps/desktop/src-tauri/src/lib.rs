//! 本模块注册 DrawHime Desktop 本地核心、SQLite 和环境检测命令。

mod environment;
mod generation;
mod local_model;
mod models;
mod resource;
mod runtime;
mod scheduler;
mod storage;

use models::{DesktopBootstrapView, DesktopEnvironmentReport, DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalModelImportInput, DesktopLocalModelView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopRuntimeStatusView, DesktopSettings, GalleryPublicationInput, GallerySyncItem};
use std::path::PathBuf;
use storage::DesktopState;
use tauri::{Manager, State};

#[tauri::command]
fn desktop_bootstrap(state: State<'_, DesktopState>) -> Result<DesktopBootstrapView, String> {
    let settings = state.load_settings()?;
    let environment = inspect_and_store(&state, &settings)?;
    let runtime = state.runtime.status()?;
    let pending_gallery_sync_count = state.pending_gallery_sync_count()?;
    Ok(DesktopBootstrapView { environment, settings, runtime, pending_gallery_sync_count })
}

#[tauri::command]
fn desktop_inspect_environment(state: State<'_, DesktopState>) -> Result<DesktopEnvironmentReport, String> {
    let settings = state.load_settings()?;
    inspect_and_store(&state, &settings)
}

#[tauri::command]
fn desktop_save_settings(app: tauri::AppHandle, state: State<'_, DesktopState>, settings: DesktopSettings) -> Result<DesktopSettings, String> {
    let settings = state.save_settings(settings)?;
    app.asset_protocol_scope().allow_directory(&settings.output_root, true).map_err(|error| format!("授权作品预览目录失败：{error}"))?;
    Ok(settings)
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

#[tauri::command]
async fn desktop_install_resource(app: tauri::AppHandle, state: State<'_, DesktopState>, resource_id: String) -> Result<DesktopResourceInstallView, String> {
    if resource_id.starts_with("runtime.") && matches!(state.runtime.status()?.status.as_str(), "starting" | "ready" | "stopping") { return Err("请先停止本地 Runtime，再安装或切换 Runtime 版本".into()); }
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || resource::install_resource(&settings, &app_data_dir, &resource_id, &app)).await.map_err(|error| format!("资源安装任务异常：{error}"))?
}

#[tauri::command]
fn desktop_runtime_status(state: State<'_, DesktopState>) -> Result<DesktopRuntimeStatusView, String> {
    state.runtime.status()
}

#[tauri::command]
async fn desktop_start_runtime(state: State<'_, DesktopState>) -> Result<DesktopRuntimeStatusView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.start(&settings, &app_data_dir)).await.map_err(|error| format!("Runtime 启动任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_stop_runtime(state: State<'_, DesktopState>) -> Result<DesktopRuntimeStatusView, String> {
    if state.running_local_job_count()? > 0 { return Err("存在运行中的本地任务，请先取消或等待任务完成".into()); }
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.stop()).await.map_err(|error| format!("Runtime 停止任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_self_test_runtime(state: State<'_, DesktopState>) -> Result<DesktopRuntimeStatusView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    let runtime = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || runtime.self_test(&settings, &app_data_dir)).await.map_err(|error| format!("Runtime 自检任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_import_local_model(state: State<'_, DesktopState>, input: DesktopLocalModelImportInput) -> Result<DesktopLocalModelView, String> {
    let settings = state.load_settings()?;
    let registration = tauri::async_runtime::spawn_blocking(move || local_model::import_local_model(&settings, input)).await.map_err(|error| format!("模型导入任务异常：{error}"))??;
    state.register_local_model(registration)
}

#[tauri::command]
fn desktop_list_local_models(state: State<'_, DesktopState>) -> Result<Vec<DesktopLocalModelView>, String> {
    state.list_local_models()
}

#[tauri::command]
fn desktop_create_local_job(state: State<'_, DesktopState>, input: DesktopLocalJobCreateInput) -> Result<DesktopLocalJobView, String> {
    state.create_local_job(input)
}

#[tauri::command]
fn desktop_list_local_jobs(state: State<'_, DesktopState>) -> Result<Vec<DesktopLocalJobView>, String> {
    state.list_local_jobs()
}

#[tauri::command]
fn desktop_cancel_local_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopLocalJobView, String> {
    state.cancel_local_job(&id)
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir().map_err(|error| format!("读取应用数据目录失败：{error}"))?;
            let picture_dir = app.path().picture_dir().unwrap_or_else(|_| PathBuf::from(&app_data).join("pictures"));
            let mut state = DesktopState::initialize(&app_data, &picture_dir)?;
            let settings = state.load_settings()?;
            app.asset_protocol_scope().allow_directory(&settings.output_root, true).map_err(|error| format!("授权作品预览目录失败：{error}"))?;
            state.start_scheduler(app.handle().clone())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_bootstrap, desktop_inspect_environment, desktop_save_settings, desktop_enqueue_gallery_publication, desktop_list_gallery_sync_queue, desktop_load_resource_catalog, desktop_download_resource, desktop_install_resource, desktop_runtime_status, desktop_start_runtime, desktop_stop_runtime, desktop_self_test_runtime, desktop_import_local_model, desktop_list_local_models, desktop_create_local_job, desktop_list_local_jobs, desktop_cancel_local_job])
        .run(tauri::generate_context!())
        .expect("DrawHime Desktop 启动失败");
}
