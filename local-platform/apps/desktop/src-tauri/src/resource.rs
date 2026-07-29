//! 本模块负责拉取签名资源清单，并以断点、切源、哈希校验和原子落盘下载桌面依赖。

use crate::models::{DesktopResourceCatalogItemView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopResourceManifestEnvelope, DesktopResourceManifestItem, DesktopResourceManifestPayload, DesktopResourceSource, DesktopSettings};
use crate::storage::LocalModelRegistration;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fs2::available_space;
use reqwest::{blocking::{Client, Response}, header::RANGE, StatusCode, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs::{self, File, OpenOptions}, io::{BufReader, Read, Seek, SeekFrom, Write}, path::{Component, Path, PathBuf}, process::{Command, Stdio}, thread, time::{Duration, Instant, UNIX_EPOCH}};
use tauri::Emitter;
use uuid::Uuid;
use zip::ZipArchive;

const MANIFEST_URL: &str = "https://www.xanime.ink/local-model-api/v1/desktop/resources/manifest";
const MANIFEST_KEY_ID: &str = "stable-2026-07-29";
const MANIFEST_PUBLIC_KEY: &str = "asfEBEwmIW6BPSgrLk9iNSgKqLprKisVFkq9QpJI8Pg=";
const MAX_MANIFEST_BYTES: u64 = 5 * 1024 * 1024;
const DOWNLOAD_BUFFER_BYTES: usize = 256 * 1024;
const DOWNLOAD_RANGE_BYTES: u64 = 8 * 1024 * 1024;
const LOW_SPEED_WINDOW: Duration = Duration::from_secs(20);
const LOW_SPEED_BYTES_PER_SECOND: u64 = 1024 * 1024;

#[derive(Deserialize)]
struct ManifestApiResponse {
    ok: bool,
    data: Option<DesktopResourceManifestEnvelope>,
    message: Option<String>,
}

/** 资源安装完成后返回界面状态及已经凑齐的底模自动登记记录。 */
pub struct ResourceInstallOutcome {
    pub view: DesktopResourceInstallView,
    pub model_registrations: Vec<LocalModelRegistration>,
}

/** 读取远端签名目录；发布配置缺失时返回明确未配置状态，不制造可安装资源。 */
pub fn load_catalog(settings: &DesktopSettings, app_data_dir: &Path) -> Result<DesktopResourceCatalogView, String> {
    let Some((manifest_url, key_id, public_key)) = manifest_configuration() else {
        return Ok(DesktopResourceCatalogView { configured: false, key_id: None, generated_at: None, expires_at: None, message: "当前安装包尚未配置经过签名的资源发布通道".into(), resources: Vec::new() });
    };
    let payload = fetch_verified_manifest(manifest_url, key_id, public_key)?;
    let cache_dir = resource_cache_dir(app_data_dir);
    let resources = payload.resources.iter().filter(|item| resource_matches_current_platform(item)).map(|item| {
        let target = cache_dir.join(&item.file_name);
        let installed = installed_resource_matches(item, settings);
        DesktopResourceCatalogItemView {
            id: item.id.clone(),
            kind: item.kind.clone(),
            version: item.version.clone(),
            file_name: item.file_name.clone(),
            byte_size: item.byte_size,
            installed_size: item.installed_size,
            sha256: item.sha256.clone(),
            required: item.required,
            downloaded: verified_marker_matches(&target, item),
            installed,
            install_path: installed.then(|| install_destination(item, settings).to_string_lossy().into_owned()),
            source_kinds: ordered_sources(item, &settings.dependency_source).iter().map(|source| source.kind.clone()).collect(),
        }
    }).collect();
    Ok(DesktopResourceCatalogView { configured: true, key_id: Some(key_id.into()), generated_at: Some(payload.generated_at), expires_at: Some(payload.expires_at), message: "资源清单签名和有效期校验通过".into(), resources })
}

/** 把已验证缓存安全安装到受控目录，并在切换失败时恢复旧版本。 */
pub fn install_resource(settings: &DesktopSettings, app_data_dir: &Path, resource_id: &str, app: &tauri::AppHandle) -> Result<ResourceInstallOutcome, String> {
    let result = install_resource_inner(settings, app_data_dir, resource_id, app);
    if let Err(error) = &result { emit_install_progress(app, install_view(resource_id, "failed", 0, None, None, Some(error.clone()))); }
    result
}

fn install_resource_inner(settings: &DesktopSettings, app_data_dir: &Path, resource_id: &str, app: &tauri::AppHandle) -> Result<ResourceInstallOutcome, String> {
    let Some((manifest_url, key_id, public_key)) = manifest_configuration() else { return Err("当前安装包尚未配置经过签名的资源发布通道".into()); };
    let payload = fetch_verified_manifest(manifest_url, key_id, public_key)?;
    let item = payload.resources.iter().find(|candidate| candidate.id == resource_id && resource_matches_current_platform(candidate)).cloned().ok_or_else(|| "资源不存在或不适用于当前系统".to_string())?;
    let cache = resource_cache_dir(app_data_dir).join(&item.file_name);
    let notify = |view| emit_install_progress(app, view);
    let view = install_cached_resource(settings, &item, &cache, &notify)?;
    let model_registrations = collect_model_registrations(settings, &payload.resources)?;
    Ok(ResourceInstallOutcome { view, model_registrations })
}

