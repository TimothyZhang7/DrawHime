//! 本模块管理桌面端唯一 ComfyUI 子进程，负责回环启动、健康探测、自检、日志与退出回收。

use crate::{
    models::{DesktopRuntimeStatusView, DesktopSettings},
    process::hide_window,
};
use chrono::Utc;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const STARTUP_DEADLINE: Duration = Duration::from_secs(120);
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RUNTIME_LEASE_MAX_BYTES: u64 = 16 * 1024;
const REQUIRED_NODES: [&str; 8] = [
    "UNETLoader",
    "CLIPLoader",
    "VAELoader",
    "CLIPTextEncode",
    "EmptyLatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
];

/** 当前桌面进程独占的 Runtime 控制器，只回收自己创建的子进程。 */
pub struct RuntimeController {
    process: Mutex<RuntimeProcess>,
}

struct RuntimeProcess {
    child: Option<Child>,
    status: String,
    port: Option<u16>,
    started_at: Option<String>,
    log_path: Option<PathBuf>,
    error: Option<String>,
    self_tested: bool,
    lease_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLease {
    owner_pid: u32,
    owner_executable: String,
    runtime_pid: u32,
    runtime_executable: String,
    runtime_entrypoint: String,
    port: u16,
    started_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsProcessIdentity {
    executable_path: String,
    command_line: String,
}

impl RuntimeController {
    /** 创建停止状态的 Runtime 控制器，应用重启后不会猜测或接管外部 Python 进程。 */
    #[cfg(test)]
    pub fn new() -> Self {
        Self::with_lease_path(None)
    }

    /** 启动桌面状态前回收上次崩溃遗留的已验证 Runtime，避免孤儿进程继续占用 GPU。 */
    pub fn initialize(app_data_dir: &Path) -> Result<Self, String> {
        let lease_path = app_data_dir
            .join("runtime-state")
            .join("runtime-process.json");
        recover_orphan_runtime(&lease_path)?;
        Ok(Self::with_lease_path(Some(lease_path)))
    }

    fn with_lease_path(lease_path: Option<PathBuf>) -> Self {
        Self {
            process: Mutex::new(RuntimeProcess {
                child: None,
                status: "stopped".into(),
                port: None,
                started_at: None,
                log_path: None,
                error: None,
                self_tested: false,
                lease_path,
            }),
        }
    }

    /** 返回真实子进程状态；发现异常退出时立即收敛为失败。 */
    pub fn status(&self) -> Result<DesktopRuntimeStatusView, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "Runtime 状态锁已损坏".to_string())?;
        refresh_process_state(&mut process)?;
        Ok(process.view())
    }

