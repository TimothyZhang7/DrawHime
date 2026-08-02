//! 本模块执行 Windows、内存、磁盘和多厂商 GPU 的真实检测，并选择可扩展的执行后端。

use crate::{
    models::{
        CapabilityView, CpuView, DesktopEnvironmentReport, DesktopSettings, EnvironmentIssue,
        ExecutionBackendView, GpuView, MemoryView, OsView, RuntimeCapabilitiesView, RuntimeView,
        WindowsSystemProbe,
    },
    process::hide_window,
    trainer,
};
use chrono::Utc;
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::Command,
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

const MIB: u64 = 1024 * 1024;
// NVIDIA 会为固件保留少量显存，6/8 GiB 标称显卡通常分别上报约 6140/8188 MiB。
const MINIMUM_GPU_MEMORY_BYTES: u64 = 5_800 * MIB;
const MINIMUM_TRAINING_GPU_MEMORY_BYTES: u64 = 7_800 * MIB;
// 桌面 Runtime 固定使用 CUDA 12.6 GA，NVIDIA 官方发布说明要求 Windows 驱动至少为 560.76。
const MINIMUM_NVIDIA_DRIVER: (u64, u64) = (560, 76);
pub(crate) const BACKEND_NVIDIA_CUDA: &str = "nvidia_cuda";
pub(crate) const BACKEND_AMD_DIRECTML: &str = "amd_directml";
pub(crate) const BACKEND_UNAVAILABLE: &str = "unavailable";

/** 后端选择结果同时携带可执行设备，避免把 WMI 展示适配器伪装成可靠显存探针。 */
struct HardwareSelection {
    backend: ExecutionBackendView,
    gpus: Vec<GpuView>,
    low_free_memory: bool,
}

/** Windows 版本检测使用三态，未知结果不能伪装成系统不兼容。 */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsBuildSupport {
    Supported,
    Unsupported,
    Unknown,
}

/** 进程内保留最近一次可信 Windows 身份，后续 CIM 瞬时失败不会覆盖正确结论。 */
#[derive(Clone)]
struct WindowsIdentity {
    name: Option<String>,
    version: String,
    build: u64,
}

static LAST_WINDOWS_IDENTITY: OnceLock<Mutex<Option<WindowsIdentity>>> = OnceLock::new();