fn install_cached_resource<F: Fn(DesktopResourceInstallView)>(settings: &DesktopSettings, item: &DesktopResourceManifestItem, cache: &Path, notify: &F) -> Result<DesktopResourceInstallView, String> {
    notify(install_view(&item.id, "verifying", 2, None, None, None));
    if !cache.is_file() || !file_matches(&cache, &item)? { return Err("资源缓存缺失或 SHA-256 校验未通过，请重新下载".into()); }
    let destination = install_destination(&item, settings);
    if installed_resource_matches(&item, settings) { return Ok(install_view(&item.id, "installed", 100, Some(&destination), None, None)); }
    let parent = destination.parent().ok_or_else(|| "资源安装目录缺少父路径".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建资源安装目录失败：{error}"))?;
    let required_space = item.installed_size.saturating_add(256 * 1024 * 1024);
    let available = available_space(parent).map_err(|error| format!("读取安装磁盘空间失败：{error}"))?;
    if available < required_space { return Err(format!("安装磁盘空间不足：至少需要 {} MiB 可用空间", required_space / 1024 / 1024)); }
    let staging = parent.join(format!(".drawhime-install-{}-{}", item.id, Uuid::new_v4()));
    notify(install_view(&item.id, "installing", 10, Some(&destination), None, None));
    let install_candidate = if item.archive != "raw" {
        fs::create_dir(&staging).map_err(|error| format!("创建安装临时目录失败：{error}"))?;
        let content = staging.join("content");
        fs::create_dir(&content).map_err(|error| format!("创建解压临时目录失败：{error}"))?;
        if item.archive == "zip" { extract_zip_safely(cache, &content, item.installed_size)?; }
        else { extract_7z_safely(cache, &content, item.installed_size)?; }
        let root = item.root_directory.as_deref().map(|directory| content.join(directory)).unwrap_or(content);
        if !root.is_dir() { return Err("资源归档声明的根目录不存在".into()); }
        validate_extracted_resource(item, &root)?;
        if item.kind == "runtime" { write_runtime_manifest(&root, item)?; }
        write_install_marker(&root, item, true)?;
        root
    } else {
        if fs::hard_link(&cache, &staging).is_err() { fs::copy(&cache, &staging).map_err(|error| format!("复制资源到安装临时文件失败：{error}"))?; }
        staging.clone()
    };
    notify(install_view(&item.id, "switching", 90, Some(&destination), None, None));
    let backup = switch_atomically(&install_candidate, &destination).map_err(|error| {
        let _ = quarantine_file(&staging, "install-failed");
        error
    })?;
    if item.archive == "raw" {
        if let Err(error) = write_install_marker(&destination, &item, false) {
            let _ = fs::remove_file(&destination);
            if let Some(previous) = &backup { let _ = fs::rename(previous, &destination); }
            notify(install_view(&item.id, "rolled_back", 95, Some(&destination), backup.as_deref(), Some(error.clone())));
            return Err(error);
        }
    }
    if item.archive != "raw" && staging.exists() { let _ = fs::remove_dir_all(&staging); }
    let view = install_view(&item.id, "installed", 100, Some(&destination), backup.as_deref(), None);
    notify(view.clone());
    Ok(view)
}

/** 下载单个资源并保存断点；只有整体哈希匹配后才写入已验证标记。 */
pub fn download_resource(settings: &DesktopSettings, app_data_dir: &Path, resource_id: &str, app: &tauri::AppHandle) -> Result<DesktopResourceDownloadView, String> {
    let Some((manifest_url, key_id, public_key)) = manifest_configuration() else { return Err("当前安装包尚未配置经过签名的资源发布通道".into()); };
    let payload = fetch_verified_manifest(manifest_url, key_id, public_key)?;
    let item = payload.resources.into_iter().find(|candidate| candidate.id == resource_id && resource_matches_current_platform(candidate)).ok_or_else(|| "资源不存在或不适用于当前系统".to_string())?;
    let sources = ordered_sources(&item, &settings.dependency_source);
    if sources.is_empty() { return Err("当前依赖来源设置下没有可用下载地址".into()); }
    let cache_dir = resource_cache_dir(app_data_dir);
    fs::create_dir_all(&cache_dir).map_err(|error| format!("创建资源缓存目录失败：{error}"))?;
    let target = cache_dir.join(&item.file_name);
    if target.is_file() && file_matches(&target, &item)? {
        write_verified_marker(&target, &item)?;
        return Ok(progress_view(&item, "downloaded", None, item.byte_size, 0, Some(&target), None));
    }
    quarantine_invalid_target(&target)?;
    let partial = partial_path(&target);
    if partial.metadata().map(|metadata| metadata.len() > item.byte_size).unwrap_or(false) { fs::remove_file(&partial).map_err(|error| format!("清理超长下载断点失败：{error}"))?; }
    emit_progress(app, progress_view(&item, "queued", None, partial.metadata().map(|metadata| metadata.len()).unwrap_or(0), 0, None, None));
    let client = Client::builder().connect_timeout(Duration::from_secs(6)).timeout(Duration::from_secs(30)).user_agent("DrawHime-Desktop/0.1").build().map_err(|error| format!("创建资源下载客户端失败：{error}"))?;
    let started_at = Instant::now();
    let mut errors = Vec::new();
    let notify = |view| emit_progress(app, view);
    for source in sources {
        if partial.metadata().map(|metadata| metadata.len()).unwrap_or(0) >= item.byte_size { break; }
        if let Err(error) = download_from_source(&client, &item, &source, &partial, started_at, &notify) { errors.push(format!("{}：{}", source.kind, error)); }
    }
    let downloaded_bytes = partial.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if downloaded_bytes != item.byte_size {
        let message = if errors.is_empty() { "下载未达到资源声明大小".into() } else { errors.join("；") };
        let view = progress_view(&item, "failed", None, downloaded_bytes, average_speed(downloaded_bytes, started_at), None, Some(message.clone()));
        emit_progress(app, view);
        return Err(message);
    }
    emit_progress(app, progress_view(&item, "verifying", None, downloaded_bytes, average_speed(downloaded_bytes, started_at), None, None));
    let actual_sha256 = sha256_file(&partial)?;
    if actual_sha256 != item.sha256 {
        quarantine_file(&partial, "checksum-invalid")?;
        let message = "资源整体 SHA-256 校验失败，文件已隔离".to_string();
        emit_progress(app, progress_view(&item, "failed", None, downloaded_bytes, 0, None, Some(message.clone())));
        return Err(message);
    }
    fs::rename(&partial, &target).map_err(|error| format!("原子写入资源缓存失败：{error}"))?;
    write_verified_marker(&target, &item)?;
    let view = progress_view(&item, "downloaded", None, item.byte_size, average_speed(item.byte_size, started_at), Some(&target), None);
    emit_progress(app, view.clone());
    Ok(view)
}

fn manifest_configuration() -> Option<(&'static str, &'static str, &'static str)> {
    (!MANIFEST_URL.is_empty() && !MANIFEST_KEY_ID.is_empty() && !MANIFEST_PUBLIC_KEY.is_empty()).then_some((MANIFEST_URL, MANIFEST_KEY_ID, MANIFEST_PUBLIC_KEY))
}

fn fetch_verified_manifest(manifest_url: &str, expected_key_id: &str, public_key: &str) -> Result<DesktopResourceManifestPayload, String> {
    let url = Url::parse(manifest_url).map_err(|_| "资源清单地址格式不正确".to_string())?;
    if url.scheme() != "https" { return Err("资源清单必须使用 HTTPS".into()); }
    let client = Client::builder().connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(12)).user_agent("DrawHime-Desktop/0.1").build().map_err(|error| format!("创建清单客户端失败：{error}"))?;
    let response = client.get(url).send().map_err(|error| format!("获取资源清单失败：{}", network_error(&error)))?;
    if !response.status().is_success() { return Err(format!("资源清单返回 HTTP {}", response.status().as_u16())); }
    if response.content_length().is_some_and(|length| length > MAX_MANIFEST_BYTES) { return Err("资源清单超过大小限制".into()); }
    let mut bytes = Vec::new();
    response.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes).map_err(|error| format!("读取资源清单失败：{error}"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES { return Err("资源清单超过大小限制".into()); }
    let wrapper: ManifestApiResponse = serde_json::from_slice(&bytes).map_err(|error| format!("解析资源清单响应失败：{error}"))?;
    if !wrapper.ok { return Err(wrapper.message.unwrap_or_else(|| "资源服务返回失败状态".into())); }
    let envelope = wrapper.data.ok_or_else(|| "资源服务未返回签名清单".to_string())?;
    verify_manifest(envelope, expected_key_id, public_key)
}

fn verify_manifest(envelope: DesktopResourceManifestEnvelope, expected_key_id: &str, public_key: &str) -> Result<DesktopResourceManifestPayload, String> {
    if envelope.key_id != expected_key_id { return Err("资源清单签名密钥标识不匹配".into()); }
    let key_bytes = BASE64.decode(public_key).map_err(|_| "资源公钥编码不正确".to_string())?;
    let key_array: [u8; 32] = key_bytes.try_into().map_err(|_| "资源公钥长度不正确".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&key_array).map_err(|_| "资源公钥内容不正确".to_string())?;
    let signature_bytes = BASE64.decode(&envelope.signature).map_err(|_| "资源清单签名编码不正确".to_string())?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| "资源清单签名长度不正确".to_string())?;
    verifying_key.verify(envelope.payload.as_bytes(), &signature).map_err(|_| "资源清单签名验证失败".to_string())?;
    let payload: DesktopResourceManifestPayload = serde_json::from_str(&envelope.payload).map_err(|error| format!("解析已签名资源载荷失败：{error}"))?;
    validate_manifest(&payload)?;
    Ok(payload)
}

