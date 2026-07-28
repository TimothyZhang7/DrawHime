//! 本模块执行 Windows、内存、磁盘和 NVIDIA GPU 的真实检测，并输出持续提示所需的能力结论。

use crate::models::{CapabilityView, CpuView, DesktopEnvironmentReport, DesktopSettings, EnvironmentIssue, GpuView, MemoryView, OsView, RuntimeView, WindowsSystemProbe};
use chrono::Utc;
use serde_json::Value;
use std::{fs, path::Path, process::Command};

const MIB: u64 = 1024 * 1024;
const MINIMUM_GPU_MEMORY_BYTES: u64 = 6 * 1024 * MIB;

/** 检测当前真实环境；任何缺失都转为明确问题，不使用虚构硬件数据。 */
pub fn inspect_environment(settings: &DesktopSettings) -> DesktopEnvironmentReport {
    let system = windows_system_probe();
    let gpus = nvidia_gpus();
    let runtime = inspect_runtime(&settings.runtime_root);
    let mut issues = Vec::new();
    if gpus.is_empty() {
        issues.push(issue("gpu_missing", "critical", "未检测到可用 NVIDIA GPU", "本地生成和 LoRA 训练保持暂停；模型管理、训练集与手动标签仍可使用。", "检查 GPU 与驱动"));
    } else if gpus.iter().all(|gpu| gpu.memory_total_bytes < MINIMUM_GPU_MEMORY_BYTES) {
        issues.push(issue("gpu_memory_insufficient", "critical", "GPU 显存低于首版运行要求", "当前检测到的 NVIDIA GPU 均少于 6GB 独立显存，生成和训练保持暂停。", "查看显存要求"));
    }
    if let Some(gpu) = gpus.first() {
        if gpu.memory_free_bytes < 1024 * MIB { issues.push(issue("gpu_busy", "warning", "GPU 当前可用显存很低", "其他程序正在大量占用显存，提交任务前需要释放显存。", "关闭占用 GPU 的程序")); }
    }
    if runtime.status == "not_installed" { issues.push(issue("runtime_missing", "warning", "本地 Runtime 尚未安装", "桌面核心和硬件检测可用；安装经过签名的推理、训练环境后才开放 GPU 任务。", "安装运行环境")); }
    if runtime.status == "installed_unverified" { issues.push(issue("runtime_unverified", "warning", "本地 Runtime 等待自检", "已发现 Runtime 清单，但尚未记录完整推理和训练自检结果。", "执行环境自检")); }
    if runtime.status == "broken" { issues.push(issue("runtime_broken", "critical", "本地 Runtime 清单损坏", "Runtime 清单不能读取或状态无效，生成和训练保持暂停。", "修复运行环境")); }
    let gpu_supported = gpus.iter().any(|gpu| gpu.memory_total_bytes >= MINIMUM_GPU_MEMORY_BYTES);
    let runtime_ready = runtime.status == "ready";
    let low_free_memory = gpus.first().map(|gpu| gpu.memory_free_bytes < 1024 * MIB).unwrap_or(true);
    let status = if !gpu_supported || runtime.status == "broken" { "blocked" } else if !runtime.installed { "installable" } else if !runtime_ready || low_free_memory { "degraded" } else { "ready" };
    DesktopEnvironmentReport {
        status: status.into(),
        checked_at: Utc::now().to_rfc3339(),
        os: OsView { name: system.os_name.unwrap_or_else(|| std::env::consts::OS.into()), version: system.os_version.unwrap_or_default(), arch: std::env::consts::ARCH.into() },
        cpu: CpuView { name: system.cpu_name.unwrap_or_else(|| "未知处理器".into()), logical_cores: std::thread::available_parallelism().map(usize::from).unwrap_or(1) },
        memory: MemoryView { total_bytes: system.total_memory_bytes.unwrap_or(0), available_bytes: system.available_memory_bytes.unwrap_or(0), virtual_total_bytes: system.virtual_total_bytes.unwrap_or(0) },
        gpus,
        disks: system.disks,
        runtime,
        capabilities: CapabilityView { inference: gpu_supported && runtime_ready && !low_free_memory, training: gpu_supported && runtime_ready && !low_free_memory, captioning: runtime_ready, model_management: true },
        issues,
    }
}

fn windows_system_probe() -> WindowsSystemProbe {
    if cfg!(not(target_os = "windows")) { return WindowsSystemProbe { os_name: None, os_version: None, cpu_name: None, total_memory_bytes: None, available_memory_bytes: None, virtual_total_bytes: None, disks: Vec::new() }; }
    let script = r#"[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$os=Get-CimInstance Win32_OperatingSystem;$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1;$disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|ForEach-Object{[ordered]@{name=$_.DeviceID;fileSystem=[string]$_.FileSystem;totalBytes=[uint64]$_.Size;availableBytes=[uint64]$_.FreeSpace}});[ordered]@{osName=[string]$os.Caption;osVersion=[string]$os.Version;cpuName=[string]$cpu.Name;totalMemoryBytes=[uint64]$os.TotalVisibleMemorySize*1024;availableMemoryBytes=[uint64]$os.FreePhysicalMemory*1024;virtualTotalBytes=[uint64]$os.TotalVirtualMemorySize*1024;disks=$disks}|ConvertTo-Json -Compress -Depth 4"#;
    let output = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script]).output();
    output.ok().filter(|result| result.status.success()).and_then(|result| serde_json::from_slice(&result.stdout).ok()).unwrap_or(WindowsSystemProbe { os_name: None, os_version: None, cpu_name: None, total_memory_bytes: None, available_memory_bytes: None, virtual_total_bytes: None, disks: Vec::new() })
}

fn nvidia_gpus() -> Vec<GpuView> {
    let output = Command::new("nvidia-smi").args(["--query-gpu=index,uuid,name,memory.total,memory.free,driver_version,compute_cap,temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"]).output();
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

fn issue(code: &str, severity: &str, title: &str, message: &str, action: &str) -> EnvironmentIssue { EnvironmentIssue { code: code.into(), severity: severity.into(), title: title.into(), message: message.into(), action: action.into() } }
fn parse_number(value: &str) -> Option<f64> { value.parse().ok() }
fn non_empty(value: &str) -> Option<String> { let value = value.trim(); (!value.is_empty() && value != "N/A").then(|| value.to_owned()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_report_always_explains_unavailable_capabilities() {
        let settings = DesktopSettings { default_privacy: "private".into(), model_root: "models".into(), output_root: "outputs".into(), runtime_root: "runtime-not-installed".into(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let report = inspect_environment(&settings);
        assert!(!report.checked_at.is_empty());
        assert!(report.capabilities.model_management);
        assert!(!report.issues.is_empty());
        if report.gpus.is_empty() { assert!(report.issues.iter().any(|issue| issue.code == "gpu_missing")); }
    }
}
