/** 本文件封装 WebView 到 Tauri 本地核心的受类型约束命令。 */
import type { DesktopAccountView, DesktopAiCleanApplyInput, DesktopAiCleanJobCreateInput, DesktopAiCleanJobView, DesktopAiCleanUndoInput, DesktopAuthorizationRequestView, DesktopAuthorizationStartRequest, DesktopBackgroundRemovalJobCreateInput, DesktopBackgroundRemovalJobView, DesktopBootstrapView, DesktopCaptionJobCreateInput, DesktopCaptionJobView, DesktopEnvironmentReport, DesktopGalleryPrivacy, DesktopGallerySyncItem, DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalLoraImportInput, DesktopLocalLoraView, DesktopLocalModelImportInput, DesktopLocalModelView, DesktopManagedFileDeleteInput, DesktopManagedFileRemovalView, DesktopOfflineUpdateImportInput, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopRuntimeStatusView, DesktopSettings, DesktopSettingsUpdate, DesktopSoftwareUpdateView, DesktopStorageCleanupInput, DesktopStorageCleanupView, DesktopTrainingAssetDeleteInput, DesktopTrainingAssetVariantSelectInput, DesktopTrainingBatchTagsInput, DesktopTrainingCaptionUpdateInput, DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetIdInput, DesktopTrainingDatasetImportInput, DesktopTrainingDatasetImportPreview, DesktopTrainingDatasetImportPreviewInput, DesktopTrainingDatasetView, DesktopTrainingImagesAddInput, DesktopTrainingJobCreateInput, DesktopTrainingJobView, DesktopTrainingManualMaskInput, DesktopTrainingSnapshotCopyInput, DesktopTrainingSnapshotView, DesktopTrainingTagTranslationInput, DesktopTrainingTriggerWordsUpdateInput, DesktopWebsiteLoraInstallProgress, DesktopWebsiteLoraView, DesktopWebsiteModelInstallProgress, DesktopWebsiteModelView, TrainingTagTranslationView } from "@drawhime/contracts";
import type { DesktopAiAnalyzeInput, DesktopAiAnalyzeView, DesktopAiSettings, DesktopAiSettingsUpdate } from "@drawhime/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 设备授权轮询完成时同时返回脱敏账号视图。 */
export interface DesktopAuthorizationPollOutcome { poll: { status: "pending" | "authorized"; intervalSeconds: number }; account: DesktopAccountView | null }

/** 在线校验 Windows Credential Manager 中的桌面账号。 */
export function loadDesktopAccountStatus(): Promise<DesktopAccountView> { return invoke("desktop_account_status"); }
/** 创建浏览器设备授权请求。 */
export function startDesktopAuthorization(input: DesktopAuthorizationStartRequest): Promise<DesktopAuthorizationRequestView> { return invoke("desktop_start_authorization", { input }); }
/** 按服务端间隔轮询设备授权，成功后凭据由 Rust 核心保存。 */
export function pollDesktopAuthorization(deviceCode: string): Promise<DesktopAuthorizationPollOutcome> { return invoke("desktop_poll_authorization", { input: { deviceCode } }); }
/** 撤销并删除当前桌面账号凭据。 */
export function signOutDesktopAccount(): Promise<DesktopAccountView> { return invoke("desktop_sign_out"); }

