//! 本模块负责拉取签名资源清单，并以断点、切源、哈希校验和原子落盘下载桌面依赖。

use crate::models::{DesktopResourceCatalogItemView, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceManifestEnvelope, DesktopResourceManifestItem, DesktopResourceManifestPayload, DesktopResourceSource, DesktopSettings};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use reqwest::{blocking::{Client, Response}, header::RANGE, StatusCode, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::{self, File, OpenOptions}, io::{BufReader, Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, time::{Duration, Instant}};
use tauri::Emitter;

const MANIFEST_URL: Option<&str> = option_env!("DRAWHIME_DESKTOP_RESOURCE_MANIFEST_URL");
const MANIFEST_KEY_ID: Option<&str> = option_env!("DRAWHIME_DESKTOP_RESOURCE_KEY_ID");
const MANIFEST_PUBLIC_KEY: Option<&str> = option_env!("DRAWHIME_DESKTOP_RESOURCE_PUBLIC_KEY");
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

/** 读取远端签名目录；发布配置缺失时返回明确未配置状态，不制造可安装资源。 */
pub fn load_catalog(settings: &DesktopSettings, app_data_dir: &Path) -> Result<DesktopResourceCatalogView, String> {
    let Some((manifest_url, key_id, public_key)) = manifest_configuration() else {
        return Ok(DesktopResourceCatalogView { configured: false, key_id: None, generated_at: None, expires_at: None, message: "当前安装包尚未配置经过签名的资源发布通道".into(), resources: Vec::new() });
    };
    let payload = fetch_verified_manifest(manifest_url, key_id, public_key)?;
    let cache_dir = resource_cache_dir(app_data_dir);
    let resources = payload.resources.iter().filter(|item| resource_matches_current_platform(item)).map(|item| {
        let target = cache_dir.join(&item.file_name);
        DesktopResourceCatalogItemView {
            id: item.id.clone(),
            kind: item.kind.clone(),
            version: item.version.clone(),
            file_name: item.file_name.clone(),
            byte_size: item.byte_size,
            sha256: item.sha256.clone(),
            required: item.required,
            downloaded: verified_marker_matches(&target, item),
            source_kinds: ordered_sources(item, &settings.dependency_source).iter().map(|source| source.kind.clone()).collect(),
        }
    }).collect();
    Ok(DesktopResourceCatalogView { configured: true, key_id: Some(key_id.into()), generated_at: Some(payload.generated_at), expires_at: Some(payload.expires_at), message: "资源清单签名和有效期校验通过".into(), resources })
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
    match (MANIFEST_URL, MANIFEST_KEY_ID, MANIFEST_PUBLIC_KEY) {
        (Some(url), Some(key_id), Some(public_key)) if !url.trim().is_empty() && !key_id.trim().is_empty() && !public_key.trim().is_empty() => Some((url, key_id, public_key)),
        _ => None,
    }
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
    Ok(())
}

fn validate_item(item: &DesktopResourceManifestItem) -> Result<(), String> {
    if item.id.len() < 2 || item.id.len() > 128 || !item.id.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '_' | '-')) { return Err("资源 ID 不符合约束".into()); }
    if !matches!(item.kind.as_str(), "runtime" | "model" | "lora" | "captioner" | "trainer") { return Err(format!("资源类型不受支持：{}", item.id)); }
    if item.os != "windows" || !matches!(item.arch.as_str(), "x86_64" | "aarch64") { return Err(format!("资源平台字段不正确：{}", item.id)); }
    if item.file_name.len() < 2 || item.file_name.len() > 255 || !item.file_name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')) { return Err(format!("资源文件名不安全：{}", item.id)); }
    if item.byte_size == 0 || item.sha256.len() != 64 || !item.sha256.chars().all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()) { return Err(format!("资源大小或哈希不正确：{}", item.id)); }
    if !matches!(item.archive.as_str(), "raw" | "zip") || item.sources.is_empty() || item.sources.len() > 8 { return Err(format!("资源归档或来源不正确：{}", item.id)); }
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

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::{net::TcpListener, thread};

    fn item() -> DesktopResourceManifestItem {
        DesktopResourceManifestItem { id: "runtime.core".into(), kind: "runtime".into(), version: "1.0.0".into(), os: "windows".into(), arch: std::env::consts::ARCH.into(), file_name: "runtime.zip".into(), byte_size: 10, sha256: "a".repeat(64), archive: "zip".into(), required: true, sources: vec![DesktopResourceSource { kind: "mirror".into(), url: "https://mirror.example/runtime.zip".into() }, DesktopResourceSource { kind: "official".into(), url: "https://official.example/runtime.zip".into() }] }
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
}
