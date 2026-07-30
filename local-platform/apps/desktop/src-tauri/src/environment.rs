//! 本模块执行 Windows、内存、磁盘和 NVIDIA GPU 的真实检测，并输出持续提示所需的能力结论。

use crate::{models::{CapabilityView, CpuView, DesktopEnvironmentReport, DesktopSettings, EnvironmentIssue, GpuView, MemoryView, OsView, RuntimeView, WindowsSystemProbe}, process::hide_window};
use chrono::Utc;
use serde_json::Value;
use std::{fs, path::Path, process::Command};

const MIB: u64 = 1024 * 1024;
// NVIDIA 会为固件保留少量显存，6/8 GiB 标称显卡通常分别上报约 6140/8188 MiB。
const MINIMUM_GPU_MEMORY_BYTES: u64 = 5_800 * MIB;
const MINIMUM_TRAINING_GPU_MEMORY_BYTES: u64 = 7_800 * MIB;
// 桌面 Runtime 固定使用 CUDA 12.6 GA，NVIDIA 官方发布说明要求 Windows 驱动至少为 560.76。
const MINIMUM_NVIDIA_DRIVER: (u64, u64) = (560, 76);

/** 检测当前真实环境；任何缺失都转为明确问题，不使用虚构硬件数据。 */
pub fn inspect_environment(settings: &DesktopSettings) -> DesktopEnvironmentReport {
    let system = windows_system_probe();
    let os_supported = cfg!(target_os = "windows") && windows_build_supported(system.os_version.as_deref(), system.os_build);
    let gpus = nvidia_gpus();
    let runtime = inspect_runtime(&settings.runtime_root);
    let generation_assets_ready = has_generation_assets(&settings.model_root);
    let anima_training_assets_ready = has_anima_assets(&settings.model_root);
    let captioner_ready = has_captioner_component(&settings.runtime_root);
    let trainer_ready = has_trainer_component(&settings.runtime_root);
    let mut issues = Vec::new();
    if !os_supported {
        issues.push(issue("windows_version_unsupported", "critical", "当前 Windows 版本不在支持范围", "首版要求 Windows 10 1809 及以后版本或 Windows 11 x64。", "查看系统升级要求"));
    }
    let nvidia_hardware_detected = !system.nvidia_adapter_names.is_empty();
    let (gpu_supported, training_gpu_supported, low_free_memory) = evaluate_gpu_state(&gpus, nvidia_hardware_detected, &mut issues);
    if runtime.status == "not_installed" { issues.push(issue("runtime_missing", "warning", "本地 Runtime 尚未安装", "桌面核心和硬件检测可用；安装经过签名的推理、训练环境后才开放 GPU 任务。", "安装运行环境")); }
    if runtime.status == "installed_unverified" { issues.push(issue("runtime_unverified", "warning", "本地 Runtime 等待自检", "已发现 Runtime 清单，但尚未记录完整推理和训练自检结果。", "执行环境自检")); }
    if runtime.status == "broken" { issues.push(issue("runtime_broken", "critical", "本地 Runtime 清单损坏", "Runtime 清单不能读取或状态无效，生成和训练保持暂停。", "修复运行环境")); }
    if runtime.status == "ready" && !generation_assets_ready { issues.push(issue("generation_model_missing", "warning", "尚未安装可生成的底模", "Runtime 已通过基础自检，但模型目录缺少完整底模资产，生成和训练保持暂停。", "前往资源安装")); }
    if runtime.installed && !captioner_ready { issues.push(issue("captioner_missing", "warning", "离线自动打标组件尚未安装", "手动 Caption 仍可使用；安装签名 WD14 组件后可批量自动打标。", "前往资源安装")); }
    if runtime.installed && !trainer_ready { issues.push(issue("trainer_missing", "warning", "本地 LoRA Trainer 尚未安装", "训练集和 Caption 仍可整理；安装签名 Trainer 组件后才开放真实 LoRA 训练。", "前往资源安装")); }
    let runtime_ready = runtime.status == "ready";
    let runtime_installed = runtime.installed;
    let status = if !os_supported || !gpu_supported || runtime.status == "broken" { "blocked" } else if !runtime.installed { "installable" } else if !runtime_ready || !generation_assets_ready || !captioner_ready || !trainer_ready || low_free_memory { "degraded" } else { "ready" };
    DesktopEnvironmentReport {
        status: status.into(),
        checked_at: Utc::now().to_rfc3339(),
        os: OsView { name: system.os_name.unwrap_or_else(|| std::env::consts::OS.into()), version: system.os_version.unwrap_or_default(), build: system.os_build, arch: std::env::consts::ARCH.into(), supported: os_supported },
        cpu: CpuView { name: system.cpu_name.unwrap_or_else(|| "未知处理器".into()), logical_cores: std::thread::available_parallelism().map(usize::from).unwrap_or(1) },
        memory: MemoryView { total_bytes: system.total_memory_bytes.unwrap_or(0), available_bytes: system.available_memory_bytes.unwrap_or(0), virtual_total_bytes: system.virtual_total_bytes.unwrap_or(0) },
        gpus,
        disks: system.disks,
        runtime,
        capabilities: CapabilityView { inference: os_supported && gpu_supported && runtime_ready && generation_assets_ready && !low_free_memory, training: os_supported && training_gpu_supported && runtime_ready && anima_training_assets_ready && trainer_ready && !low_free_memory, captioning: os_supported && runtime_installed && captioner_ready, model_management: true },
        issues,
    }
}

