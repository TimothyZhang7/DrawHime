//! 本模块管理桌面端唯一 ComfyUI 子进程，负责回环启动、健康探测、自检、日志与退出回收。

use crate::{
    environment::{BACKEND_AMD_DIRECTML, BACKEND_NVIDIA_CUDA},
    models::{DesktopRuntimeStatusView, DesktopSettings, RuntimeCapabilitiesView},
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
const REQUIRED_NODES: [&str; 9] = [
    "UNETLoader",
    "CLIPLoader",
    "VAELoader",
    "CLIPTextEncode",
    "EmptyLatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
    "LoraLoader",
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
    backend: Option<String>,
    device_index: Option<u32>,
    launch_profile: Option<String>,
    error: Option<String>,
    self_tested: bool,
    lease_path: Option<PathBuf>,
}

/** 安装器写入的 Runtime 清单只允许受控入口与启动 profile。 */
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledRuntimeManifest {
    resource_id: String,
    backend: Option<String>,
    launch_profile: Option<String>,
    python_executable: Option<String>,
    entrypoint: Option<String>,
    capabilities: Option<RuntimeCapabilitiesView>,
}

/** 旧清单迁移后或新清单解析后的实际启动参数来源。 */
struct ResolvedRuntimeProfile {
    backend: String,
    launch_profile: String,
    python_executable: String,
    entrypoint: String,
    capabilities: RuntimeCapabilitiesView,
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
                backend: None,
                device_index: None,
                launch_profile: None,
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
        let selected = crate::environment::preferred_execution_backend_view();
        let selected_backend = selected.id;
        if process.status == "ready" {
            if process.port.is_some_and(runtime_health_ok)
                && process.backend.as_deref() == Some(selected_backend.as_str())
                && process.device_index == selected.device_index
            {
                return Ok(process.view());
            }
            // 显卡或驱动变化后不得继续复用另一后端的旧进程。
            stop_child(&mut process);
        }

        let runtime_root = Path::new(&settings.runtime_root).join("current");
        let profile = read_runtime_profile(&runtime_root)?;
        if profile.backend != selected_backend {
            return Err(format!(
                "当前已安装 Runtime 属于 {}，与自动选择的 {} 后端不匹配，请先安装对应运行环境",
                profile.backend, selected_backend
            ));
        }
        let python = controlled_runtime_path(&runtime_root, &profile.python_executable)?;
        let entrypoint = controlled_runtime_path(&runtime_root, &profile.entrypoint)?;
        validate_runtime_files(&runtime_root, &python, &entrypoint)?;
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

        let entrypoint_argument = entrypoint.to_string_lossy().into_owned();
        let port_argument = port.to_string();
        let config_argument = config_path.to_string_lossy().into_owned();
        let output_argument = output_directory.to_string_lossy().into_owned();
        let mut command = Command::new(&python);
        hide_window(&mut command);
        command
            .current_dir(&runtime_root)
            .args(["-s", entrypoint_argument.as_str()]);
        append_launch_profile_arguments(&mut command, &profile, selected.device_index)?;
        command
            .args([
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
        process.backend = Some(profile.backend.clone());
        process.device_index = selected.device_index;
        process.launch_profile = Some(profile.launch_profile.clone());
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
            if let Err(error) =
                persist_runtime_lease(&process, child.id(), port, &python, &entrypoint)
            {
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
        process.backend = None;
        process.device_index = None;
        process.launch_profile = None;
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
        let backend = process
            .backend
            .as_deref()
            .ok_or_else(|| "Runtime 未记录执行后端".to_string())?;
        validate_runtime_device(devices, backend)?;
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
            backend: self.backend.clone(),
            device_index: self.device_index,
            launch_profile: self.launch_profile.clone(),
            error: self.error.clone(),
        }
    }
}

/** 读取并迁移受控 Runtime profile；未知后端或入口直接拒绝。 */
fn read_runtime_profile(root: &Path) -> Result<ResolvedRuntimeProfile, String> {
    let path = root.join("runtime-manifest.json");
    let manifest: InstalledRuntimeManifest = serde_json::from_slice(
        &fs::read(&path).map_err(|error| format!("读取 Runtime 内部清单失败：{error}"))?,
    )
    .map_err(|error| format!("解析 Runtime 内部清单失败：{error}"))?;
    let legacy_nvidia = manifest.resource_id.contains("nvidia") && manifest.backend.is_none();
    let backend = manifest
        .backend
        .or_else(|| legacy_nvidia.then(|| BACKEND_NVIDIA_CUDA.into()))
        .ok_or_else(|| "Runtime 清单缺少执行后端".to_string())?;
    let launch_profile = manifest
        .launch_profile
        .or_else(|| legacy_nvidia.then(|| "nvidia-cuda126".into()))
        .ok_or_else(|| "Runtime 清单缺少启动 profile".to_string())?;
    let python_executable = manifest
        .python_executable
        .unwrap_or_else(|| "python_embeded/python.exe".into());
    let entrypoint = manifest
        .entrypoint
        .unwrap_or_else(|| "ComfyUI/main.py".into());
    let capabilities = manifest.capabilities.unwrap_or(RuntimeCapabilitiesView {
        inference: true,
        training: legacy_nvidia,
        cpu_vae_required: false,
        fp32_unet_required: false,
        max_validated_edge: 1536,
        max_validated_batch: 1,
        max_validated_loras: 64,
    });
    let valid = matches!(
        (backend.as_str(), launch_profile.as_str()),
        (BACKEND_NVIDIA_CUDA, "nvidia-cuda126") | (BACKEND_AMD_DIRECTML, "anima-directml-fp32")
    );
    if !valid || !capabilities.inference {
        return Err("Runtime 清单声明了不受支持的执行后端或启动 profile".into());
    }
    Ok(ResolvedRuntimeProfile {
        backend,
        launch_profile,
        python_executable,
        entrypoint,
        capabilities,
    })
}

/** 服务端清单不能下发任意参数，所有 profile 都由客户端固定映射。 */
fn append_launch_profile_arguments(
    command: &mut Command,
    profile: &ResolvedRuntimeProfile,
    device_index: Option<u32>,
) -> Result<(), String> {
    match profile.launch_profile.as_str() {
        "nvidia-cuda126" => {
            let index =
                device_index.ok_or_else(|| "NVIDIA CUDA profile 缺少已选择设备索引".to_string())?;
            let index_argument = index.to_string();
            command.args(["--cuda-device", index_argument.as_str()]);
            Ok(())
        }
        "anima-directml-fp32"
            if profile.capabilities.cpu_vae_required && profile.capabilities.fp32_unet_required =>
        {
            command.args([
                "--directml",
                "0",
                "--cpu-vae",
                "--fp32-unet",
                "--use-split-cross-attention",
            ]);
            Ok(())
        }
        "anima-directml-fp32" => {
            Err("AMD Runtime 能力清单缺少 FP32 UNet 或 CPU VAE 强制门禁".into())
        }
        _ => Err("Runtime 启动 profile 不受支持".into()),
    }
}

/** 按后端验证真实 ComfyUI 设备类型和厂商，拒绝选错混合显卡。 */
fn validate_runtime_device(devices: &[Value], backend: &str) -> Result<(), String> {
    let matched = devices.iter().any(|device| {
        let device_type = device
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let name = device
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        match backend {
            BACKEND_NVIDIA_CUDA => {
                device_type == "cuda"
                    && (name.is_empty() || name.contains("nvidia") || name.contains("cuda"))
            }
            BACKEND_AMD_DIRECTML => {
                matches!(device_type.as_str(), "privateuseone" | "directml")
                    && (name.is_empty()
                        || name == "privateuseone"
                        || name.contains("amd")
                        || name.contains("radeon")
                        || name.contains("directml"))
            }
            _ => false,
        }
    });
    if matched {
        Ok(())
    } else if backend == BACKEND_AMD_DIRECTML {
        Err("Runtime 未检测到与当前 AMD 显卡匹配的 DirectML 执行设备".into())
    } else {
        Err("Runtime 未检测到与当前 NVIDIA 显卡匹配的 CUDA 执行设备".into())
    }
}

/** Runtime profile 只允许安装目录内的普通相对路径。 */
fn controlled_runtime_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Runtime profile 包含不安全入口路径".into());
    }
    Ok(root.join(path))
}

