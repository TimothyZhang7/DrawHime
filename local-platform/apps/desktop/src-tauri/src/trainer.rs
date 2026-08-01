//! 本模块执行签名 Trainer 组件、串行占用 GPU、持久化训练进度并把有效 safetensors 登记为本地 LoRA。

use crate::{
    local_model,
    models::{DesktopLocalLoraImportInput, DesktopSettings, DesktopTrainingSuggestionView},
    process::hide_window,
    runtime::RuntimeController,
    training::{self, TrainingExecution},
    workload::GpuWorkloadCoordinator,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::AppHandle;

const MAX_RUNNER_LINE_BYTES: usize = 256 * 1024;
const MAX_RUNNER_ERROR_BYTES: usize = 32 * 1024;
const TRAINER_RESOURCE_ID: &str = "trainer.anima-sd-scripts";
const MINIMUM_TRAINER_PROTOCOL_VERSION: u32 = 2;

/** 应用生命周期内唯一的本地 LoRA 训练 Worker。 */
pub struct TrainingScheduler {
    stopping: Arc<AtomicBool>,
    wake_signal: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}

struct TrainerComponent {
    python: PathBuf,
    root: PathBuf,
    runner: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrainerInstallMarker {
    resource_id: String,
    version: String,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainerRequest {
    job_id: String,
    output_name: String,
    workspace: String,
    model_path: String,
    text_encoder_path: String,
    vae_path: String,
    parameters: crate::models::DesktopTrainingParameters,
    assets: Vec<TrainerAssetRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainerAssetRequest {
    path: String,
    sha256: String,
    byte_size: u64,
    caption: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrainerEvent {
    kind: String,
    progress: Option<u32>,
    current_epoch: Option<u32>,
    path: Option<String>,
    message: Option<String>,
    oom: Option<bool>,
}

enum TrainingStop {
    Application,
    Cancelled,
    Failed { message: String, oom: bool },
}

impl TrainingScheduler {
    /** 启动使用独立 SQLite 连接的训练 Worker。 */
    pub fn start(
        database_path: PathBuf,
        app_data_dir: PathBuf,
        runtime: Arc<RuntimeController>,
        gpu_workload: Arc<GpuWorkloadCoordinator>,
        app: AppHandle,
    ) -> Result<Self, String> {
        let stopping = Arc::new(AtomicBool::new(false));
        let wake_signal = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_stopping = stopping.clone();
        let worker_signal = wake_signal.clone();
        // 训练调度需要处理较深的进程、日志和快照调用链，保留独立栈避免影响 UI 进程。
        let worker = thread::Builder::new()
            .name("drawhime-training-scheduler".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                training_loop(
                    &database_path,
                    &app_data_dir,
                    &runtime,
                    &gpu_workload,
                    &app,
                    &worker_stopping,
                    &worker_signal,
                )
            })
            .map_err(|error| format!("启动本地训练线程失败：{error}"))?;
        Ok(Self {
            stopping,
            wake_signal,
            worker: Some(worker),
        })
    }

    /** 唤醒等待中的训练 Worker。 */
    pub fn wake(&self) {
        let (lock, condition) = &*self.wake_signal;
        if let Ok(mut pending) = lock.lock() {
            *pending = true;
            condition.notify_one();
        }
    }
}

impl Drop for TrainingScheduler {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.wake();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn training_loop(
    database_path: &Path,
    app_data_dir: &Path,
    runtime: &RuntimeController,
    gpu_workload: &Arc<GpuWorkloadCoordinator>,
    app: &AppHandle,
    stopping: &AtomicBool,
    wake_signal: &(Mutex<bool>, Condvar),
) {
    let Ok(mut database) = Connection::open(database_path) else {
        return;
    };
    let _ = database.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    while !stopping.load(Ordering::SeqCst) {
        let Some(gpu_guard) = gpu_workload.acquire(stopping) else {
            break;
        };
        match training::claim_next_job(&mut database) {
            Ok(Some(job)) => {
                execute_job(&database, app_data_dir, runtime, app, stopping, job);
                drop(gpu_guard);
            }
            Ok(None) => {
                drop(gpu_guard);
                wait_for_work(wake_signal, stopping);
            }
            Err(_) => {
                drop(gpu_guard);
                thread::sleep(Duration::from_secs(2));
            }
        }
    }
}

fn execute_job(
    database: &Connection,
    app_data_dir: &Path,
    runtime: &RuntimeController,
    app: &AppHandle,
    stopping: &AtomicBool,
    job: TrainingExecution,
) {
    training::emit_job(database, app, &job.id);
    let result = execute_runner(database, app_data_dir, runtime, app, stopping, &job);
    let terminal = match result {
        Ok(registration) => training::finish_success(database, &job, registration),
        Err(TrainingStop::Application) => training::requeue_interrupted(database, &job),
        Err(TrainingStop::Cancelled) => training::finish_cancelled(database, &job),
        Err(TrainingStop::Failed { message, oom }) => {
            training::finish_failed(database, &job, &message, oom.then(|| oom_suggestion(&job)))
        }
    };
    if terminal.is_ok() {
        training::emit_job(database, app, &job.id);
    }
}

fn execute_runner(
    database: &Connection,
    app_data_dir: &Path,
    runtime: &RuntimeController,
    app: &AppHandle,
    stopping: &AtomicBool,
    job: &TrainingExecution,
) -> Result<crate::storage::LocalLoraRegistration, TrainingStop> {
    let settings = load_settings(database).map_err(failed)?;
    let component = find_trainer_component(&settings.runtime_root).map_err(failed)?;
    validate_execution_files(app_data_dir, Path::new(&settings.model_root), job).map_err(failed)?;
    // 只有所有快照和签名组件已确认可执行后才停止 ComfyUI，避免错误提交打断用户可用 Runtime。
    runtime.stop().map_err(failed)?;
    let workspace = app_data_dir
        .join("training-workspaces")
        .join(&job.id)
        .join(&job.attempt_id);
    fs::create_dir_all(&workspace)
        .map_err(|error| failed(format!("创建训练工作目录失败：{error}")))?;
    let request_path = workspace.join("request.json");
    let mut protected_parameters = job.parameters.clone();
    // Caption 打乱时至少保留全部用户触发词，避免角色身份锚点被随机拆散。
    protected_parameters.keep_tokens =
        protected_keep_tokens(protected_parameters.keep_tokens, &job.trigger_words);
    let request = TrainerRequest {
        job_id: job.id.clone(),
        output_name: safe_output_name(&job.id),
        workspace: workspace.to_string_lossy().into_owned(),
        model_path: Path::new(&settings.model_root)
            .join(&job.model_relative_path)
            .to_string_lossy()
            .into_owned(),
        text_encoder_path: Path::new(&settings.model_root)
            .join(&job.text_encoder_relative_path)
            .to_string_lossy()
            .into_owned(),
        vae_path: Path::new(&settings.model_root)
            .join(&job.vae_relative_path)
            .to_string_lossy()
            .into_owned(),
        parameters: protected_parameters,
        assets: job
            .assets
            .iter()
            .map(|asset| TrainerAssetRequest {
                path: app_data_dir
                    .join(&asset.relative_path)
                    .to_string_lossy()
                    .into_owned(),
                sha256: asset.sha256.clone(),
                byte_size: asset.byte_size,
                caption: compose_caption(&asset.caption, &job.trigger_words),
            })
            .collect(),
    };
    write_request(&request_path, &request).map_err(failed)?;
    // 排队期间显卡或驱动可能变化，执行前再次锁定与生成链路相同的 NVIDIA 设备。
    let selected_backend = crate::environment::preferred_execution_backend_view();
    let cuda_device = training_cuda_device(&selected_backend.id, selected_backend.device_index)
        .map_err(failed)?;
    let mut command = Command::new(&component.python);
    command
        .args([
            "-I",
            component.runner.to_string_lossy().as_ref(),
            "--request",
            request_path.to_string_lossy().as_ref(),
        ])
        .current_dir(&component.root)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8:replace")
        .env("PYTHONNOUSERSITE", "1")
        .env("CUDA_VISIBLE_DEVICES", cuda_device)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| failed(format!("启动本地 Trainer 失败：{error}")))?;
    let stderr = child.stderr.take();
    let stderr_reader = thread::spawn(move || read_limited_stderr(stderr));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failed("Trainer 没有标准输出"))?;
    let (sender, receiver) = mpsc::sync_channel::<Result<String, String>>(32);
    let stdout_reader = thread::spawn(move || read_runner_lines(stdout, sender));
    let mut output_path = None;
    let mut runner_error: Option<(String, bool)> = None;
    loop {
        if stopping.load(Ordering::SeqCst) {
            kill_process_tree(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let _ = fs::remove_file(&request_path);
            return Err(TrainingStop::Application);
        }
        if training::cancel_requested(database, &job.id) {
            kill_process_tree(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let _ = fs::remove_file(&request_path);
            return Err(TrainingStop::Cancelled);
        }
        match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(Ok(line)) => {
                let event: TrainerEvent =
                    serde_json::from_str(&line).map_err(|_| failed("Trainer 返回了无效进度"))?;
                match event.kind.as_str() {
                    "progress" => {
                        training::update_progress(
                            database,
                            &job.id,
                            event.progress.unwrap_or(1),
                            event.current_epoch.unwrap_or(0),
                        )
                        .map_err(failed)?;
                        training::emit_job(database, app, &job.id);
                    }
                    "result" => output_path = event.path.map(PathBuf::from),
                    "error" => {
                        runner_error = Some((
                            event.message.unwrap_or_else(|| "本地训练失败".into()),
                            event.oom.unwrap_or(false),
                        ))
                    }
                    _ => return Err(failed("Trainer 返回了未知事件")),
                }
            }
            Ok(Err(error)) => {
                kill_process_tree(&mut child);
                return Err(failed(error));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = child
        .wait()
        .map_err(|error| failed(format!("等待 Trainer 退出失败：{error}")))?;
    let _ = stdout_reader.join();
    let stderr = stderr_reader.join().unwrap_or_default();
    let _ = fs::remove_file(&request_path);
    if !status.success() {
        let (message, oom) =
            runner_error.unwrap_or_else(|| classify_runner_error(&stderr, &component));
        return Err(TrainingStop::Failed { message, oom });
    }
    let output_path = output_path.ok_or_else(|| failed("Trainer 完成但没有返回 LoRA 产物"))?;
    validate_output_path(&workspace, &output_path).map_err(failed)?;
    let mut registration = local_model::import_local_lora(
        &settings,
        DesktopLocalLoraImportInput {
            title: job.title.clone(),
            r#type: job.r#type.clone(),
            source_path: output_path.to_string_lossy().into_owned(),
            trigger_words: job.trigger_words.clone(),
        },
    )
    .map_err(failed)?;
    // 本机训练产物必须绑定训练时的精确底模，避免切换同系列微调模型后角色失真。
    registration.base_model_sha256 = Some(job.model_sha256.clone());
    Ok(registration)
}

/** Trainer 当前只接受 CUDA；设备索引来自统一硬件选择，不能回落默认 0 号卡。 */
fn training_cuda_device(backend: &str, device_index: Option<u32>) -> Result<String, String> {
    if backend != crate::environment::BACKEND_NVIDIA_CUDA {
        return Err("当前 GPU 后端不支持 Windows LoRA 训练".into());
    }
    device_index
        .map(|index| index.to_string())
        .ok_or_else(|| "NVIDIA 训练链路缺少已选择设备索引".into())
}

fn validate_execution_files(
    app_data_dir: &Path,
    model_root: &Path,
    job: &TrainingExecution,
) -> Result<(), String> {
    validate_snapshot(
        &model_root.join(&job.model_relative_path),
        &job.model_sha256,
        Some(job.model_byte_size),
        Some(job.model_modified_ms),
    )?;
    validate_snapshot(
        &model_root.join(&job.text_encoder_relative_path),
        &job.text_encoder_sha256,
        None,
        None,
    )?;
    validate_snapshot(
        &model_root.join(&job.vae_relative_path),
        &job.vae_sha256,
        None,
        None,
    )?;
    for asset in &job.assets {
        validate_snapshot(
            &app_data_dir.join(&asset.relative_path),
            &asset.sha256,
            Some(asset.byte_size),
            None,
        )?;
    }
    Ok(())
}

fn validate_snapshot(
    path: &Path,
    expected_hash: &str,
    expected_size: Option<u64>,
    expected_modified_ms: Option<u64>,
) -> Result<(), String> {
    let metadata = path
        .metadata()
        .map_err(|_| "训练任务快照文件缺失".to_string())?;
    if !metadata.is_file() || expected_size.is_some_and(|value| value != metadata.len()) {
        return Err("训练任务快照文件大小已经变化".into());
    }
    if expected_modified_ms.is_some_and(|value| modified_millis(&metadata).ok() != Some(value)) {
        return Err("训练底模修改时间已经变化".into());
    }
    if sha256_file(path)? != expected_hash {
        return Err("训练任务快照文件 SHA-256 已变化".into());
    }
    Ok(())
}

fn find_trainer_component(runtime_root: &str) -> Result<TrainerComponent, String> {
    let runtime_root = Path::new(runtime_root);
    let python = runtime_root
        .join("current")
        .join("python_embeded")
        .join("python.exe");
    if !python.is_file() {
        return Err("本地 Runtime 的私有 Python 尚未安装".into());
    }
    let root = find_compatible_trainer_root(runtime_root)?;
    Ok(TrainerComponent {
        python,
        runner: root.join("runner.py"),
        root,
    })
}

/** 环境检测与任务执行共用同一 Trainer 协议门禁，避免界面显示可用后才在子进程中失败。 */
pub(crate) fn has_compatible_component(runtime_root: &str) -> bool {
    find_compatible_trainer_root(Path::new(runtime_root)).is_ok()
}

fn find_compatible_trainer_root(runtime_root: &Path) -> Result<PathBuf, String> {
    let components_root = runtime_root.join("components").join("trainer");
    let candidates = fs::read_dir(&components_root)
        .map_err(|_| "签名 Trainer 组件尚未安装".to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| trainer_component_complete(path))
        .collect::<Vec<_>>();
    let selected = candidates
        .iter()
        .filter_map(|path| trainer_protocol_version(path).map(|protocol| (protocol, path)))
        .max_by_key(|(protocol, _)| *protocol);
    if let Some((_, root)) = selected {
        return Ok(root.clone());
    }
    if candidates.is_empty() {
        Err("Trainer 组件文件不完整，请在资源安装页执行修复".into())
    } else {
        Err(format!("Trainer 组件协议版本过旧，请在资源安装页修复并安装 v{MINIMUM_TRAINER_PROTOCOL_VERSION} 或更高版本"))
    }
}

fn trainer_component_complete(root: &Path) -> bool {
    root.join(".drawhime-resource.json").is_file()
        && root.join("runner.py").is_file()
        && root
            .join("sd-scripts")
            .join("anima_train_network.py")
            .is_file()
        && root.join("site-packages").join("accelerate").is_dir()
}

fn trainer_protocol_version(root: &Path) -> Option<u32> {
    let marker = fs::read(root.join(".drawhime-resource.json"))
        .ok()
        .and_then(|content| serde_json::from_slice::<TrainerInstallMarker>(&content).ok())?;
    if marker.resource_id != TRAINER_RESOURCE_ID
        || marker.sha256.len() != 64
        || !marker
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return None;
    }
    let protocol = marker.version.rsplit_once("-v")?.1.parse::<u32>().ok()?;
    (protocol >= MINIMUM_TRAINER_PROTOCOL_VERSION).then_some(protocol)
}

fn validate_output_path(workspace: &Path, output: &Path) -> Result<(), String> {
    let root =
        fs::canonicalize(workspace).map_err(|error| format!("读取训练工作目录失败：{error}"))?;
    let output = fs::canonicalize(output).map_err(|_| "训练 LoRA 产物不存在".to_string())?;
    if !output.starts_with(&root)
        || output
            .extension()
            .is_none_or(|value| !value.to_string_lossy().eq_ignore_ascii_case("safetensors"))
    {
        return Err("Trainer 返回了工作目录外的产物".into());
    }
    Ok(())
}

fn compose_caption(caption: &str, trigger_words: &[String]) -> String {
    let existing = caption
        .split([',', '，', '\n', ';', '；'])
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::HashSet<_>>();
    trigger_words
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && !existing.contains(&value.to_lowercase()))
        .chain(std::iter::once(caption.trim()))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/** 触发词保护数量不低于有效触发词数，并受契约上限约束。 */
fn protected_keep_tokens(configured: u32, trigger_words: &[String]) -> u32 {
    let required = trigger_words
        .iter()
        .filter(|value| !value.trim().is_empty())
        .count()
        .min(10) as u32;
    configured.max(required).min(10)
}

fn oom_suggestion(job: &TrainingExecution) -> DesktopTrainingSuggestionView {
    let resolution = match job.parameters.resolution {
        value if value > 1024 => Some(1024),
        value if value > 768 => Some(768),
        value if value > 512 => Some(512),
        _ => None,
    };
    let rank = match job.parameters.rank {
        value if value > 32 => Some(32),
        value if value > 16 => Some(16),
        value if value > 8 => Some(8),
        _ => None,
    };
    DesktopTrainingSuggestionView {
        message: "GPU 显存不足；优先应用建议分辨率，其次降低 Rank，并关闭其他占用 GPU 的程序。"
            .into(),
        resolution,
        rank,
    }
}

fn write_request(path: &Path, request: &TrainerRequest) -> Result<(), String> {
    let temporary = path.with_extension("json.writing");
    let mut file =
        File::create(&temporary).map_err(|error| format!("创建 Trainer 请求失败：{error}"))?;
    serde_json::to_writer(&mut file, request)
        .map_err(|error| format!("序列化 Trainer 请求失败：{error}"))?;
    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("保存 Trainer 请求失败：{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("提交 Trainer 请求失败：{error}"))
}

fn read_runner_lines(stdout: impl Read, sender: mpsc::SyncSender<Result<String, String>>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut bytes = Vec::new();
        let read = match reader.read_until(b'\n', &mut bytes) {
            Ok(read) => read,
            Err(error) => {
                let _ = sender.send(Err(format!("读取 Trainer 进度失败：{error}")));
                break;
            }
        };
        if read == 0 {
            break;
        }
        if bytes.len() > MAX_RUNNER_LINE_BYTES {
            let _ = sender.send(Err("Trainer 单条进度超过限制".into()));
            break;
        }
        while matches!(bytes.last(), Some(b'\n' | b'\r')) {
            bytes.pop();
        }
        // Python 依赖偶尔向 stdout 写入本地代码页字节；仅提取 JSON 事件，非协议日志由 stderr 负责展示。
        let text = String::from_utf8_lossy(&bytes);
        let Some(start) = text.find('{') else {
            continue;
        };
        let Some(end) = text.rfind('}') else {
            continue;
        };
        let candidate = &text[start..=end];
        // 原生依赖可能输出带花括号的本地代码页日志；只把完整协议事件交给任务状态机。
        if serde_json::from_str::<TrainerEvent>(candidate).is_err() {
            continue;
        }
        if sender.send(Ok(candidate.to_string())).is_err() {
            break;
        }
    }
}

fn read_limited_stderr(stderr: Option<impl Read>) -> String {
    let Some(mut stderr) = stderr else {
        return String::new();
    };
    let mut bytes = Vec::new();
    let _ = stderr
        .by_ref()
        .take(MAX_RUNNER_ERROR_BYTES as u64)
        .read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn classify_runner_error(stderr: &str, component: &TrainerComponent) -> (String, bool) {
    let text = stderr.replace(component.root.to_string_lossy().as_ref(), "<TRAINER>");
    let oom = text.contains("CUDA out of memory") || text.contains("OutOfMemoryError");
    let message = if oom {
        "GPU 显存不足，训练进程已安全停止".into()
    } else {
        text.lines()
            .last()
            .unwrap_or("Trainer 进程异常退出")
            .trim()
            .chars()
            .take(800)
            .collect()
    };
    (message, oom)
}

fn kill_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = hide_window(&mut Command::new("taskkill"))
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn load_settings(database: &Connection) -> Result<DesktopSettings, String> {
    database.query_row("SELECT theme_mode,font_scale,default_privacy,auto_upload,model_root,output_root,runtime_root,upload_concurrency,wifi_only,bandwidth_limit_kib FROM desktop_settings WHERE id=1", [], |row| Ok(DesktopSettings { theme_mode: row.get(0)?, font_scale: row.get(1)?, content_font_scale: 1.2, default_privacy: row.get(2)?, auto_upload: row.get::<_,i64>(3)? != 0, model_root: row.get(4)?, output_root: row.get(5)?, runtime_root: row.get(6)?, upload_concurrency: row.get(7)?, wifi_only: row.get::<_,i64>(8)? != 0, bandwidth_limit_kib: row.get(9)? })).map_err(|error| format!("读取 Trainer 设置失败：{error}"))
}
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut reader =
        BufReader::new(File::open(path).map_err(|error| format!("读取训练快照失败：{error}"))?);
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("计算训练快照哈希失败：{error}"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}
fn modified_millis(metadata: &fs::Metadata) -> Result<u64, String> {
    metadata
        .modified()
        .map_err(|error| format!("读取训练底模修改时间失败：{error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| "训练底模修改时间早于系统纪元".to_string())
}
fn safe_output_name(id: &str) -> String {
    format!("drawhime-{}", id.replace('-', ""))
}
fn failed(message: impl Into<String>) -> TrainingStop {
    TrainingStop::Failed {
        message: message.into(),
        oom: false,
    }
}
fn wait_for_work(wake_signal: &(Mutex<bool>, Condvar), stopping: &AtomicBool) {
    let (lock, condition) = wake_signal;
    if let Ok(pending) = lock.lock() {
        if !*pending && !stopping.load(Ordering::SeqCst) {
            let _ = condition.wait_timeout(pending, Duration::from_secs(2));
        }
    }
    if let Ok(mut pending) = lock.lock() {
        *pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trainer_progress_ignores_non_utf8_noise_and_keeps_json_event() {
        let input =
            b"\xff\xfe native {progress} noise\r\nlog: {\"kind\":\"progress\",\"progress\":42}\r\n";
        let (sender, receiver) = mpsc::sync_channel(4);
        read_runner_lines(input.as_slice(), sender);
        let line = receiver
            .recv()
            .expect("读取 Trainer JSON 事件")
            .expect("事件解析前读取成功");
        let event: TrainerEvent = serde_json::from_str(&line).expect("解析 Trainer JSON 事件");
        assert_eq!(event.kind, "progress");
        assert_eq!(event.progress, Some(42));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn trainer_selects_compatible_protocol_instead_of_directory_time() {
        let temporary = tempfile::tempdir().expect("创建 Trainer 选择测试目录");
        let components = temporary.path().join("components/trainer");
        write_test_component(&components.join("legacy"), "anima-sd-scripts-test-py312-v1");
        let compatible = components.join("current");
        write_test_component(&compatible, "anima-sd-scripts-test-py312-v2");
        assert_eq!(
            find_compatible_trainer_root(temporary.path()).expect("选择兼容 Trainer"),
            compatible
        );
    }

    fn write_test_component(root: &Path, version: &str) {
        fs::create_dir_all(root.join("sd-scripts")).expect("创建 sd-scripts 测试目录");
        fs::create_dir_all(root.join("site-packages/accelerate"))
            .expect("创建 accelerate 测试目录");
        fs::write(root.join("runner.py"), b"# test").expect("写入 Trainer 测试入口");
        fs::write(root.join("sd-scripts/anima_train_network.py"), b"# test")
            .expect("写入训练测试入口");
        fs::write(root.join(".drawhime-resource.json"), serde_json::to_vec(&serde_json::json!({ "resourceId": TRAINER_RESOURCE_ID, "version": version, "sha256": "a".repeat(64) })).expect("生成 Trainer 测试标记")).expect("写入 Trainer 测试标记");
    }

    #[test]
    fn trainer_keeps_all_trigger_words_when_captions_are_shuffled() {
        assert_eq!(
            protected_keep_tokens(1, &["my_character".into(), "special_style".into()]),
            2
        );
        assert_eq!(protected_keep_tokens(5, &["my_character".into()]), 5);
    }

    #[test]
    fn trainer_uses_selected_cuda_device_and_rejects_directml() {
        assert_eq!(
            training_cuda_device(crate::environment::BACKEND_NVIDIA_CUDA, Some(2))
                .expect("选择 CUDA 训练设备"),
            "2"
        );
        assert!(training_cuda_device(crate::environment::BACKEND_NVIDIA_CUDA, None).is_err());
        assert!(training_cuda_device(crate::environment::BACKEND_AMD_DIRECTML, None).is_err());
    }
}