/** 加载本机设置、环境报告和图库待同步数量。 */
export function loadDesktopBootstrap(): Promise<DesktopBootstrapView> { return invoke("desktop_bootstrap"); }
/** 主动重新检测本机环境。 */
export function inspectDesktopEnvironment(): Promise<DesktopEnvironmentReport> { return invoke("desktop_inspect_environment"); }
/** 校验并保存桌面端设置。 */
export function saveDesktopSettings(settings: DesktopSettingsUpdate): Promise<DesktopSettings> { return invoke("desktop_save_settings", { settings }); }
/** 读取不含密钥正文的 AI 辅助设置。 */
export function loadDesktopAiSettings(): Promise<DesktopAiSettings> { return invoke("desktop_load_ai_settings"); }
/** 保存 AI 端点元数据并通过 Rust 核心安全处理 API Key。 */
export function saveDesktopAiSettings(input: DesktopAiSettingsUpdate): Promise<DesktopAiSettings> { return invoke("desktop_save_ai_settings", { input }); }
/** 使用已保存配置执行真实连通性测试。 */
export function testDesktopAiSettings(): Promise<string> { return invoke("desktop_test_ai_settings"); }
/** 使用固定用途对本机图片执行真实 AI 打标或反推。 */
export function analyzeDesktopImage(input: DesktopAiAnalyzeInput): Promise<DesktopAiAnalyzeView> { return invoke("desktop_ai_analyze_image", { input }); }
/** 读取本机持久化图库同步队列。 */
export function listDesktopGallerySyncQueue(): Promise<DesktopGallerySyncItem[]> { return invoke("desktop_list_gallery_sync_queue"); }
/** 监听图库 Worker 已持久化的断点与终态变化。 */
export function listenDesktopGallerySyncUpdates(handler: (item: DesktopGallerySyncItem) => void): Promise<UnlistenFn> { return listen<DesktopGallerySyncItem>("desktop-gallery-sync-updated", (event) => handler(event.payload)); }
/** 把已校验的本地结果加入幂等图库同步队列。 */
export function enqueueDesktopGalleryPublication(input: { localTaskId: string; artifactPath: string; privacy: DesktopGalleryPrivacy }): Promise<DesktopGallerySyncItem> { return invoke("desktop_enqueue_gallery_publication", { input }); }
/** 拉取并验签桌面端资源目录；发布通道未配置时返回明确状态。 */
export function loadDesktopResourceCatalog(): Promise<DesktopResourceCatalogView> { return invoke("desktop_load_resource_catalog"); }
/** 执行真实的断点下载、切源和整体哈希校验。 */
export function downloadDesktopResource(resourceId: string): Promise<DesktopResourceDownloadView> { return invoke("desktop_download_resource", { resourceId }); }
/** 暂停当前资源并保留断点。 */
export function pauseDesktopResourceDownload(resourceId: string): Promise<void> { return invoke("desktop_pause_resource_download", { resourceId }); }
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
/** 删除底模受管主文件并保留历史任务登记。 */
export function deleteDesktopLocalModelFile(input: DesktopManagedFileDeleteInput): Promise<DesktopManagedFileRemovalView> { return invoke("desktop_delete_local_model_file", { input }); }
/** 导入并登记本机已有 safetensors LoRA。 */
export function importDesktopLocalLora(input: DesktopLocalLoraImportInput): Promise<DesktopLocalLoraView> { return invoke("desktop_import_local_lora", { input }); }
/** 读取当前设备已登记 LoRA。 */
export function listDesktopLocalLoras(): Promise<DesktopLocalLoraView[]> { return invoke("desktop_list_local_loras"); }
/** 删除 LoRA 受管文件并保留历史任务登记。 */
export function deleteDesktopLocalLoraFile(input: DesktopManagedFileDeleteInput): Promise<DesktopManagedFileRemovalView> { return invoke("desktop_delete_local_lora_file", { input }); }
/** 预览或确认执行无引用受管文件清理。 */
export function cleanupDesktopStorage(input: DesktopStorageCleanupInput): Promise<DesktopStorageCleanupView> { return invoke("desktop_storage_cleanup", { input }); }
/** 读取当前账号可访问的网站 LoRA 目录。 */
export function loadDesktopWebsiteLoras(forceRefresh = false): Promise<DesktopWebsiteLoraView[]> { return invoke("desktop_load_website_loras", { forceRefresh }); }