    /** 仅向本地调度器返回已经过健康探测的回环地址。 */
    pub fn endpoint(&self) -> Result<String, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "Runtime 状态锁已损坏".to_string())?;
        refresh_process_state(&mut process)?;
        if process.status != "ready" {
            return Err("Runtime 当前未就绪".into());
        }
        let port = process
            .port
            .ok_or_else(|| "Runtime 缺少回环端口".to_string())?;
        if !runtime_health_ok(port) {
            return Err("Runtime 健康探测失败".into());
        }
        Ok(format!("http://127.0.0.1:{port}"))
    }

    /** 使用受控便携 Python 和动态回环端口启动 ComfyUI，并等待真实健康响应。 */
    pub fn start(
        &self,
        settings: &DesktopSettings,
        app_data_dir: &Path,
    ) -> Result<DesktopRuntimeStatusView, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "Runtime 状态锁已损坏".to_string())?;
        refresh_process_state(&mut process)?;
        if process.status == "ready" {
            if process.port.is_some_and(runtime_health_ok) {
                return Ok(process.view());
            }
            stop_child(&mut process);
        }

        let runtime_root = Path::new(&settings.runtime_root).join("current");
        let python = runtime_root.join("python_embeded").join("python.exe");
        let main = runtime_root.join("ComfyUI").join("main.py");
        validate_runtime_files(&runtime_root, &python, &main)?;
        let runtime_data = app_data_dir.join("runtime-state");
        let log_dir = runtime_data.join("logs");
        fs::create_dir_all(&log_dir)
            .map_err(|error| format!("创建 Runtime 日志目录失败：{error}"))?;
        cleanup_old_logs(&log_dir)?;
        let config_path = runtime_data.join("extra-model-paths.yaml");
        write_model_path_config(&config_path, Path::new(&settings.model_root))?;
        let output_directory = runtime_data.join("comfy-output");
        fs::create_dir_all(&output_directory)
            .map_err(|error| format!("创建 Runtime 输出目录失败：{error}"))?;
        let port = available_loopback_port()?;
        let log_path = log_dir.join(format!(
            "comfyui-{}.log",
            Utc::now().format("%Y%m%d-%H%M%S")
        ));
        let stdout = create_log_file(&log_path)?;
        let stderr = stdout
            .try_clone()
            .map_err(|error| format!("复制 Runtime 日志句柄失败：{error}"))?;

        let main_argument = main.to_string_lossy().into_owned();
        let port_argument = port.to_string();
        let config_argument = config_path.to_string_lossy().into_owned();
        let output_argument = output_directory.to_string_lossy().into_owned();
        let mut command = Command::new(&python);
        hide_window(&mut command);
        command
            .current_dir(runtime_root.join("ComfyUI"))
            .args([
                "-s",
                main_argument.as_str(),
                "--windows-standalone-build",
                "--listen",
                "127.0.0.1",
                "--port",
                port_argument.as_str(),
                "--disable-auto-launch",
                "--extra-model-paths-config",
                config_argument.as_str(),
                "--output-directory",
                output_argument.as_str(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        process.status = "starting".into();
        process.port = Some(port);
        process.started_at = Some(Utc::now().to_rfc3339());
        process.log_path = Some(log_path);
        process.error = None;
        process.self_tested = false;
        process.child = match command.spawn() {
            Ok(child) => Some(child),
            Err(error) => {
                process.status = "failed".into();
                process.error = Some(format!("启动便携 Python 失败：{error}"));
                return Err(process.error.clone().unwrap_or_default());
            }
        };
        if let Some(child) = process.child.as_ref() {
            if let Err(error) = persist_runtime_lease(&process, child.id(), port, &python, &main) {
                stop_child(&mut process);
                process.status = "failed".into();
                process.error = Some(error);
                return Err(process.error.clone().unwrap_or_default());
            }
        }

        let started = Instant::now();
        while started.elapsed() < STARTUP_DEADLINE {
            if let Some(exit) = process
                .child
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .flatten()
            {
                process.child = None;
                process.status = "failed".into();
                process.error = Some(format!(
                    "Runtime 启动期间退出，退出码 {}",
                    exit.code().unwrap_or(-1)
                ));
                return Err(process.error.clone().unwrap_or_default());
            }
            if runtime_health_ok(port) {
                process.status = "ready".into();
                return Ok(process.view());
            }
            thread::sleep(Duration::from_millis(500));
        }
        stop_child(&mut process);
        process.status = "failed".into();
        process.error = Some("Runtime 启动超过 120 秒，详细输出已保留到本地日志".into());
        Err(process.error.clone().unwrap_or_default())
    }

    /** 幂等停止当前桌面核心创建的 Runtime 子进程。 */
    pub fn stop(&self) -> Result<DesktopRuntimeStatusView, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "Runtime 状态锁已损坏".to_string())?;
        process.status = "stopping".into();
        stop_child(&mut process);
        process.status = "stopped".into();
        process.port = None;
        process.started_at = None;
        process.error = None;
        process.self_tested = false;
        Ok(process.view())
    }

    /** 验证 GPU 与核心节点后原子记录自检成功；缺少模型不会被误判为完整推理可用。 */
    pub fn self_test(
        &self,
        settings: &DesktopSettings,
        app_data_dir: &Path,
    ) -> Result<DesktopRuntimeStatusView, String> {
        self.start(settings, app_data_dir)?;
        let mut process = self
            .process
            .lock()
            .map_err(|_| "Runtime 状态锁已损坏".to_string())?;
        refresh_process_state(&mut process)?;
        if process.self_tested {
            return Ok(process.view());
        }
        let port = process
            .port
            .ok_or_else(|| "Runtime 自检缺少回环端口".to_string())?;
        let client = http_client()?;
        let system: Value = client
            .get(format!("http://127.0.0.1:{port}/system_stats"))
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.json())
            .map_err(|error| format!("Runtime GPU 自检失败：{error}"))?;
        let devices = system
            .get("devices")
            .and_then(Value::as_array)
            .ok_or_else(|| "Runtime 未返回 GPU 设备列表".to_string())?;
        if !devices
            .iter()
            .any(|device| device.get("type").and_then(Value::as_str) == Some("cuda"))
        {
            return Err("Runtime 未检测到 CUDA 执行设备".into());
        }
        let nodes: Value = client
            .get(format!("http://127.0.0.1:{port}/object_info"))
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.json())
            .map_err(|error| format!("Runtime 节点自检失败：{error}"))?;
        let missing = REQUIRED_NODES
            .into_iter()
            .filter(|node| nodes.get(*node).is_none())
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(format!("Runtime 缺少生成必需节点：{}", missing.join(", ")));
        }
        mark_runtime_ready(Path::new(&settings.runtime_root).join("current").as_path())?;
        process.status = "ready".into();
        process.error = None;
        process.self_tested = true;
        Ok(process.view())
    }
}