/** 检测当前真实环境；任何缺失都转为明确问题，不使用虚构硬件数据。 */
pub fn inspect_environment(settings: &DesktopSettings) -> DesktopEnvironmentReport {
    let system = windows_system_probe();
    let os_support = if cfg!(target_os = "windows") {
        windows_build_support(system.os_version.as_deref(), system.os_build)
    } else {
        WindowsBuildSupport::Unsupported
    };
    let os_supported = os_support == WindowsBuildSupport::Supported;
    let nvidia_gpus = nvidia_gpus();
    let runtime = inspect_runtime(&settings.runtime_root);
    let generation_assets_ready = has_generation_assets(&settings.model_root);
    let anima_training_assets_ready = has_anima_assets(&settings.model_root);
    let captioner_ready = has_captioner_component(&settings.runtime_root);
    let trainer_ready = trainer::has_compatible_component(&settings.runtime_root);
    let mut issues = Vec::new();
    match os_support {
        WindowsBuildSupport::Unsupported => issues.push(issue(
            "windows_version_unsupported",
            "critical",
            "当前 Windows 版本不在支持范围",
            "首版要求 Windows 10 1809 及以后版本或 Windows 11 x64。",
            "查看系统升级要求",
        )),
        WindowsBuildSupport::Unknown => issues.push(issue(
            "windows_version_unknown",
            "warning",
            "Windows 版本暂未确认",
            "系统信息服务本次未返回可信版本，程序会自动重试；这不代表当前 Windows 不受支持。",
            "重新检测",
        )),
        WindowsBuildSupport::Supported => {}
    }
    let hardware = select_hardware_backend(&system.display_adapters, nvidia_gpus, &mut issues);
    let gpu_supported = hardware.backend.inference_supported;
    let training_gpu_supported = hardware.backend.training_supported;
    let low_free_memory = hardware.low_free_memory;
    let selected_backend = hardware.backend.id.clone();
    let runtime_backend_matches = runtime
        .backend
        .as_deref()
        .is_none_or(|backend| backend == selected_backend);
    if runtime.installed && !runtime_backend_matches {
        issues.push(issue(
            "runtime_backend_mismatch",
            "warning",
            "本地 Runtime 与当前显卡不匹配",
            "程序会安装适合当前显卡的独立 Runtime；模型、LoRA、作品和训练集不会被删除。",
            "安装匹配的运行环境",
        ));
    }
    if runtime.status == "not_installed" {
        issues.push(issue(
            "runtime_missing",
            "warning",
            "本地 Runtime 尚未安装",
            "桌面核心和硬件检测可用；安装经过签名的推理、训练环境后才开放 GPU 任务。",
            "安装运行环境",
        ));
    }
    if runtime.status == "installed_unverified" {
        issues.push(issue(
            "runtime_unverified",
            "warning",
            "本地 Runtime 等待自检",
            "已发现 Runtime 清单，但尚未记录完整推理和训练自检结果。",
            "执行环境自检",
        ));
    }
    if runtime.status == "broken" {
        issues.push(issue(
            "runtime_broken",
            "critical",
            "本地 Runtime 清单损坏",
            "Runtime 清单不能读取或状态无效，生成和训练保持暂停。",
            "修复运行环境",
        ));
    }
    if runtime.status == "ready" && !generation_assets_ready {
        issues.push(issue(
            "generation_model_missing",
            "warning",
            "尚未安装可生成的底模",
            "Runtime 已通过基础自检，但模型目录缺少完整底模资产，生成和训练保持暂停。",
            "前往资源安装",
        ));
    }
    if runtime.installed && !captioner_ready {
        issues.push(issue(
            "captioner_missing",
            "warning",
            "离线自动打标组件尚未安装",
            "手动 Caption 仍可使用；安装签名 WD14 组件后可批量自动打标。",
            "前往资源安装",
        ));
    }
    let trainer_required = selected_backend == BACKEND_NVIDIA_CUDA;
    if runtime.installed && trainer_required && !trainer_ready {
        issues.push(issue(
            "trainer_missing",
            "warning",
            "本地 LoRA Trainer 需要修复",
            "训练集和 Caption 仍可整理；请安装当前签名 Trainer 组件，旧协议组件不会继续执行训练。",
            "前往资源安装",
        ));
    }
    let runtime_ready = runtime.status == "ready" && runtime_backend_matches;
    let runtime_installed = runtime.installed;
    let status = if os_support == WindowsBuildSupport::Unsupported
        || !gpu_supported
        || runtime.status == "broken"
    {
        "blocked"
    } else if !runtime.installed {
        "installable"
    } else if !runtime_ready
        || !generation_assets_ready
        || !captioner_ready
        || (trainer_required && !trainer_ready)
        || low_free_memory
        || os_support == WindowsBuildSupport::Unknown
    {
        "degraded"
    } else {
        "ready"
    };
    DesktopEnvironmentReport {
        status: status.into(),
        checked_at: Utc::now().to_rfc3339(),
        os: OsView {
            name: system
                .os_name
                .unwrap_or_else(|| std::env::consts::OS.into()),
            version: system.os_version.unwrap_or_default(),
            build: system.os_build,
            arch: std::env::consts::ARCH.into(),
            supported: os_supported,
        },
        cpu: CpuView {
            name: system.cpu_name.unwrap_or_else(|| "未知处理器".into()),
            logical_cores: std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1),
        },
        memory: MemoryView {
            total_bytes: system.total_memory_bytes.unwrap_or(0),
            available_bytes: system.available_memory_bytes.unwrap_or(0),
            virtual_total_bytes: system.virtual_total_bytes.unwrap_or(0),
        },
        display_adapters: system.display_adapters,
        gpus: hardware.gpus,
        execution_backend: hardware.backend,
        disks: system.disks,
        runtime,
        // Runtime 会长期持有显存，空闲显存只用于状态提示，不得让已就绪客户端在完成首图后失去继续排队能力。
        capabilities: CapabilityView {
            inference: os_supported && gpu_supported && runtime_ready && generation_assets_ready,
            training: os_supported
                && training_gpu_supported
                && runtime_ready
                && anima_training_assets_ready
                && trainer_ready
                && selected_backend == BACKEND_NVIDIA_CUDA,
            captioning: os_supported && runtime_installed && captioner_ready,
            model_management: true,
        },
        issues,
    }
}

/** 在创建持久生成任务前重新确认 GPU、Runtime 与底模能力，避免环境变化后留下无法执行的队列任务。 */
pub fn require_inference_ready(settings: &DesktopSettings) -> Result<(), String> {
    let report = inspect_environment(settings);
    report
        .capabilities
        .inference
        .then_some(())
        .ok_or_else(|| capability_block_message(&report, "本地生成"))
}

/** 在创建持久训练任务前重新确认训练显存、Runtime 与 Anima 资产能力，避免无效占用训练队列。 */
pub fn require_training_ready(settings: &DesktopSettings) -> Result<(), String> {
    let report = inspect_environment(settings);
    report
        .capabilities
        .training
        .then_some(())
        .ok_or_else(|| capability_block_message(&report, "LoRA 训练"))
}