fn validate_manifest(payload: &DesktopResourceManifestPayload) -> Result<(), String> {
    if payload.schema_version != 1 { return Err("资源清单版本不受支持".into()); }
    if !matches!(payload.channel.as_str(), "stable" | "beta") { return Err("资源清单发布通道不正确".into()); }
    let generated_at = DateTime::parse_from_rfc3339(&payload.generated_at).map_err(|_| "资源清单生成时间不正确".to_string())?.with_timezone(&Utc);
    let expires_at = DateTime::parse_from_rfc3339(&payload.expires_at).map_err(|_| "资源清单过期时间不正确".to_string())?.with_timezone(&Utc);
    if generated_at > Utc::now() + ChronoDuration::minutes(5) { return Err("资源清单生成时间晚于本机时间".into()); }
    if expires_at <= Utc::now() || expires_at <= generated_at { return Err("资源清单已经过期".into()); }
    if payload.resources.len() > 500 { return Err("资源清单项目过多".into()); }
    let mut ids = HashSet::new();
    for item in &payload.resources {
        if !ids.insert(&item.id) { return Err(format!("资源清单存在重复 ID：{}", item.id)); }
        validate_item(item)?;
    }
    validate_model_groups(&payload.resources)?;
    Ok(())
}

fn validate_model_groups(items: &[DesktopResourceManifestItem]) -> Result<(), String> {
    let mut groups: HashMap<&str, (&str, &str, &str, HashSet<&str>)> = HashMap::new();
    for item in items {
        let Some(registration) = &item.model_registration else { continue; };
        if !matches!(registration.workflow_kind.as_str(), "checkpoint" | "anima") || !matches!(registration.role.as_str(), "primary" | "text_encoder" | "vae") { return Err(format!("模型组合字段不正确：{}", item.id)); }
        let group = groups.entry(&registration.group_id).or_insert((&registration.display_name, &registration.family, &registration.workflow_kind, HashSet::new()));
        if group.0 != registration.display_name || group.1 != registration.family || group.2 != registration.workflow_kind || !group.3.insert(&registration.role) { return Err(format!("模型组合元数据冲突：{}", registration.group_id)); }
    }
    for (group_id, (_, _, workflow_kind, roles)) in groups {
        let valid = if workflow_kind == "anima" { roles.len() == 3 && ["primary", "text_encoder", "vae"].iter().all(|role| roles.contains(role)) } else { roles.len() == 1 && roles.contains("primary") };
        if !valid { return Err(format!("模型组合资源不完整：{group_id}")); }
    }
    Ok(())
}

fn validate_item(item: &DesktopResourceManifestItem) -> Result<(), String> {
    if item.id.len() < 2 || item.id.len() > 128 || !item.id.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '_' | '-')) { return Err("资源 ID 不符合约束".into()); }
    if !matches!(item.kind.as_str(), "runtime" | "model" | "lora" | "captioner" | "trainer") { return Err(format!("资源类型不受支持：{}", item.id)); }
    if item.os != "windows" || !matches!(item.arch.as_str(), "x86_64" | "aarch64") { return Err(format!("资源平台字段不正确：{}", item.id)); }
    if item.file_name.len() < 2 || item.file_name.len() > 255 || !item.file_name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')) { return Err(format!("资源文件名不安全：{}", item.id)); }
    validate_windows_relative_path(Path::new(&item.file_name)).map_err(|_| format!("资源文件名不适用于 Windows：{}", item.id))?;
    if item.byte_size == 0 || item.installed_size == 0 || item.installed_size > 512 * 1024 * 1024 * 1024 || item.sha256.len() != 64 || !item.sha256.chars().all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()) { return Err(format!("资源大小或哈希不正确：{}", item.id)); }
    if !matches!(item.archive.as_str(), "raw" | "zip" | "7z") || item.sources.is_empty() || item.sources.len() > 8 { return Err(format!("资源归档或来源不正确：{}", item.id)); }
    if matches!(item.kind.as_str(), "model" | "lora") && (item.archive != "raw" || item.installed_size != item.byte_size) { return Err(format!("模型和 LoRA 必须使用声明大小一致的原始文件：{}", item.id)); }
    if matches!(item.kind.as_str(), "runtime" | "captioner" | "trainer") && item.archive == "raw" { return Err(format!("运行组件必须使用归档文件：{}", item.id)); }
    if item.archive == "raw" && item.root_directory.is_some() { return Err(format!("原始文件资源不得声明归档根目录：{}", item.id)); }
    if item.kind == "model" && (!matches!(item.install_directory.as_deref(), Some("checkpoints" | "diffusion_models" | "text_encoders" | "vae")) || item.model_registration.is_none()) { return Err(format!("模型资源缺少受控安装目录或组合登记：{}", item.id)); }
    if item.kind == "lora" && item.install_directory.as_deref().is_some_and(|directory| directory != "loras") { return Err(format!("LoRA 安装目录不正确：{}", item.id)); }
    if !matches!(item.kind.as_str(), "model" | "lora") && (item.install_directory.is_some() || item.model_registration.is_some()) { return Err(format!("非模型资源不得声明模型安装元数据：{}", item.id)); }
    if let Some(root_directory) = &item.root_directory { validate_windows_relative_path(Path::new(root_directory)).map_err(|_| format!("资源归档根目录不安全：{}", item.id))?; if Path::new(root_directory).components().count() != 1 { return Err(format!("资源归档根目录只能包含一级：{}", item.id)); } }
    let mut kinds = HashSet::new();
    for source in &item.sources {
        if !matches!(source.kind.as_str(), "official" | "mirror") || !kinds.insert(&source.kind) { return Err(format!("资源来源类型不正确或重复：{}", item.id)); }
        let url = Url::parse(&source.url).map_err(|_| format!("资源下载地址格式不正确：{}", item.id))?;
        if url.scheme() != "https" { return Err(format!("资源下载地址必须使用 HTTPS：{}", item.id)); }
    }
    Ok(())
}

