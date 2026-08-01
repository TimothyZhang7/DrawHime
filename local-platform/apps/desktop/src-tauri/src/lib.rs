//! 本模块注册 DrawHime Desktop 本地核心、SQLite 和环境检测命令。

mod ai_assist;
mod ai_cleaner;
mod background_removal;
mod auth;
mod captioner;
mod environment;
mod gallery_sync;
mod generation;
mod local_model;
mod models;
mod network;
mod process;
mod resource;
mod runtime;
mod scheduler;
mod software_update;
mod storage;
mod storage_cleanup;
mod trainer;
mod training;
mod training_dataset;
mod training_files;
mod training_import;
mod training_tags;
mod website_catalog_cache;
mod website_lora;
mod website_media;
mod website_model;
mod website_tag_translation;
mod workload;

use models::{
    DesktopAiAnalyzeInput, DesktopAiAnalyzeView, DesktopAiCleanApplyInput,
    DesktopAiCleanJobCreateInput, DesktopAiCleanJobView, DesktopAiCleanUndoInput,
    DesktopAiSettings, DesktopAiSettingsUpdate, DesktopBackgroundRemovalJobCreateInput,
    DesktopBackgroundRemovalJobView, DesktopBootstrapView, DesktopCaptionJobCreateInput,
    DesktopCaptionJobView, DesktopEnvironmentReport, DesktopLocalJobCreateInput,
    DesktopLocalJobView, DesktopLocalLoraImportInput, DesktopLocalLoraView,
    DesktopLocalModelImportInput, DesktopLocalModelView, DesktopManagedFileDeleteInput,
    DesktopManagedFileRemovalView, DesktopOfflineUpdateImportInput, DesktopResourceCatalogView,
    DesktopResourceDownloadView, DesktopResourceInstallView, DesktopRuntimeStatusView,
    DesktopSettings, DesktopSoftwareUpdateView, DesktopStorageCleanupInput,
    DesktopStorageCleanupView, DesktopTrainingAssetDeleteInput, DesktopTrainingBatchTagsInput,
    DesktopTrainingCaptionUpdateInput,
    DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetIdInput,
    DesktopTrainingDatasetImportInput, DesktopTrainingDatasetImportPreview,
    DesktopTrainingDatasetImportPreviewInput, DesktopTrainingDatasetView,
    DesktopTrainingImagesAddInput, DesktopTrainingJobCreateInput, DesktopTrainingJobView,
    DesktopTrainingAssetVariantSelectInput, DesktopTrainingManualMaskInput,
    DesktopTrainingSnapshotCopyInput, DesktopTrainingSnapshotView,
    DesktopTrainingTagTranslationInput, DesktopTrainingTagTranslationView,
    DesktopTrainingTriggerWordsUpdateInput, DesktopWebsiteLoraView, DesktopWebsiteModelView,
    GalleryPublicationInput, GallerySyncItem,
};
use std::{
    env,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use storage::DesktopState;
use tauri::{Manager, PhysicalSize, State, WebviewUrl, WindowEvent};

/** 预览页只有完成 React 根组件挂载后才对主窗口和验收报告为可用。 */
static GENERATION_PREVIEW_READY: AtomicBool = AtomicBool::new(false);

/** 返回不包含会话密钥的桌面账号状态。 */
#[tauri::command]
async fn desktop_account_status() -> Result<auth::DesktopAccountView, String> {
    tauri::async_runtime::spawn_blocking(auth::account_status)
        .await
        .map_err(|error| format!("账号状态任务异常：{error}"))?
}

/** 创建浏览器设备授权请求。 */
#[tauri::command]
async fn desktop_start_authorization(
    input: auth::DesktopAuthorizationStartInput,
) -> Result<auth::DesktopAuthorizationRequestView, String> {
    tauri::async_runtime::spawn_blocking(move || auth::start_authorization(input))
        .await
        .map_err(|error| format!("设备授权任务异常：{error}"))?
}

/** 轮询设备授权并在成功时写入 Windows Credential Manager。 */
#[tauri::command]
async fn desktop_poll_authorization(
    input: auth::DesktopAuthorizationPollInput,
) -> Result<auth::DesktopAuthorizationPollOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || auth::poll_authorization(input))
        .await
        .map_err(|error| format!("设备授权轮询异常：{error}"))?
}

/** 撤销并删除当前桌面账号凭据。 */
#[tauri::command]
async fn desktop_sign_out() -> Result<auth::DesktopAccountView, String> {
    tauri::async_runtime::spawn_blocking(auth::sign_out)
        .await
        .map_err(|error| format!("桌面退出任务异常：{error}"))?
}

#[tauri::command]
fn desktop_bootstrap(state: State<'_, DesktopState>) -> Result<DesktopBootstrapView, String> {
    let settings = state.load_settings()?;
    let environment = inspect_and_store(&state, &settings)?;
    let runtime = state.runtime.status()?;
    let pending_gallery_sync_count = state.pending_gallery_sync_count()?;
    Ok(DesktopBootstrapView {
        environment,
        settings,
        runtime,
        pending_gallery_sync_count,
    })
}

#[tauri::command]
fn desktop_inspect_environment(
    state: State<'_, DesktopState>,
) -> Result<DesktopEnvironmentReport, String> {
    let settings = state.load_settings()?;
    inspect_and_store(&state, &settings)
}