/** 将当前环境的首个关键问题转为提交接口可直接显示的中文错误，不丢失可操作原因。 */
fn capability_block_message(report: &DesktopEnvironmentReport, capability: &str) -> String {
    let issue = report
        .issues
        .iter()
        .find(|issue| issue.severity == "critical")
        .or_else(|| report.issues.first());
    match issue {
        Some(issue) => format!("{capability}当前不可用：{}。{}", issue.title, issue.message),
        None => format!("{capability}当前不可用，请重新检测本机 GPU、Runtime 与资源状态"),
    }
}

/** 自动选择执行后端：优先成熟 CUDA，CUDA 不满足时回落到 AMD DirectML。 */
fn select_hardware_backend(
    adapters: &[crate::models::DisplayAdapterView],
    nvidia_gpus: Vec<GpuView>,
    issues: &mut Vec<EnvironmentIssue>,
) -> HardwareSelection {
    let nvidia_adapter_present = adapters.iter().any(|adapter| adapter.vendor == "NVIDIA");
    let amd_adapter = adapters.iter().find(|adapter| adapter.vendor == "AMD");
    let cuda_driver_supported = nvidia_gpus
        .iter()
        .any(|gpu| nvidia_driver_supported(&gpu.driver_version));
    // 多 NVIDIA 设备固定选择显存容量最大、其次空闲显存最多的可用卡，避免 ComfyUI 默认误用 0 号弱卡。
    let selected_cuda_gpu = nvidia_gpus
        .iter()
        .filter(|gpu| {
            nvidia_driver_supported(&gpu.driver_version)
                && gpu.memory_total_bytes >= MINIMUM_GPU_MEMORY_BYTES
        })
        .max_by_key(|gpu| (gpu.memory_total_bytes, gpu.memory_free_bytes));
    if let Some(selected_cuda_gpu) = selected_cuda_gpu {
        let training_supported =
            selected_cuda_gpu.memory_total_bytes >= MINIMUM_TRAINING_GPU_MEMORY_BYTES;
        let low_free_memory = selected_cuda_gpu.memory_free_bytes < 1024 * MIB;
        if !training_supported {
            issues.push(issue(
                "training_gpu_memory_insufficient",
                "warning",
                "GPU 显存仅支持本地生成",
                "当前 CUDA GPU 可用于本地生成，但少于 8GB 独立显存，LoRA 训练保持暂停。",
                "查看训练显存要求",
            ));
        }
        if low_free_memory {
            issues.push(issue(
                "gpu_busy",
                "warning",
                "GPU 当前可用显存很低",
                "其他程序正在大量占用显存，提交任务前建议释放显存。",
                "关闭占用 GPU 的程序",
            ));
        }
        return HardwareSelection {
            backend: backend_view(
                BACKEND_NVIDIA_CUDA,
                "NVIDIA CUDA",
                "NVIDIA",
                Some(selected_cuda_gpu.name.clone()),
                Some(selected_cuda_gpu.index),
                false,
                true,
                training_supported,
            ),
            gpus: nvidia_gpus,
            low_free_memory,
        };
    }
    if let Some(adapter) = amd_adapter {
        issues.push(issue(
            "amd_directml_compatibility_mode",
            "warning",
            "AMD DirectML 兼容模式",
            "本地生成使用 FP32、CPU VAE 和分块注意力；速度低于 CUDA。Windows 下的 LoRA 训练尚未通过真实验收，因此保持关闭。",
            "查看 AMD 兼容范围",
        ));
        let gpu = GpuView {
            index: 0,
            uuid: adapter.pnp_device_id.clone(),
            name: adapter.name.clone(),
            vendor: adapter.vendor.clone(),
            backend: BACKEND_AMD_DIRECTML.into(),
            memory_total_bytes: adapter.dedicated_memory_bytes.unwrap_or(0),
            memory_free_bytes: 0,
            memory_reliable: false,
            driver_version: adapter.driver_version.clone(),
            architecture_hint: None,
            temperature_celsius: None,
            utilization_percent: None,
        };
        return HardwareSelection {
            backend: backend_view(
                BACKEND_AMD_DIRECTML,
                "AMD DirectML",
                "AMD",
                Some(adapter.name.clone()),
                None,
                true,
                true,
                false,
            ),
            gpus: vec![gpu],
            low_free_memory: false,
        };
    }
    if nvidia_adapter_present && nvidia_gpus.is_empty() {
        issues.push(issue(
            "nvidia_driver_unavailable",
            "critical",
            "NVIDIA 显卡驱动不可用",
            "Windows 已发现 NVIDIA 显卡，但 nvidia-smi 未返回可用设备；请修复驱动后重试。",
            "安装或修复 NVIDIA 驱动",
        ));
    } else if !nvidia_gpus.is_empty() && !cuda_driver_supported {
        let detected = nvidia_gpus
            .iter()
            .map(|gpu| gpu.driver_version.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        issues.push(issue(
            "nvidia_driver_too_old",
            "critical",
            "NVIDIA 显卡驱动版本过旧",
            &format!("当前驱动为 {detected}，CUDA 12.6 Runtime 要求 Windows 驱动至少为 560.76。"),
            "更新 NVIDIA 驱动",
        ));
    } else if !nvidia_gpus.is_empty() {
        issues.push(issue(
            "gpu_memory_insufficient",
            "critical",
            "GPU 显存低于运行要求",
            "当前 NVIDIA GPU 少于 6GB 独立显存，本地生成保持暂停。",
            "查看显存要求",
        ));
    } else {
        issues.push(issue(
            "gpu_missing",
            "critical",
            "未检测到可用的 NVIDIA 或 AMD GPU",
            "本地生成和 LoRA 训练保持暂停；模型管理、训练集与手动标签仍可使用。",
            "检查 GPU 与驱动",
        ));
    }
    HardwareSelection {
        backend: backend_view(
            BACKEND_UNAVAILABLE,
            "无可用 GPU 后端",
            "未知",
            None,
            None,
            false,
            false,
            false,
        ),
        gpus: nvidia_gpus,
        low_free_memory: false,
    }
}

/** 构造厂商无关的能力上限；AMD 只开放报告中真实验证的范围。 */
fn backend_view(
    id: &str,
    label: &str,
    vendor: &str,
    adapter_name: Option<String>,
    device_index: Option<u32>,
    compatibility_mode: bool,
    inference_supported: bool,
    training_supported: bool,
) -> ExecutionBackendView {
    let amd = id == BACKEND_AMD_DIRECTML;
    ExecutionBackendView {
        id: id.into(),
        label: label.into(),
        vendor: vendor.into(),
        adapter_name,
        device_index,
        compatibility_mode,
        inference_supported,
        training_supported,
        limits: RuntimeCapabilitiesView {
            inference: inference_supported,
            training: training_supported,
            cpu_vae_required: amd,
            fp32_unet_required: amd,
            max_validated_edge: if amd { 512 } else { 1536 },
            max_validated_batch: 1,
            max_validated_loras: if amd {
                1
            } else if inference_supported {
                64
            } else {
                0
            },
        },
    }
}

/** 资源目录和安装接口复用同一自动选择逻辑，避免 UI 与核心得到不同依赖集合。 */
pub(crate) fn preferred_execution_backend() -> String {
    preferred_execution_backend_view().id
}

/** Runtime 启动同时读取后端和实际设备索引，避免资源选择与进程参数分别探测。 */
pub(crate) fn preferred_execution_backend_view() -> ExecutionBackendView {
    let system = windows_system_probe();
    select_hardware_backend(&system.display_adapters, nvidia_gpus(), &mut Vec::new()).backend
}

fn windows_system_probe() -> WindowsSystemProbe {
    if cfg!(not(target_os = "windows")) {
        return empty_windows_system_probe();
    }
    // Windows 版本优先读取稳定的注册表，CIM 只负责补充内存、CPU、磁盘和显示适配器。
    let script = r#"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$registry = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
$video = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
$buildText = if ($os -and $os.BuildNumber) { [string]$os.BuildNumber } elseif ($registry -and $registry.CurrentBuildNumber) { [string]$registry.CurrentBuildNumber } else { $null }
$build = if ($buildText -and $buildText -match '^\d+$') { [uint64]$buildText } else { $null }
$osName = if ($os -and $os.Caption) { [string]$os.Caption } elseif ($registry -and $registry.ProductName) { [string]$registry.ProductName } else { $null }
$osVersion = if ($os -and $os.Version) { [string]$os.Version } elseif ($build) { "10.0.$build" } else { $null }
$displayAdapters = @($video | ForEach-Object {
  $name = [string]$_.Name
  $compatibility = [string]$_.AdapterCompatibility
  $vendor = if ("$name $compatibility" -match 'NVIDIA') { 'NVIDIA' } elseif ("$name $compatibility" -match 'AMD|Advanced Micro Devices|Radeon') { 'AMD' } elseif ("$name $compatibility" -match 'Intel') { 'Intel' } elseif ($compatibility) { $compatibility } else { '未知' }
  $backends = if ($vendor -eq 'NVIDIA') { @('nvidia_cuda') } elseif ($vendor -eq 'AMD') { @('amd_directml') } else { @() }
  [ordered]@{
    name = $name
    vendor = $vendor
    driverVersion = if ($_.DriverVersion) { [string]$_.DriverVersion } else { '' }
    pnpDeviceId = if ($_.PNPDeviceID) { [string]$_.PNPDeviceID } else { $name }
    dedicatedMemoryBytes = if ($_.AdapterRAM) { [uint64]$_.AdapterRAM } else { $null }
    supportedBackends = $backends
  }
})
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue | ForEach-Object {
  [ordered]@{ name = $_.DeviceID; fileSystem = [string]$_.FileSystem; totalBytes = [uint64]$_.Size; availableBytes = [uint64]$_.FreeSpace }
})
[ordered]@{
  osName = $osName
  osVersion = $osVersion
  osBuild = $build
  cpuName = if ($cpu -and $cpu.Name) { [string]$cpu.Name } else { $null }
  totalMemoryBytes = if ($os -and $os.TotalVisibleMemorySize) { [uint64]$os.TotalVisibleMemorySize * 1024 } else { $null }
  availableMemoryBytes = if ($os -and $os.FreePhysicalMemory) { [uint64]$os.FreePhysicalMemory * 1024 } else { $null }
  virtualTotalBytes = if ($os -and $os.TotalVirtualMemorySize) { [uint64]$os.TotalVirtualMemorySize * 1024 } else { $null }
  displayAdapters = $displayAdapters
  disks = $disks
} | ConvertTo-Json -Compress -Depth 4
"#;
    let mut last_probe = None;
    for attempt in 0..2 {
        let output = hide_window(&mut Command::new("powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output();
        if let Some(mut probe) = output
            .ok()
            .filter(|result| result.status.success())
            .and_then(|result| serde_json::from_slice::<WindowsSystemProbe>(&result.stdout).ok())
        {
            complete_windows_probe(&mut probe);
            if probe.os_version.is_some() && probe.os_build.is_some() {
                return probe;
            }
            last_probe = Some(probe);
        }
        if attempt == 0 {
            thread::sleep(Duration::from_millis(150));
        }
    }
    let mut probe = last_probe.unwrap_or_else(empty_windows_system_probe);
    complete_windows_probe(&mut probe);
    probe
}

/** 使用不依赖 WMI/CIM 的 Windows 接口补全关键字段，系统信息服务异常时仍返回真实版本和内存。 */
fn complete_windows_probe(probe: &mut WindowsSystemProbe) {
    #[cfg(target_os = "windows")]
    {
        if probe.os_version.is_none() || probe.os_build.is_none() {
            if let Some(identity) = windows_registry_identity() {
                probe.os_name = probe.os_name.clone().or(identity.name);
                probe.os_version = Some(identity.version);
                probe.os_build = Some(identity.build);
            }
        }
        if probe.total_memory_bytes.is_none()
            || probe.available_memory_bytes.is_none()
            || probe.virtual_total_bytes.is_none()
        {
            if let Some(memory) = windows_native_memory() {
                probe.total_memory_bytes = probe.total_memory_bytes.or(Some(memory.0));
                probe.available_memory_bytes = probe.available_memory_bytes.or(Some(memory.1));
                probe.virtual_total_bytes = probe.virtual_total_bytes.or(Some(memory.2));
            }
        }
    }
    stabilize_windows_identity(probe);
}

/** 直接读取 64 位系统注册表中的 Windows 版本，避免 PowerShell 或 CIM 瞬时故障阻塞启动。 */
#[cfg(target_os = "windows")]
fn windows_registry_identity() -> Option<WindowsIdentity> {
    use winreg::{
        enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
        RegKey,
    };

    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .ok()?;
    let build_text: String = key.get_value("CurrentBuildNumber").ok()?;
    let build = build_text
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)?;
    let major = key
        .get_value::<u32, _>("CurrentMajorVersionNumber")
        .unwrap_or(10);
    let minor = key
        .get_value::<u32, _>("CurrentMinorVersionNumber")
        .unwrap_or(0);
    let name = key
        .get_value::<String, _>("ProductName")
        .ok()
        .filter(|value| !value.trim().is_empty());
    Some(WindowsIdentity {
        name,
        version: format!("{major}.{minor}.{build}"),
        build,
    })
}

/** 调用 Win32 内存状态接口，避免 WMI 不可用时把真实内存错误显示为 0 GB。 */
#[cfg(target_os = "windows")]
fn windows_native_memory() -> Option<(u64, u64, u64)> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_physical: u64,
        available_physical: u64,
        total_page_file: u64,
        available_page_file: u64,
        total_virtual: u64,
        available_virtual: u64,
        available_extended_virtual: u64,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
    }

    let mut status = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_physical: 0,
        available_physical: 0,
        total_page_file: 0,
        available_page_file: 0,
        total_virtual: 0,
        available_virtual: 0,
        available_extended_virtual: 0,
    };
    // Win32 只写入固定布局结构体，返回零时不采用其中的未完成数据。
    let succeeded = unsafe { GlobalMemoryStatusEx(&mut status) } != 0;
    (succeeded && status.total_physical > 0).then_some((
        status.total_physical,
        status.available_physical,
        status.total_page_file,
    ))
}