fn validate_runtime_files(root: &Path, python: &Path, entrypoint: &Path) -> Result<(), String> {
    if !root.join("runtime-manifest.json").is_file() {
        return Err("Runtime 尚未完成受控安装".into());
    }
    if !python.is_file() {
        return Err("Runtime 缺少便携 Python".into());
    }
    if !entrypoint.is_file() {
        return Err("Runtime 缺少受控启动入口".into());
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

    fn directml_profile() -> ResolvedRuntimeProfile {
        ResolvedRuntimeProfile {
            backend: BACKEND_AMD_DIRECTML.into(),
            launch_profile: "anima-directml-fp32".into(),
            python_executable: "python_embeded/python.exe".into(),
            entrypoint: "directml_runner.py".into(),
            capabilities: RuntimeCapabilitiesView {
                inference: true,
                training: false,
                cpu_vae_required: true,
                fp32_unet_required: true,
                max_validated_edge: 512,
                max_validated_batch: 1,
                max_validated_loras: 1,
            },
        }
    }

    fn nvidia_profile() -> ResolvedRuntimeProfile {
        ResolvedRuntimeProfile {
            backend: BACKEND_NVIDIA_CUDA.into(),
            launch_profile: "nvidia-cuda126".into(),
            python_executable: "python_embeded/python.exe".into(),
            entrypoint: "ComfyUI/main.py".into(),
            capabilities: RuntimeCapabilitiesView {
                inference: true,
                training: true,
                cpu_vae_required: false,
                fp32_unet_required: false,
                max_validated_edge: 1536,
                max_validated_batch: 1,
                max_validated_loras: 64,
            },
        }
    }

    #[test]
    fn cuda_profile_uses_selected_nvidia_device_index() {
        let mut command = Command::new("python.exe");
        append_launch_profile_arguments(&mut command, &nvidia_profile(), Some(2))
            .expect("CUDA profile 参数有效");
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments, ["--cuda-device", "2"]);
        assert!(append_launch_profile_arguments(
            &mut Command::new("python.exe"),
            &nvidia_profile(),
            None
        )
        .is_err());
    }

    #[test]
    fn directml_profile_uses_only_verified_arguments() {
        let mut command = Command::new("python.exe");
        append_launch_profile_arguments(&mut command, &directml_profile(), None)
            .expect("DirectML profile 参数有效");
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            arguments,
            [
                "--directml",
                "0",
                "--cpu-vae",
                "--fp32-unet",
                "--use-split-cross-attention"
            ]
        );
        let mut unsafe_profile = directml_profile();
        unsafe_profile.capabilities.fp32_unet_required = false;
        assert!(append_launch_profile_arguments(
            &mut Command::new("python.exe"),
            &unsafe_profile,
            None,
        )
        .is_err());
    }

    #[test]
    fn runtime_device_validation_distinguishes_cuda_and_directml() {
        let cuda = serde_json::json!({ "type": "cuda", "name": "NVIDIA GeForce RTX" });
        // ComfyUI 在真实 DirectML 日志中会把设备名收敛为 privateuseone，厂商选择由受控 Runner 先完成。
        let directml = serde_json::json!({ "type": "privateuseone", "name": "privateuseone" });
        assert!(validate_runtime_device(&[cuda.clone()], BACKEND_NVIDIA_CUDA).is_ok());
        assert!(validate_runtime_device(&[directml.clone()], BACKEND_AMD_DIRECTML).is_ok());
        assert!(validate_runtime_device(&[cuda], BACKEND_AMD_DIRECTML).is_err());
        assert!(validate_runtime_device(&[directml], BACKEND_NVIDIA_CUDA).is_err());
    }

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
            content_font_scale: 1.2,
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
            content_font_scale: 1.2,
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
