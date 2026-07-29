//! 本模块实现网站公开与本人私有 LoRA 的设备会话鉴权、断点下载和整体哈希校验。

use crate::auth::{self, DesktopSessionError};
use crate::{models::DesktopWebsiteLoraInstallProgress, website_media::{self, WebsiteImageRef}};
use chrono::Utc;
use reqwest::{blocking::{Client, Response}, StatusCode};
use serde::{de::DeserializeOwned, Deserialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteLoraVersion { id: String, file_name: String, sha256: String, byte_size: u64 }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteLoraEntry {
    id: String,
    title: String,
    description: String,
    r#type: String,
    model_family: String,
    model_family_name: String,
    trigger_words: Vec<String>,
    owner_display_name: String,
    privacy: String,
    is_owner: bool,
    version: Option<WebsiteLoraVersion>,
    #[serde(default)]
    examples: Vec<WebsiteImageRef>,
}

#[derive(Debug, Deserialize)]
struct WebsiteLoraList { entries: Vec<WebsiteLoraEntry> }

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> { ok: bool, data: Option<T>, code: Option<String>, message: Option<String> }

/** 下载完成后交给本地 LoRA 安装器的可信快照。 */
pub struct WebsiteLoraDownload { pub view: crate::models::DesktopWebsiteLoraView, pub path: PathBuf }

/** 读取当前设备账号可见的网站 LoRA，并按本机内容哈希标记安装状态。 */
pub fn load_catalog(app_data_dir: &Path, installed_hashes: &HashSet<String>) -> Result<Vec<crate::models::DesktopWebsiteLoraView>, String> {
    let session = authenticated_session()?;
    let client = network_client()?;
    let payload: WebsiteLoraList = parse_json(client.get(auth::api_url("/v1/lora-library")).bearer_auth(&session.token).send())?;
    Ok(payload.entries.into_iter().filter_map(|entry| {
        let example_paths = website_media::cache_images(&client, &session.token, app_data_dir, "loras", &entry.examples);
        to_view(entry, installed_hashes, example_paths)
    }).collect())
}

/** 重新读取单项权限与版本，按真实服务端 Range 断点下载并校验完整 SHA-256。 */
pub fn download_and_verify(app_data_dir: &Path, lora_id: &str, installed_hashes: &HashSet<String>, app: &AppHandle) -> Result<WebsiteLoraDownload, String> {
    if !uuid_like(lora_id) { return Err("网站 LoRA ID 不正确".into()); }
    let session = authenticated_session()?;
    let client = network_client()?;
    let entry: WebsiteLoraEntry = parse_json(client.get(auth::api_url(&format!("/v1/lora-library/{lora_id}"))).bearer_auth(&session.token).send())?;
    let example_paths = website_media::cache_images(&client, &session.token, app_data_dir, "loras", &entry.examples);
    let view = to_view(entry, installed_hashes, example_paths).ok_or_else(|| "网站 LoRA 当前没有可下载版本".to_string())?;
    let cache_root = app_data_dir.join("downloads").join("website-loras");
    fs::create_dir_all(&cache_root).map_err(|error| format!("创建网站 LoRA 下载目录失败：{error}"))?;
    let partial = cache_root.join(format!("{}.part", view.version_id));
    let completed = cache_root.join(format!("{}-{}.safetensors", view.version_id, &view.sha256[..12]));
    if completed.is_file() && completed.metadata().map(|value| value.len()).ok() == Some(view.byte_size) && sha256_file(&completed)? == view.sha256 {
        return Ok(WebsiteLoraDownload { view, path: completed });
    }
    let mut offset = partial.metadata().map(|value| value.len()).unwrap_or(0);
    if offset > view.byte_size { fs::remove_file(&partial).map_err(|error| format!("清理异常 LoRA 断点失败：{error}"))?; offset = 0; }
    let mut request = client.get(auth::api_url(&format!("/v1/lora-library/{lora_id}/download"))).bearer_auth(&session.token);
    if offset > 0 { request = request.header("range", format!("bytes={offset}-")); }
    let mut response = request.send().map_err(|_| "连接网站 LoRA 下载服务失败".to_string())?;
    validate_download_response(&response, offset, view.byte_size)?;
    if offset > 0 && response.status() == StatusCode::OK { offset = 0; }
    let mut output = OpenOptions::new().create(true).write(true).truncate(offset == 0).append(offset > 0).open(&partial).map_err(|error| format!("打开 LoRA 下载断点失败：{error}"))?;
    let started = Instant::now();
    let mut downloaded = offset;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = response.read(&mut buffer).map_err(|_| "网站 LoRA 下载连接中断，已保留断点".to_string())?;
        if read == 0 { break; }
        output.write_all(&buffer[..read]).map_err(|error| format!("写入 LoRA 下载断点失败：{error}"))?;
        downloaded += read as u64;
        if downloaded > view.byte_size { return Err("网站 LoRA 下载字节数超过目录声明".into()); }
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        emit_progress(app, &view.id, "downloading", downloaded, view.byte_size, ((downloaded - offset) as f64 / elapsed) as u64, None);
    }
    output.sync_all().map_err(|error| format!("同步 LoRA 下载文件失败：{error}"))?;
    if downloaded != view.byte_size { return Err("网站 LoRA 下载尚未完整，已保留断点".into()); }
    emit_progress(app, &view.id, "verifying", downloaded, view.byte_size, 0, None);
    if sha256_file(&partial)? != view.sha256 { quarantine(&partial)?; return Err("网站 LoRA SHA-256 校验失败，异常文件已隔离".into()); }
    if completed.exists() { fs::remove_file(&completed).map_err(|error| format!("清理旧 LoRA 缓存失败：{error}"))?; }
    fs::rename(&partial, &completed).map_err(|error| format!("提交 LoRA 下载缓存失败：{error}"))?;
    Ok(WebsiteLoraDownload { view, path: completed })
}