/** 可信版本写入进程缓存；当前探测缺失时沿用缓存而不产生瞬时错误结论。 */
fn stabilize_windows_identity(probe: &mut WindowsSystemProbe) {
    probe.os_name = probe
        .os_name
        .take()
        .filter(|value| !value.trim().is_empty());
    probe.os_version = probe
        .os_version
        .take()
        .filter(|value| !value.trim().is_empty());
    probe.os_build = probe.os_build.filter(|value| *value > 0);
    let cache = LAST_WINDOWS_IDENTITY.get_or_init(|| Mutex::new(None));
    let Ok(mut identity) = cache.lock() else {
        return;
    };
    if let (Some(version), Some(build)) = (probe.os_version.as_ref(), probe.os_build) {
        *identity = Some(WindowsIdentity {
            name: probe.os_name.clone(),
            version: version.clone(),
            build,
        });
    } else if let Some(cached) = identity.as_ref() {
        probe.os_name = probe.os_name.clone().or_else(|| cached.name.clone());
        probe.os_version = Some(cached.version.clone());
        probe.os_build = Some(cached.build);
    }
}

/** 构造完全未知的系统探针；调用方必须保留未知与不支持的差异。 */
fn empty_windows_system_probe() -> WindowsSystemProbe {
    WindowsSystemProbe {
        os_name: None,
        os_version: None,
        os_build: None,
        cpu_name: None,
        total_memory_bytes: None,
        available_memory_bytes: None,
        virtual_total_bytes: None,
        display_adapters: Vec::new(),
        disks: Vec::new(),
    }
}

