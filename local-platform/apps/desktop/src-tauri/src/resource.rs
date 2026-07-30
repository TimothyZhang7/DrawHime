//! 本模块负责拉取签名资源清单，并以断点、切源、哈希校验和原子落盘下载桌面依赖。

use crate::models::{DesktopResourceCatalogItemView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopResourceManifestEnvelope, DesktopResourceManifestItem, DesktopResourceManifestPayload, DesktopResourceSource, DesktopSettings};
use crate::process::hide_window;
use crate::storage::LocalModelRegistration;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fs2::available_space;
use reqwest::{blocking::{Client, Response}, header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE}, StatusCode, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs::{self, File, OpenOptions}, io::{BufReader, Read, Seek, SeekFrom, Write}, path::{Component, Path, PathBuf}, process::{Command, Stdio}, sync::{Mutex, OnceLock}, thread, time::{Duration, Instant, UNIX_EPOCH}};
use tauri::Emitter;
use uuid::Uuid;
use zip::ZipArchive;

const MANIFEST_URL: &str = "https://www.xanime.ink/local-model-api/v1/desktop/resources/manifest";
const MANIFEST_KEY_ID: &str = "stable-2026-07-29";
const MANIFEST_PUBLIC_KEY: &str = "asfEBEwmIW6BPSgrLk9iNSgKqLprKisVFkq9QpJI8Pg=";
const MAX_MANIFEST_BYTES: u64 = 5 * 1024 * 1024;
const DOWNLOAD_BUFFER_BYTES: usize = 256 * 1024;
const DOWNLOAD_RANGE_BYTES: u64 = 8 * 1024 * 1024;
const SOURCE_CIRCUIT_DURATION: Duration = Duration::from_secs(2 * 60);
const DOWNLOAD_PAUSED_ERROR: &str = "download_paused";

#[derive(Clone, Copy)]
struct DownloadPolicy {
    low_speed_window: Duration,
    minimum_bytes_per_second: u64,
}

const PRODUCTION_DOWNLOAD_POLICY: DownloadPolicy = DownloadPolicy {
    low_speed_window: Duration::from_secs(8),
    minimum_bytes_per_second: 512 * 1024,
};

static SOURCE_FAILURES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static PAUSED_DOWNLOADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

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
    let (payload, cached_manifest) = load_resource_manifest(manifest_url, key_id, public_key, app_data_dir)?;
    let cache_dir = resource_cache_dir(app_data_dir);
    let resources = payload.resources.iter().filter(|item| item.kind != "application" && resource_matches_current_platform(item)).map(|item| {
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
            model_registration: item.model_registration.clone(),
        }
    }).collect();
    let message = if cached_manifest { "网络暂不可用，已使用仍在有效期内的本机签名清单" } else { "资源清单签名和有效期校验通过" };
    Ok(DesktopResourceCatalogView { configured: true, key_id: Some(key_id.into()), generated_at: Some(payload.generated_at), expires_at: Some(payload.expires_at), message: message.into(), resources })
}

/** 把已验证缓存安全安装到受控目录，并在切换失败时恢复旧版本。 */
pub fn install_resource(settings: &DesktopSettings, app_data_dir: &Path, resource_id: &str, app: &tauri::AppHandle) -> Result<ResourceInstallOutcome, String> {
    let result = install_resource_inner(settings, app_data_dir, resource_id, app);
    if let Err(error) = &result { emit_install_progress(app, install_view(resource_id, "failed", 0, None, None, Some(error.clone()))); }
    result
}

