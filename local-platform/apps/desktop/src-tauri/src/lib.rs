//! 本模块注册 DrawHime Desktop 本地核心、SQLite 和环境检测命令。

mod captioner;
mod auth;
mod environment;
mod generation;
mod gallery_sync;
mod local_model;
mod models;
mod resource;
mod runtime;
mod scheduler;
mod storage;
mod training;
mod training_dataset;
mod trainer;
mod workload;

use models::{DesktopBootstrapView, DesktopCaptionJobCreateInput, DesktopCaptionJobView, DesktopEnvironmentReport, DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalLoraImportInput, DesktopLocalLoraView, DesktopLocalModelImportInput, DesktopLocalModelView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopRuntimeStatusView, DesktopSettings, DesktopTrainingCaptionUpdateInput, DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetIdInput, DesktopTrainingDatasetView, DesktopTrainingImagesAddInput, DesktopTrainingJobCreateInput, DesktopTrainingJobView, GalleryPublicationInput, GallerySyncItem};
use std::path::PathBuf;
use storage::DesktopState;
use tauri::{Manager, State};

/** 返回不包含会话密钥的桌面账号状态。 */
#[tauri::command]
async fn desktop_account_status() -> Result<auth::DesktopAccountView, String> {
    tauri::async_runtime::spawn_blocking(auth::account_status).await.map_err(|error| format!("账号状态任务异常：{error}"))?
}

/** 创建浏览器设备授权请求。 */
#[tauri::command]
async fn desktop_start_authorization(input: auth::DesktopAuthorizationStartInput) -> Result<auth::DesktopAuthorizationRequestView, String> {
    tauri::async_runtime::spawn_blocking(move || auth::start_authorization(input)).await.map_err(|error| format!("设备授权任务异常：{error}"))?
}

/** 轮询设备授权并在成功时写入 Windows Credential Manager。 */
#[tauri::command]
async fn desktop_poll_authorization(input: auth::DesktopAuthorizationPollInput) -> Result<auth::DesktopAuthorizationPollOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || auth::poll_authorization(input)).await.map_err(|error| format!("设备授权轮询异常：{error}"))?
}