fn nvidia_gpus() -> Vec<GpuView> {
    let output = hide_window(&mut Command::new("nvidia-smi")).args(["--query-gpu=index,uuid,name,memory.total,memory.free,driver_version,compute_cap,temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"]).output();
    let Some(output) = output.ok().filter(|result| result.status.success()) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let columns: Vec<_> = line.split(',').map(str::trim).collect();
            if columns.len() < 9 {
                return None;
            }
            Some(GpuView {
                index: columns[0].parse().ok()?,
                uuid: columns[1].into(),
                name: columns[2].into(),
                vendor: "NVIDIA".into(),
                backend: BACKEND_NVIDIA_CUDA.into(),
                memory_total_bytes: parse_number(columns[3])? as u64 * MIB,
                memory_free_bytes: parse_number(columns[4])? as u64 * MIB,
                memory_reliable: true,
                driver_version: columns[5].into(),
                architecture_hint: non_empty(columns[6]),
                temperature_celsius: parse_number(columns[7]),
                utilization_percent: parse_number(columns[8]),
            })
        })
        .collect()
}

fn inspect_runtime(root: &str) -> RuntimeView {
    let manifest_path = Path::new(root)
        .join("current")
        .join("runtime-manifest.json");
    if !manifest_path.is_file() {
        return RuntimeView {
            installed: false,
            status: "not_installed".into(),
            root_path: root.into(),
            backend: None,
            launch_profile: None,
        };
    }
    let manifest = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok());
    let status = manifest
        .as_ref()
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    let resource_id = manifest
        .as_ref()
        .and_then(|value| value.get("resourceId"))
        .and_then(Value::as_str);
    let backend = manifest
        .as_ref()
        .and_then(|value| value.get("backend"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            resource_id
                .filter(|value| value.contains("nvidia"))
                .map(|_| BACKEND_NVIDIA_CUDA.into())
        });
    let launch_profile = manifest
        .as_ref()
        .and_then(|value| value.get("launchProfile"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            backend
                .as_deref()
                .filter(|value| *value == BACKEND_NVIDIA_CUDA)
                .map(|_| "nvidia-cuda126".into())
        });
    let normalized = match status.as_deref() {
        Some("ready") => "ready",
        Some("installed") | Some("installed_unverified") => "installed_unverified",
        _ => "broken",
    };
    RuntimeView {
        installed: true,
        status: normalized.into(),
        root_path: root.into(),
        backend,
        launch_profile,
    }
}