#[tauri::command]
fn desktop_save_settings(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    settings: DesktopSettings,
) -> Result<DesktopSettings, String> {
    let settings = state.save_settings(settings)?;
    allow_preview_directories(&app, &state.app_data_dir, &settings)?;
    Ok(settings)
}

/** 返回不含密钥正文的桌面 AI 辅助设置。 */
#[tauri::command]
fn desktop_load_ai_settings(state: State<'_, DesktopState>) -> Result<DesktopAiSettings, String> {
    state.load_ai_settings(ai_assist::api_key_configured()?)
}

/** 把非敏感设置写入 SQLite，把 API Key 写入 Windows Credential Manager。 */
#[tauri::command]
fn desktop_save_ai_settings(
    state: State<'_, DesktopState>,
    input: DesktopAiSettingsUpdate,
) -> Result<DesktopAiSettings, String> {
    let (enabled, endpoint_type, base_url, model, configured) = ai_assist::prepare_settings(input)?;
    state.save_ai_settings_metadata(enabled, &endpoint_type, &base_url, &model, configured)
}

/** 使用当前配置执行一次真实上游连通性测试。 */
#[tauri::command]
async fn desktop_test_ai_settings(state: State<'_, DesktopState>) -> Result<String, String> {
    let settings = state.load_ai_settings(ai_assist::api_key_configured()?)?;
    tauri::async_runtime::spawn_blocking(move || ai_assist::test_settings(&settings))
        .await
        .map_err(|error| format!("AI 测试任务异常：{error}"))?
}

/** 在后台线程中读取本机图片并执行 AI 打标或反推。 */
#[tauri::command]
async fn desktop_ai_analyze_image(
    state: State<'_, DesktopState>,
    input: DesktopAiAnalyzeInput,
) -> Result<DesktopAiAnalyzeView, String> {
    let settings = state.load_ai_settings(ai_assist::api_key_configured()?)?;
    tauri::async_runtime::spawn_blocking(move || ai_assist::analyze_image(&settings, input))
        .await
        .map_err(|error| format!("AI 图片分析任务异常：{error}"))?
}

#[tauri::command]
fn desktop_enqueue_gallery_publication(
    state: State<'_, DesktopState>,
    input: GalleryPublicationInput,
) -> Result<GallerySyncItem, String> {
    state.enqueue_gallery_publication(input)
}

#[tauri::command]
fn desktop_list_gallery_sync_queue(
    state: State<'_, DesktopState>,
) -> Result<Vec<GallerySyncItem>, String> {
    state.list_gallery_sync_queue()
}

#[tauri::command]
async fn desktop_load_resource_catalog(
    state: State<'_, DesktopState>,
) -> Result<DesktopResourceCatalogView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || resource::load_catalog(&settings, &app_data_dir))
        .await
        .map_err(|error| format!("资源目录任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_download_resource(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    resource_id: String,
) -> Result<DesktopResourceDownloadView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        resource::download_resource(&settings, &app_data_dir, &resource_id, &app)
    })
    .await
    .map_err(|error| format!("资源下载任务异常：{error}"))?
}

/** 暂停资源下载并保留已完成分片，用户再次下载时继续断点。 */
#[tauri::command]
fn desktop_pause_resource_download(resource_id: String) -> Result<(), String> {
    resource::pause_download(&resource_id)
}

#[tauri::command]
async fn desktop_install_resource(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    resource_id: String,
) -> Result<DesktopResourceInstallView, String> {
    if resource_id.starts_with("runtime.")
        && matches!(
            state.runtime.status()?.status.as_str(),
            "starting" | "ready" | "stopping"
        )
    {
        return Err("请先停止本地 Runtime，再安装或切换 Runtime 版本".into());
    }
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        resource::install_resource(&settings, &app_data_dir, &resource_id, &app)
    })
    .await
    .map_err(|error| format!("资源安装任务异常：{error}"))??;
    for registration in outcome.model_registrations {
        state.register_local_model(registration)?;
    }
    Ok(outcome.view)
}

#[tauri::command]
fn desktop_runtime_status(
    state: State<'_, DesktopState>,
) -> Result<DesktopRuntimeStatusView, String> {
    state.runtime.status()
}

#[tauri::command]
async fn desktop_start_runtime(
    state: State<'_, DesktopState>,
) -> Result<DesktopRuntimeStatusView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    let runtime = state.runtime.clone();
    let gpu_workload = state.gpu_workload.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gpu_workload
            .try_acquire()
            .ok_or_else(|| "GPU 正在执行生成或训练任务".to_string())?;
        runtime.start(&settings, &app_data_dir)
    })
    .await
    .map_err(|error| format!("Runtime 启动任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_stop_runtime(
    state: State<'_, DesktopState>,
) -> Result<DesktopRuntimeStatusView, String> {
    if state.running_local_job_count()? > 0 {
        return Err("存在运行中的本地任务，请先取消或等待任务完成".into());
    }
    let runtime = state.runtime.clone();
    let gpu_workload = state.gpu_workload.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gpu_workload
            .try_acquire()
            .ok_or_else(|| "GPU 正在执行生成或训练任务".to_string())?;
        runtime.stop()
    })
    .await
    .map_err(|error| format!("Runtime 停止任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_self_test_runtime(
    state: State<'_, DesktopState>,
) -> Result<DesktopRuntimeStatusView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    let runtime = state.runtime.clone();
    let gpu_workload = state.gpu_workload.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gpu_workload
            .try_acquire()
            .ok_or_else(|| "GPU 正在执行生成或训练任务".to_string())?;
        runtime.self_test(&settings, &app_data_dir)
    })
    .await
    .map_err(|error| format!("Runtime 自检任务异常：{error}"))?
}