/** 在创建持久生成任务前重新确认 GPU、Runtime 与底模能力，避免环境变化后留下无法执行的队列任务。 */
pub fn require_inference_ready(settings: &DesktopSettings) -> Result<(), String> {
    let report = inspect_environment(settings);
    report.capabilities.inference.then_some(()).ok_or_else(|| capability_block_message(&report, "本地生成"))
}

/** 在创建持久训练任务前重新确认训练显存、Runtime 与 Anima 资产能力，避免无效占用训练队列。 */
pub fn require_training_ready(settings: &DesktopSettings) -> Result<(), String> {
    let report = inspect_environment(settings);
    report.capabilities.training.then_some(()).ok_or_else(|| capability_block_message(&report, "LoRA 训练"))
}

/** 将当前环境的首个关键问题转为提交接口可直接显示的中文错误，不丢失可操作原因。 */
fn capability_block_message(report: &DesktopEnvironmentReport, capability: &str) -> String {
    let issue = report.issues.iter().find(|issue| issue.severity == "critical").or_else(|| report.issues.first());
    match issue {
        Some(issue) => format!("{capability}当前不可用：{}。{}", issue.title, issue.message),
        None => format!("{capability}当前不可用，请重新检测本机 GPU、Runtime 与资源状态"),
    }
}