fn install_resource_inner(settings: &DesktopSettings, app_data_dir: &Path, resource_id: &str, app: &tauri::AppHandle) -> Result<ResourceInstallOutcome, String> {
    let Some((manifest_url, key_id, public_key)) = manifest_configuration() else { return Err("当前安装包尚未配置经过签名的资源发布通道".into()); };
    let (payload, _) = load_resource_manifest(manifest_url, key_id, public_key, app_data_dir)?;
    let item = payload.resources.iter().find(|candidate| candidate.id == resource_id && resource_matches_current_platform(candidate)).cloned().ok_or_else(|| "资源不存在或不适用于当前系统".to_string())?;
    // 应用程序包只能经过软件更新控制器重新验签并启动，禁止作为普通依赖写入模型目录。
    if item.kind == "application" { return Err("应用程序包请在软件更新页面应用".into()); }
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
    ensure_sufficient_space(available, required_space)?;
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

/** 在写入临时目录前统一执行磁盘容量门禁，避免覆盖现有 Runtime 或模型。 */
fn ensure_sufficient_space(available: u64, required: u64) -> Result<(), String> {
    if available < required { return Err(format!("安装磁盘空间不足：至少需要 {} MiB 可用空间", required / 1024 / 1024)); }
    Ok(())
}

/** 下载单个资源并保存断点；只有整体哈希匹配后才写入已验证标记。 */
pub fn download_resource(settings: &DesktopSettings, app_data_dir: &Path, resource_id: &str, app: &tauri::AppHandle) -> Result<DesktopResourceDownloadView, String> {
    clear_download_pause(resource_id);
    let Some((manifest_url, key_id, public_key)) = manifest_configuration() else { return Err("当前安装包尚未配置经过签名的资源发布通道".into()); };
    let (payload, _) = load_resource_manifest(manifest_url, key_id, public_key, app_data_dir)?;
    let item = payload.resources.into_iter().find(|candidate| candidate.id == resource_id && resource_matches_current_platform(candidate)).ok_or_else(|| "资源不存在或不适用于当前系统".to_string())?;
    let sources = ordered_sources(&item, &settings.dependency_source);
    if sources.is_empty() { return Err("当前依赖来源设置下没有可用下载地址".into()); }
    let cache_dir = resource_cache_dir(app_data_dir);
    fs::create_dir_all(&cache_dir).map_err(|error| format!("创建资源缓存目录失败：{error}"))?;
    let target = cache_dir.join(&item.file_name);
    if target.is_file() && file_matches(&target, &item)? {
        write_verified_marker(&target, &item)?;
        return Ok(progress_view(&item, "downloaded", None, item.byte_size, 0, None, Some(&target), None));
    }
    quarantine_invalid_target(&target)?;
    let partial = partial_path(&target);
    if partial.metadata().map(|metadata| metadata.len() > item.byte_size).unwrap_or(false) { fs::remove_file(&partial).map_err(|error| format!("清理超长下载断点失败：{error}"))?; }
    let session_start_bytes = partial.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    emit_progress(app, progress_view(&item, "queued", None, session_start_bytes, 0, None, None, None));
    let client = Client::builder().connect_timeout(Duration::from_secs(4)).timeout(Duration::from_secs(20)).user_agent("DrawHime-Desktop/0.1").build().map_err(|error| format!("创建资源下载客户端失败：{error}"))?;
    // 续传测速只统计本次会话新增字节，历史断点不得参与速度和剩余时间计算。
    let session_started_at = Instant::now();
    let mut errors = Vec::new();
    let mut switch_reason = None;
    let mut active_source_kind = None;
    let notify = |view| emit_progress(app, view);
    for (index, source) in sources.iter().enumerate() {
        if partial.metadata().map(|metadata| metadata.len()).unwrap_or(0) >= item.byte_size { break; }
        active_source_kind = Some(source.kind.clone());
        match download_from_source(&client, &item, source, &partial, session_started_at, session_start_bytes, &notify) {
            Ok(()) => record_source_success(source),
            Err(error) => {
                if error == DOWNLOAD_PAUSED_ERROR {
                    let downloaded = partial.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                    let view = progress_view(&item, "paused", active_source_kind, downloaded, 0, None, Some(&partial), None);
                    emit_progress(app, view.clone());
                    return Ok(view);
                }
                record_source_failure(source);
                let reason = format!("{}来源{}，已保留断点", source_kind_name(&source.kind), error);
                errors.push(reason.clone());
                switch_reason = Some(reason);
                if let Some(next_source) = sources.get(index + 1) {
                    let downloaded = partial.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                    active_source_kind = Some(next_source.kind.clone());
                    emit_progress(app, progress_view(&item, "downloading", active_source_kind.clone(), downloaded, session_average_speed(downloaded, session_start_bytes, session_started_at), switch_reason.clone(), None, None));
                }
            }
        }
    }
    let downloaded_bytes = partial.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if downloaded_bytes != item.byte_size {
        let message = if errors.is_empty() { "下载未达到资源声明大小".into() } else { errors.join("；") };
        let view = progress_view(&item, "failed", active_source_kind.clone(), downloaded_bytes, 0, switch_reason.clone(), None, Some(message.clone()));
        emit_progress(app, view);
        return Err(message);
    }
    emit_progress(app, progress_view(&item, "verifying", active_source_kind.clone(), downloaded_bytes, 0, switch_reason.clone(), None, None));
    let actual_sha256 = sha256_file(&partial)?;
    if actual_sha256 != item.sha256 {
        quarantine_file(&partial, "checksum-invalid")?;
        let message = "资源整体 SHA-256 校验失败，文件已隔离".to_string();
        emit_progress(app, progress_view(&item, "failed", active_source_kind.clone(), downloaded_bytes, 0, switch_reason.clone(), None, Some(message.clone())));
        return Err(message);
    }
    fs::rename(&partial, &target).map_err(|error| format!("原子写入资源缓存失败：{error}"))?;
    write_verified_marker(&target, &item)?;
    let view = progress_view(&item, "downloaded", active_source_kind, item.byte_size, 0, switch_reason, Some(&target), None);
    emit_progress(app, view.clone());
    Ok(view)
}

/** 标记指定资源暂停；已写入的分片继续保留，下一次下载从原偏移恢复。 */
pub fn pause_download(resource_id: &str) -> Result<(), String> {
    if resource_id.trim().is_empty() || resource_id.len() > 128 { return Err("资源 ID 不正确".into()); }
    paused_downloads().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(resource_id.to_string());
    Ok(())
}

fn manifest_configuration() -> Option<(&'static str, &'static str, &'static str)> {
    (!MANIFEST_URL.is_empty() && !MANIFEST_KEY_ID.is_empty() && !MANIFEST_PUBLIC_KEY.is_empty()).then_some((MANIFEST_URL, MANIFEST_KEY_ID, MANIFEST_PUBLIC_KEY))
}

/** 为软件更新控制器读取同一固定公钥验签后的在线清单。 */
pub(crate) fn verified_manifest() -> Result<DesktopResourceManifestPayload, String> {
    let Some((manifest_url, key_id, public_key)) = manifest_configuration() else { return Err("当前安装包尚未配置经过签名的更新通道".into()); };
    fetch_verified_manifest(manifest_url, key_id, public_key)
}

/** 返回资源受控缓存路径，调用方仍需使用签名条目校验。 */
pub(crate) fn cached_resource_path(app_data_dir: &Path, item: &DesktopResourceManifestItem) -> PathBuf { resource_cache_dir(app_data_dir).join(&item.file_name) }

/** 导入离线 NSIS 包及其 Ed25519 信封，验证完成后写入与在线下载相同的受控缓存。 */
pub(crate) fn import_offline_application(app_data_dir: &Path, installer_path: &Path, envelope_path: &Path) -> Result<DesktopResourceManifestItem, String> {
    if !installer_path.is_file() || !envelope_path.is_file() { return Err("离线更新安装包或签名信封不存在".into()); }
    let item = verify_offline_application(installer_path, envelope_path)?;
    let cache_dir = resource_cache_dir(app_data_dir);
    fs::create_dir_all(&cache_dir).map_err(|error| format!("创建更新缓存目录失败：{error}"))?;
    let target = cache_dir.join(&item.file_name);
    let target_envelope = offline_envelope_path(&target);
    let nonce = Uuid::new_v4();
    let temporary = cache_dir.join(format!("{}.offline-{nonce}", item.file_name));
    let temporary_envelope = cache_dir.join(format!("{}.envelope-{nonce}", item.file_name));
    fs::copy(installer_path, &temporary).map_err(|error| format!("复制离线更新包失败：{error}"))?;
    if let Err(error) = fs::copy(envelope_path, &temporary_envelope) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("复制离线更新签名失败：{error}"));
    }
    if target.exists() { quarantine_file(&target, "replaced")?; }
    if target_envelope.exists() { quarantine_file(&target_envelope, "replaced")?; }
    fs::rename(&temporary, &target).map_err(|error| format!("提交离线更新缓存失败：{error}"))?;
    fs::rename(&temporary_envelope, &target_envelope).map_err(|error| format!("提交离线更新签名失败：{error}"))?;
    write_verified_marker(&target, &item)?;
    Ok(item)
}

/** 重新验证离线包签名与完整性，应用更新前不得只信任 SQLite 或验证标记。 */
pub(crate) fn verify_offline_application(installer_path: &Path, envelope_path: &Path) -> Result<DesktopResourceManifestItem, String> {
    verify_application_package(installer_path, envelope_path, MANIFEST_KEY_ID, MANIFEST_PUBLIC_KEY)
}

fn verify_application_package(installer_path: &Path, envelope_path: &Path, expected_key_id: &str, public_key: &str) -> Result<DesktopResourceManifestItem, String> {
    let envelope_bytes = fs::read(envelope_path).map_err(|error| format!("读取离线更新签名失败：{error}"))?;
    if envelope_bytes.len() as u64 > MAX_MANIFEST_BYTES { return Err("离线更新签名信封超过大小限制".into()); }
    let envelope: DesktopResourceManifestEnvelope = serde_json::from_slice(&envelope_bytes).map_err(|error| format!("解析离线更新签名失败：{error}"))?;
    let payload = verify_manifest(envelope, expected_key_id, public_key)?;
    let file_name = installer_path.file_name().and_then(|value| value.to_str()).ok_or_else(|| "离线更新文件名不正确".to_string())?;
    let item = payload.resources.into_iter().find(|item| item.kind == "application" && item.file_name == file_name && resource_matches_current_platform(item)).ok_or_else(|| "签名信封没有登记该 Windows 安装包".to_string())?;
    if !file_matches(installer_path, &item)? { return Err("离线更新安装包大小或 SHA-256 与签名不一致".into()); }
    Ok(item)
}