fn ordered_sources<'a>(item: &'a DesktopResourceManifestItem, preference: &str) -> Vec<&'a DesktopResourceSource> {
    let mut sources: Vec<_> = item.sources.iter().filter(|source| match preference { "official" => source.kind == "official", "mirror" => source.kind == "mirror", _ => true }).collect();
    if preference == "auto" { sources.sort_by_key(|source| if source.kind == "official" { 0 } else { 1 }); }
    sources
}

fn download_from_source<F: Fn(DesktopResourceDownloadView)>(client: &Client, item: &DesktopResourceManifestItem, source: &DesktopResourceSource, partial: &Path, started_at: Instant, notify: &F) -> Result<(), String> {
    let mut offset = partial.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let mut file = OpenOptions::new().create(true).read(true).write(true).open(partial).map_err(|error| format!("打开下载断点失败：{error}"))?;
    file.seek(SeekFrom::Start(offset)).map_err(|error| format!("定位下载断点失败：{error}"))?;
    let source_started = Instant::now();
    let source_start_bytes = offset;
    while offset < item.byte_size {
        let end_inclusive = (offset + DOWNLOAD_RANGE_BYTES - 1).min(item.byte_size - 1);
        let response = client.get(&source.url).header(RANGE, format!("bytes={offset}-{end_inclusive}")).send().map_err(|error| network_error(&error))?;
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && offset == item.byte_size { return Ok(()); }
        let full_single_response = offset == 0 && end_inclusive + 1 == item.byte_size && response.status() == StatusCode::OK;
        if response.status() != StatusCode::PARTIAL_CONTENT && !full_single_response {
            return Err(if response.status().is_success() { "下载来源不支持断点 Range".into() } else { format!("HTTP {}", response.status().as_u16()) });
        }
        offset = stream_response(response, &mut file, item, source, offset, end_inclusive + 1, started_at, notify)?;
        if source_started.elapsed() >= LOW_SPEED_WINDOW {
            let source_speed = (offset - source_start_bytes) / source_started.elapsed().as_secs().max(1);
            if source_speed < LOW_SPEED_BYTES_PER_SECOND && offset < item.byte_size { file.flush().map_err(|error| format!("保存低速断点失败：{error}"))?; return Err(format!("持续下载速度过低（{} KiB/s）", source_speed / 1024)); }
        }
    }
    Ok(())
}

fn stream_response<F: Fn(DesktopResourceDownloadView)>(mut response: Response, file: &mut File, item: &DesktopResourceManifestItem, source: &DesktopResourceSource, mut downloaded: u64, expected_end: u64, started_at: Instant, notify: &F) -> Result<u64, String> {
    let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_BYTES];
    let mut last_emit = Instant::now();
    loop {
        let read = response.read(&mut buffer).map_err(|error| format!("读取中断：{error}"))?;
        if read == 0 { break; }
        let next = downloaded.saturating_add(read as u64);
        if next > expected_end { return Err("上游返回分片超过请求范围".into()); }
        file.write_all(&buffer[..read]).map_err(|error| format!("写入下载断点失败：{error}"))?;
        downloaded = next;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            notify(progress_view(item, "downloading", Some(source.kind.clone()), downloaded, average_speed(downloaded, started_at), None, None));
            last_emit = Instant::now();
        }
        if downloaded == expected_end { break; }
    }
    file.flush().map_err(|error| format!("保存下载断点失败：{error}"))?;
    if downloaded < expected_end { return Err("连接提前结束，已保留断点".into()); }
    Ok(downloaded)
}

fn resource_matches_current_platform(item: &DesktopResourceManifestItem) -> bool { item.os == "windows" && item.arch == std::env::consts::ARCH }
fn resource_cache_dir(app_data_dir: &Path) -> PathBuf { app_data_dir.join("resource-cache") }
fn partial_path(target: &Path) -> PathBuf { target.with_file_name(format!("{}.part", target.file_name().unwrap_or_default().to_string_lossy())) }
fn marker_path(target: &Path) -> PathBuf { target.with_file_name(format!("{}.verified", target.file_name().unwrap_or_default().to_string_lossy())) }
fn verified_marker_matches(target: &Path, item: &DesktopResourceManifestItem) -> bool { target.metadata().is_ok_and(|metadata| metadata.len() == item.byte_size) && fs::read_to_string(marker_path(target)).is_ok_and(|value| value.trim() == item.sha256) }
fn write_verified_marker(target: &Path, item: &DesktopResourceManifestItem) -> Result<(), String> { fs::write(marker_path(target), format!("{}\n", item.sha256)).map_err(|error| format!("写入资源验证标记失败：{error}")) }
fn file_matches(path: &Path, item: &DesktopResourceManifestItem) -> Result<bool, String> { Ok(path.metadata().map(|metadata| metadata.len() == item.byte_size).unwrap_or(false) && sha256_file(path)? == item.sha256) }
fn average_speed(bytes: u64, started_at: Instant) -> u64 { bytes / started_at.elapsed().as_secs().max(1) }
fn network_error(error: &reqwest::Error) -> String { if error.is_timeout() { "连接或读取超时".into() } else if error.is_connect() { "连接失败".into() } else { "网络传输失败".into() } }

fn install_destination(item: &DesktopResourceManifestItem, settings: &DesktopSettings) -> PathBuf {
    match item.kind.as_str() {
        "runtime" => Path::new(&settings.runtime_root).join("current"),
        "model" => Path::new(&settings.model_root).join(item.install_directory.as_deref().unwrap_or("checkpoints")).join(&item.file_name),
        "lora" => Path::new(&settings.model_root).join("loras").join(&item.file_name),
        "captioner" => Path::new(&settings.runtime_root).join("components").join("captioner").join(&item.version),
        "trainer" => Path::new(&settings.runtime_root).join("components").join("trainer").join(&item.version),
        _ => Path::new(&settings.model_root).join(&item.file_name),
    }
}