#[tauri::command]
async fn desktop_import_local_model(
    state: State<'_, DesktopState>,
    input: DesktopLocalModelImportInput,
) -> Result<DesktopLocalModelView, String> {
    let settings = state.load_settings()?;
    let registration = tauri::async_runtime::spawn_blocking(move || {
        local_model::import_local_model(&settings, input)
    })
    .await
    .map_err(|error| format!("模型导入任务异常：{error}"))??;
    state.register_local_model(registration)
}

#[tauri::command]
fn desktop_list_local_models(
    state: State<'_, DesktopState>,
) -> Result<Vec<DesktopLocalModelView>, String> {
    state.list_local_models()
}

/** 删除底模受管主文件，活动任务和历史登记由核心统一保护。 */
#[tauri::command]
fn desktop_delete_local_model_file(
    state: State<'_, DesktopState>,
    input: DesktopManagedFileDeleteInput,
) -> Result<DesktopManagedFileRemovalView, String> {
    let settings = state.load_settings()?;
    let database = state
        .database
        .lock()
        .map_err(|_| "桌面数据库锁已损坏".to_string())?;
    storage_cleanup::delete_model_file(&database, &settings, input)
}

#[tauri::command]
async fn desktop_import_local_lora(
    state: State<'_, DesktopState>,
    input: DesktopLocalLoraImportInput,
) -> Result<DesktopLocalLoraView, String> {
    let settings = state.load_settings()?;
    let registration = tauri::async_runtime::spawn_blocking(move || {
        local_model::import_local_lora(&settings, input)
    })
    .await
    .map_err(|error| format!("LoRA 导入任务异常：{error}"))??;
    state.register_local_lora(registration)
}

#[tauri::command]
fn desktop_list_local_loras(
    state: State<'_, DesktopState>,
) -> Result<Vec<DesktopLocalLoraView>, String> {
    state.list_local_loras()
}

/** 删除 LoRA 受管文件，历史任务继续保留自己的不可变使用快照。 */
#[tauri::command]
fn desktop_delete_local_lora_file(
    state: State<'_, DesktopState>,
    input: DesktopManagedFileDeleteInput,
) -> Result<DesktopManagedFileRemovalView, String> {
    let settings = state.load_settings()?;
    let database = state
        .database
        .lock()
        .map_err(|_| "桌面数据库锁已损坏".to_string())?;
    storage_cleanup::delete_lora_file(&database, &settings, input)
}

/** 扫描或确认清理无引用受管文件，较慢的目录统计在阻塞线程执行。 */
#[tauri::command]
async fn desktop_storage_cleanup(
    state: State<'_, DesktopState>,
    input: DesktopStorageCleanupInput,
) -> Result<DesktopStorageCleanupView, String> {
    let settings = state.load_settings()?;
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let database = rusqlite::Connection::open(database_path)
            .map_err(|error| format!("打开清理数据库失败：{error}"))?;
        database
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .map_err(|error| format!("初始化清理数据库连接失败：{error}"))?;
        storage_cleanup::cleanup(&database, &settings, &app_data_dir, input)
    })
    .await
    .map_err(|error| format!("存储清理任务异常：{error}"))?
}

/** 使用设备会话读取网站 LoRA 目录，原始会话密钥不会进入 WebView。 */
#[tauri::command]
async fn desktop_load_website_loras(
    state: State<'_, DesktopState>,
    force_refresh: bool,
) -> Result<Vec<DesktopWebsiteLoraView>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let installed = state
        .list_local_loras()?
        .into_iter()
        .map(|item| item.sha256)
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        website_lora::load_catalog(&app_data_dir, &installed, force_refresh)
    })
    .await
    .map_err(|error| format!("网站 LoRA 目录任务异常：{error}"))?
}

/** 使用设备会话读取网站底模目录并缓存封面，不向 WebView 暴露会话密钥。 */
#[tauri::command]
async fn desktop_load_website_models(
    state: State<'_, DesktopState>,
    force_refresh: bool,
) -> Result<Vec<DesktopWebsiteModelView>, String> {
    let app_data_dir = state.app_data_dir.clone();
    let models = tauri::async_runtime::spawn_blocking(move || {
        website_model::load_catalog(&app_data_dir, force_refresh)
    })
    .await
    .map_err(|error| format!("网站底模目录任务异常：{error}"))??;
    state.sync_model_profiles(&models)?;
    Ok(models)
}

/** 从唯一主站下载底模，在用户模型盘内校验安装并登记为可生成模型。 */
#[tauri::command]
async fn desktop_install_website_model(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    model_id: String,
) -> Result<DesktopLocalModelView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    let app_for_install = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let downloaded = website_model::download_and_verify(
            &app_data_dir,
            PathBuf::from(&settings.model_root).as_path(),
            &model_id,
            &app_for_install,
        )?;
        let total_bytes = downloaded
            .view
            .download
            .as_ref()
            .map(|item| item.byte_size)
            .unwrap_or(1);
        website_model::emit_install_state(
            &app_for_install,
            &downloaded.view.id,
            total_bytes,
            "installing",
            None,
        );
        match local_model::install_website_model(&settings, &downloaded.view, &downloaded.path) {
            Ok(registration) => Ok((downloaded.view.id, total_bytes, registration)),
            Err(error) => {
                website_model::emit_install_state(
                    &app_for_install,
                    &downloaded.view.id,
                    total_bytes,
                    "failed",
                    Some(error.clone()),
                );
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| format!("网站底模安装任务异常：{error}"))??;
    match state.register_local_model(outcome.2) {
        Ok(view) => {
            website_model::emit_install_state(&app, &outcome.0, outcome.1, "installed", None);
            Ok(view)
        }
        Err(error) => {
            website_model::emit_install_state(
                &app,
                &outcome.0,
                outcome.1,
                "failed",
                Some(error.clone()),
            );
            Err(error)
        }
    }
}