/** 离线签名信封与安装包同目录保存，回滚和应用时都重新验签。 */
pub(crate) fn offline_envelope_path(installer_path: &Path) -> PathBuf { installer_path.with_file_name(format!("{}.envelope.json", installer_path.file_name().unwrap_or_default().to_string_lossy())) }

fn fetch_verified_manifest(manifest_url: &str, expected_key_id: &str, public_key: &str) -> Result<DesktopResourceManifestPayload, String> {
    verify_manifest(fetch_manifest_envelope(manifest_url)?, expected_key_id, public_key)
}

/** 普通依赖优先使用在线签名清单，网络异常时回退到仍有效的本机签名信封。 */
fn load_resource_manifest(manifest_url: &str, expected_key_id: &str, public_key: &str, app_data_dir: &Path) -> Result<(DesktopResourceManifestPayload, bool), String> {
    match fetch_manifest_envelope(manifest_url) {
        Ok(envelope) => {
            let payload = verify_manifest(envelope.clone(), expected_key_id, public_key)?;
            persist_cached_resource_manifest(app_data_dir, &envelope)?;
            Ok((payload, false))
        }
        Err(online_error) => {
            let cached = read_cached_resource_manifest(app_data_dir).and_then(|envelope| verify_manifest(envelope, expected_key_id, public_key));
            cached.map(|payload| (payload, true)).map_err(|cached_error| format!("{online_error}；本机签名清单不可用：{cached_error}"))
        }
    }
}

/** 签名信封使用同目录临时文件和回滚文件原子更新，缓存损坏不会覆盖上一份可用清单。 */
fn persist_cached_resource_manifest(app_data_dir: &Path, envelope: &DesktopResourceManifestEnvelope) -> Result<(), String> {
    let directory = resource_cache_dir(app_data_dir);
    fs::create_dir_all(&directory).map_err(|error| format!("创建资源缓存目录失败：{error}"))?;
    let target = cached_resource_manifest_path(app_data_dir);
    let temporary = directory.join(format!("manifest-envelope.tmp-{}", Uuid::new_v4()));
    let backup = directory.join("manifest-envelope.previous.json");
    let bytes = serde_json::to_vec(envelope).map_err(|error| format!("序列化资源签名清单失败：{error}"))?;
    fs::write(&temporary, bytes).map_err(|error| format!("写入资源签名清单临时文件失败：{error}"))?;
    if backup.exists() { fs::remove_file(&backup).map_err(|error| format!("清理旧资源清单回滚文件失败：{error}"))?; }
    if target.exists() { fs::rename(&target, &backup).map_err(|error| format!("备份旧资源签名清单失败：{error}"))?; }
    if let Err(error) = fs::rename(&temporary, &target) {
        if backup.exists() { let _ = fs::rename(&backup, &target); }
        return Err(format!("提交资源签名清单缓存失败：{error}"));
    }
    if backup.exists() { let _ = fs::remove_file(backup); }
    Ok(())
}

/** 读取缓存信封时限制体积，随后仍执行固定公钥、时间和完整载荷校验。 */
fn read_cached_resource_manifest(app_data_dir: &Path) -> Result<DesktopResourceManifestEnvelope, String> {
    let path = cached_resource_manifest_path(app_data_dir);
    let metadata = path.metadata().map_err(|_| "尚无本机签名清单缓存".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES { return Err("本机签名清单缓存大小异常".into()); }
    let bytes = fs::read(path).map_err(|error| format!("读取本机签名清单失败：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析本机签名清单失败：{error}"))
}

/** 有界读取 HTTPS 清单信封；签名验证由调用方在返回后立即执行。 */
fn fetch_manifest_envelope(manifest_url: &str) -> Result<DesktopResourceManifestEnvelope, String> {
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
    wrapper.data.ok_or_else(|| "资源服务未返回签名清单".to_string())
}

/** 保存当前在线清单的原始签名信封，使已下载版本在后续回滚时仍可重新验签。 */
pub(crate) fn persist_online_application_envelope(app_data_dir: &Path, item: &DesktopResourceManifestItem) -> Result<PathBuf, String> {
    let Some((manifest_url, key_id, public_key)) = manifest_configuration() else { return Err("当前安装包尚未配置经过签名的更新通道".into()); };
    let envelope = fetch_manifest_envelope(manifest_url)?;
    let payload = verify_manifest(envelope.clone(), key_id, public_key)?;
    if !payload.resources.iter().any(|candidate| candidate.id == item.id && candidate.file_name == item.file_name && candidate.sha256 == item.sha256 && candidate.byte_size == item.byte_size && candidate.version == item.version) { return Err("在线签名清单已切换到其他更新版本".into()); }
    let installer = cached_resource_path(app_data_dir, item);
    let target = offline_envelope_path(&installer);
    let temporary = target.with_file_name(format!("{}.tmp-{}", target.file_name().unwrap_or_default().to_string_lossy(), Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec(&envelope).map_err(|error| format!("序列化更新签名失败：{error}"))?).map_err(|error| format!("保存在线更新签名失败：{error}"))?;
    if target.exists() { quarantine_file(&target, "replaced")?; }
    fs::rename(&temporary, &target).map_err(|error| format!("提交在线更新签名失败：{error}"))?;
    Ok(target)
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
    if !matches!(item.kind.as_str(), "runtime" | "model" | "lora" | "captioner" | "trainer" | "application") { return Err(format!("资源类型不受支持：{}", item.id)); }
    if item.os != "windows" || !matches!(item.arch.as_str(), "x86_64" | "aarch64") { return Err(format!("资源平台字段不正确：{}", item.id)); }
    if item.file_name.len() < 2 || item.file_name.len() > 255 || !item.file_name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')) { return Err(format!("资源文件名不安全：{}", item.id)); }
    validate_windows_relative_path(Path::new(&item.file_name)).map_err(|_| format!("资源文件名不适用于 Windows：{}", item.id))?;
    if item.byte_size == 0 || item.installed_size == 0 || item.installed_size > 512 * 1024 * 1024 * 1024 || item.sha256.len() != 64 || !item.sha256.chars().all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()) { return Err(format!("资源大小或哈希不正确：{}", item.id)); }
    if !matches!(item.archive.as_str(), "raw" | "zip" | "7z") || item.sources.is_empty() || item.sources.len() > 8 { return Err(format!("资源归档或来源不正确：{}", item.id)); }
    if matches!(item.kind.as_str(), "model" | "lora") && (item.archive != "raw" || item.installed_size != item.byte_size) { return Err(format!("模型和 LoRA 必须使用声明大小一致的原始文件：{}", item.id)); }
    if matches!(item.kind.as_str(), "runtime" | "captioner" | "trainer") && item.archive == "raw" { return Err(format!("运行组件必须使用归档文件：{}", item.id)); }
    if item.kind == "application" && (item.archive != "raw" || item.application_update.is_none() || !item.file_name.to_ascii_lowercase().ends_with(".exe")) { return Err(format!("应用更新必须是带版本元数据的原始 NSIS EXE：{}", item.id)); }
    if let Some(metadata) = &item.application_update {
        let version = semantic_version(&item.version).ok_or_else(|| format!("应用更新版本格式不正确：{}", item.id))?;
        let minimum = semantic_version(&metadata.minimum_version).ok_or_else(|| format!("应用更新最低版本格式不正确：{}", item.id))?;
        if minimum > version || metadata.release_notes.len() > 20_000 { return Err(format!("应用更新版本门禁或说明不正确：{}", item.id)); }
    }
    if item.kind != "application" && item.application_update.is_some() { return Err(format!("非应用资源不得声明软件更新元数据：{}", item.id)); }
    if item.archive == "raw" && item.root_directory.is_some() { return Err(format!("原始文件资源不得声明归档根目录：{}", item.id)); }
    if item.kind == "model" && (!matches!(item.install_directory.as_deref(), Some("checkpoints" | "diffusion_models" | "text_encoders" | "vae")) || item.model_registration.is_none()) { return Err(format!("模型资源缺少受控安装目录或组合登记：{}", item.id)); }
    if item.kind == "lora" && item.install_directory.as_deref().is_some_and(|directory| directory != "loras") { return Err(format!("LoRA 安装目录不正确：{}", item.id)); }
    if !matches!(item.kind.as_str(), "model" | "lora") && (item.install_directory.is_some() || item.model_registration.is_some()) { return Err(format!("非模型资源不得声明模型安装元数据：{}", item.id)); }
    if let Some(root_directory) = &item.root_directory { validate_windows_relative_path(Path::new(root_directory)).map_err(|_| format!("资源归档根目录不安全：{}", item.id))?; if Path::new(root_directory).components().count() != 1 { return Err(format!("资源归档根目录只能包含一级：{}", item.id)); } }
    let mut kinds = HashSet::new();
    let mut urls = HashSet::new();
    for source in &item.sources {
        if !matches!(source.kind.as_str(), "official" | "mirror") || !kinds.insert(&source.kind) || !urls.insert(&source.url) { return Err(format!("资源来源类型或地址不正确、重复：{}", item.id)); }
        let url = Url::parse(&source.url).map_err(|_| format!("资源下载地址格式不正确：{}", item.id))?;
        if url.scheme() != "https" { return Err(format!("资源下载地址必须使用 HTTPS：{}", item.id)); }
    }
    Ok(())
}

fn semantic_version(value: &str) -> Option<(u64, u64, u64)> {
    let values = value.split('.').map(str::parse::<u64>).collect::<Result<Vec<_>, _>>().ok()?;
    (values.len() == 3).then_some((values[0], values[1], values[2]))
}

fn ordered_sources<'a>(item: &'a DesktopResourceManifestItem, preference: &str) -> Vec<&'a DesktopResourceSource> {
    let mut sources: Vec<_> = item.sources.iter().filter(|source| match preference { "official" => source.kind == "official", "mirror" => source.kind == "mirror", _ => true }).collect();
    if preference == "auto" {
        sources.sort_by_key(|source| if source.kind == "official" { 0 } else { 1 });
        let healthy: Vec<_> = sources.iter().copied().filter(|source| !source_circuit_open(source)).collect();
        if !healthy.is_empty() { return healthy; }
    }
    sources
}