/** 只读取目录项判断是否存在完整可加载资产，避免首屏对数 GB 模型重复计算哈希。 */
fn has_generation_assets(root: &str) -> bool {
    let root = Path::new(root);
    let checkpoint_ready = contains_safetensors(&root.join("checkpoints"));
    let anima_ready = contains_safetensors(&root.join("diffusion_models"))
        && root
            .join("text_encoders")
            .join("qwen_3_06b_base.safetensors")
            .is_file()
        && root
            .join("vae")
            .join("qwen_image_vae.safetensors")
            .is_file();
    checkpoint_ready || anima_ready
}

/** 训练只接受具备独立 DiT、Qwen3 和 VAE 的 Anima 资产组合。 */
fn has_anima_assets(root: &str) -> bool {
    let root = Path::new(root);
    contains_safetensors(&root.join("diffusion_models"))
        && root
            .join("text_encoders")
            .join("qwen_3_06b_base.safetensors")
            .is_file()
        && root
            .join("vae")
            .join("qwen_image_vae.safetensors")
            .is_file()
}

fn contains_safetensors(directory: &Path) -> bool {
    fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| {
            entry.path().is_file()
                && entry.path().extension().is_some_and(|extension| {
                    extension
                        .to_string_lossy()
                        .eq_ignore_ascii_case("safetensors")
                })
        })
}