fn collect_model_registrations(settings: &DesktopSettings, items: &[DesktopResourceManifestItem]) -> Result<Vec<LocalModelRegistration>, String> {
    let mut groups: HashMap<&str, Vec<&DesktopResourceManifestItem>> = HashMap::new();
    for item in items.iter().filter(|item| item.model_registration.is_some()) {
        groups.entry(item.model_registration.as_ref().unwrap().group_id.as_str()).or_default().push(item);
    }
    let mut registrations = Vec::new();
    for group in groups.into_values() {
        if !group.iter().all(|item| installed_resource_matches(item, settings)) { continue; }
        let primary = group.iter().find(|item| item.model_registration.as_ref().is_some_and(|registration| registration.role == "primary")).ok_or_else(|| "模型组合缺少主文件".to_string())?;
        let metadata = install_destination(primary, settings).metadata().map_err(|error| format!("读取已安装底模失败：{error}"))?;
        let primary_registration = primary.model_registration.as_ref().unwrap();
        let text_encoder = group.iter().find(|item| item.model_registration.as_ref().is_some_and(|registration| registration.role == "text_encoder"));
        let vae = group.iter().find(|item| item.model_registration.as_ref().is_some_and(|registration| registration.role == "vae"));
        registrations.push(LocalModelRegistration {
            display_name: primary_registration.display_name.clone(),
            family: primary_registration.family.clone(),
            workflow_kind: primary_registration.workflow_kind.clone(),
            model_file_name: primary.file_name.clone(),
            model_relative_path: resource_relative_path(primary)?,
            model_sha256: primary.sha256.clone(),
            byte_size: primary.byte_size,
            model_modified_ms: metadata.modified().map_err(|error| format!("读取底模修改时间失败：{error}"))?.duration_since(UNIX_EPOCH).map_err(|_| "底模修改时间早于系统纪元".to_string())?.as_millis() as u64,
            text_encoder_file_name: text_encoder.map(|item| item.file_name.clone()),
            text_encoder_relative_path: text_encoder.map(|item| resource_relative_path(item)).transpose()?,
            text_encoder_sha256: text_encoder.map(|item| item.sha256.clone()),
            vae_file_name: vae.map(|item| item.file_name.clone()),
            vae_relative_path: vae.map(|item| resource_relative_path(item)).transpose()?,
            vae_sha256: vae.map(|item| item.sha256.clone()),
        });
    }
    Ok(registrations)
}

fn resource_relative_path(item: &DesktopResourceManifestItem) -> Result<String, String> {
    let directory = item.install_directory.as_deref().ok_or_else(|| "模型资源缺少安装目录".to_string())?;
    Ok(format!("{directory}/{}", item.file_name))
}

fn installed_resource_matches(item: &DesktopResourceManifestItem, settings: &DesktopSettings) -> bool {
    let destination = install_destination(item, settings);
    let marker = install_marker_path(&destination, item.archive != "raw");
    if !destination.exists() || !marker.is_file() { return false; }
    let Ok(content) = fs::read_to_string(marker) else { return false; };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else { return false; };
    value.get("resourceId").and_then(serde_json::Value::as_str) == Some(item.id.as_str()) && value.get("sha256").and_then(serde_json::Value::as_str) == Some(item.sha256.as_str())
}

fn install_marker_path(destination: &Path, directory: bool) -> PathBuf {
    if directory { destination.join(".drawhime-resource.json") } else { destination.with_file_name(format!("{}.drawhime-resource.json", destination.file_name().unwrap_or_default().to_string_lossy())) }
}

fn write_install_marker(destination: &Path, item: &DesktopResourceManifestItem, directory: bool) -> Result<(), String> {
    let marker = install_marker_path(destination, directory);
    let content = serde_json::to_vec_pretty(&serde_json::json!({ "resourceId": item.id, "version": item.version, "sha256": item.sha256, "installedAt": Utc::now().to_rfc3339() })).map_err(|error| format!("生成安装标记失败：{error}"))?;
    fs::write(marker, content).map_err(|error| format!("写入安装标记失败：{error}"))
}

fn extract_zip_safely(archive_path: &Path, staging: &Path, maximum_installed_bytes: u64) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| format!("打开资源归档失败：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("读取资源 ZIP 失败：{error}"))?;
    if archive.len() > 200_000 { return Err("资源 ZIP 文件数量超过限制".into()); }
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| format!("读取 ZIP 项失败：{error}"))?;
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) { return Err("资源 ZIP 包含链接文件".into()); }
        let relative = entry.enclosed_name().ok_or_else(|| "资源 ZIP 包含路径穿越项".to_string())?;
        validate_windows_relative_path(&relative)?;
        extracted_bytes = extracted_bytes.checked_add(entry.size()).ok_or_else(|| "资源 ZIP 解压大小溢出".to_string())?;
        if extracted_bytes > maximum_installed_bytes { return Err("资源 ZIP 解压大小超过签名清单声明".into()); }
        let output = staging.join(relative);
        if entry.is_dir() { fs::create_dir_all(&output).map_err(|error| format!("创建 ZIP 目录失败：{error}"))?; continue; }
        if let Some(parent) = output.parent() { fs::create_dir_all(parent).map_err(|error| format!("创建 ZIP 文件目录失败：{error}"))?; }
        let mut target = OpenOptions::new().create_new(true).write(true).open(&output).map_err(|error| format!("创建 ZIP 解压文件失败：{error}"))?;
        std::io::copy(&mut entry, &mut target).map_err(|error| format!("解压资源文件失败：{error}"))?;
        target.flush().map_err(|error| format!("保存解压资源失败：{error}"))?;
    }
    Ok(())
}