fn download_from_source<F: Fn(DesktopResourceDownloadView)>(client: &Client, item: &DesktopResourceManifestItem, source: &DesktopResourceSource, partial: &Path, session_started_at: Instant, session_start_bytes: u64, notify: &F) -> Result<(), String> {
    download_from_source_with_policy(client, item, source, partial, session_started_at, session_start_bytes, notify, PRODUCTION_DOWNLOAD_POLICY)
}

fn download_from_source_with_policy<F: Fn(DesktopResourceDownloadView)>(client: &Client, item: &DesktopResourceManifestItem, source: &DesktopResourceSource, partial: &Path, session_started_at: Instant, session_start_bytes: u64, notify: &F, policy: DownloadPolicy) -> Result<(), String> {
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
        validate_range_response(&response, item, offset, end_inclusive, full_single_response)?;
        offset = stream_response(response, &mut file, item, source, offset, end_inclusive + 1, session_started_at, session_start_bytes, source_started, source_start_bytes, notify, policy)?;
    }
    Ok(())
}

fn validate_range_response(response: &Response, item: &DesktopResourceManifestItem, start: u64, end_inclusive: u64, full_single_response: bool) -> Result<(), String> {
    let expected_length = end_inclusive.saturating_sub(start).saturating_add(1);
    let content_length = response.headers().get(CONTENT_LENGTH).and_then(|value| value.to_str().ok()).and_then(|value| value.parse::<u64>().ok());
    if content_length != Some(expected_length) { return Err("下载来源返回的分片长度不正确".into()); }
    if !full_single_response {
        let expected_range = format!("bytes {start}-{end_inclusive}/{}", item.byte_size);
        let content_range = response.headers().get(CONTENT_RANGE).and_then(|value| value.to_str().ok());
        if content_range != Some(expected_range.as_str()) { return Err("下载来源返回的 Content-Range 不正确".into()); }
    }
    Ok(())
}

fn stream_response<F: Fn(DesktopResourceDownloadView)>(mut response: Response, file: &mut File, item: &DesktopResourceManifestItem, source: &DesktopResourceSource, mut downloaded: u64, expected_end: u64, session_started_at: Instant, session_start_bytes: u64, source_started: Instant, source_start_bytes: u64, notify: &F, policy: DownloadPolicy) -> Result<u64, String> {
    let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_BYTES];
    let mut last_emit = Instant::now();
    loop {
        if download_paused(&item.id) {
            file.flush().map_err(|error| format!("保存暂停断点失败：{error}"))?;
            return Err(DOWNLOAD_PAUSED_ERROR.into());
        }
        let read = response.read(&mut buffer).map_err(|error| format!("读取中断：{error}"))?;
        if read == 0 { break; }
        let next = downloaded.saturating_add(read as u64);
        if next > expected_end { return Err("上游返回分片超过请求范围".into()); }
        file.write_all(&buffer[..read]).map_err(|error| format!("写入下载断点失败：{error}"))?;
        downloaded = next;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            notify(progress_view(item, "downloading", Some(source.kind.clone()), downloaded, session_average_speed(downloaded, session_start_bytes, session_started_at), None, None, None));
            last_emit = Instant::now();
        }
        let source_elapsed = source_started.elapsed();
        if source_elapsed >= policy.low_speed_window && downloaded < item.byte_size {
            let source_speed = downloaded.saturating_sub(source_start_bytes) / source_elapsed.as_secs().max(1);
            if source_speed < policy.minimum_bytes_per_second {
                file.flush().map_err(|error| format!("保存低速断点失败：{error}"))?;
                return Err(format!("持续下载速度过低（{} KiB/s）", source_speed / 1024));
            }
        }
        if downloaded == expected_end { break; }
    }
    file.flush().map_err(|error| format!("保存下载断点失败：{error}"))?;
    if downloaded < expected_end { return Err("连接提前结束，已保留断点".into()); }
    Ok(downloaded)
}