impl Drop for RuntimeController {
    fn drop(&mut self) {
        if let Ok(process) = self.process.get_mut() {
            stop_child(process);
        }
    }
}

impl RuntimeProcess {
    fn view(&self) -> DesktopRuntimeStatusView {
        DesktopRuntimeStatusView {
            status: self.status.clone(),
            pid: self.child.as_ref().map(Child::id),
            port: self.port,
            started_at: self.started_at.clone(),
            checked_at: Utc::now().to_rfc3339(),
            log_path: self
                .log_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            error: self.error.clone(),
        }
    }
}

fn validate_runtime_files(root: &Path, python: &Path, main: &Path) -> Result<(), String> {
    if !root.join("runtime-manifest.json").is_file() {
        return Err("Runtime 尚未完成受控安装".into());
    }
    if !python.is_file() {
        return Err("Runtime 缺少便携 Python".into());
    }
    if !main.is_file() {
        return Err("Runtime 缺少 ComfyUI 入口".into());
    }
    Ok(())
}

fn create_log_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("创建 Runtime 日志失败：{error}"))
}

fn cleanup_old_logs(directory: &Path) -> Result<(), String> {
    let mut logs = fs::read_dir(directory)
        .map_err(|error| format!("读取 Runtime 日志目录失败：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("log"))
        })
        .collect::<Vec<_>>();
    logs.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let remove_count = logs.len().saturating_sub(4);
    for entry in logs.into_iter().take(remove_count) {
        fs::remove_file(entry.path())
            .map_err(|error| format!("清理旧 Runtime 日志失败：{error}"))?;
    }
    Ok(())
}

fn write_model_path_config(path: &Path, model_root: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Runtime 配置目录失败：{error}"))?;
    }
    let escaped = model_root
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let content = format!("drawhime:\n  base_path: \"{escaped}\"\n  checkpoints: checkpoints\n  diffusion_models: diffusion_models\n  unet: diffusion_models\n  loras: loras\n  clip: text_encoders\n  text_encoders: text_encoders\n  vae: vae\n");
    fs::write(path, content).map_err(|error| format!("写入 Runtime 模型目录配置失败：{error}"))
}

