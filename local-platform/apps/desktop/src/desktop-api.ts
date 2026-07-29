/** 本文件封装 WebView 到 Tauri 本地核心的受类型约束命令。 */
import type { DesktopBootstrapView, DesktopEnvironmentReport, DesktopGalleryPrivacy, DesktopGallerySyncItem, DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalLoraImportInput, DesktopLocalLoraView, DesktopLocalModelImportInput, DesktopLocalModelView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopRuntimeStatusView, DesktopSettings, DesktopSettingsUpdate } from "@drawhime/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 加载本机设置、环境报告和图库待同步数量。 */
export function loadDesktopBootstrap(): Promise<DesktopBootstrapView> { return invoke("desktop_bootstrap"); }
/** 主动重新检测本机环境。 */
export function inspectDesktopEnvironment(): Promise<DesktopEnvironmentReport> { return invoke("desktop_inspect_environment"); }
/** 校验并保存桌面端设置。 */
export function saveDesktopSettings(settings: DesktopSettingsUpdate): Promise<DesktopSettings> { return invoke("desktop_save_settings", { settings }); }
/** 读取本机持久化图库同步队列。 */
export function listDesktopGallerySyncQueue(): Promise<DesktopGallerySyncItem[]> { return invoke("desktop_list_gallery_sync_queue"); }
/** 把已校验的本地结果加入幂等图库同步队列。 */
export function enqueueDesktopGalleryPublication(input: { localTaskId: string; artifactPath: string; privacy: DesktopGalleryPrivacy }): Promise<DesktopGallerySyncItem> { return invoke("desktop_enqueue_gallery_publication", { input }); }
/** 拉取并验签桌面端资源目录；发布通道未配置时返回明确状态。 */
export function loadDesktopResourceCatalog(): Promise<DesktopResourceCatalogView> { return invoke("desktop_load_resource_catalog"); }
/** 执行真实的断点下载、切源和整体哈希校验。 */
export function downloadDesktopResource(resourceId: string): Promise<DesktopResourceDownloadView> { return invoke("desktop_download_resource", { resourceId }); }
/** 监听 Rust 下载线程发出的资源进度。 */
export function listenDesktopResourceProgress(handler: (progress: DesktopResourceDownloadView) => void): Promise<UnlistenFn> { return listen<DesktopResourceDownloadView>("desktop-resource-progress", (event) => handler(event.payload)); }
/** 把已验证资源安全安装到受控目录并保留旧版本回滚副本。 */
export function installDesktopResource(resourceId: string): Promise<DesktopResourceInstallView> { return invoke("desktop_install_resource", { resourceId }); }
/** 监听资源校验、解压、切换和回滚进度。 */
export function listenDesktopResourceInstallProgress(handler: (progress: DesktopResourceInstallView) => void): Promise<UnlistenFn> { return listen<DesktopResourceInstallView>("desktop-resource-install-progress", (event) => handler(event.payload)); }
/** 读取当前 ComfyUI 子进程的真实状态。 */
export function loadDesktopRuntimeStatus(): Promise<DesktopRuntimeStatusView> { return invoke("desktop_runtime_status"); }
/** 启动受控回环 Runtime 并等待健康探测通过。 */
export function startDesktopRuntime(): Promise<DesktopRuntimeStatusView> { return invoke("desktop_start_runtime"); }
/** 幂等停止当前桌面核心创建的 Runtime。 */
export function stopDesktopRuntime(): Promise<DesktopRuntimeStatusView> { return invoke("desktop_stop_runtime"); }
/** 执行 GPU 与核心节点自检并更新 Runtime 就绪状态。 */
export function selfTestDesktopRuntime(): Promise<DesktopRuntimeStatusView> { return invoke("desktop_self_test_runtime"); }
/** 导入并登记本机已有 safetensors 模型。 */
export function importDesktopLocalModel(input: DesktopLocalModelImportInput): Promise<DesktopLocalModelView> { return invoke("desktop_import_local_model", { input }); }
/** 读取当前设备已登记模型。 */
export function listDesktopLocalModels(): Promise<DesktopLocalModelView[]> { return invoke("desktop_list_local_models"); }
/** 导入并登记本机已有 safetensors LoRA。 */
export function importDesktopLocalLora(input: DesktopLocalLoraImportInput): Promise<DesktopLocalLoraView> { return invoke("desktop_import_local_lora", { input }); }
/** 读取当前设备已登记 LoRA。 */
export function listDesktopLocalLoras(): Promise<DesktopLocalLoraView[]> { return invoke("desktop_list_local_loras"); }
/** 持久化创建本地生成任务并立即返回。 */
export function createDesktopLocalJob(input: DesktopLocalJobCreateInput): Promise<DesktopLocalJobView> { return invoke("desktop_create_local_job", { input }); }
/** 读取当前设备最近本地生成任务。 */
export function listDesktopLocalJobs(): Promise<DesktopLocalJobView[]> { return invoke("desktop_list_local_jobs"); }
/** 取消排队中或运行中的本地任务。 */
export function cancelDesktopLocalJob(id: string): Promise<DesktopLocalJobView> { return invoke("desktop_cancel_local_job", { id }); }
/** 监听 SQLite 已持久化的任务状态更新。 */
export function listenDesktopLocalJobUpdates(handler: (job: DesktopLocalJobView) => void): Promise<UnlistenFn> { return listen<DesktopLocalJobView>("desktop-local-job-updated", (event) => handler(event.payload)); }