/** 只接受资源安装器写入标记且必需文件完整的 Captioner 版本。 */
fn has_captioner_component(runtime_root: &str) -> bool {
    let root = Path::new(runtime_root).join("components").join("captioner");
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .any(|path| {
            path.is_dir()
                && path.join(".drawhime-resource.json").is_file()
                && path.join("runner.py").is_file()
                && path.join("model.onnx").is_file()
                && path.join("selected_tags.csv").is_file()
                && path
                    .join("site-packages")
                    .join("onnxruntime")
                    .join("__init__.py")
                    .is_file()
        })
}

fn issue(code: &str, severity: &str, title: &str, message: &str, action: &str) -> EnvironmentIssue {
    EnvironmentIssue {
        code: code.into(),
        severity: severity.into(),
        title: title.into(),
        message: message.into(),
        action: action.into(),
    }
}
fn parse_number(value: &str) -> Option<f64> {
    value.parse().ok()
}
fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value != "N/A").then(|| value.to_owned())
}
/** 比较 nvidia-smi 返回的主次版本，拒绝缺失、畸形或低于 CUDA 12.6 要求的驱动。 */
fn nvidia_driver_supported(value: &str) -> bool {
    let mut parts = value.trim().split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    let Some(minor) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    (major, minor) >= MINIMUM_NVIDIA_DRIVER
}
/** Windows 10 与 11 的内核主版本均为 10；缺失数据返回未知，不能误判为不支持。 */
fn windows_build_support(version: Option<&str>, build: Option<u64>) -> WindowsBuildSupport {
    let (Some(version), Some(build)) = (version, build) else {
        return WindowsBuildSupport::Unknown;
    };
    if version.starts_with("10.") && build >= 17763 {
        WindowsBuildSupport::Supported
    } else {
        WindowsBuildSupport::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_report_always_explains_unavailable_capabilities() {
        let settings = DesktopSettings {
            theme_mode: "system".into(),
            font_scale: 1.1,
            content_font_scale: 1.2,
            default_privacy: "private".into(),
            auto_upload: true,
            model_root: "models".into(),
            output_root: "outputs".into(),
            runtime_root: "runtime-not-installed".into(),
            upload_concurrency: 2,
            wifi_only: false,
            bandwidth_limit_kib: None,
        };
        let report = inspect_environment(&settings);
        assert!(!report.checked_at.is_empty());
        assert!(report.capabilities.model_management);
        assert!(!report.issues.is_empty());
        if report.gpus.is_empty() {
            assert!(report
                .issues
                .iter()
                .any(|issue| issue.code == "gpu_missing"));
        }
    }

    #[test]
    fn windows_build_gate_matches_supported_range() {
        assert_eq!(
            windows_build_support(Some("10.0.17763"), Some(17762)),
            WindowsBuildSupport::Unsupported
        );
        assert_eq!(
            windows_build_support(Some("10.0.17763"), Some(17763)),
            WindowsBuildSupport::Supported
        );
        assert_eq!(
            windows_build_support(Some("6.3"), Some(9600)),
            WindowsBuildSupport::Unsupported
        );
        assert_eq!(
            windows_build_support(None, None),
            WindowsBuildSupport::Unknown
        );
        assert_eq!(
            windows_build_support(Some("10.0.26100"), None),
            WindowsBuildSupport::Unknown
        );
    }

    /** Windows 发布门禁必须验证不依赖 CIM 的注册表与内存回退确实能读取当前主机。 */
    #[cfg(target_os = "windows")]
    #[test]
    fn native_windows_fallback_reads_real_host() {
        let identity =
            windows_registry_identity().expect("应能从 64 位系统注册表读取 Windows 版本");
        assert_eq!(
            windows_build_support(Some(&identity.version), Some(identity.build)),
            WindowsBuildSupport::Supported
        );
        let memory = windows_native_memory().expect("应能从 Win32 API 读取系统内存");
        assert!(memory.0 > 0);
        assert!(memory.1 <= memory.0);
        assert!(memory.2 >= memory.0);
    }

    #[test]
    fn gpu_backend_selection_covers_nvidia_amd_and_unavailable_devices() {
        let gpu = |total_mib: u64, free_mib: u64, driver_version: &str| GpuView {
            index: 0,
            uuid: "test".into(),
            name: "测试 GPU".into(),
            vendor: "NVIDIA".into(),
            backend: BACKEND_NVIDIA_CUDA.into(),
            memory_total_bytes: total_mib * MIB,
            memory_free_bytes: free_mib * MIB,
            memory_reliable: true,
            driver_version: driver_version.into(),
            architecture_hint: Some("test".into()),
            temperature_celsius: Some(0.0),
            utilization_percent: Some(0.0),
        };
        let adapter = |vendor: &str| crate::models::DisplayAdapterView {
            name: format!("测试 {vendor} GPU"),
            vendor: vendor.into(),
            driver_version: "1.0".into(),
            pnp_device_id: format!("PCI\\VEN_{vendor}"),
            dedicated_memory_bytes: Some(12 * 1024 * MIB),
            supported_backends: vec![if vendor == "AMD" {
                BACKEND_AMD_DIRECTML.into()
            } else {
                BACKEND_NVIDIA_CUDA.into()
            }],
        };
        let mut issues = Vec::new();
        let missing = select_hardware_backend(&[], vec![], &mut issues);
        assert_eq!(missing.backend.id, BACKEND_UNAVAILABLE);
        assert!(issues.iter().any(|issue| issue.code == "gpu_missing"));

        issues.clear();
        let missing_driver = select_hardware_backend(&[adapter("NVIDIA")], vec![], &mut issues);
        assert_eq!(missing_driver.backend.id, BACKEND_UNAVAILABLE);
        assert!(issues
            .iter()
            .any(|issue| issue.code == "nvidia_driver_unavailable"));

        issues.clear();
        let fallback = select_hardware_backend(
            &[adapter("NVIDIA"), adapter("AMD")],
            vec![gpu(8_188, 8_000, "560.75")],
            &mut issues,
        );
        assert_eq!(fallback.backend.id, BACKEND_AMD_DIRECTML);
        assert!(!fallback.backend.training_supported);

        issues.clear();
        let low_memory = select_hardware_backend(
            &[adapter("NVIDIA")],
            vec![gpu(4_092, 4_000, "560.76")],
            &mut issues,
        );
        assert_eq!(low_memory.backend.id, BACKEND_UNAVAILABLE);
        assert!(issues
            .iter()
            .any(|issue| issue.code == "gpu_memory_insufficient"));

        issues.clear();
        let generation_only = select_hardware_backend(
            &[adapter("NVIDIA")],
            vec![gpu(6_140, 6_000, "560.76")],
            &mut issues,
        );
        assert_eq!(generation_only.backend.id, BACKEND_NVIDIA_CUDA);
        assert!(generation_only.backend.inference_supported);
        assert!(!generation_only.backend.training_supported);

        issues.clear();
        let full_cuda = select_hardware_backend(
            &[adapter("NVIDIA"), adapter("AMD")],
            vec![gpu(8_188, 8_000, "596.21")],
            &mut issues,
        );
        assert_eq!(full_cuda.backend.id, BACKEND_NVIDIA_CUDA);
        assert!(full_cuda.backend.training_supported);
        assert!(issues.is_empty());

        issues.clear();
        let first = gpu(8_188, 8_000, "596.21");
        let mut larger = gpu(24_000, 20_000, "596.21");
        larger.index = 2;
        larger.name = "测试 24GB GPU".into();
        let selected =
            select_hardware_backend(&[adapter("NVIDIA")], vec![first, larger], &mut issues);
        assert_eq!(selected.backend.device_index, Some(2));
        assert_eq!(
            selected.backend.adapter_name.as_deref(),
            Some("测试 24GB GPU")
        );
        assert!(selected.backend.training_supported);

        issues.clear();
        let directml = select_hardware_backend(&[adapter("AMD")], vec![], &mut issues);
        assert_eq!(directml.backend.id, BACKEND_AMD_DIRECTML);
        assert_eq!(directml.backend.limits.max_validated_edge, 512);
        assert_eq!(directml.backend.limits.max_validated_loras, 1);
        assert!(issues
            .iter()
            .any(|issue| issue.code == "amd_directml_compatibility_mode"));
    }

    #[test]
    fn nvidia_driver_gate_matches_cuda_12_6_windows_requirement() {
        assert!(!nvidia_driver_supported("560.75"));
        assert!(nvidia_driver_supported("560.76"));
        assert!(nvidia_driver_supported("596.21"));
        assert!(!nvidia_driver_supported("unknown"));
    }
}