fn extract_7z_safely(archive_path: &Path, staging: &Path, maximum_installed_bytes: u64) -> Result<(), String> {
    let tar = Path::new(r"C:\Windows\System32\tar.exe");
    if !tar.is_file() { return Err("当前 Windows 缺少系统归档工具 tar.exe".into()); }
    let archive_text = archive_path.to_string_lossy().into_owned();
    let staging_text = staging.to_string_lossy().into_owned();
    let names_output = Command::new(tar).args(["-tf", archive_text.as_str()]).output().map_err(|error| format!("读取 7z 文件列表失败：{error}"))?;
    if !names_output.status.success() || names_output.stdout.len() > 64 * 1024 * 1024 { return Err("资源 7z 文件列表读取失败或超过限制".into()); }
    let names = String::from_utf8(names_output.stdout).map_err(|_| "资源 7z 文件名不是 UTF-8".to_string())?;
    let mut entry_count = 0_usize;
    for name in names.lines().filter(|name| !name.trim().is_empty()) {
        entry_count += 1;
        if entry_count > 200_000 { return Err("资源 7z 文件数量超过限制".into()); }
        let normalized = name.trim_end_matches('/').replace('\\', "/");
        validate_windows_relative_path(Path::new(&normalized))?;
    }
    let verbose = Command::new(tar).args(["-tvf", archive_text.as_str()]).output().map_err(|error| format!("读取 7z 类型列表失败：{error}"))?;
    if !verbose.status.success() || verbose.stdout.len() > 128 * 1024 * 1024 { return Err("资源 7z 类型列表读取失败或超过限制".into()); }
    if String::from_utf8_lossy(&verbose.stdout).lines().any(|line| matches!(line.chars().next(), Some('l' | 'h'))) { return Err("资源 7z 包含链接条目".into()); }
    let mut child = Command::new(tar).args(["-xf", archive_text.as_str(), "-C", staging_text.as_str()]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| format!("启动 7z 解压失败：{error}"))?;
    let mut last_size_check = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| format!("读取 7z 解压状态失败：{error}"))? {
            if !status.success() { return Err(format!("系统 tar 解压 7z 失败，退出码 {}", status.code().unwrap_or(-1))); }
            break;
        }
        if last_size_check.elapsed() >= Duration::from_secs(5) {
            if directory_size_limited(staging, maximum_installed_bytes)? > maximum_installed_bytes { let _ = child.kill(); let _ = child.wait(); return Err("资源 7z 解压大小超过签名清单声明".into()); }
            last_size_check = Instant::now();
        }
        thread::sleep(Duration::from_millis(250));
    }
    if directory_size_limited(staging, maximum_installed_bytes)? > maximum_installed_bytes { return Err("资源 7z 解压大小超过签名清单声明".into()); }
    Ok(())
}

fn directory_size_limited(root: &Path, limit: u64) -> Result<u64, String> {
    let mut total = 0_u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| format!("读取解压目录失败：{error}"))? {
            let entry = entry.map_err(|error| format!("读取解压项失败：{error}"))?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| format!("读取解压项元数据失败：{error}"))?;
            if metadata.file_type().is_symlink() { return Err("资源归档解压后包含链接".into()); }
            #[cfg(windows)]
            { use std::os::windows::fs::MetadataExt; if metadata.file_attributes() & 0x400 != 0 { return Err("资源归档解压后包含重解析点".into()); } }
            if metadata.is_dir() { pending.push(entry.path()); }
            else if metadata.is_file() { total = total.checked_add(metadata.len()).ok_or_else(|| "资源解压大小溢出".to_string())?; if total > limit { return Ok(total); } }
        }
    }
    Ok(total)
}

fn validate_windows_relative_path(path: &Path) -> Result<(), String> {
    const RESERVED: [&str; 22] = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    for component in path.components() {
        let Component::Normal(value) = component else { return Err("资源 ZIP 包含非普通相对路径".into()); };
        let text = value.to_string_lossy();
        if text.is_empty() || text.ends_with(' ') || text.ends_with('.') || text.contains(':') || text.contains('\0') { return Err("资源 ZIP 包含 Windows 不安全文件名".into()); }
        let stem = text.split('.').next().unwrap_or_default().to_ascii_uppercase();
        if RESERVED.contains(&stem.as_str()) { return Err("资源 ZIP 包含 Windows 保留文件名".into()); }
    }
    Ok(())
}

fn validate_extracted_resource(item: &DesktopResourceManifestItem, staging: &Path) -> Result<(), String> {
    if item.kind == "runtime" {
        for required in [staging.join("python_embeded").join("python.exe"), staging.join("ComfyUI").join("main.py")] {
            if !required.is_file() { return Err(format!("Runtime 归档缺少必需文件：{}", required.file_name().unwrap_or_default().to_string_lossy())); }
        }
    }
    if item.kind == "captioner" {
        for required in [staging.join("runner.py"), staging.join("model.onnx"), staging.join("selected_tags.csv"), staging.join("site-packages").join("onnxruntime").join("__init__.py")] {
            if !required.is_file() { return Err(format!("Captioner 归档缺少必需文件：{}", required.file_name().unwrap_or_default().to_string_lossy())); }
        }
    }
    Ok(())
}

fn write_runtime_manifest(root: &Path, item: &DesktopResourceManifestItem) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(&serde_json::json!({ "schemaVersion": 1, "status": "installed", "runtimeVersion": item.version, "resourceId": item.id, "resourceSha256": item.sha256, "pythonExecutable": "python_embeded/python.exe", "entrypoint": "ComfyUI/main.py", "installedAt": Utc::now().to_rfc3339() })).map_err(|error| format!("生成 Runtime 内部清单失败：{error}"))?;
    fs::write(root.join("runtime-manifest.json"), content).map_err(|error| format!("写入 Runtime 内部清单失败：{error}"))
}

fn switch_atomically(staging: &Path, destination: &Path) -> Result<Option<PathBuf>, String> {
    let backup = if destination.exists() {
        let name = destination.file_name().unwrap_or_default().to_string_lossy();
        let path = destination.with_file_name(format!("{name}.previous-{}-{}", Utc::now().format("%Y%m%d%H%M%S"), Uuid::new_v4()));
        fs::rename(destination, &path).map_err(|error| format!("保留旧资源版本失败：{error}"))?;
        Some(path)
    } else { None };
    if let Err(error) = fs::rename(staging, destination) {
        if let Some(previous) = &backup { let _ = fs::rename(previous, destination); }
        return Err(format!("切换新资源版本失败：{error}"));
    }
    Ok(backup)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("读取资源文件失败：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop { let read = reader.read(&mut buffer).map_err(|error| format!("计算资源哈希失败：{error}"))?; if read == 0 { break; } hasher.update(&buffer[..read]); }
    Ok(hex::encode(hasher.finalize()))
}

fn quarantine_invalid_target(target: &Path) -> Result<(), String> {
    if !target.exists() { return Ok(()); }
    quarantine_file(target, "unverified")?;
    let marker = marker_path(target);
    if marker.exists() { fs::remove_file(marker).map_err(|error| format!("清理失效验证标记失败：{error}"))?; }
    Ok(())
}

fn quarantine_file(path: &Path, reason: &str) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let timestamp = Utc::now().timestamp();
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let quarantined = path.with_file_name(format!("{name}.{reason}.{timestamp}"));
    fs::rename(path, quarantined).map_err(|error| format!("隔离异常资源失败：{error}"))
}

fn progress_view(item: &DesktopResourceManifestItem, status: &str, source_kind: Option<String>, downloaded_bytes: u64, bytes_per_second: u64, target_path: Option<&Path>, error: Option<String>) -> DesktopResourceDownloadView {
    DesktopResourceDownloadView { resource_id: item.id.clone(), status: status.into(), source_kind, downloaded_bytes, total_bytes: item.byte_size, bytes_per_second, target_path: target_path.map(|path| path.to_string_lossy().into_owned()), error }
}