/** 断点下载并校验网站 LoRA 后原子导入本机仓库。 */
#[tauri::command]
async fn desktop_install_website_lora(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    lora_id: String,
) -> Result<DesktopLocalLoraView, String> {
    let settings = state.load_settings()?;
    let app_data_dir = state.app_data_dir.clone();
    let installed = state
        .list_local_loras()?
        .into_iter()
        .map(|item| item.sha256)
        .collect();
    let app_for_download = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let downloaded = website_lora::download_and_verify(
            &app_data_dir,
            &lora_id,
            &installed,
            &app_for_download,
        )?;
        website_lora::emit_install_state(&app_for_download, &downloaded.view, "installing", None);
        let registration =
            local_model::install_website_lora(&settings, &downloaded.view, &downloaded.path)?;
        Ok::<_, String>((downloaded.view, registration))
    })
    .await
    .map_err(|error| format!("网站 LoRA 安装任务异常：{error}"))??;
    let view = state.register_local_lora(outcome.1)?;
    website_lora::emit_install_state(&app, &outcome.0, "installed", None);
    Ok(view)
}

/** 验签在线通道并返回当前软件更新与可信回滚状态。 */
#[tauri::command]
async fn desktop_software_update_status(
    state: State<'_, DesktopState>,
) -> Result<DesktopSoftwareUpdateView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        software_update::status(&database_path, &app_data_dir)
    })
    .await
    .map_err(|error| format!("软件更新检查任务异常：{error}"))?
}

/** 使用依赖来源策略断点下载最新签名 NSIS 包。 */
#[tauri::command]
async fn desktop_download_software_update(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<DesktopSoftwareUpdateView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    let settings = state.load_settings()?;
    tauri::async_runtime::spawn_blocking(move || {
        software_update::download(&database_path, &app_data_dir, &settings, &app)
    })
    .await
    .map_err(|error| format!("软件下载任务异常：{error}"))?
}

/** 导入离线安装包和 Ed25519 信封。 */
#[tauri::command]
async fn desktop_import_offline_update(
    state: State<'_, DesktopState>,
    input: DesktopOfflineUpdateImportInput,
) -> Result<DesktopSoftwareUpdateView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        software_update::import_offline(&database_path, &app_data_dir, input)
    })
    .await
    .map_err(|error| format!("离线更新导入任务异常：{error}"))?
}

/** 启动静默更新辅助进程后退出当前应用。 */
#[tauri::command]
async fn desktop_apply_software_update(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<DesktopSoftwareUpdateView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    let relaunch_path =
        env::current_exe().map_err(|error| format!("读取当前程序路径失败：{error}"))?;
    let view = tauri::async_runtime::spawn_blocking(move || {
        software_update::apply(&database_path, &app_data_dir, &relaunch_path)
    })
    .await
    .map_err(|error| format!("软件更新应用任务异常：{error}"))??;
    let exit_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        exit_app.exit(0);
    });
    Ok(view)
}

/** 启动上一可信版本安装包后退出当前应用。 */
#[tauri::command]
async fn desktop_rollback_software_update(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<DesktopSoftwareUpdateView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    let relaunch_path =
        env::current_exe().map_err(|error| format!("读取当前程序路径失败：{error}"))?;
    let view = tauri::async_runtime::spawn_blocking(move || {
        software_update::rollback(&database_path, &app_data_dir, &relaunch_path)
    })
    .await
    .map_err(|error| format!("软件回滚任务异常：{error}"))??;
    let exit_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        exit_app.exit(0);
    });
    Ok(view)
}

#[tauri::command]
fn desktop_create_training_dataset(
    state: State<'_, DesktopState>,
    input: DesktopTrainingDatasetCreateInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.create_training_dataset(input)
}

/** 删除可编辑训练集但保留独立训练快照、训练记录和 LoRA 产物。 */
#[tauri::command]
async fn desktop_delete_training_dataset(
    state: State<'_, DesktopState>,
    input: DesktopTrainingDatasetIdInput,
) -> Result<String, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let database = rusqlite::Connection::open(database_path)
            .map_err(|error| format!("打开训练集数据库失败：{error}"))?;
        database
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .map_err(|error| format!("初始化训练集数据库连接失败：{error}"))?;
        training_dataset::delete_dataset(&database, &app_data_dir, input)
    })
    .await
    .map_err(|error| format!("删除训练集任务异常：{error}"))?
}

/** 在后台安全复制或解压来源，只返回统计和受控预检令牌。 */
#[tauri::command]
async fn desktop_preview_training_dataset_import(
    state: State<'_, DesktopState>,
    input: DesktopTrainingDatasetImportPreviewInput,
) -> Result<DesktopTrainingDatasetImportPreview, String> {
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        training_import::preview_import(&app_data_dir, input)
    })
    .await
    .map_err(|error| format!("训练集预检任务异常：{error}"))?
}