fn available_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("分配 Runtime 回环端口失败：{error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("读取 Runtime 回环端口失败：{error}"))
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(HEALTH_REQUEST_TIMEOUT)
        .timeout(HEALTH_REQUEST_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|error| format!("创建 Runtime 健康客户端失败：{error}"))
}

fn runtime_health_ok(port: u16) -> bool {
    http_client()
        .ok()
        .and_then(|client| {
            client
                .get(format!("http://127.0.0.1:{port}/system_stats"))
                .send()
                .ok()
        })
        .is_some_and(|response| response.status().is_success())
}

fn refresh_process_state(process: &mut RuntimeProcess) -> Result<(), String> {
    let Some(child) = process.child.as_mut() else {
        return Ok(());
    };
    if let Some(exit) = child
        .try_wait()
        .map_err(|error| format!("读取 Runtime 进程状态失败：{error}"))?
    {
        process.child = None;
        remove_runtime_lease(process);
        process.port = None;
        process.self_tested = false;
        if !matches!(process.status.as_str(), "stopping" | "stopped") {
            process.status = "failed".into();
            process.error = Some(format!(
                "Runtime 已退出，退出码 {}",
                exit.code().unwrap_or(-1)
            ));
        }
    }
    Ok(())
}

fn stop_child(process: &mut RuntimeProcess) {
    if let Some(mut child) = process.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    remove_runtime_lease(process);
}

/** 原子记录桌面与 Runtime 进程身份，崩溃后只允许回收完全匹配的自有进程。 */
fn persist_runtime_lease(
    process: &RuntimeProcess,
    runtime_pid: u32,
    port: u16,
    runtime_executable: &Path,
    runtime_entrypoint: &Path,
) -> Result<(), String> {
    let Some(path) = process.lease_path.as_ref() else {
        return Ok(());
    };
    let owner_executable =
        std::env::current_exe().map_err(|error| format!("读取桌面进程路径失败：{error}"))?;
    let lease = RuntimeLease {
        owner_pid: std::process::id(),
        owner_executable: owner_executable.to_string_lossy().into_owned(),
        runtime_pid,
        runtime_executable: runtime_executable.to_string_lossy().into_owned(),
        runtime_entrypoint: runtime_entrypoint.to_string_lossy().into_owned(),
        port,
        started_at: Utc::now().to_rfc3339(),
    };
    let parent = path
        .parent()
        .ok_or_else(|| "Runtime 租约目录不正确".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建 Runtime 租约目录失败：{error}"))?;
    let temporary = parent.join(format!("runtime-process.{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&lease)
            .map_err(|error| format!("生成 Runtime 租约失败：{error}"))?,
    )
    .map_err(|error| format!("写入 Runtime 租约失败：{error}"))?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("切换 Runtime 租约失败：{error}"));
    }
    Ok(())
}

fn remove_runtime_lease(process: &RuntimeProcess) {
    if let Some(path) = process.lease_path.as_ref() {
        let _ = fs::remove_file(path);
    }
}

/** 校验租约、桌面宿主和 Python 命令行后回收孤儿；PID 复用或身份不符时只清理失效租约。 */
fn recover_orphan_runtime(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let metadata =
        fs::metadata(path).map_err(|error| format!("读取 Runtime 租约状态失败：{error}"))?;
    if metadata.len() == 0 || metadata.len() > RUNTIME_LEASE_MAX_BYTES {
        fs::remove_file(path).map_err(|error| format!("清理异常 Runtime 租约失败：{error}"))?;
        return Ok(());
    }
    let lease = match fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RuntimeLease>(&bytes).ok())
    {
        Some(lease) => lease,
        None => {
            fs::remove_file(path).map_err(|error| format!("清理损坏 Runtime 租约失败：{error}"))?;
            return Ok(());
        }
    };
    #[cfg(windows)]
    {
        if let Some(owner) = windows_process_identity(lease.owner_pid)? {
            if same_windows_path(&owner.executable_path, &lease.owner_executable) {
                return Err("另一个 DrawHime Desktop 实例仍在运行，请先关闭后再启动".into());
            }
        }
        if let Some(runtime) = windows_process_identity(lease.runtime_pid)? {
            if runtime_process_matches(&runtime, &lease) {
                terminate_windows_process_tree(lease.runtime_pid)?;
            }
        }
    }
    fs::remove_file(path).map_err(|error| format!("清理旧 Runtime 租约失败：{error}"))
}