/** 统一评估 GPU 门禁并生成可操作提示，确保无卡、低显存和繁忙状态使用同一真实逻辑。 */
fn evaluate_gpu_state(gpus: &[GpuView], nvidia_hardware_detected: bool, issues: &mut Vec<EnvironmentIssue>) -> (bool, bool, bool) {
    let driver_supported = gpus.iter().any(|gpu| nvidia_driver_supported(&gpu.driver_version));
    let generation_supported = driver_supported && gpus.iter().any(|gpu| gpu.memory_total_bytes >= MINIMUM_GPU_MEMORY_BYTES);
    let training_supported = driver_supported && gpus.iter().any(|gpu| gpu.memory_total_bytes >= MINIMUM_TRAINING_GPU_MEMORY_BYTES);
    let low_free_memory = gpus.first().map(|gpu| gpu.memory_free_bytes < 1024 * MIB).unwrap_or(true);
    if gpus.is_empty() {
        if nvidia_hardware_detected {
            issues.push(issue("nvidia_driver_unavailable", "critical", "NVIDIA 显卡驱动不可用", "Windows 已发现 NVIDIA 显卡硬件，但 nvidia-smi 未返回可用设备；生成和训练保持暂停。", "安装或修复 NVIDIA 驱动"));
        } else {
            issues.push(issue("gpu_missing", "critical", "未检测到可用 NVIDIA GPU", "本地生成和 LoRA 训练保持暂停；模型管理、训练集与手动标签仍可使用。", "检查 GPU 与驱动"));
        }
    } else if !driver_supported {
        let detected = gpus.iter().map(|gpu| gpu.driver_version.as_str()).collect::<Vec<_>>().join(" / ");
        let message = format!("当前 NVIDIA 驱动为 {detected}，CUDA 12.6 Runtime 要求 Windows 驱动至少为 560.76；生成和训练保持暂停。");
        issues.push(issue("nvidia_driver_too_old", "critical", "NVIDIA 显卡驱动版本过旧", &message, "更新 NVIDIA 驱动"));
    } else if !generation_supported {
        issues.push(issue("gpu_memory_insufficient", "critical", "GPU 显存低于首版运行要求", "当前检测到的 NVIDIA GPU 均少于 6GB 独立显存，生成和训练保持暂停。", "查看显存要求"));
    } else if !training_supported {
        issues.push(issue("training_gpu_memory_insufficient", "warning", "GPU 显存仅支持本地生成", "当前 GPU 可用于本地生成，但少于 8GB 独立显存，LoRA 训练保持暂停。", "查看训练显存要求"));
    }
    if !gpus.is_empty() && low_free_memory {
        issues.push(issue("gpu_busy", "warning", "GPU 当前可用显存很低", "其他程序正在大量占用显存，提交任务前需要释放显存。", "关闭占用 GPU 的程序"));
    }
    (generation_supported, training_supported, low_free_memory)
}

fn windows_system_probe() -> WindowsSystemProbe {
    if cfg!(not(target_os = "windows")) { return WindowsSystemProbe { os_name: None, os_version: None, os_build: None, cpu_name: None, total_memory_bytes: None, available_memory_bytes: None, virtual_total_bytes: None, nvidia_adapter_names: Vec::new(), disks: Vec::new() }; }
    let script = r#"[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$os=Get-CimInstance Win32_OperatingSystem;$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1;$nvidiaAdapters=@(Get-CimInstance Win32_VideoController|Where-Object{$_.Name -match 'NVIDIA'}|ForEach-Object{[string]$_.Name});$disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|ForEach-Object{[ordered]@{name=$_.DeviceID;fileSystem=[string]$_.FileSystem;totalBytes=[uint64]$_.Size;availableBytes=[uint64]$_.FreeSpace}});[ordered]@{osName=[string]$os.Caption;osVersion=[string]$os.Version;osBuild=[uint64]$os.BuildNumber;cpuName=[string]$cpu.Name;totalMemoryBytes=[uint64]$os.TotalVisibleMemorySize*1024;availableMemoryBytes=[uint64]$os.FreePhysicalMemory*1024;virtualTotalBytes=[uint64]$os.TotalVirtualMemorySize*1024;nvidiaAdapterNames=$nvidiaAdapters;disks=$disks}|ConvertTo-Json -Compress -Depth 4"#;
    let output = hide_window(&mut Command::new("powershell.exe")).args(["-NoProfile", "-NonInteractive", "-Command", script]).output();
    output.ok().filter(|result| result.status.success()).and_then(|result| serde_json::from_slice(&result.stdout).ok()).unwrap_or(WindowsSystemProbe { os_name: None, os_version: None, os_build: None, cpu_name: None, total_memory_bytes: None, available_memory_bytes: None, virtual_total_bytes: None, nvidia_adapter_names: Vec::new(), disks: Vec::new() })
}