/** 用户确认后复核预检快照，并原子创建训练集、图片和同名标签。 */
#[tauri::command]
async fn desktop_import_training_dataset(
    state: State<'_, DesktopState>,
    input: DesktopTrainingDatasetImportInput,
) -> Result<DesktopTrainingDatasetView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut database = rusqlite::Connection::open(database_path)
            .map_err(|error| format!("打开训练集数据库失败：{error}"))?;
        database
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .map_err(|error| format!("初始化训练集数据库连接失败：{error}"))?;
        training_import::commit_import(&mut database, &app_data_dir, input)
    })
    .await
    .map_err(|error| format!("训练集导入任务异常：{error}"))?
}

#[tauri::command]
fn desktop_list_training_datasets(
    state: State<'_, DesktopState>,
) -> Result<Vec<DesktopTrainingDatasetView>, String> {
    state.list_training_datasets()
}

/** 更新训练集触发词，后续训练任务读取新值，既有任务快照保持不变。 */
#[tauri::command]
fn desktop_update_training_trigger_words(
    state: State<'_, DesktopState>,
    input: DesktopTrainingTriggerWordsUpdateInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.update_training_trigger_words(input)
}

#[tauri::command]
async fn desktop_add_training_images(
    state: State<'_, DesktopState>,
    input: DesktopTrainingImagesAddInput,
) -> Result<DesktopTrainingDatasetView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut database = rusqlite::Connection::open(database_path)
            .map_err(|error| format!("打开训练集数据库失败：{error}"))?;
        database
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .map_err(|error| format!("初始化训练集数据库连接失败：{error}"))?;
        training_dataset::add_images(&mut database, &app_data_dir, input)
    })
    .await
    .map_err(|error| format!("训练图片导入任务异常：{error}"))?
}

#[tauri::command]
fn desktop_update_training_caption(
    state: State<'_, DesktopState>,
    input: DesktopTrainingCaptionUpdateInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.update_training_caption(input)
}

/** 批量标签操作只跨越 WebView 一次，并由核心统一保证文件和 SQLite 回滚。 */
#[tauri::command]
fn desktop_batch_update_training_tags(
    state: State<'_, DesktopState>,
    input: DesktopTrainingBatchTagsInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.batch_update_training_tags(input)
}

/** 删除单张训练图片及未运行的打标关联，不触碰已提交训练任务快照。 */
#[tauri::command]
async fn desktop_delete_training_asset(
    state: State<'_, DesktopState>,
    input: DesktopTrainingAssetDeleteInput,
) -> Result<DesktopTrainingDatasetView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let database = rusqlite::Connection::open(database_path)
            .map_err(|error| format!("打开训练集数据库失败：{error}"))?;
        database
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .map_err(|error| format!("初始化训练集数据库连接失败：{error}"))?;
        training_dataset::delete_asset(&database, &app_data_dir, input)
    })
    .await
    .map_err(|error| format!("删除训练图片任务异常：{error}"))?
}

/** 设备会话在 Rust 核心内调用真实标签翻译接口，密钥不会返回页面。 */
#[tauri::command]
async fn desktop_translate_training_tags(
    input: DesktopTrainingTagTranslationInput,
) -> Result<DesktopTrainingTagTranslationView, String> {
    tauri::async_runtime::spawn_blocking(move || website_tag_translation::translate(input))
        .await
        .map_err(|error| format!("标签翻译任务异常：{error}"))?
}

/** 持久化创建批量或单图离线打标任务并立即返回。 */
#[tauri::command]
fn desktop_create_caption_job(
    state: State<'_, DesktopState>,
    input: DesktopCaptionJobCreateInput,
) -> Result<DesktopCaptionJobView, String> {
    state.create_caption_job(input)
}

/** 返回最近的本地离线打标任务。 */
#[tauri::command]
fn desktop_list_caption_jobs(
    state: State<'_, DesktopState>,
) -> Result<Vec<DesktopCaptionJobView>, String> {
    state.list_caption_jobs()
}

/** 暂停本地离线打标任务。 */
#[tauri::command]
fn desktop_pause_caption_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopCaptionJobView, String> {
    state.pause_caption_job(&id)
}

/** 恢复本地离线打标任务。 */
#[tauri::command]
fn desktop_resume_caption_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopCaptionJobView, String> {
    state.resume_caption_job(&id)
}

