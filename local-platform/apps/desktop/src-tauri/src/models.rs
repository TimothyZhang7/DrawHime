//! 本模块定义 WebView、环境检测和 SQLite 之间共享的桌面端序列化模型。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrapView {
    pub environment: DesktopEnvironmentReport,
    pub settings: DesktopSettings,
    pub runtime: DesktopRuntimeStatusView,
    pub pending_gallery_sync_count: u64,
}

/** 桌面核心托管的 ComfyUI 子进程状态。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatusView {
    pub status: String,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub started_at: Option<String>,
    pub checked_at: String,
    pub log_path: Option<String>,
    pub error: Option<String>,
}

/** 已复制到受控目录并持久登记的本地底模。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalModelView {
    pub id: String,
    pub display_name: String,
    pub family: String,
    pub workflow_kind: String,
    pub model_file_name: String,
    pub resource_group_id: Option<String>,
    pub generation_profile: Option<DesktopWebsiteModelParameters>,
    pub model_sha256: String,
    pub byte_size: u64,
    pub text_encoder_file_name: Option<String>,
    pub vae_file_name: Option<String>,
    pub available: bool,
    pub created_at: String,
    pub updated_at: String,
}

/** 从用户已有 safetensors 文件导入本地底模的输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalModelImportInput {
    pub display_name: String,
    pub family: String,
    pub workflow_kind: String,
    pub model_source_path: String,
    pub text_encoder_source_path: Option<String>,
    pub vae_source_path: Option<String>,
}

/** 已登记的本机 LoRA 视图。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalLoraView {
    pub id: String,
    pub title: String,
    pub r#type: String,
    pub file_name: String,
    pub sha256: String,
    pub base_model_sha256: Option<String>,
    pub byte_size: u64,
    pub trigger_words: Vec<String>,
    pub available: bool,
    pub created_at: String,
    pub updated_at: String,
}

/** 从本地文件导入 LoRA 的输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalLoraImportInput {
    pub title: String,
    pub r#type: String,
    pub source_path: String,
    pub trigger_words: Vec<String>,
}

/** 本地任务选择的单个 LoRA 模型与文本编码器独立强度。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalLoraSelectionInput {
    pub id: String,
    pub strength: f64,
    pub clip_strength: f64,
}

/** 本地训练集中的单张真实图片与 Caption 视图。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingAssetView {
    pub id: String,
    pub file_name: String,
    pub path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub available: bool,
    pub caption: Option<String>,
    pub caption_source: Option<String>,
    pub confirmed: bool,
    pub created_at: String,
    pub updated_at: String,
}

/** 本地训练集及当前人工确认阶段。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingDatasetView {
    pub id: String,
    pub title: String,
    pub r#type: String,
    pub trigger_words: Vec<String>,
    pub status: String,
    pub assets: Vec<DesktopTrainingAssetView>,
    pub created_at: String,
    pub updated_at: String,
}

/** 创建本地训练集的输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingDatasetCreateInput {
    pub title: String,
    pub r#type: String,
    pub trigger_words: Vec<String>,
}

/** 修改本地训练集触发词的输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingTriggerWordsUpdateInput {
    pub dataset_id: String,
    pub trigger_words: Vec<String>,
}

/** 向本地训练集批量导入图片的输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingImagesAddInput {
    pub dataset_id: String,
    pub source_paths: Vec<String>,
}

/** 保存单张训练图片 Caption 的输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingCaptionUpdateInput {
    pub dataset_id: String,
    pub asset_id: String,
    pub caption: Option<String>,
}

/** 删除单张本地训练图片的输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingAssetDeleteInput {
    pub dataset_id: String,
    pub asset_id: String,
}

/** 批量读取训练标签中英对照的输入。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingTagTranslationInput {
    pub tags: Vec<String>,
}

/** 单个训练标签的翻译与稳定颜色。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingTagTranslationItem {
    pub tag: String,
    pub translated: String,
    pub color: String,
    pub source: String,
}

/** 桌面训练标签批量翻译结果。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingTagTranslationView {
    pub translations: Vec<DesktopTrainingTagTranslationItem>,
}

/** 仅包含训练集 ID 的幂等命令输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingDatasetIdInput {
    pub dataset_id: String,
}

/** 创建本地离线自动打标任务的参数。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCaptionJobCreateInput {
    pub dataset_id: String,
    pub asset_id: Option<String>,
    pub general_threshold: f64,
    pub character_threshold: f64,
    pub include_character_tags: bool,
}

/** 离线自动打标任务中的逐图执行状态。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCaptionJobItemView {
    pub asset_id: String,
    pub status: String,
    pub caption: Option<String>,
    pub error: Option<String>,
}

/** SQLite 持久化的离线自动打标任务视图。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCaptionJobView {
    pub id: String,
    pub dataset_id: String,
    pub asset_id: Option<String>,
    pub status: String,
    pub progress: u32,
    pub total_assets: u32,
    pub processed_assets: u32,
    pub succeeded_assets: u32,
    pub failed_assets: u32,
    pub skipped_assets: u32,
    pub general_threshold: f64,
    pub character_threshold: f64,
    pub include_character_tags: bool,
    pub error: Option<String>,
    pub items: Vec<DesktopCaptionJobItemView>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
}

/** 桌面端真实 LoRA 训练任务固化的用户参数。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingParameters {
    pub rank: u32,
    pub alpha: u32,
    pub epochs: u32,
    pub repeats: u32,
    pub resolution: u32,
    pub learning_rate: f64,
    pub lr_scheduler: String,
    pub warmup_ratio: f64,
    pub gradient_accumulation_steps: u32,
    pub caption_dropout_rate: f64,
    pub shuffle_caption: bool,
    pub keep_tokens: u32,
    pub seed: u32,
}

/** 创建桌面端真实 LoRA 训练任务的参数。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingJobCreateInput {
    pub dataset_id: String,
    pub model_id: String,
    pub title: String,
    pub parameters: DesktopTrainingParameters,
}

/** 单次桌面训练执行尝试。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingAttemptView {
    pub id: String,
    pub attempt_number: u32,
    pub status: String,
    pub error: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

/** 显存不足后的确定性降档建议。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingSuggestionView {
    pub message: String,
    pub resolution: Option<u32>,
    pub rank: Option<u32>,
}

/** SQLite 为事实源的桌面端 LoRA 训练任务视图。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingJobView {
    pub id: String,
    pub dataset_id: String,
    pub dataset_title: String,
    pub title: String,
    pub r#type: String,
    pub status: String,
    pub progress: u32,
    pub queue_position: u32,
    pub current_epoch: u32,
    pub total_epochs: u32,
    pub model_id: String,
    pub model_display_name: String,
    pub trigger_words: Vec<String>,
    pub asset_count: u32,
    pub parameters: DesktopTrainingParameters,
    pub attempts: Vec<DesktopTrainingAttemptView>,
    pub output_lora_id: Option<String>,
    pub error: Option<String>,
    pub suggestion: Option<DesktopTrainingSuggestionView>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
}

/** 提交到本机串行调度器的生成参数。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalJobCreateInput {
    pub model_id: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub quality_preset: String,
    pub steps: u32,
    pub cfg: f64,
    pub sampler_name: String,
    pub scheduler_name: String,
    pub sampling_max_edge: u32,
    pub sampling_pixel_budget: u32,
    pub aspect_step_threshold: f64,
    pub aspect_adjusted_steps: u32,
    pub upscale_method: String,
    pub quality_prompt_enabled: bool,
    pub default_negative_enabled: bool,
    pub seed: Option<u32>,
    pub loras: Vec<DesktopLocalLoraSelectionInput>,
    pub privacy: String,
}

/** 本地生成任务的不可变采样参数快照。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalJobParametersView {
    pub width: u32,
    pub height: u32,
    pub quality_preset: String,
    pub steps: u32,
    pub cfg: f64,
    pub sampler_name: String,
    pub scheduler_name: String,
    pub sampling_max_edge: u32,
    pub sampling_pixel_budget: u32,
    pub aspect_step_threshold: f64,
    pub aspect_adjusted_steps: u32,
    pub upscale_method: String,
    pub quality_prompt_enabled: bool,
    pub quality_prefix: Option<String>,
    pub default_negative_enabled: bool,
    pub default_negative_prompt: Option<String>,
    pub seed: u32,
}

/** 本地生成任务产物摘要。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalArtifactView {
    pub path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

/** 本地任务固化的 LoRA 内容与强度快照。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalJobLoraView {
    pub id: String,
    pub title: String,
    pub r#type: String,
    pub file_name: String,
    pub sha256: String,
    pub strength: f64,
    pub clip_strength: f64,
    pub trigger_words: Vec<String>,
}

/** 本地任务每次 Runtime 执行的持久审计记录。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalJobAttemptView {
    pub id: String,
    pub attempt_number: u32,
    pub status: String,
    pub runtime_prompt_id: Option<String>,
    pub error: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

/** SQLite 中持久化的本地生成任务视图。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalJobView {
    pub id: String,
    pub status: String,
    pub progress: u32,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub model_id: String,
    pub model_display_name: String,
    pub model_sha256: String,
    pub parameters: DesktopLocalJobParametersView,
    pub privacy: String,
    pub runtime_prompt_id: Option<String>,
    pub error: Option<String>,
    pub loras: Vec<DesktopLocalJobLoraView>,
    pub attempts: Vec<DesktopLocalJobAttemptView>,
    pub artifact: Option<DesktopLocalArtifactView>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEnvironmentReport {
    pub status: String,
    pub checked_at: String,
    pub os: OsView,
    pub cpu: CpuView,
    pub memory: MemoryView,
    pub gpus: Vec<GpuView>,
    pub disks: Vec<DiskView>,
    pub runtime: RuntimeView,
    pub capabilities: CapabilityView,
    pub issues: Vec<EnvironmentIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsView { pub name: String, pub version: String, pub build: Option<u64>, pub arch: String, pub supported: bool }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuView { pub name: String, pub logical_cores: usize }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryView { pub total_bytes: u64, pub available_bytes: u64, pub virtual_total_bytes: u64 }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuView {
    pub index: u32,
    pub uuid: String,
    pub name: String,
    pub vendor: String,
    pub memory_total_bytes: u64,
    pub memory_free_bytes: u64,
    pub driver_version: String,
    pub compute_capability: Option<String>,
    pub temperature_celsius: Option<f64>,
    pub utilization_percent: Option<f64>,
}

/** 签名资源清单中的单个下载来源。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskView { pub name: String, pub file_system: String, pub total_bytes: u64, pub available_bytes: u64 }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView { pub installed: bool, pub status: String, pub root_path: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityView { pub inference: bool, pub training: bool, pub captioning: bool, pub model_management: bool }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentIssue { pub code: String, pub severity: String, pub title: String, pub message: String, pub action: String }

/** 签名资源清单中的不可变资源项目。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub theme_mode: String,
    /** 字体缩放仅允许 100%–130%，默认 110%。 */
    pub font_scale: f64,
    pub default_privacy: String,
    /** 登录账号后是否自动把新完成的本机图片加入网页图库同步队列。 */
    pub auto_upload: bool,
    pub model_root: String,
    pub output_root: String,
    pub runtime_root: String,
    pub upload_concurrency: u32,
    pub wifi_only: bool,
    pub bandwidth_limit_kib: Option<u64>,
}

