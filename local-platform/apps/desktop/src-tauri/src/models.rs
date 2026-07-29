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

/** 本地任务选择的单个 LoRA 强度。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLocalLoraSelectionInput {
    pub id: String,
    pub strength: f64,
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

/** 仅包含训练集 ID 的幂等命令输入。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrainingDatasetIdInput {
    pub dataset_id: String,
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
    pub steps: u32,
    pub cfg: f64,
    pub sampler_name: String,
    pub scheduler_name: String,
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
    pub steps: u32,
    pub cfg: f64,
    pub sampler_name: String,
    pub scheduler_name: String,
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
    pub dependency_source: String,
    pub default_privacy: String,
    pub model_root: String,
    pub output_root: String,
    pub runtime_root: String,
    pub upload_concurrency: u32,
    pub wifi_only: bool,
    pub bandwidth_limit_kib: Option<u64>,
}

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
    pub required: bool,
    pub sources: Vec<DesktopResourceSource>,
}

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
#[derive(Debug, Clone, Deserialize)]
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
    #[serde(default)]
    pub disks: Vec<DiskView>,
}