/** 撤销并删除当前桌面账号凭据。 */
#[tauri::command]
async fn desktop_sign_out() -> Result<auth::DesktopAccountView, String> {
    tauri::async_runtime::spawn_blocking(auth::sign_out).await.map_err(|error| format!("桌面退出任务异常：{error}"))?
}

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
    let outcome = tauri::async_runtime::spawn_blocking(move || resource::install_resource(&settings, &app_data_dir, &resource_id, &app)).await.map_err(|error| format!("资源安装任务异常：{error}"))??;
    for registration in outcome.model_registrations { state.register_local_model(registration)?; }
    Ok(outcome.view)
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
    let gpu_workload = state.gpu_workload.clone();
    tauri::async_runtime::spawn_blocking(move || { let _guard = gpu_workload.try_acquire().ok_or_else(|| "GPU 正在执行生成或训练任务".to_string())?; runtime.start(&settings, &app_data_dir) }).await.map_err(|error| format!("Runtime 启动任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_stop_runtime(state: State<'_, DesktopState>) -> Result<DesktopRuntimeStatusView, String> {
    if state.running_local_job_count()? > 0 { return Err("存在运行中的本地任务，请先取消或等待任务完成".into()); }
    let runtime = state.runtime.clone();
    let gpu_workload = state.gpu_workload.clone();
    tauri::async_runtime::spawn_blocking(move || { let _guard = gpu_workload.try_acquire().ok_or_else(|| "GPU 正在执行生成或训练任务".to_string())?; runtime.stop() }).await.map_err(|error| format!("Runtime 停止任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_self_test_runtime(state: State<'_, DesktopState>) -> Result<DesktopRuntimeStatusView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    let runtime = state.runtime.clone();
    let gpu_workload = state.gpu_workload.clone();
    tauri::async_runtime::spawn_blocking(move || { let _guard = gpu_workload.try_acquire().ok_or_else(|| "GPU 正在执行生成或训练任务".to_string())?; runtime.self_test(&settings, &app_data_dir) }).await.map_err(|error| format!("Runtime 自检任务异常：{error}"))?
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
async fn desktop_import_local_lora(state: State<'_, DesktopState>, input: DesktopLocalLoraImportInput) -> Result<DesktopLocalLoraView, String> {
    let settings = state.load_settings()?;
    let registration = tauri::async_runtime::spawn_blocking(move || local_model::import_local_lora(&settings, input)).await.map_err(|error| format!("LoRA 导入任务异常：{error}"))??;
    state.register_local_lora(registration)
}

#[tauri::command]
fn desktop_list_local_loras(state: State<'_, DesktopState>) -> Result<Vec<DesktopLocalLoraView>, String> {
    state.list_local_loras()
}

#[tauri::command]
fn desktop_create_training_dataset(state: State<'_, DesktopState>, input: DesktopTrainingDatasetCreateInput) -> Result<DesktopTrainingDatasetView, String> {
    state.create_training_dataset(input)
}

#[tauri::command]
fn desktop_list_training_datasets(state: State<'_, DesktopState>) -> Result<Vec<DesktopTrainingDatasetView>, String> {
    state.list_training_datasets()
}

#[tauri::command]
async fn desktop_add_training_images(state: State<'_, DesktopState>, input: DesktopTrainingImagesAddInput) -> Result<DesktopTrainingDatasetView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut database = rusqlite::Connection::open(database_path).map_err(|error| format!("打开训练集数据库失败：{error}"))?;
        database.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;").map_err(|error| format!("初始化训练集数据库连接失败：{error}"))?;
        training_dataset::add_images(&mut database, &app_data_dir, input)
    }).await.map_err(|error| format!("训练图片导入任务异常：{error}"))?
}

#[tauri::command]
fn desktop_update_training_caption(state: State<'_, DesktopState>, input: DesktopTrainingCaptionUpdateInput) -> Result<DesktopTrainingDatasetView, String> {
    state.update_training_caption(input)
}

/** 持久化创建批量或单图离线打标任务并立即返回。 */
#[tauri::command]
fn desktop_create_caption_job(state: State<'_, DesktopState>, input: DesktopCaptionJobCreateInput) -> Result<DesktopCaptionJobView, String> {
    state.create_caption_job(input)
}

/** 返回最近的本地离线打标任务。 */
#[tauri::command]
fn desktop_list_caption_jobs(state: State<'_, DesktopState>) -> Result<Vec<DesktopCaptionJobView>, String> {
    state.list_caption_jobs()
}

/** 幂等取消排队或运行中的本地离线打标任务。 */
#[tauri::command]
fn desktop_cancel_caption_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopCaptionJobView, String> {
    state.cancel_caption_job(&id)
}

/** 创建本地 LoRA 训练任务并立即返回持久化排队记录。 */
#[tauri::command]
fn desktop_create_training_job(state: State<'_, DesktopState>, input: DesktopTrainingJobCreateInput) -> Result<DesktopTrainingJobView, String> {
    state.create_training_job(input)
}

/** 返回最近的本地 LoRA 训练任务。 */
#[tauri::command]
fn desktop_list_training_jobs(state: State<'_, DesktopState>) -> Result<Vec<DesktopTrainingJobView>, String> {
    state.list_training_jobs()
}

/** 幂等取消排队或运行中的本地 LoRA 训练任务。 */
#[tauri::command]
fn desktop_cancel_training_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopTrainingJobView, String> {
    state.cancel_training_job(&id)
}

#[tauri::command]
async fn desktop_confirm_training_dataset(state: State<'_, DesktopState>, input: DesktopTrainingDatasetIdInput) -> Result<DesktopTrainingDatasetView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let database = rusqlite::Connection::open(database_path).map_err(|error| format!("打开训练集数据库失败：{error}"))?;
        database.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;").map_err(|error| format!("初始化训练集数据库连接失败：{error}"))?;
        training_dataset::confirm_dataset(&database, &app_data_dir, &input.dataset_id)
    }).await.map_err(|error| format!("训练集确认任务异常：{error}"))?
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
        .plugin(tauri_plugin_opener::init())
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
        .invoke_handler(tauri::generate_handler![desktop_account_status, desktop_start_authorization, desktop_poll_authorization, desktop_sign_out, desktop_bootstrap, desktop_inspect_environment, desktop_save_settings, desktop_enqueue_gallery_publication, desktop_list_gallery_sync_queue, desktop_load_resource_catalog, desktop_download_resource, desktop_install_resource, desktop_runtime_status, desktop_start_runtime, desktop_stop_runtime, desktop_self_test_runtime, desktop_import_local_model, desktop_list_local_models, desktop_import_local_lora, desktop_list_local_loras, desktop_create_training_dataset, desktop_list_training_datasets, desktop_add_training_images, desktop_update_training_caption, desktop_create_caption_job, desktop_list_caption_jobs, desktop_cancel_caption_job, desktop_confirm_training_dataset, desktop_create_training_job, desktop_list_training_jobs, desktop_cancel_training_job, desktop_create_local_job, desktop_list_local_jobs, desktop_cancel_local_job])
        .run(tauri::generate_context!())
        .expect("DrawHime Desktop 启动失败");
}