#[cfg(windows)]
fn windows_process_identity(pid: u32) -> Result<Option<WindowsProcessIdentity>, String> {
    let script = format!("$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}';if($null -eq $p){{exit 3}};[ordered]@{{executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine}}|ConvertTo-Json -Compress");
    let output = hide_window(&mut Command::new("powershell.exe"))
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| format!("查询 Runtime 进程身份失败：{error}"))?;
    if output.status.code() == Some(3) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err("查询 Runtime 进程身份失败".into());
    }
    serde_json::from_slice(&output.stdout)
        .map(Some)
        .map_err(|error| format!("解析 Runtime 进程身份失败：{error}"))
}

#[cfg(windows)]
fn runtime_process_matches(identity: &WindowsProcessIdentity, lease: &RuntimeLease) -> bool {
    same_windows_path(&identity.executable_path, &lease.runtime_executable)
        && identity.command_line.to_ascii_lowercase().contains(
            &lease
                .runtime_entrypoint
                .replace('/', "\\")
                .to_ascii_lowercase(),
        )
        && identity
            .command_line
            .contains(&format!("--port {}", lease.port))
        && identity.command_line.contains("--listen 127.0.0.1")
}

#[cfg(windows)]
fn same_windows_path(left: &str, right: &str) -> bool {
    left.replace('/', "\\")
        .eq_ignore_ascii_case(&right.replace('/', "\\"))
}

#[cfg(windows)]
fn terminate_windows_process_tree(pid: u32) -> Result<(), String> {
    let status = hide_window(&mut Command::new("taskkill"))
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|error| format!("回收孤儿 Runtime 失败：{error}"))?
        .status;
    if status.success() || windows_process_identity(pid)?.is_none() {
        Ok(())
    } else {
        Err("回收孤儿 Runtime 失败".into())
    }
}