fn nvidia_gpus() -> Vec<GpuView> {
    let output = hide_window(&mut Command::new("nvidia-smi")).args(["--query-gpu=index,uuid,name,memory.total,memory.free,driver_version,compute_cap,temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"]).output();
    let Some(output) = output.ok().filter(|result| result.status.success()) else { return Vec::new(); };
    String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
        let columns: Vec<_> = line.split(',').map(str::trim).collect();
        if columns.len() < 9 { return None; }
        Some(GpuView { index: columns[0].parse().ok()?, uuid: columns[1].into(), name: columns[2].into(), vendor: "NVIDIA".into(), memory_total_bytes: parse_number(columns[3])? as u64 * MIB, memory_free_bytes: parse_number(columns[4])? as u64 * MIB, driver_version: columns[5].into(), compute_capability: non_empty(columns[6]), temperature_celsius: parse_number(columns[7]), utilization_percent: parse_number(columns[8]) })
    }).collect()
}

fn inspect_runtime(root: &str) -> RuntimeView {
    let manifest_path = Path::new(root).join("current").join("runtime-manifest.json");
    if !manifest_path.is_file() { return RuntimeView { installed: false, status: "not_installed".into(), root_path: root.into() }; }
    let status = fs::read_to_string(&manifest_path).ok().and_then(|content| serde_json::from_str::<Value>(&content).ok()).and_then(|value| value.get("status").and_then(Value::as_str).map(str::to_owned));
    let normalized = match status.as_deref() { Some("ready") => "ready", Some("installed") | Some("installed_unverified") => "installed_unverified", _ => "broken" };
    RuntimeView { installed: true, status: normalized.into(), root_path: root.into() }
}

/** 只读取目录项判断是否存在完整可加载资产，避免首屏对数 GB 模型重复计算哈希。 */
fn has_generation_assets(root: &str) -> bool {
    let root = Path::new(root);
    let checkpoint_ready = contains_safetensors(&root.join("checkpoints"));
    let anima_ready = contains_safetensors(&root.join("diffusion_models"))
        && root.join("text_encoders").join("qwen_3_06b_base.safetensors").is_file()
        && root.join("vae").join("qwen_image_vae.safetensors").is_file();
    checkpoint_ready || anima_ready
}

/** 训练只接受具备独立 DiT、Qwen3 和 VAE 的 Anima 资产组合。 */
fn has_anima_assets(root: &str) -> bool {
    let root = Path::new(root);
    contains_safetensors(&root.join("diffusion_models"))
        && root.join("text_encoders").join("qwen_3_06b_base.safetensors").is_file()
        && root.join("vae").join("qwen_image_vae.safetensors").is_file()
}

fn contains_safetensors(directory: &Path) -> bool {
    fs::read_dir(directory).ok().into_iter().flatten().filter_map(Result::ok).any(|entry| entry.path().is_file() && entry.path().extension().is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("safetensors")))
}

/** 只接受资源安装器写入标记且必需文件完整的 Captioner 版本。 */
fn has_captioner_component(runtime_root: &str) -> bool {
    let root = Path::new(runtime_root).join("components").join("captioner");
    fs::read_dir(root).ok().into_iter().flatten().filter_map(Result::ok).map(|entry| entry.path()).any(|path| path.is_dir() && path.join(".drawhime-resource.json").is_file() && path.join("runner.py").is_file() && path.join("model.onnx").is_file() && path.join("selected_tags.csv").is_file() && path.join("site-packages").join("onnxruntime").join("__init__.py").is_file())
}

/** 只接受资源安装器写入标记且固定 Anima 训练入口完整的 Trainer。 */
fn has_trainer_component(runtime_root: &str) -> bool {
    let root = Path::new(runtime_root).join("components").join("trainer");
    fs::read_dir(root).ok().into_iter().flatten().filter_map(Result::ok).map(|entry| entry.path()).any(|path| path.is_dir() && path.join(".drawhime-resource.json").is_file() && path.join("runner.py").is_file() && path.join("sd-scripts").join("anima_train_network.py").is_file() && path.join("site-packages").join("accelerate").is_dir())
}

