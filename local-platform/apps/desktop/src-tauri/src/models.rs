//! 本模块定义 WebView、环境检测和 SQLite 之间共享的桌面端序列化模型。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrapView {
    pub environment: DesktopEnvironmentReport,
    pub settings: DesktopSettings,
    pub pending_gallery_sync_count: u64,
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
    pub required: bool,
    pub sources: Vec<DesktopResourceSource>,
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