fn emit_progress(app: &tauri::AppHandle, view: DesktopResourceDownloadView) { let _ = app.emit("desktop-resource-progress", view); }
fn install_view(resource_id: &str, status: &str, progress: u32, install_path: Option<&Path>, rollback_path: Option<&Path>, error: Option<String>) -> DesktopResourceInstallView { DesktopResourceInstallView { resource_id: resource_id.into(), status: status.into(), progress, install_path: install_path.map(|path| path.to_string_lossy().into_owned()), rollback_path: rollback_path.map(|path| path.to_string_lossy().into_owned()), error } }
fn emit_install_progress(app: &tauri::AppHandle, view: DesktopResourceInstallView) { let _ = app.emit("desktop-resource-install-progress", view); }

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::{net::TcpListener, thread};

    fn item() -> DesktopResourceManifestItem {
        DesktopResourceManifestItem { id: "runtime.core".into(), kind: "runtime".into(), version: "1.0.0".into(), os: "windows".into(), arch: std::env::consts::ARCH.into(), file_name: "runtime.zip".into(), byte_size: 10, installed_size: 1024, sha256: "a".repeat(64), archive: "zip".into(), root_directory: None, install_directory: None, model_registration: None, required: true, sources: vec![DesktopResourceSource { kind: "mirror".into(), url: "https://mirror.example/runtime.zip".into() }, DesktopResourceSource { kind: "official".into(), url: "https://official.example/runtime.zip".into() }] }
    }

    #[test]
    fn source_preference_obeys_user_setting() {
        let item = item();
        assert_eq!(ordered_sources(&item, "auto").iter().map(|source| source.kind.as_str()).collect::<Vec<_>>(), vec!["official", "mirror"]);
        assert_eq!(ordered_sources(&item, "official").len(), 1);
        assert_eq!(ordered_sources(&item, "mirror")[0].kind, "mirror");
    }

    #[test]
    fn signed_manifest_rejects_tampering() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let payload = serde_json::to_string(&DesktopResourceManifestPayload { schema_version: 1, channel: "stable".into(), generated_at: Utc::now().to_rfc3339(), expires_at: (Utc::now() + ChronoDuration::hours(1)).to_rfc3339(), resources: vec![item()] }).expect("序列化测试清单");
        let signature = BASE64.encode(signing_key.sign(payload.as_bytes()).to_bytes());
        let public_key = BASE64.encode(signing_key.verifying_key().to_bytes());
        assert!(verify_manifest(DesktopResourceManifestEnvelope { key_id: "test".into(), payload: payload.clone(), signature: signature.clone() }, "test", &public_key).is_ok());
        assert!(verify_manifest(DesktopResourceManifestEnvelope { key_id: "test".into(), payload: format!("{payload} "), signature }, "test", &public_key).is_err());
    }

    #[test]
    fn range_download_resumes_existing_partial_file() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("启动测试下载端点");
        let address = listener.local_addr().expect("读取测试端点地址");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("接受测试下载连接");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("读取测试请求");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("Range: bytes=5-9") || request.contains("range: bytes=5-9"));
            stream.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: bytes 5-9/10\r\nConnection: close\r\n\r\nfghij").expect("写入测试分片");
        });
        let temporary = tempfile::tempdir().expect("创建下载临时目录");
        let partial = temporary.path().join("runtime.zip.part");
        fs::write(&partial, b"abcde").expect("写入测试断点");
        let mut item = item();
        item.sha256 = hex::encode(Sha256::digest(b"abcdefghij"));
        let source = DesktopResourceSource { kind: "official".into(), url: format!("http://{address}/runtime.zip") };
        let client = Client::builder().timeout(Duration::from_secs(5)).build().expect("创建测试客户端");
        download_from_source(&client, &item, &source, &partial, Instant::now(), &|_| {}).expect("续传测试资源");
        server.join().expect("等待测试端点退出");
        assert_eq!(fs::read(partial).expect("读取续传结果"), b"abcdefghij");
    }

    #[test]
    fn runtime_zip_extracts_into_staging_and_rejects_windows_unsafe_paths() {
        let temporary = tempfile::tempdir().expect("创建解压临时目录");
        let archive_path = temporary.path().join("runtime.zip");
        let file = File::create(&archive_path).expect("创建测试 ZIP");
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        archive.start_file("python_embeded/python.exe", options).expect("创建便携 Python 项");
        archive.write_all(b"python").expect("写入便携 Python");
        archive.start_file("ComfyUI/main.py", options).expect("创建 ComfyUI 入口项");
        archive.write_all(b"print('comfyui')").expect("写入 ComfyUI 入口");
        archive.start_file("bin/worker.txt", options).expect("创建 Runtime 文件项");
        archive.write_all(b"runtime-worker").expect("写入 Runtime 文件");
        archive.finish().expect("完成测试 ZIP");
        let staging = temporary.path().join("staging");
        fs::create_dir(&staging).expect("创建测试安装目录");
        extract_zip_safely(&archive_path, &staging, 1024).expect("安全解压 Runtime");
        let item = item();
        validate_extracted_resource(&item, &staging).expect("校验 Runtime 内部清单");
        assert_eq!(fs::read(staging.join("bin/worker.txt")).expect("读取 Runtime 文件"), b"runtime-worker");
        assert!(validate_windows_relative_path(Path::new("../outside.txt")).is_err());
        assert!(validate_windows_relative_path(Path::new("CON.txt")).is_err());
    }

    #[test]
    fn atomic_switch_keeps_previous_version_for_rollback() {
        let temporary = tempfile::tempdir().expect("创建切换临时目录");
        let destination = temporary.path().join("current");
        let staging = temporary.path().join("staging");
        fs::create_dir(&destination).expect("创建旧版本");
        fs::write(destination.join("version.txt"), b"old").expect("写入旧版本");
        fs::create_dir(&staging).expect("创建新版本");
        fs::write(staging.join("version.txt"), b"new").expect("写入新版本");
        let backup = switch_atomically(&staging, &destination).expect("原子切换").expect("保留旧版本路径");
        assert_eq!(fs::read(destination.join("version.txt")).expect("读取新版本"), b"new");
        assert_eq!(fs::read(backup.join("version.txt")).expect("读取回滚版本"), b"old");
    }

    #[test]
    fn verified_runtime_cache_installs_and_updates_environment_state() {
        let temporary = tempfile::tempdir().expect("创建 Runtime 安装测试目录");
        let cache = temporary.path().join("runtime.zip");
        let file = File::create(&cache).expect("创建 Runtime 缓存");
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        archive.start_file("python_embeded/python.exe", options).expect("创建便携 Python");
        archive.write_all(b"python").expect("写入便携 Python");
        archive.start_file("ComfyUI/main.py", options).expect("创建 ComfyUI 入口");
        archive.write_all(b"print('comfyui')").expect("写入 ComfyUI 入口");
        archive.start_file("bin/runtime.txt", options).expect("创建 Runtime 程序文件");
        archive.write_all(b"verified-runtime").expect("写入 Runtime 程序文件");
        archive.finish().expect("完成 Runtime 缓存");
        let mut item = item();
        item.byte_size = cache.metadata().expect("读取 Runtime 缓存大小").len();
        item.installed_size = 4096;
        item.sha256 = sha256_file(&cache).expect("计算 Runtime 缓存哈希");
        let settings = DesktopSettings { theme_mode: "system".into(), dependency_source: "auto".into(), default_privacy: "private".into(), model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: temporary.path().join("runtime").to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let result = install_cached_resource(&settings, &item, &cache, &|_| {}).expect("安装已验证 Runtime");
        assert_eq!(result.status, "installed");
        assert!(installed_resource_matches(&item, &settings));
        let report = crate::environment::inspect_environment(&settings);
        assert_eq!(report.runtime.status, "installed_unverified");
    }

    #[test]
    fn official_runtime_7z_is_compatible_with_safe_extractor() {
        let Ok(archive_path) = std::env::var("DRAWHIME_RUNTIME_TEST_ARCHIVE") else { return; };
        let temporary = tempfile::tempdir().expect("创建官方 Runtime 安装目录");
        let mut item = item();
        item.id = "runtime.comfyui.nvidia-cu126".into();
        item.version = "comfyui-v0.28.0-nvidia-cu126".into();
        item.file_name = "drawhime-runtime-comfyui-v0.28.0-nvidia-cu126-x86_64.7z".into();
        item.byte_size = 2_034_160_963;
        item.installed_size = 5_579_485_120;
        item.sha256 = "6af1b60b6a1fad780b07871e4ff356ac04a1807755ee13c6050e3ec3a4157cc0".into();
        item.archive = "7z".into();
        item.root_directory = Some("ComfyUI_windows_portable".into());
        let settings = DesktopSettings { theme_mode: "system".into(), dependency_source: "auto".into(), default_privacy: "private".into(), model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: temporary.path().join("runtime").to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let result = install_cached_resource(&settings, &item, Path::new(&archive_path), &|_| {}).expect("安全安装官方 Runtime");
        assert_eq!(result.status, "installed");
        assert!(installed_resource_matches(&item, &settings));
        assert_eq!(crate::environment::inspect_environment(&settings).runtime.status, "installed_unverified");
    }

    #[test]
    fn published_captioner_zip_installs_all_runtime_files() {
        let Ok(archive_path) = std::env::var("DRAWHIME_CAPTIONER_TEST_ARCHIVE") else { return; };
        let temporary = tempfile::tempdir().expect("创建 Captioner 安装目录");
        let item = DesktopResourceManifestItem {
            id: "captioner.wd-vit-tagger-v3".into(),
            kind: "captioner".into(),
            version: "wd-vit-tagger-v3-2.0-ort-1.22.1".into(),
            os: "windows".into(),
            arch: std::env::consts::ARCH.into(),
            file_name: "drawhime-wd-vit-tagger-v3-win-x64.zip".into(),
            byte_size: 364_125_250,
            installed_size: 415_737_407,
            sha256: "f709bca5c0e1a96ed2a0dd584210335471e4aa34a4d3c5b0604149a5b23a71a9".into(),
            archive: "zip".into(),
            root_directory: Some("drawhime-wd-vit-tagger-v3".into()),
            install_directory: None,
            model_registration: None,
            required: true,
            sources: vec![DesktopResourceSource { kind: "mirror".into(), url: "https://www.xanime.ink/local-model-api/v1/desktop/resources/captioner.wd-vit-tagger-v3/content".into() }],
        };
        let runtime_root = temporary.path().join("runtime");
        fs::create_dir_all(runtime_root.join("current")).expect("创建测试 Runtime");
        fs::write(runtime_root.join("current/runtime-manifest.json"), b"{\"status\":\"ready\"}").expect("写入测试 Runtime 清单");
        let settings = DesktopSettings { theme_mode: "system".into(), dependency_source: "auto".into(), default_privacy: "private".into(), model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: runtime_root.to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let result = install_cached_resource(&settings, &item, Path::new(&archive_path), &|_| {}).expect("安装已发布 Captioner");
        assert_eq!(result.status, "installed");
        let root = PathBuf::from(result.install_path.expect("读取 Captioner 安装路径"));
        assert!(root.join("runner.py").is_file());
        assert!(root.join("model.onnx").is_file());
        assert!(root.join("selected_tags.csv").is_file());
        assert!(root.join("site-packages/onnxruntime/__init__.py").is_file());
        assert!(installed_resource_matches(&item, &settings));
        assert!(crate::environment::inspect_environment(&settings).capabilities.captioning);
    }

    #[test]
    fn installed_anima_resource_group_becomes_one_registered_model() {
        let temporary = tempfile::tempdir().expect("创建模型组合临时目录");
        let settings = DesktopSettings { theme_mode: "system".into(), dependency_source: "auto".into(), default_privacy: "private".into(), model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: temporary.path().join("runtime").to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let definitions = [("primary", "diffusion_models", "model.safetensors", b"model".as_slice()), ("text_encoder", "text_encoders", "clip.safetensors", b"clip".as_slice()), ("vae", "vae", "vae.safetensors", b"vae".as_slice())];
        let mut items = Vec::new();
        for (role, directory, file_name, bytes) in definitions {
            let cache = temporary.path().join(format!("cache-{role}.safetensors"));
            fs::write(&cache, bytes).expect("写入模型缓存");
            let item = DesktopResourceManifestItem { id: format!("model.test.{role}"), kind: "model".into(), version: "1".into(), os: "windows".into(), arch: std::env::consts::ARCH.into(), file_name: file_name.into(), byte_size: bytes.len() as u64, installed_size: bytes.len() as u64, sha256: hex::encode(Sha256::digest(bytes)), archive: "raw".into(), root_directory: None, install_directory: Some(directory.into()), model_registration: Some(crate::models::DesktopResourceModelRegistration { group_id: "model.test".into(), display_name: "测试 Anima".into(), family: "anima".into(), workflow_kind: "anima".into(), role: role.into() }), required: true, sources: vec![DesktopResourceSource { kind: "mirror".into(), url: format!("https://mirror.example/{file_name}") }] };
            install_cached_resource(&settings, &item, &cache, &|_| {}).expect("安装模型组合文件");
            items.push(item);
        }
        validate_model_groups(&items).expect("模型组合清单有效");
        let registrations = collect_model_registrations(&settings, &items).expect("收集模型登记");
        assert_eq!(registrations.len(), 1);
        assert_eq!(registrations[0].model_file_name, "model.safetensors");
        assert_eq!(registrations[0].text_encoder_file_name.as_deref(), Some("clip.safetensors"));
        assert_eq!(registrations[0].vae_file_name.as_deref(), Some("vae.safetensors"));
    }
}