fn mark_runtime_ready(root: &Path) -> Result<(), String> {
    let manifest_path = root.join("runtime-manifest.json");
    let content = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取 Runtime 内部清单失败：{error}"))?;
    let mut manifest: Value = serde_json::from_str(&content)
        .map_err(|error| format!("解析 Runtime 内部清单失败：{error}"))?;
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| "Runtime 内部清单结构不正确".to_string())?;
    object.insert("status".into(), Value::String("ready".into()));
    object.insert(
        "selfTestedAt".into(),
        Value::String(Utc::now().to_rfc3339()),
    );
    let temporary = root.join(format!("runtime-manifest.{}.tmp", Uuid::new_v4()));
    let backup = root.join("runtime-manifest.previous.json");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("生成 Runtime 自检清单失败：{error}"))?,
    )
    .map_err(|error| format!("写入 Runtime 自检清单失败：{error}"))?;
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|error| format!("清理旧 Runtime 清单备份失败：{error}"))?;
    }
    fs::rename(&manifest_path, &backup)
        .map_err(|error| format!("备份 Runtime 清单失败：{error}"))?;
    if let Err(error) = fs::rename(&temporary, &manifest_path) {
        let _ = fs::rename(&backup, &manifest_path);
        return Err(format!("切换 Runtime 自检清单失败：{error}"));
    }
    fs::remove_file(backup).map_err(|error| format!("清理 Runtime 清单备份失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_controller_starts_stopped_without_external_process() {
        let controller = RuntimeController::new();
        let status = controller.status().expect("读取初始 Runtime 状态");
        assert_eq!(status.status, "stopped");
        assert!(status.pid.is_none());
        assert!(status.port.is_none());
    }

    #[test]
    fn corrupt_runtime_lease_is_removed_without_touching_processes() {
        let temporary = tempfile::tempdir().expect("创建损坏租约目录");
        let lease = temporary.path().join("runtime-process.json");
        fs::write(&lease, b"broken").expect("写入损坏租约");
        recover_orphan_runtime(&lease).expect("清理损坏租约");
        assert!(!lease.exists());
    }

    #[cfg(windows)]
    #[test]
    fn runtime_lease_requires_exact_executable_entrypoint_and_port() {
        let lease = RuntimeLease {
            owner_pid: 1,
            owner_executable: r"C:\DrawHime\drawhime-desktop.exe".into(),
            runtime_pid: 2,
            runtime_executable: r"C:\Runtime\python.exe".into(),
            runtime_entrypoint: r"C:\Runtime\ComfyUI\main.py".into(),
            port: 50123,
            started_at: Utc::now().to_rfc3339(),
        };
        let matching = WindowsProcessIdentity { executable_path: r"c:\runtime\PYTHON.EXE".into(), command_line: r#""C:\Runtime\python.exe" -s C:\Runtime\ComfyUI\main.py --listen 127.0.0.1 --port 50123"#.into() };
        assert!(runtime_process_matches(&matching, &lease));
        let reused_pid = WindowsProcessIdentity {
            executable_path: r"C:\Windows\python.exe".into(),
            command_line: matching.command_line.clone(),
        };
        assert!(!runtime_process_matches(&reused_pid, &lease));
    }

    #[test]
    fn runtime_start_rejects_incomplete_installation() {
        let temporary = tempfile::tempdir().expect("创建临时 Runtime 目录");
        let settings = DesktopSettings {
            theme_mode: "system".into(),
            font_scale: 1.1,
            default_privacy: "private".into(),
            auto_upload: true,
            model_root: temporary
                .path()
                .join("models")
                .to_string_lossy()
                .into_owned(),
            output_root: temporary
                .path()
                .join("outputs")
                .to_string_lossy()
                .into_owned(),
            runtime_root: temporary
                .path()
                .join("runtime")
                .to_string_lossy()
                .into_owned(),
            upload_concurrency: 2,
            wifi_only: false,
            bandwidth_limit_kib: None,
        };
        let error = RuntimeController::new()
            .start(&settings, temporary.path())
            .expect_err("缺失 Runtime 应拒绝启动");
        assert!(error.contains("Runtime"));
    }

    #[test]
    fn installed_runtime_passes_real_lifecycle_self_test() {
        let Ok(runtime_root) = std::env::var("DRAWHIME_RUNTIME_LIFECYCLE_TEST_ROOT") else {
            return;
        };
        let temporary = tempfile::tempdir().expect("创建 Runtime 自检数据目录");
        let settings = DesktopSettings {
            theme_mode: "system".into(),
            font_scale: 1.1,
            default_privacy: "private".into(),
            auto_upload: true,
            model_root: temporary
                .path()
                .join("models")
                .to_string_lossy()
                .into_owned(),
            output_root: temporary
                .path()
                .join("outputs")
                .to_string_lossy()
                .into_owned(),
            runtime_root,
            upload_concurrency: 2,
            wifi_only: false,
            bandwidth_limit_kib: None,
        };
        let controller = RuntimeController::new();
        let ready = controller
            .self_test(&settings, temporary.path())
            .expect("真实 Runtime 自检通过");
        assert_eq!(ready.status, "ready");
        assert!(ready.pid.is_some());
        assert!(ready.port.is_some());
        assert_eq!(
            controller.stop().expect("停止真实 Runtime").status,
            "stopped"
        );
    }
}