/** 桌面 AI 辅助设置视图不包含 Windows Credential Manager 中的密钥正文。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAiSettings { pub enabled: bool, pub endpoint_type: String, pub base_url: String, pub model: String, pub api_key_configured: bool }

/** 桌面 AI 辅助设置更新请求使用显式清除字段，避免空输入覆盖既有密钥。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAiSettingsUpdate { pub enabled: bool, pub endpoint_type: String, pub base_url: String, pub model: String, pub api_key: Option<String>, pub clear_api_key: bool }

/** 桌面 AI 图片分析请求只允许固定的打标和反推用途。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAiAnalyzeInput { pub image_path: String, pub purpose: String, pub user_instruction: Option<String> }

/** 桌面 AI 图片分析结果可直接写入 Caption 或生成提示词。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAiAnalyzeView { pub purpose: String, pub text: String }

/** 服务端签名前的资源清单载荷。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceSource { pub kind: String, pub url: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceManifestItem {
    pub id: String,
    pub kind: String,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub file_name: String,
    pub byte_size: u64,
    pub installed_size: u64,
    pub sha256: String,
    pub archive: String,
    pub root_directory: Option<String>,
    pub install_directory: Option<String>,
    pub model_registration: Option<DesktopResourceModelRegistration>,
    pub application_update: Option<DesktopApplicationUpdateMetadata>,
    pub required: bool,
    pub sources: Vec<DesktopResourceSource>,
}

/** 签名清单中 application 更新包的版本门禁和用户说明。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApplicationUpdateMetadata { pub minimum_version: String, pub release_notes: String, pub mandatory: bool }

/** 桌面软件更新检查、下载、暂存、应用和回滚视图。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSoftwareUpdateView { pub current_version: String, pub latest_version: Option<String>, pub status: String, pub mandatory: bool, pub release_notes: Option<String>, pub byte_size: u64, pub downloaded_bytes: u64, pub rollback_version: Option<String>, pub error: Option<String> }

/** 离线更新安装包与签名信封输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOfflineUpdateImportInput { pub installer_path: String, pub envelope_path: String }

/** 签名清单中把多个原始文件组合为一个可用底模的登记元数据。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceModelRegistration {
    pub group_id: String,
    pub display_name: String,
    pub family: String,
    pub workflow_kind: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceManifestPayload {
    pub schema_version: u32,
    pub channel: String,
    pub generated_at: String,
    pub expires_at: String,
    pub resources: Vec<DesktopResourceManifestItem>,
}

/** 服务端返回的资源清单签名信封。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceManifestEnvelope { pub key_id: String, pub payload: String, pub signature: String }

/** 桌面界面展示的单个资源和本机缓存状态。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceCatalogItemView {
    pub id: String,
    pub kind: String,
    pub version: String,
    pub file_name: String,
    pub byte_size: u64,
    pub installed_size: u64,
    pub sha256: String,
    pub required: bool,
    pub downloaded: bool,
    pub installed: bool,
    pub install_path: Option<String>,
    pub source_kinds: Vec<String>,
    pub model_registration: Option<DesktopResourceModelRegistration>,
}

/** 桌面界面展示的已验签资源目录。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceCatalogView {
    pub configured: bool,
    pub key_id: Option<String>,
    pub generated_at: Option<String>,
    pub expires_at: Option<String>,
    pub message: String,
    pub resources: Vec<DesktopResourceCatalogItemView>,
}

/** 桌面资源下载命令与进度事件的统一视图。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceDownloadView {
    pub resource_id: String,
    pub status: String,
    pub source_kind: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub bytes_per_second: u64,
    pub eta_seconds: Option<u64>,
    pub target_path: Option<String>,
    pub error: Option<String>,
}

/** 桌面资源校验、解压、原子切换和回滚的统一视图。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopResourceInstallView {
    pub resource_id: String,
    pub status: String,
    pub progress: u32,
    pub install_path: Option<String>,
    pub rollback_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryPublicationInput { pub local_task_id: String, pub artifact_path: String, pub privacy: String }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GallerySyncItem {
    pub id: String,
    pub local_task_id: String,
    pub artifact_path: String,
    pub artifact_sha256: String,
    pub privacy: String,
    pub status: String,
    pub uploaded_bytes: u64,
    pub retry_count: u32,
    pub gallery_item_id: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/** 当前账号可访问的网站 LoRA 目录项。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteLoraView { pub id: String, pub title: String, pub description: String, pub r#type: String, pub model_family: String, pub model_family_name: String, pub trigger_words: Vec<String>, pub owner_display_name: String, pub privacy: String, pub is_owner: bool, pub version_id: String, pub file_name: String, pub sha256: String, pub byte_size: u64, pub installed: bool, pub cover_path: Option<String>, pub example_paths: Vec<String> }

/** 桌面端网站底模仓库视图；远端封面已转换为受控本机缓存路径。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteModelView { pub id: String, pub display_name: String, pub description: String, pub family: String, pub family_name: String, pub model_file_name: String, pub resource_group_id: Option<String>, pub download: Option<DesktopWebsiteModelDownload>, pub components: DesktopWebsiteModelComponents, pub runtime_format: String, pub usage_guide: String, pub source_links: Vec<DesktopWebsiteSourceLink>, pub parameters: DesktopWebsiteModelParameters, pub cover_path: Option<String>, pub example_paths: Vec<String> }

/** 网站底模统一由主站提供的可断点下载文件。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteModelDownload { pub file_name: String, pub sha256: String, pub byte_size: u64, pub content_url: String }

/** 由主站模型目录下发的 Anima 共享组件，客户端按文件名和哈希同时校验。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteModelComponents { pub text_encoder: DesktopWebsiteModelComponent, pub vae: DesktopWebsiteModelComponent }

/** 一个可复用 Runtime 组件的受控文件身份。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteModelComponent { pub file_name: String, pub sha256: String }

/** 网站底模来源链接只包含可公开展示的站点名称和 HTTPS 地址。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteSourceLink { pub label: String, pub url: String }

/** 网站底模详情中的推荐采样参数。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteModelParameters {
    pub steps: u32,
    pub cfg: f64,
    pub sampler: String,
    pub scheduler: String,
    pub sampling_max_edge: u32,
    pub sampling_pixel_budget: u32,
    pub aspect_step_threshold: f64,
    pub max_edge: u32,
    pub quality_prefix: String,
    pub default_negative_prompt: String,
    pub training_supported: bool,
    pub available_samplers: Vec<String>,
    pub available_schedulers: Vec<String>,
    pub presets: DesktopWebsiteModelPresets,
}

/** 在线底模目录的三个质量档，实际提交时由核心再次校验范围。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteModelPresets { pub fast: DesktopWebsiteModelPreset, pub quality: DesktopWebsiteModelPreset, pub extreme: DesktopWebsiteModelPreset }

/** 一个质量档的步数和潜空间预算。 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteModelPreset { pub steps: u32, pub aspect_adjusted_steps: u32, pub sampling_max_edge: u32, pub sampling_pixel_budget: u32 }

/** 网站 LoRA 断点下载、校验与安装进度。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteLoraInstallProgress { pub lora_id: String, pub status: String, pub downloaded_bytes: u64, pub total_bytes: u64, pub bytes_per_second: u64, pub error: Option<String> }

/** 网站底模断点下载、校验和安装进度。 */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWebsiteModelInstallProgress { pub model_id: String, pub status: String, pub downloaded_bytes: u64, pub total_bytes: u64, pub bytes_per_second: u64, pub error: Option<String> }

/** PowerShell 一次性采集的 Windows 系统与显卡硬件探针结果。 */
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsSystemProbe {
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub os_build: Option<u64>,
    pub cpu_name: Option<String>,
    pub total_memory_bytes: Option<u64>,
    pub available_memory_bytes: Option<u64>,
    pub virtual_total_bytes: Option<u64>,
    /** WMI 可见的 NVIDIA 适配器用于区分无显卡和驱动不可用。 */
    #[serde(default)]
    pub nvidia_adapter_names: Vec<String>,
    #[serde(default)]
    pub disks: Vec<DiskView>,
}