/** 读取主站底模仓库和已缓存封面，不把设备会话暴露给页面。 */
export function loadDesktopWebsiteModels(forceRefresh = false): Promise<DesktopWebsiteModelView[]> { return invoke("desktop_load_website_models", { forceRefresh }); }
/** 从主站断点下载并安装一个在线底模。 */
export function installDesktopWebsiteModel(modelId: string): Promise<DesktopLocalModelView> { return invoke("desktop_install_website_model", { modelId }); }
/** 监听网站底模下载、校验和安装进度。 */
export function listenDesktopWebsiteModelProgress(handler: (progress: DesktopWebsiteModelInstallProgress) => void): Promise<UnlistenFn> { return listen<DesktopWebsiteModelInstallProgress>("desktop-website-model-progress", (event) => handler(event.payload)); }
/** 断点下载、校验并安装一个网站 LoRA。 */
export function installDesktopWebsiteLora(loraId: string): Promise<DesktopLocalLoraView> { return invoke("desktop_install_website_lora", { loraId }); }
/** 监听网站 LoRA 下载、校验和安装进度。 */
export function listenDesktopWebsiteLoraProgress(handler: (progress: DesktopWebsiteLoraInstallProgress) => void): Promise<UnlistenFn> { return listen<DesktopWebsiteLoraInstallProgress>("desktop-website-lora-progress", (event) => handler(event.payload)); }
/** 检查签名稳定通道和可信回滚缓存。 */
export function loadDesktopSoftwareUpdateStatus(): Promise<DesktopSoftwareUpdateView> { return invoke("desktop_software_update_status"); }
/** 断点下载最新签名 NSIS 更新包。 */
export function downloadDesktopSoftwareUpdate(): Promise<DesktopSoftwareUpdateView> { return invoke("desktop_download_software_update"); }
/** 导入离线安装包和 Ed25519 信封。 */
export function importDesktopOfflineUpdate(input: DesktopOfflineUpdateImportInput): Promise<DesktopSoftwareUpdateView> { return invoke("desktop_import_offline_update", { input }); }
/** 应用已验证更新并退出当前程序。 */
export function applyDesktopSoftwareUpdate(): Promise<DesktopSoftwareUpdateView> { return invoke("desktop_apply_software_update"); }
/** 使用可信缓存回滚到上一版本。 */
export function rollbackDesktopSoftwareUpdate(): Promise<DesktopSoftwareUpdateView> { return invoke("desktop_rollback_software_update"); }
/** 创建本地持久训练集。 */
export function createDesktopTrainingDataset(input: DesktopTrainingDatasetCreateInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_create_training_dataset", { input }); }
/** 删除可编辑训练集目录；独立训练快照和历史训练记录保持不变。 */
export function deleteDesktopTrainingDataset(input: DesktopTrainingDatasetIdInput): Promise<string> { return invoke("desktop_delete_training_dataset", { input }); }
/** 安全预检训练集文件夹或压缩包，不创建数据库记录。 */
export function previewDesktopTrainingDatasetImport(input: DesktopTrainingDatasetImportPreviewInput): Promise<DesktopTrainingDatasetImportPreview> { return invoke("desktop_preview_training_dataset_import", { input }); }
/** 用户确认后按预检快照原子创建训练集。 */
export function importDesktopTrainingDataset(input: DesktopTrainingDatasetImportInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_import_training_dataset", { input }); }
/** 读取全部本地训练集与图片 Caption。 */
export function listDesktopTrainingDatasets(): Promise<DesktopTrainingDatasetView[]> { return invoke("desktop_list_training_datasets"); }
/** 更新训练集触发词并返回最新持久化视图。 */
export function updateDesktopTrainingTriggerWords(input: DesktopTrainingTriggerWordsUpdateInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_update_training_trigger_words", { input }); }
/** 使用原生选择结果批量导入训练图片。 */
export function addDesktopTrainingImages(input: DesktopTrainingImagesAddInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_add_training_images", { input }); }
/** 保存单张训练图片 Caption。 */
export function updateDesktopTrainingCaption(input: DesktopTrainingCaptionUpdateInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_update_training_caption", { input }); }
/** 在一次核心事务中批量添加或删除训练标签。 */
export function batchUpdateDesktopTrainingTags(input: DesktopTrainingBatchTagsInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_batch_update_training_tags", { input }); }
/** 删除没有活动打标、清洗或抠图任务的单张原训练图片。 */
export function deleteDesktopTrainingAsset(input: DesktopTrainingAssetDeleteInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_delete_training_asset", { input }); }
/** 使用设备会话批量读取训练标签的中文翻译和颜色。 */
export function translateDesktopTrainingTags(input: DesktopTrainingTagTranslationInput): Promise<TrainingTagTranslationView> { return invoke("desktop_translate_training_tags", { input }); }
/** 创建批量或单图离线自动打标任务。 */
export function createDesktopCaptionJob(input: DesktopCaptionJobCreateInput): Promise<DesktopCaptionJobView> { return invoke("desktop_create_caption_job", { input }); }
/** 读取最近的持久化离线自动打标任务。 */
export function listDesktopCaptionJobs(): Promise<DesktopCaptionJobView[]> { return invoke("desktop_list_caption_jobs"); }
/** 取消排队或运行中的离线自动打标任务。 */
export function cancelDesktopCaptionJob(id: string): Promise<DesktopCaptionJobView> { return invoke("desktop_cancel_caption_job", { id }); }
/** 暂停持久化自动打标任务。 */
export function pauseDesktopCaptionJob(id: string): Promise<DesktopCaptionJobView> { return invoke("desktop_pause_caption_job", { id }); }
/** 恢复持久化自动打标任务。 */
export function resumeDesktopCaptionJob(id: string): Promise<DesktopCaptionJobView> { return invoke("desktop_resume_caption_job", { id }); }
/** 监听 SQLite 已持久化的离线自动打标状态。 */
export function listenDesktopCaptionJobUpdates(handler: (job: DesktopCaptionJobView) => void): Promise<UnlistenFn> { return listen<DesktopCaptionJobView>("desktop-caption-job-updated", (event) => handler(event.payload)); }
/** 创建单图或批量自动抠图任务。 */
export function createDesktopBackgroundRemovalJob(input: DesktopBackgroundRemovalJobCreateInput): Promise<DesktopBackgroundRemovalJobView> { return invoke("desktop_create_background_removal_job", { input }); }
/** 返回最近的自动抠图任务。 */
export function listDesktopBackgroundRemovalJobs(): Promise<DesktopBackgroundRemovalJobView[]> { return invoke("desktop_list_background_removal_jobs"); }
/** 暂停自动抠图任务。 */
export function pauseDesktopBackgroundRemovalJob(id: string): Promise<DesktopBackgroundRemovalJobView> { return invoke("desktop_pause_background_removal_job", { id }); }
/** 恢复自动抠图任务。 */
export function resumeDesktopBackgroundRemovalJob(id: string): Promise<DesktopBackgroundRemovalJobView> { return invoke("desktop_resume_background_removal_job", { id }); }
/** 取消自动抠图任务。 */
export function cancelDesktopBackgroundRemovalJob(id: string): Promise<DesktopBackgroundRemovalJobView> { return invoke("desktop_cancel_background_removal_job", { id }); }
/** 保存手动 PNG alpha 蒙版。 */
export function saveDesktopTrainingManualMask(input: DesktopTrainingManualMaskInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_save_training_manual_mask", { input }); }
/** 选择后续训练使用的原图或派生版本。 */
export function selectDesktopTrainingAssetVariant(input: DesktopTrainingAssetVariantSelectInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_select_training_asset_variant", { input }); }
/** 监听抠图任务持久化状态。 */
export function listenDesktopBackgroundRemovalJobUpdates(handler: (job: DesktopBackgroundRemovalJobView) => void): Promise<UnlistenFn> { return listen<DesktopBackgroundRemovalJobView>("desktop-background-removal-job-updated", (event) => handler(event.payload)); }
/** 创建只生成建议的单图或批量 AI 标签清洗任务。 */
export function createDesktopAiCleanJob(input: DesktopAiCleanJobCreateInput): Promise<DesktopAiCleanJobView> { return invoke("desktop_create_ai_clean_job", { input }); }
/** 返回最近的持久化 AI 标签清洗任务。 */
export function listDesktopAiCleanJobs(): Promise<DesktopAiCleanJobView[]> { return invoke("desktop_list_ai_clean_jobs"); }
/** 幂等取消排队或运行中的 AI 标签清洗任务。 */
export function cancelDesktopAiCleanJob(id: string): Promise<DesktopAiCleanJobView> { return invoke("desktop_cancel_ai_clean_job", { id }); }
/** 暂停持久化 AI 标签清洗任务。 */
export function pauseDesktopAiCleanJob(id: string): Promise<DesktopAiCleanJobView> { return invoke("desktop_pause_ai_clean_job", { id }); }
/** 恢复持久化 AI 标签清洗任务。 */
export function resumeDesktopAiCleanJob(id: string): Promise<DesktopAiCleanJobView> { return invoke("desktop_resume_ai_clean_job", { id }); }
/** 原子应用用户接受的 AI 标签删除与新增建议。 */
export function applyDesktopAiClean(input: DesktopAiCleanApplyInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_apply_ai_clean", { input }); }
/** 撤销未被后续编辑覆盖的 AI 标签清洗。 */
export function undoDesktopAiClean(input: DesktopAiCleanUndoInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_undo_ai_clean", { input }); }
/** 监听 SQLite 已持久化的 AI 标签清洗状态。 */
export function listenDesktopAiCleanJobUpdates(handler: (job: DesktopAiCleanJobView) => void): Promise<UnlistenFn> { return listen<DesktopAiCleanJobView>("desktop-ai-clean-job-updated", (event) => handler(event.payload)); }
/** 创建本地 LoRA 训练任务并立即返回排队记录。 */
export function createDesktopTrainingJob(input: DesktopTrainingJobCreateInput): Promise<DesktopTrainingJobView> { return invoke("desktop_create_training_job", { input }); }
/** 读取最近的持久化本地 LoRA 训练任务。 */
export function listDesktopTrainingJobs(): Promise<DesktopTrainingJobView[]> { return invoke("desktop_list_training_jobs"); }
/** 读取任务创建时冻结的完整训练快照。 */
export function getDesktopTrainingSnapshot(id: string): Promise<DesktopTrainingSnapshotView> { return invoke("desktop_get_training_snapshot", { id }); }
/** 从只读训练快照创建新的可编辑训练集。 */
export function copyDesktopTrainingSnapshot(input: DesktopTrainingSnapshotCopyInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_copy_training_snapshot", { input }); }
/** 取消排队或运行中的本地 LoRA 训练任务。 */
export function cancelDesktopTrainingJob(id: string): Promise<DesktopTrainingJobView> { return invoke("desktop_cancel_training_job", { id }); }
/** 监听 SQLite 已持久化的本地 LoRA 训练状态。 */
export function listenDesktopTrainingJobUpdates(handler: (job: DesktopTrainingJobView) => void): Promise<UnlistenFn> { return listen<DesktopTrainingJobView>("desktop-training-job-updated", (event) => handler(event.payload)); }
/** 全量校验后确认训练集。 */
export function confirmDesktopTrainingDataset(input: DesktopTrainingDatasetIdInput): Promise<DesktopTrainingDatasetView> { return invoke("desktop_confirm_training_dataset", { input }); }
/** 持久化创建本地生成任务并立即返回。 */
export function createDesktopLocalJob(input: DesktopLocalJobCreateInput): Promise<DesktopLocalJobView> { return invoke("desktop_create_local_job", { input }); }
/** 读取当前设备最近本地生成任务。 */
export function listDesktopLocalJobs(): Promise<DesktopLocalJobView[]> { return invoke("desktop_list_local_jobs"); }
/** 独立预览只读取最新一条任务，避免加载完整记录页。 */
export function loadDesktopLatestLocalJob(): Promise<DesktopLocalJobView | null> { return invoke("desktop_latest_local_job"); }
/** 独立预览只读取界面设置，不触发硬件与 Runtime 检测。 */
export function loadDesktopPreviewSettings(): Promise<DesktopSettings> { return invoke("desktop_load_preview_settings"); }
/** 取消排队中或运行中的本地任务。 */
export function cancelDesktopLocalJob(id: string): Promise<DesktopLocalJobView> { return invoke("desktop_cancel_local_job", { id }); }
/** 创建或关闭独立原生生成预览窗口，返回切换后的打开状态。 */
export function toggleDesktopGenerationPreview(): Promise<boolean> { return invoke("desktop_toggle_generation_preview"); }
/** 预览根组件完成挂载后向 Rust 核心登记，防止空白 WebView 被误判为可用。 */
export function markDesktopGenerationPreviewReady(): Promise<boolean> { return invoke("desktop_mark_generation_preview_ready"); }
/** 切换生成预览窗口是否始终位于普通窗口之上。 */
export function setDesktopGenerationPreviewAlwaysOnTop(alwaysOnTop: boolean): Promise<boolean> { return invoke("desktop_set_generation_preview_always_on_top", { alwaysOnTop }); }
/** 监听 SQLite 已持久化的任务状态更新。 */
export function listenDesktopLocalJobUpdates(handler: (job: DesktopLocalJobView) => void): Promise<UnlistenFn> { return listen<DesktopLocalJobView>("desktop-local-job-updated", (event) => handler(event.payload)); }