fn source_failures() -> &'static Mutex<HashMap<String, Instant>> { SOURCE_FAILURES.get_or_init(|| Mutex::new(HashMap::new())) }
fn paused_downloads() -> &'static Mutex<HashSet<String>> { PAUSED_DOWNLOADS.get_or_init(|| Mutex::new(HashSet::new())) }
fn download_paused(resource_id: &str) -> bool { paused_downloads().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(resource_id) }
fn clear_download_pause(resource_id: &str) { paused_downloads().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(resource_id); }

fn source_circuit_open(source: &DesktopResourceSource) -> bool {
    let mut failures = source_failures().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    failures.retain(|_, failed_at| failed_at.elapsed() < SOURCE_CIRCUIT_DURATION);
    failures.contains_key(&source.url)
}

fn record_source_failure(source: &DesktopResourceSource) {
    source_failures().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(source.url.clone(), Instant::now());
}

fn record_source_success(source: &DesktopResourceSource) {
    source_failures().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&source.url);
}

fn source_kind_name(kind: &str) -> &'static str { if kind == "official" { "官方" } else { "主站镜像" } }

fn resource_matches_current_platform(item: &DesktopResourceManifestItem) -> bool { item.os == "windows" && item.arch == std::env::consts::ARCH }
fn resource_cache_dir(app_data_dir: &Path) -> PathBuf { app_data_dir.join("resource-cache") }
fn cached_resource_manifest_path(app_data_dir: &Path) -> PathBuf { resource_cache_dir(app_data_dir).join("manifest-envelope.json") }
fn partial_path(target: &Path) -> PathBuf { target.with_file_name(format!("{}.part", target.file_name().unwrap_or_default().to_string_lossy())) }
fn marker_path(target: &Path) -> PathBuf { target.with_file_name(format!("{}.verified", target.file_name().unwrap_or_default().to_string_lossy())) }
fn verified_marker_matches(target: &Path, item: &DesktopResourceManifestItem) -> bool { target.metadata().is_ok_and(|metadata| metadata.len() == item.byte_size) && fs::read_to_string(marker_path(target)).is_ok_and(|value| value.trim() == item.sha256) }
fn write_verified_marker(target: &Path, item: &DesktopResourceManifestItem) -> Result<(), String> { fs::write(marker_path(target), format!("{}\n", item.sha256)).map_err(|error| format!("写入资源验证标记失败：{error}")) }
fn file_matches(path: &Path, item: &DesktopResourceManifestItem) -> Result<bool, String> { Ok(path.metadata().map(|metadata| metadata.len() == item.byte_size).unwrap_or(false) && sha256_file(path)? == item.sha256) }
/** 速度只按本次会话新增字节计算，并等待采样稳定后再向界面提供数值。 */
fn session_average_speed(downloaded_bytes: u64, session_start_bytes: u64, started_at: Instant) -> u64 {
    let elapsed_millis = started_at.elapsed().as_millis();
    let session_bytes = downloaded_bytes.saturating_sub(session_start_bytes);
    if elapsed_millis < 750 || session_bytes < 64 * 1024 { return 0; }
    ((session_bytes as u128 * 1_000) / elapsed_millis).min(u64::MAX as u128) as u64
}
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
    if item.archive == "raw" && destination.metadata().map(|metadata| !metadata.is_file() || metadata.len() != item.byte_size).unwrap_or(true) { return false; }
    let Ok(content) = fs::read_to_string(marker) else { return false; };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else { return false; };
    let sha256_matches = value.get("sha256").and_then(serde_json::Value::as_str) == Some(item.sha256.as_str());
    let resource_matches = value.get("resourceId").and_then(serde_json::Value::as_str) == Some(item.id.as_str());
    // 相同签名内容可由多个底模组合复用，避免文本编码器和 VAE 被重复下载及占用磁盘。
    sha256_matches && (resource_matches || item.archive == "raw")
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
    let names_output = hide_window(&mut Command::new(tar)).args(["-tf", archive_text.as_str()]).output().map_err(|error| format!("读取 7z 文件列表失败：{error}"))?;
    if !names_output.status.success() || names_output.stdout.len() > 64 * 1024 * 1024 { return Err("资源 7z 文件列表读取失败或超过限制".into()); }
    let names = String::from_utf8(names_output.stdout).map_err(|_| "资源 7z 文件名不是 UTF-8".to_string())?;
    let mut entry_count = 0_usize;
    for name in names.lines().filter(|name| !name.trim().is_empty()) {
        entry_count += 1;
        if entry_count > 200_000 { return Err("资源 7z 文件数量超过限制".into()); }
        let normalized = name.trim_end_matches('/').replace('\\', "/");
        validate_windows_relative_path(Path::new(&normalized))?;
    }
    let verbose = hide_window(&mut Command::new(tar)).args(["-tvf", archive_text.as_str()]).output().map_err(|error| format!("读取 7z 类型列表失败：{error}"))?;
    if !verbose.status.success() || verbose.stdout.len() > 128 * 1024 * 1024 { return Err("资源 7z 类型列表读取失败或超过限制".into()); }
    if String::from_utf8_lossy(&verbose.stdout).lines().any(|line| matches!(line.chars().next(), Some('l' | 'h'))) { return Err("资源 7z 包含链接条目".into()); }
    let mut child = hide_window(&mut Command::new(tar)).args(["-xf", archive_text.as_str(), "-C", staging_text.as_str()]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| format!("启动 7z 解压失败：{error}"))?;
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
    if item.kind == "trainer" {
        for required in [staging.join("runner.py"), staging.join("sd-scripts").join("anima_train_network.py"), staging.join("sd-scripts").join("networks").join("lora_anima.py"), staging.join("site-packages").join("accelerate").join("__init__.py")] {
            if !required.is_file() { return Err(format!("Trainer 归档缺少必需文件：{}", required.file_name().unwrap_or_default().to_string_lossy())); }
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

fn progress_view(item: &DesktopResourceManifestItem, status: &str, source_kind: Option<String>, downloaded_bytes: u64, bytes_per_second: u64, switch_reason: Option<String>, target_path: Option<&Path>, error: Option<String>) -> DesktopResourceDownloadView {
    let remaining_bytes = item.byte_size.saturating_sub(downloaded_bytes);
    // 只有稳定下载阶段才展示 ETA，暂停、校验、完成和失败状态不沿用旧速度。
    let eta_seconds = (status == "downloading" && bytes_per_second > 0 && remaining_bytes > 0)
        .then(|| remaining_bytes.saturating_add(bytes_per_second - 1) / bytes_per_second)
        .filter(|seconds| *seconds <= 7 * 24 * 60 * 60);
    DesktopResourceDownloadView { resource_id: item.id.clone(), status: status.into(), source_kind, downloaded_bytes, total_bytes: item.byte_size, bytes_per_second, eta_seconds, switch_reason, target_path: target_path.map(|path| path.to_string_lossy().into_owned()), error }
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
        DesktopResourceManifestItem { id: "runtime.core".into(), kind: "runtime".into(), version: "1.0.0".into(), os: "windows".into(), arch: std::env::consts::ARCH.into(), file_name: "runtime.zip".into(), byte_size: 10, installed_size: 1024, sha256: "a".repeat(64), archive: "zip".into(), root_directory: None, install_directory: None, model_registration: None, application_update: None, required: true, sources: vec![DesktopResourceSource { kind: "mirror".into(), url: "https://mirror.example/runtime.zip".into() }, DesktopResourceSource { kind: "official".into(), url: "https://official.example/runtime.zip".into() }] }
    }

    fn application_item(bytes: &[u8]) -> DesktopResourceManifestItem {
        DesktopResourceManifestItem {
            id: "application.desktop.stable".into(),
            kind: "application".into(),
            version: "0.2.0".into(),
            os: "windows".into(),
            arch: std::env::consts::ARCH.into(),
            file_name: "drawhime-update.exe".into(),
            byte_size: bytes.len() as u64,
            installed_size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
            archive: "raw".into(),
            root_directory: None,
            install_directory: None,
            model_registration: None,
            application_update: Some(crate::models::DesktopApplicationUpdateMetadata {
                minimum_version: "0.1.0".into(),
                release_notes: "测试签名更新".into(),
                mandatory: false,
            }),
            required: false,
            sources: vec![DesktopResourceSource {
                kind: "mirror".into(),
                url: "https://mirror.example/drawhime-update.exe".into(),
            }],
        }
    }

    fn signed_application_envelope(
        item: DesktopResourceManifestItem,
        signing_key: &SigningKey,
    ) -> DesktopResourceManifestEnvelope {
        let payload = serde_json::to_string(&DesktopResourceManifestPayload {
            schema_version: 1,
            channel: "stable".into(),
            generated_at: Utc::now().to_rfc3339(),
            expires_at: (Utc::now() + ChronoDuration::hours(1)).to_rfc3339(),
            resources: vec![item],
        })
        .expect("序列化应用更新测试清单");
        DesktopResourceManifestEnvelope {
            key_id: "test".into(),
            signature: BASE64.encode(signing_key.sign(payload.as_bytes()).to_bytes()),
            payload,
        }
    }

    #[test]
    fn source_preference_obeys_user_setting() {
        let item = item();
        assert_eq!(ordered_sources(&item, "auto").iter().map(|source| source.kind.as_str()).collect::<Vec<_>>(), vec!["official", "mirror"]);
        assert_eq!(ordered_sources(&item, "official").len(), 1);
        assert_eq!(ordered_sources(&item, "mirror")[0].kind, "mirror");
    }

    #[test]
    fn resource_rejects_duplicate_official_and_mirror_urls() {
        let mut item = item();
        item.sources[1].url = item.sources[0].url.clone();
        assert!(validate_item(&item).is_err());
    }

    #[test]
    fn disk_space_gate_rejects_installation_before_writing() {
        let required = 512 * 1024 * 1024;
        assert!(ensure_sufficient_space(required - 1, required).is_err());
        assert!(ensure_sufficient_space(required, required).is_ok());
    }

    #[test]
    fn auto_source_skips_open_circuit_while_fixed_source_stays_selected() {
        let mut item = item();
        item.sources[0].url = "https://mirror.example/circuit-runtime.zip".into();
        item.sources[1].url = "https://official.example/circuit-runtime.zip".into();
        let official = item.sources.iter().find(|source| source.kind == "official").expect("找到官方测试来源");
        record_source_failure(official);
        assert_eq!(ordered_sources(&item, "auto").iter().map(|source| source.kind.as_str()).collect::<Vec<_>>(), vec!["mirror"]);
        assert_eq!(ordered_sources(&item, "official")[0].kind, "official");
        record_source_success(official);
        assert_eq!(ordered_sources(&item, "auto")[0].kind, "official");
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

    /** 本机清单缓存仍必须通过原始签名和有效期验证。 */
    #[test]
    fn cached_manifest_preserves_verified_envelope() {
        let temporary = tempfile::tempdir().expect("创建清单缓存测试目录");
        let signing_key = SigningKey::from_bytes(&[11_u8; 32]);
        let envelope = signed_application_envelope(application_item(b"cached-installer"), &signing_key);
        persist_cached_resource_manifest(temporary.path(), &envelope).expect("原子保存签名清单");
        let restored = read_cached_resource_manifest(temporary.path()).expect("读取签名清单缓存");
        let public_key = BASE64.encode(signing_key.verifying_key().to_bytes());
        let payload = verify_manifest(restored, "test", &public_key).expect("缓存清单重新验签");
        assert_eq!(payload.resources[0].id, "application.desktop.stable");
    }

    #[test]
    fn application_resource_requires_complete_update_metadata() {
        let mut application = application_item(b"signed-installer");
        application.application_update = None;
        assert!(validate_item(&application).is_err());
        application.application_update = Some(crate::models::DesktopApplicationUpdateMetadata {
            minimum_version: "0.3.0".into(),
            release_notes: "最低版本高于目标版本".into(),
            mandatory: false,
        });
        assert!(validate_item(&application).is_err());
    }

    #[test]
    fn offline_application_rejects_tampered_envelope() {
        let temporary = tempfile::tempdir().expect("创建离线更新篡改测试目录");
        let installer = temporary.path().join("drawhime-update.exe");
        fs::write(&installer, b"signed-installer").expect("写入测试安装包");
        let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
        let mut envelope = signed_application_envelope(application_item(b"signed-installer"), &signing_key);
        envelope.payload.push(' ');
        let envelope_path = temporary.path().join("update.envelope.json");
        fs::write(&envelope_path, serde_json::to_vec(&envelope).expect("序列化篡改信封")).expect("写入篡改信封");
        let public_key = BASE64.encode(signing_key.verifying_key().to_bytes());
        assert!(verify_application_package(&installer, &envelope_path, "test", &public_key).is_err());
    }

    #[test]
    fn offline_application_rejects_installer_sha256_mismatch() {
        let temporary = tempfile::tempdir().expect("创建离线更新哈希测试目录");
        let installer = temporary.path().join("drawhime-update.exe");
        fs::write(&installer, b"broken-installer").expect("写入被替换安装包");
        let signing_key = SigningKey::from_bytes(&[11_u8; 32]);
        let envelope = signed_application_envelope(application_item(b"signed-installer"), &signing_key);
        let envelope_path = temporary.path().join("update.envelope.json");
        fs::write(&envelope_path, serde_json::to_vec(&envelope).expect("序列化签名信封")).expect("写入签名信封");
        let public_key = BASE64.encode(signing_key.verifying_key().to_bytes());
        assert!(verify_application_package(&installer, &envelope_path, "test", &public_key).is_err());
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
        download_from_source(&client, &item, &source, &partial, Instant::now(), 5, &|_| {}).expect("续传测试资源");
        server.join().expect("等待测试端点退出");
        assert_eq!(fs::read(partial).expect("读取续传结果"), b"abcdefghij");
    }

    #[test]
    fn range_download_rejects_misaligned_content_range() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("启动错位分片端点");
        let address = listener.local_addr().expect("读取错位分片地址");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("接受错位分片连接");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("读取错位分片请求");
            stream.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 10\r\nContent-Range: bytes 1-10/10\r\nConnection: close\r\n\r\nabcdefghij").expect("写入错位分片响应");
        });
        let temporary = tempfile::tempdir().expect("创建错位分片测试目录");
        let partial = temporary.path().join("runtime.zip.part");
        let mut item = item();
        item.sha256 = hex::encode(Sha256::digest(b"abcdefghij"));
        let source = DesktopResourceSource { kind: "official".into(), url: format!("http://{address}/runtime.zip") };
        let client = Client::builder().timeout(Duration::from_secs(5)).build().expect("创建错位分片客户端");
        let error = download_from_source(&client, &item, &source, &partial, Instant::now(), 0, &|_| {}).expect_err("错位 Content-Range 必须被拒绝");
        server.join().expect("等待错位分片端点退出");
        assert!(error.contains("Content-Range"));
        assert_eq!(partial.metadata().expect("读取错位分片断点").len(), 0);
    }

    #[test]
    fn progress_view_reports_ceiled_eta() {
        let mut item = item();
        item.byte_size = 10_000;
        let view = progress_view(&item, "downloading", Some("official".into()), 1_001, 1_000, None, None, None);
        assert_eq!(view.eta_seconds, Some(9));
        assert!(view.switch_reason.is_none());
    }

    #[test]
    fn resumed_session_speed_excludes_existing_partial_bytes() {
        let started_at = Instant::now() - Duration::from_secs(2);
        let speed = session_average_speed(8 * 1024 * 1024 + 2 * 1024 * 1024, 8 * 1024 * 1024, started_at);
        assert!(speed >= 900 * 1024 && speed <= 1100 * 1024);
        let verifying = progress_view(&item(), "verifying", Some("official".into()), 9, speed, None, None, None);
        assert_eq!(verifying.eta_seconds, None);
    }

    #[test]
    fn slow_official_source_switches_to_mirror_without_losing_partial_bytes() {
        let content = vec![b'x'; 64 * 1024];
        let official_listener = TcpListener::bind("127.0.0.1:0").expect("启动慢速官方端点");
        let official_address = official_listener.local_addr().expect("读取慢速官方地址");
        let official_server = thread::spawn(move || {
            let (mut stream, _) = official_listener.accept().expect("接受慢速官方连接");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("读取慢速官方请求");
            stream.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 65536\r\nContent-Range: bytes 0-65535/65536\r\nConnection: close\r\n\r\n").expect("写入慢速官方响应头");
            stream.write_all(&vec![b'x'; 1024]).expect("写入首个慢速分片");
            stream.flush().expect("刷新首个慢速分片");
            thread::sleep(Duration::from_millis(150));
            let _ = stream.write_all(&vec![b'x'; 1024]);
            let _ = stream.flush();
        });
        let mirror_listener = TcpListener::bind("127.0.0.1:0").expect("启动镜像端点");
        let mirror_address = mirror_listener.local_addr().expect("读取镜像地址");
        let mirror_content = content.clone();
        let mirror_server = thread::spawn(move || {
            let (mut stream, _) = mirror_listener.accept().expect("接受镜像连接");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("读取镜像续传请求");
            let request = String::from_utf8_lossy(&request[..read]);
            let range_line = request.lines().find(|line| line.to_ascii_lowercase().starts_with("range: bytes=")).expect("镜像请求包含 Range");
            let start = range_line.split('=').nth(1).and_then(|value| value.split('-').next()).and_then(|value| value.parse::<usize>().ok()).expect("解析镜像续传偏移");
            assert!(start > 0 && start < mirror_content.len());
            let body = &mirror_content[start..];
            let header = format!("HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n", body.len(), start, mirror_content.len() - 1, mirror_content.len());
            stream.write_all(header.as_bytes()).expect("写入镜像响应头");
            stream.write_all(body).expect("写入镜像剩余内容");
        });
        let temporary = tempfile::tempdir().expect("创建切源测试目录");
        let partial = temporary.path().join("runtime.zip.part");
        let mut item = item();
        item.byte_size = content.len() as u64;
        item.sha256 = hex::encode(Sha256::digest(&content));
        let official = DesktopResourceSource { kind: "official".into(), url: format!("http://{official_address}/runtime.zip") };
        let mirror = DesktopResourceSource { kind: "mirror".into(), url: format!("http://{mirror_address}/runtime.zip") };
        let client = Client::builder().timeout(Duration::from_secs(5)).build().expect("创建切源测试客户端");
        let policy = DownloadPolicy { low_speed_window: Duration::from_millis(100), minimum_bytes_per_second: 128 * 1024 };
        let error = download_from_source_with_policy(&client, &item, &official, &partial, Instant::now(), 0, &|_| {}, policy).expect_err("慢速官方来源应当熔断");
        assert!(error.contains("速度过低"));
        let retained = partial.metadata().expect("读取已保留断点").len();
        assert!(retained > 0 && retained < item.byte_size);
        download_from_source_with_policy(&client, &item, &mirror, &partial, Instant::now(), retained, &|_| {}, DownloadPolicy { low_speed_window: Duration::from_secs(2), minimum_bytes_per_second: 1 }).expect("镜像从原偏移续传");
        official_server.join().expect("等待慢速官方端点退出");
        mirror_server.join().expect("等待镜像端点退出");
        assert_eq!(fs::read(partial).expect("读取切源下载结果"), content);
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
        let settings = DesktopSettings { theme_mode: "system".into(), font_scale: 1.1, dependency_source: "auto".into(), default_privacy: "private".into(), auto_upload: true, model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: temporary.path().join("runtime").to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
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
        let settings = DesktopSettings { theme_mode: "system".into(), font_scale: 1.1, dependency_source: "auto".into(), default_privacy: "private".into(), auto_upload: true, model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: temporary.path().join("runtime").to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
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
            application_update: None,
            required: true,
            sources: vec![DesktopResourceSource { kind: "mirror".into(), url: "https://www.xanime.ink/local-model-api/v1/desktop/resources/captioner.wd-vit-tagger-v3/content".into() }],
        };
        let runtime_root = temporary.path().join("runtime");
        fs::create_dir_all(runtime_root.join("current")).expect("创建测试 Runtime");
        fs::write(runtime_root.join("current/runtime-manifest.json"), b"{\"status\":\"ready\"}").expect("写入测试 Runtime 清单");
        let settings = DesktopSettings { theme_mode: "system".into(), font_scale: 1.1, dependency_source: "auto".into(), default_privacy: "private".into(), auto_upload: true, model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: runtime_root.to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
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
    fn published_trainer_zip_installs_anima_training_entry() {
        let Ok(archive_path) = std::env::var("DRAWHIME_TRAINER_TEST_ARCHIVE") else { return; };
        let temporary = tempfile::tempdir().expect("创建 Trainer 安装目录");
        let item = DesktopResourceManifestItem {
            id: "trainer.anima-sd-scripts".into(), kind: "trainer".into(), version: "anima-sd-scripts-37a1cbbc5725-py312-v2".into(), os: "windows".into(), arch: std::env::consts::ARCH.into(), file_name: "drawhime-anima-trainer-win-x64-v2.zip".into(), byte_size: 162_338_622, installed_size: 506_199_484, sha256: "c8344e24c9c54feffa02ea79253cae543220a0072165bd2e03b48721678dc993".into(), archive: "zip".into(), root_directory: Some("drawhime-anima-trainer".into()), install_directory: None, model_registration: None, application_update: None, required: true, sources: vec![DesktopResourceSource { kind: "mirror".into(), url: "https://www.xanime.ink/local-model-api/v1/desktop/resources/trainer.anima-sd-scripts/content".into() }],
        };
        let runtime_root = temporary.path().join("runtime");
        fs::create_dir_all(runtime_root.join("current").join("python_embeded")).expect("创建测试 Runtime");
        fs::write(runtime_root.join("current/runtime-manifest.json"), b"{\"status\":\"ready\"}").expect("写入测试 Runtime 清单");
        fs::write(runtime_root.join("current/python_embeded/python.exe"), b"test").expect("写入测试 Python 标记");
        let model_root = temporary.path().join("models");
        for directory in ["diffusion_models", "text_encoders", "vae"] { fs::create_dir_all(model_root.join(directory)).expect("创建测试模型目录"); }
        fs::write(model_root.join("diffusion_models/anima.safetensors"), b"test").expect("写入测试 DiT");
        fs::write(model_root.join("text_encoders/qwen_3_06b_base.safetensors"), b"test").expect("写入测试文本编码器");
        fs::write(model_root.join("vae/qwen_image_vae.safetensors"), b"test").expect("写入测试 VAE");
        let settings = DesktopSettings { theme_mode: "system".into(), font_scale: 1.1, dependency_source: "auto".into(), default_privacy: "private".into(), auto_upload: true, model_root: model_root.to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: runtime_root.to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let result = install_cached_resource(&settings, &item, Path::new(&archive_path), &|_| {}).expect("安装已发布 Trainer");
        assert_eq!(result.status, "installed");
        let root = PathBuf::from(result.install_path.expect("读取 Trainer 安装路径"));
        assert!(root.join("runner.py").is_file());
        assert!(root.join("sd-scripts/anima_train_network.py").is_file());
        assert!(root.join("site-packages/accelerate/__init__.py").is_file());
        assert!(installed_resource_matches(&item, &settings));
    }

    #[test]
    fn installed_anima_resource_group_becomes_one_registered_model() {
        let temporary = tempfile::tempdir().expect("创建模型组合临时目录");
        let settings = DesktopSettings { theme_mode: "system".into(), font_scale: 1.1, dependency_source: "auto".into(), default_privacy: "private".into(), auto_upload: true, model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: temporary.path().join("runtime").to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let definitions = [("primary", "diffusion_models", "model.safetensors", b"model".as_slice()), ("text_encoder", "text_encoders", "clip.safetensors", b"clip".as_slice()), ("vae", "vae", "vae.safetensors", b"vae".as_slice())];
        let mut items = Vec::new();
        for (role, directory, file_name, bytes) in definitions {
            let cache = temporary.path().join(format!("cache-{role}.safetensors"));
            fs::write(&cache, bytes).expect("写入模型缓存");
            let item = DesktopResourceManifestItem { id: format!("model.test.{role}"), kind: "model".into(), version: "1".into(), os: "windows".into(), arch: std::env::consts::ARCH.into(), file_name: file_name.into(), byte_size: bytes.len() as u64, installed_size: bytes.len() as u64, sha256: hex::encode(Sha256::digest(bytes)), archive: "raw".into(), root_directory: None, install_directory: Some(directory.into()), model_registration: Some(crate::models::DesktopResourceModelRegistration { group_id: "model.test".into(), display_name: "测试 Anima".into(), family: "anima".into(), workflow_kind: "anima".into(), role: role.into() }), application_update: None, required: true, sources: vec![DesktopResourceSource { kind: "mirror".into(), url: format!("https://mirror.example/{file_name}") }] };
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

    /** 验证不同模型组合可以安全复用文件名、大小和哈希完全一致的原始组件。 */
    #[test]
    fn identical_raw_model_resource_is_shared_across_groups() {
        let temporary = tempfile::tempdir().expect("创建共享模型资源临时目录");
        let settings = DesktopSettings { theme_mode: "system".into(), font_scale: 1.1, dependency_source: "auto".into(), default_privacy: "private".into(), auto_upload: true, model_root: temporary.path().join("models").to_string_lossy().into_owned(), output_root: temporary.path().join("outputs").to_string_lossy().into_owned(), runtime_root: temporary.path().join("runtime").to_string_lossy().into_owned(), upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let cache = temporary.path().join("shared-encoder.safetensors");
        fs::write(&cache, b"shared-encoder").expect("写入共享文本编码器缓存");
        let mut first = item();
        first.id = "model.first.text-encoder".into();
        first.kind = "model".into();
        first.file_name = "shared-encoder.safetensors".into();
        first.byte_size = cache.metadata().expect("读取共享组件大小").len();
        first.installed_size = first.byte_size;
        first.sha256 = sha256_file(&cache).expect("计算共享组件哈希");
        first.archive = "raw".into();
        first.root_directory = None;
        first.install_directory = Some("text_encoders".into());
        first.model_registration = Some(crate::models::DesktopResourceModelRegistration { group_id: "model.first".into(), display_name: "模型一".into(), family: "anima".into(), workflow_kind: "anima".into(), role: "text_encoder".into() });
        install_cached_resource(&settings, &first, &cache, &|_| {}).expect("安装第一组共享组件");
        let mut second = first.clone();
        second.id = "model.second.text-encoder".into();
        second.model_registration = Some(crate::models::DesktopResourceModelRegistration { group_id: "model.second".into(), display_name: "模型二".into(), family: "anima".into(), workflow_kind: "anima".into(), role: "text_encoder".into() });
        assert!(installed_resource_matches(&second, &settings));
        second.byte_size += 1;
        assert!(!installed_resource_matches(&second, &settings));
    }
}