/** 幂等取消排队或运行中的本地离线打标任务。 */
#[tauri::command]
fn desktop_cancel_caption_job(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<DesktopCaptionJobView, String> {
    state.cancel_caption_job(&id)
}

/** 创建单图或批量自动抠图任务。 */
#[tauri::command]
fn desktop_create_background_removal_job(
    state: State<'_, DesktopState>,
    input: DesktopBackgroundRemovalJobCreateInput,
) -> Result<DesktopBackgroundRemovalJobView, String> {
    state.create_background_removal_job(input)
}

/** 返回最近的自动抠图任务。 */
#[tauri::command]
fn desktop_list_background_removal_jobs(
    state: State<'_, DesktopState>,
) -> Result<Vec<DesktopBackgroundRemovalJobView>, String> {
    state.list_background_removal_jobs()
}

/** 暂停自动抠图任务。 */
#[tauri::command]
fn desktop_pause_background_removal_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopBackgroundRemovalJobView, String> {
    state.pause_background_removal_job(&id)
}

/** 恢复自动抠图任务。 */
#[tauri::command]
fn desktop_resume_background_removal_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopBackgroundRemovalJobView, String> {
    state.resume_background_removal_job(&id)
}

/** 取消自动抠图任务。 */
#[tauri::command]
fn desktop_cancel_background_removal_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopBackgroundRemovalJobView, String> {
    state.cancel_background_removal_job(&id)
}

/** 保存手动编辑的 PNG alpha 蒙版并生成透明派生文件。 */
#[tauri::command]
fn desktop_save_training_manual_mask(
    state: State<'_, DesktopState>,
    input: DesktopTrainingManualMaskInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.save_training_manual_mask(input)
}

/** 选择后续训练快照使用的原图或派生版本。 */
#[tauri::command]
fn desktop_select_training_asset_variant(
    state: State<'_, DesktopState>,
    input: DesktopTrainingAssetVariantSelectInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.select_training_asset_variant(input)
}

/** 创建持久化 AI 标签清洗批次，只生成建议而不直接改写训练集。 */
#[tauri::command]
fn desktop_create_ai_clean_job(
    state: State<'_, DesktopState>,
    input: DesktopAiCleanJobCreateInput,
) -> Result<DesktopAiCleanJobView, String> {
    state.create_ai_clean_job(input)
}

/** 返回最近的 AI 标签清洗批次和逐图建议。 */
#[tauri::command]
fn desktop_list_ai_clean_jobs(
    state: State<'_, DesktopState>,
) -> Result<Vec<DesktopAiCleanJobView>, String> {
    state.list_ai_clean_jobs()
}

/** 暂停 AI 标签清洗批次。 */
#[tauri::command]
fn desktop_pause_ai_clean_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopAiCleanJobView, String> {
    state.pause_ai_clean_job(&id)
}

/** 恢复 AI 标签清洗批次。 */
#[tauri::command]
fn desktop_resume_ai_clean_job(state: State<'_, DesktopState>, id: String) -> Result<DesktopAiCleanJobView, String> {
    state.resume_ai_clean_job(&id)
}

/** 幂等取消排队或运行中的 AI 标签清洗批次。 */
#[tauri::command]
fn desktop_cancel_ai_clean_job(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<DesktopAiCleanJobView, String> {
    state.cancel_ai_clean_job(&id)
}

/** 原子应用用户接受的 AI 删除和新增建议。 */
#[tauri::command]
fn desktop_apply_ai_clean(
    state: State<'_, DesktopState>,
    input: DesktopAiCleanApplyInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.apply_ai_clean(input)
}

/** 撤销未被后续人工编辑覆盖的 AI 清洗。 */
#[tauri::command]
fn desktop_undo_ai_clean(
    state: State<'_, DesktopState>,
    input: DesktopAiCleanUndoInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.undo_ai_clean(input)
}

/** 创建本地 LoRA 训练任务并立即返回持久化排队记录。 */
#[tauri::command]
fn desktop_create_training_job(
    state: State<'_, DesktopState>,
    input: DesktopTrainingJobCreateInput,
) -> Result<DesktopTrainingJobView, String> {
    state.create_training_job(input)
}

/** 返回最近的本地 LoRA 训练任务。 */
#[tauri::command]
fn desktop_list_training_jobs(
    state: State<'_, DesktopState>,
) -> Result<Vec<DesktopTrainingJobView>, String> {
    state.list_training_jobs()
}

/** 返回训练任务创建时冻结的图片、标签来源和完整参数。 */
#[tauri::command]
fn desktop_get_training_snapshot(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<DesktopTrainingSnapshotView, String> {
    state.get_training_snapshot(&id)
}

/** 从只读训练快照创建新的可编辑训练集，原训练集和历史任务保持不变。 */
#[tauri::command]
fn desktop_copy_training_snapshot(
    state: State<'_, DesktopState>,
    input: DesktopTrainingSnapshotCopyInput,
) -> Result<DesktopTrainingDatasetView, String> {
    state.copy_training_snapshot(input)
}

/** 幂等取消排队或运行中的本地 LoRA 训练任务。 */
#[tauri::command]
fn desktop_cancel_training_job(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<DesktopTrainingJobView, String> {
    state.cancel_training_job(&id)
}

#[tauri::command]
async fn desktop_confirm_training_dataset(
    state: State<'_, DesktopState>,
    input: DesktopTrainingDatasetIdInput,
) -> Result<DesktopTrainingDatasetView, String> {
    let database_path = state.database_path.clone();
    let app_data_dir = state.app_data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let database = rusqlite::Connection::open(database_path)
            .map_err(|error| format!("打开训练集数据库失败：{error}"))?;
        database
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
            .map_err(|error| format!("初始化训练集数据库连接失败：{error}"))?;
        training_dataset::confirm_dataset(&database, &app_data_dir, &input.dataset_id)
    })
    .await
    .map_err(|error| format!("训练集确认任务异常：{error}"))?
}

#[tauri::command]
fn desktop_create_local_job(
    state: State<'_, DesktopState>,
    input: DesktopLocalJobCreateInput,
) -> Result<DesktopLocalJobView, String> {
    state.create_local_job(input)
}

#[tauri::command]
fn desktop_list_local_jobs(
    state: State<'_, DesktopState>,
) -> Result<Vec<DesktopLocalJobView>, String> {
    state.list_local_jobs()
}

/** 独立预览只读取最新任务，避免为不可见历史记录执行关联查询。 */
#[tauri::command]
fn desktop_latest_local_job(
    state: State<'_, DesktopState>,
) -> Result<Option<DesktopLocalJobView>, String> {
    state.latest_local_job()
}

/** 独立预览只读取设置，不触发主窗口的硬件、Runtime 和网络检测。 */
#[tauri::command]
fn desktop_load_preview_settings(
    state: State<'_, DesktopState>,
) -> Result<DesktopSettings, String> {
    state.load_settings()
}

#[tauri::command]
fn desktop_cancel_local_job(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<DesktopLocalJobView, String> {
    state.cancel_local_job(&id)
}

/** 按实际原生窗口状态创建或关闭生成预览，主页面不维护可能失真的窗口副本状态。 */
#[tauri::command]
async fn desktop_toggle_generation_preview(app: tauri::AppHandle) -> Result<bool, String> {
    const LABEL: &str = "generation-preview";
    if let Some(window) = app.get_webview_window(LABEL) {
        // 使用正常关闭请求释放 WebView2；强制 destroy 在共用浏览器环境时可能阻塞主线程。
        GENERATION_PREVIEW_READY.store(false, Ordering::Release);
        window
            .close()
            .map_err(|error| format!("关闭生成预览窗口失败：{error}"))?;
        return Ok(false);
    }
    GENERATION_PREVIEW_READY.store(false, Ordering::Release);
    let data_root = installed_data_root().map(Ok).unwrap_or_else(|| {
        app.path()
            .app_data_dir()
            .map_err(|error| format!("读取预览窗口数据目录失败：{error}"))
    })?;
    let window =
        tauri::WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .title("DrawHime 生成预览")
            // 先沿用原有 720 高度创建隐藏窗口，随后按真实标题栏和边框补足外框宽度。
            .inner_size(720.0, 720.0)
            .min_inner_size(320.0, 420.0)
            .resizable(true)
            .minimizable(true)
            .maximizable(true)
            // 先在隐藏 WebView 中应用主题和最新任务，避免默认深色闪烁及首帧交互卡顿。
            .visible(false)
            .always_on_top(false)
            // 动态 WebView 使用独立环境目录，避免与主窗口环境选项冲突后永久停留在 about:blank。
            .data_directory(data_root.join("webview-preview"))
            .center()
            .build()
            .map_err(|error| format!("创建生成预览窗口失败：{error}"))?;
    let inner_size = window
        .inner_size()
        .map_err(|error| format!("读取生成预览内容区尺寸失败：{error}"))?;
    let outer_size = window
        .outer_size()
        .map_err(|error| format!("读取生成预览外框尺寸失败：{error}"))?;
    // 原生标题栏会让 1:1 内容区呈现为竖长外框；保持当前外框高度并补宽，确保用户看到的初始窗口严格为正方形。
    let horizontal_frame = outer_size.width.saturating_sub(inner_size.width);
    let vertical_frame = outer_size.height.saturating_sub(inner_size.height);
    let target_outer_side = outer_size.height;
    window
        .set_size(PhysicalSize::new(
            target_outer_side.saturating_sub(horizontal_frame),
            target_outer_side.saturating_sub(vertical_frame),
        ))
        .map_err(|error| format!("设置生成预览初始尺寸失败：{error}"))?;
    window
        .center()
        .map_err(|error| format!("居中生成预览窗口失败：{error}"))?;
    window.on_window_event(|event| {
        if matches!(event, WindowEvent::Destroyed) {
            GENERATION_PREVIEW_READY.store(false, Ordering::Release);
        }
    });
    Ok(true)
}

/** 预览 React 根组件挂载后登记就绪，主窗口不能替空白 WebView 伪造成功状态。 */
#[tauri::command]
async fn desktop_mark_generation_preview_ready(
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    if window.label() != "generation-preview" {
        return Err("只有生成预览窗口可以登记就绪状态".to_string());
    }
    window
        .show()
        .map_err(|error| format!("显示生成预览窗口失败：{error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("聚焦生成预览窗口失败：{error}"))?;
    GENERATION_PREVIEW_READY.store(true, Ordering::Release);
    Ok(true)
}

/** 只有预览窗口已登记且 React 根组件已挂载时才报告打开，避免把空白 WebView 误判为成功。 */
#[tauri::command]
fn desktop_generation_preview_open(app: tauri::AppHandle) -> bool {
    app.get_webview_window("generation-preview").is_some()
        && GENERATION_PREVIEW_READY.load(Ordering::Acquire)
}

/** 预览窗口可在普通 Windows 层级与置顶层级间切换，不强制遮挡主窗口。 */
#[tauri::command]
async fn desktop_set_generation_preview_always_on_top(
    app: tauri::AppHandle,
    always_on_top: bool,
) -> Result<bool, String> {
    let window = app
        .get_webview_window("generation-preview")
        .ok_or_else(|| "生成预览窗口尚未打开".to_string())?;
    window
        .set_always_on_top(always_on_top)
        .map_err(|error| format!("切换预览窗口层级失败：{error}"))?;
    Ok(always_on_top)
}

/** 检测后保存脱敏 JSON 快照，页面与诊断记录始终使用同一结论。 */
fn inspect_and_store(
    state: &DesktopState,
    settings: &DesktopSettings,
) -> Result<DesktopEnvironmentReport, String> {
    let report = environment::inspect_environment(settings);
    let json =
        serde_json::to_string(&report).map_err(|error| format!("序列化环境报告失败：{error}"))?;
    state.save_environment_snapshot(&json, &report.checked_at)?;
    Ok(report)
}

/** 已安装程序以卸载器为边界识别用户选择的安装目录，开发构建继续使用系统应用数据目录。 */
fn installed_data_root() -> Option<PathBuf> {
    let executable = env::current_exe().ok()?;
    let install_root = executable.parent()?;
    install_root
        .join("uninstall.exe")
        .is_file()
        .then(|| install_root.join("data"))
}

/** 仅向 WebView 开放作品、训练图片和仓库媒体目录，不暴露 SQLite、模型权重或资源缓存。 */
fn allow_preview_directories(
    app: &tauri::AppHandle,
    app_data_dir: &std::path::Path,
    settings: &DesktopSettings,
) -> Result<(), String> {
    for directory in [
        PathBuf::from(&settings.output_root),
        app_data_dir.join("datasets"),
        app_data_dir.join("catalog-covers"),
    ] {
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("创建本机预览目录失败：{error}"))?;
        app.asset_protocol_scope()
            .allow_directory(directory, true)
            .map_err(|error| format!("授权本机预览目录失败：{error}"))?;
    }
    Ok(())
}

/** 启动桌面窗口并在 setup 阶段建立真实本地数据库。 */
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = installed_data_root().map(Ok).unwrap_or_else(|| {
                app.path()
                    .app_data_dir()
                    .map_err(|error| format!("读取应用数据目录失败：{error}"))
            })?;
            let mut state = DesktopState::initialize(&app_data)?;
            let settings = state.load_settings()?;
            allow_preview_directories(app.handle(), &app_data, &settings)?;
            state.start_scheduler(app.handle().clone())?;
            app.manage(state);
            // WebView 必须手动指定绝对数据目录，否则 WebView2 会在 LocalAppData 生成第二份缓存。
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .ok_or_else(|| "缺少桌面窗口配置".to_string())?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)
                .map_err(|error| format!("读取桌面窗口配置失败：{error}"))?
                .data_directory(app_data.join("webview"))
                .build()
                .map_err(|error| format!("创建桌面窗口失败：{error}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_account_status,
            desktop_start_authorization,
            desktop_poll_authorization,
            desktop_sign_out,
            desktop_bootstrap,
            desktop_inspect_environment,
            desktop_save_settings,
            desktop_load_ai_settings,
            desktop_save_ai_settings,
            desktop_test_ai_settings,
            desktop_ai_analyze_image,
            desktop_enqueue_gallery_publication,
            desktop_list_gallery_sync_queue,
            desktop_load_resource_catalog,
            desktop_download_resource,
            desktop_pause_resource_download,
            desktop_install_resource,
            desktop_runtime_status,
            desktop_start_runtime,
            desktop_stop_runtime,
            desktop_self_test_runtime,
            desktop_import_local_model,
            desktop_list_local_models,
            desktop_delete_local_model_file,
            desktop_import_local_lora,
            desktop_list_local_loras,
            desktop_delete_local_lora_file,
            desktop_storage_cleanup,
            desktop_load_website_models,
            desktop_install_website_model,
            desktop_load_website_loras,
            desktop_install_website_lora,
            desktop_software_update_status,
            desktop_download_software_update,
            desktop_import_offline_update,
            desktop_apply_software_update,
            desktop_rollback_software_update,
            desktop_create_training_dataset,
            desktop_delete_training_dataset,
            desktop_preview_training_dataset_import,
            desktop_import_training_dataset,
            desktop_list_training_datasets,
            desktop_update_training_trigger_words,
            desktop_add_training_images,
            desktop_update_training_caption,
            desktop_batch_update_training_tags,
            desktop_delete_training_asset,
            desktop_translate_training_tags,
            desktop_create_caption_job,
            desktop_list_caption_jobs,
            desktop_pause_caption_job,
            desktop_resume_caption_job,
            desktop_cancel_caption_job,
            desktop_create_background_removal_job,
            desktop_list_background_removal_jobs,
            desktop_pause_background_removal_job,
            desktop_resume_background_removal_job,
            desktop_cancel_background_removal_job,
            desktop_save_training_manual_mask,
            desktop_select_training_asset_variant,
            desktop_create_ai_clean_job,
            desktop_list_ai_clean_jobs,
            desktop_pause_ai_clean_job,
            desktop_resume_ai_clean_job,
            desktop_cancel_ai_clean_job,
            desktop_apply_ai_clean,
            desktop_undo_ai_clean,
            desktop_confirm_training_dataset,
            desktop_create_training_job,
            desktop_list_training_jobs,
            desktop_get_training_snapshot,
            desktop_copy_training_snapshot,
            desktop_cancel_training_job,
            desktop_create_local_job,
            desktop_list_local_jobs,
            desktop_latest_local_job,
            desktop_load_preview_settings,
            desktop_cancel_local_job,
            desktop_toggle_generation_preview,
            desktop_mark_generation_preview_ready,
            desktop_generation_preview_open,
            desktop_set_generation_preview_always_on_top
        ])
        .run(tauri::generate_context!())
        .expect("DrawHime Desktop 启动失败");
}