/** 安装阶段和最终状态沿用同一事件，页面不会把下载完成误报为已经可用。 */
pub fn emit_install_state(app: &AppHandle, view: &crate::models::DesktopWebsiteLoraView, status: &str, error: Option<String>) {
    emit_progress(app, &view.id, status, view.byte_size, view.byte_size, 0, error);
}

fn authenticated_session() -> Result<auth::DesktopAuthenticatedSession, String> {
    match auth::authenticated_session() {
        Ok(Some(session)) => Ok(session),
        Ok(None) => Err("请先连接绘图姬账号".into()),
        Err(DesktopSessionError::Network) => Err("账号服务当前不可达".into()),
        Err(DesktopSessionError::Service(message)) => Err(message),
    }
}

fn network_client() -> Result<Client, String> { Client::builder().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(300)).user_agent("DrawHime-Desktop/0.1").build().map_err(|error| format!("创建网站资源客户端失败：{error}")) }

fn parse_json<T: DeserializeOwned>(result: Result<Response, reqwest::Error>) -> Result<T, String> {
    let response = result.map_err(|_| "网站 LoRA 服务连接失败".to_string())?;
    let status = response.status();
    let payload: ApiEnvelope<T> = response.json().map_err(|_| "网站 LoRA 服务返回格式不正确".to_string())?;
    if !status.is_success() || !payload.ok { return Err(payload.message.or(payload.code).unwrap_or_else(|| format!("网站 LoRA 服务 HTTP {}", status.as_u16()))); }
    payload.data.ok_or_else(|| "网站 LoRA 服务未返回数据".into())
}

fn to_view(entry: WebsiteLoraEntry, installed_hashes: &HashSet<String>, example_paths: Vec<String>) -> Option<crate::models::DesktopWebsiteLoraView> {
    let version = entry.version?;
    let cover_path = example_paths.first().cloned();
    Some(crate::models::DesktopWebsiteLoraView { id: entry.id, title: entry.title, description: entry.description, r#type: entry.r#type, model_family: entry.model_family, model_family_name: entry.model_family_name, trigger_words: entry.trigger_words, owner_display_name: entry.owner_display_name, privacy: entry.privacy, is_owner: entry.is_owner, version_id: version.id, file_name: version.file_name, sha256: version.sha256.clone(), byte_size: version.byte_size, installed: installed_hashes.contains(&version.sha256), cover_path, example_paths })
}

fn validate_download_response(response: &Response, offset: u64, total: u64) -> Result<(), String> {
    if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN { return Err("网站 LoRA 下载权限已失效".into()); }
    if offset > 0 {
        if response.status() != StatusCode::PARTIAL_CONTENT { return Err("网站 LoRA 下载端点未接受断点范围".into()); }
        let expected = format!("bytes {offset}-{}/{total}", total - 1);
        if response.headers().get("content-range").and_then(|value| value.to_str().ok()) != Some(expected.as_str()) { return Err("网站 LoRA 断点范围响应不正确".into()); }
    } else if response.status() != StatusCode::OK { return Err(format!("网站 LoRA 下载返回 HTTP {}", response.status().as_u16())); }
    let expected_length = total - offset;
    if response.content_length() != Some(expected_length) { return Err("网站 LoRA 下载长度与目录声明不一致".into()); }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> { let mut file = File::open(path).map_err(|error| format!("读取 LoRA 文件失败：{error}"))?; file.seek(SeekFrom::Start(0)).map_err(|error| format!("定位 LoRA 文件失败：{error}"))?; let mut hash = Sha256::new(); let mut buffer = [0_u8; 1024 * 1024]; loop { let read = file.read(&mut buffer).map_err(|error| format!("计算 LoRA 哈希失败：{error}"))?; if read == 0 { break; } hash.update(&buffer[..read]); } Ok(hex::encode(hash.finalize())) }
fn quarantine(path: &Path) -> Result<(), String> { let target = path.with_extension(format!("invalid-{}", Utc::now().timestamp())); fs::rename(path, target).map_err(|error| format!("隔离异常 LoRA 失败：{error}")) }
fn uuid_like(value: &str) -> bool { value.len() == 36 && value.chars().all(|character| character.is_ascii_hexdigit() || character == '-') }
fn emit_progress(app: &AppHandle, lora_id: &str, status: &str, downloaded_bytes: u64, total_bytes: u64, bytes_per_second: u64, error: Option<String>) { let _ = app.emit("desktop-website-lora-progress", DesktopWebsiteLoraInstallProgress { lora_id: lora_id.into(), status: status.into(), downloaded_bytes, total_bytes, bytes_per_second, error }); }