fn issue(code: &str, severity: &str, title: &str, message: &str, action: &str) -> EnvironmentIssue { EnvironmentIssue { code: code.into(), severity: severity.into(), title: title.into(), message: message.into(), action: action.into() } }
fn parse_number(value: &str) -> Option<f64> { value.parse().ok() }
fn non_empty(value: &str) -> Option<String> { let value = value.trim(); (!value.is_empty() && value != "N/A").then(|| value.to_owned()) }
/** 比较 nvidia-smi 返回的主次版本，拒绝缺失、畸形或低于 CUDA 12.6 要求的驱动。 */
fn nvidia_driver_supported(value: &str) -> bool {
    let mut parts = value.trim().split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u64>().ok()) else { return false; };
    let Some(minor) = parts.next().and_then(|part| part.parse::<u64>().ok()) else { return false; };
    (major, minor) >= MINIMUM_NVIDIA_DRIVER
}
/** Windows 10 与 11 的内核主版本均为 10，使用构建号判断最低 1809。 */
fn windows_build_supported(version: Option<&str>, build: Option<u64>) -> bool { version.is_some_and(|value| value.starts_with("10.")) && build.is_some_and(|value| value >= 17763) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_report_always_explains_unavailable_capabilities() {
        let settings = DesktopSettings { theme_mode: "system".into(), dependency_source: "auto".into(), default_privacy: "private".into(), auto_upload: true, model_root: "models".into(), output_root: "outputs".into(), runtime_root: "runtime-not-installed".into(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let report = inspect_environment(&settings);
        assert!(!report.checked_at.is_empty());
        assert!(report.capabilities.model_management);
        assert!(!report.issues.is_empty());
        if report.gpus.is_empty() { assert!(report.issues.iter().any(|issue| issue.code == "gpu_missing")); }
    }

    #[test]
    fn windows_build_gate_matches_supported_range() {
        assert!(!windows_build_supported(Some("10.0.17763"), Some(17762)));
        assert!(windows_build_supported(Some("10.0.17763"), Some(17763)));
        assert!(!windows_build_supported(Some("6.3"), Some(9600)));
    }

    #[test]
    fn gpu_gate_explains_missing_low_memory_and_generation_only_devices() {
        let mut issues = Vec::new();
        assert_eq!(evaluate_gpu_state(&[], false, &mut issues), (false, false, true));
        assert!(issues.iter().any(|issue| issue.code == "gpu_missing"));

        issues.clear();
        assert_eq!(evaluate_gpu_state(&[], true, &mut issues), (false, false, true));
        assert!(issues.iter().any(|issue| issue.code == "nvidia_driver_unavailable"));

        let gpu = |total_mib: u64, free_mib: u64, driver_version: &str| GpuView { index: 0, uuid: "test".into(), name: "测试 GPU".into(), vendor: "NVIDIA".into(), memory_total_bytes: total_mib * MIB, memory_free_bytes: free_mib * MIB, driver_version: driver_version.into(), compute_capability: Some("test".into()), temperature_celsius: Some(0.0), utilization_percent: Some(0.0) };
        issues.clear();
        assert_eq!(evaluate_gpu_state(&[gpu(8_188, 8_000, "560.75")], true, &mut issues), (false, false, false));
        assert!(issues.iter().any(|issue| issue.code == "nvidia_driver_too_old"));

        issues.clear();
        assert_eq!(evaluate_gpu_state(&[gpu(4_092, 4_000, "560.76")], true, &mut issues), (false, false, false));
        assert!(issues.iter().any(|issue| issue.code == "gpu_memory_insufficient"));

        issues.clear();
        assert_eq!(evaluate_gpu_state(&[gpu(6_140, 6_000, "560.76")], true, &mut issues), (true, false, false));
        assert!(issues.iter().any(|issue| issue.code == "training_gpu_memory_insufficient"));

        issues.clear();
        assert_eq!(evaluate_gpu_state(&[gpu(8_188, 8_000, "596.21")], true, &mut issues), (true, true, false));
        assert!(issues.is_empty());
    }

    #[test]
    fn nvidia_driver_gate_matches_cuda_12_6_windows_requirement() {
        assert!(!nvidia_driver_supported("560.75"));
        assert!(nvidia_driver_supported("560.76"));
        assert!(nvidia_driver_supported("596.21"));
        assert!(!nvidia_driver_supported("unknown"));
    }
}
