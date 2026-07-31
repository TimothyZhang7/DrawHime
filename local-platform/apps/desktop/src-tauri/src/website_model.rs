//! 本模块读取主站底模仓库并把受保护封面缓存成本机文件，不直接暴露设备会话。

use crate::{auth::{self, DesktopSessionError}, models::{DesktopWebsiteModelComponents, DesktopWebsiteModelDownload, DesktopWebsiteModelInstallProgress, DesktopWebsiteModelParameters, DesktopWebsiteModelView, DesktopWebsiteSourceLink}, network::online_client_builder, website_catalog_cache, website_media::{self, WebsiteImageRef}};
use chrono::Utc;
use reqwest::{blocking::{Client, Response}, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteModelEntry { id: String, display_name: String, description: String, family: String, family_name: String, model_file_name: String, resource_group_id: Option<String>, #[serde(default)] download: Option<DesktopWebsiteModelDownload>, components: DesktopWebsiteModelComponents, runtime_format: String, usage_guide: String, source_links: Vec<DesktopWebsiteSourceLink>, parameters: DesktopWebsiteModelParameters, examples: Vec<WebsiteImageRef> }

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WebsiteModelList { entries: Vec<WebsiteModelEntry> }

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> { ok: bool, data: Option<T>, code: Option<String>, message: Option<String> }

/** 下载完成后交给本地模型安装器的可信目录快照。 */
pub struct WebsiteModelDownload { pub view: DesktopWebsiteModelView, pub path: PathBuf }

/** 读取当前账号可见的底模仓库，并逐张容错缓存全部示例图。 */
pub fn load_catalog(app_data_dir: &Path, force_refresh: bool) -> Result<Vec<DesktopWebsiteModelView>, String> {
    let session = match auth::authenticated_session() {
        Ok(Some(session)) => Some(session),
        Ok(None) => return Err("请先连接绘图姬账号".into()),
        Err(DesktopSessionError::Network) if auth::has_stored_session()? => None,
        Err(DesktopSessionError::Network) => return Err("账号服务当前不可达".into()),
        Err(DesktopSessionError::Service(message)) => return Err(message),
    };
    let Some(session) = session else { return cached_catalog(app_data_dir); };
    let client = network_client()?;
    let payload: WebsiteModelList = match parse_json(client.get(auth::api_url("/v1/model-library")).bearer_auth(&session.token).send()) {
        Ok(payload) => payload,
        Err(online_error) => return cached_catalog(app_data_dir).map_err(|cache_error| format!("{online_error}；{cache_error}")),
    };
    if let Err(error) = website_catalog_cache::store(app_data_dir, "models", &payload) { eprintln!("{error}"); }
    Ok(payload.entries.into_iter().map(|entry| {
        let example_paths = website_media::cache_images(&client, &session.token, app_data_dir, "models", &entry.examples, force_refresh);
        let cover_path = example_paths.first().cloned();
        DesktopWebsiteModelView { id: entry.id, display_name: entry.display_name, description: entry.description, family: entry.family, family_name: entry.family_name, model_file_name: entry.model_file_name, resource_group_id: entry.resource_group_id, download: entry.download, components: entry.components, runtime_format: entry.runtime_format, usage_guide: entry.usage_guide, source_links: entry.source_links, parameters: entry.parameters, cover_path, example_paths }
    }).collect())
}

/** 网络不可用时读取最近一次成功目录，并只引用仍存在的本机图片缓存。 */
fn cached_catalog(app_data_dir: &Path) -> Result<Vec<DesktopWebsiteModelView>, String> {
    let payload: WebsiteModelList = website_catalog_cache::load(app_data_dir, "models")?;
    Ok(payload.entries.into_iter().map(|entry| {
        let example_paths = website_media::cached_image_paths(app_data_dir, "models", &entry.examples);
        let cover_path = example_paths.first().cloned();
        DesktopWebsiteModelView { id: entry.id, display_name: entry.display_name, description: entry.description, family: entry.family, family_name: entry.family_name, model_file_name: entry.model_file_name, resource_group_id: entry.resource_group_id, download: entry.download, components: entry.components, runtime_format: entry.runtime_format, usage_guide: entry.usage_guide, source_links: entry.source_links, parameters: entry.parameters, cover_path, example_paths }
    }).collect())
}

/** 重新读取单项目录后，从唯一主站地址断点下载并完整校验底模。 */
pub fn download_and_verify(app_data_dir: &Path, model_root: &Path, model_id: &str, app: &AppHandle) -> Result<WebsiteModelDownload, String> {
    if !uuid_like(model_id) { return Err("网站底模 ID 不正确".into()); }
    let session = match auth::authenticated_session() {
        Ok(Some(session)) => session,
        Ok(None) => return Err("请先连接绘图姬账号".into()),
        Err(DesktopSessionError::Network) => return Err("账号服务当前不可达".into()),
        Err(DesktopSessionError::Service(message)) => return Err(message),
    };
    let client = download_client()?;
    let entry: WebsiteModelEntry = parse_json(client.get(auth::api_url(&format!("/v1/model-library/{model_id}"))).bearer_auth(&session.token).send())?;
    let download = entry.download.clone().ok_or_else(|| "当前底模尚未提供主站下载文件".to_string())?;
    if !download.content_url.starts_with("/v1/model-library/") { return Err("网站底模下载路径不受信任".into()); }
    let example_paths = website_media::cache_images(&client, &session.token, app_data_dir, "models", &entry.examples, true);
    let cover_path = example_paths.first().cloned();
    let view = DesktopWebsiteModelView { id: entry.id, display_name: entry.display_name, description: entry.description, family: entry.family, family_name: entry.family_name, model_file_name: entry.model_file_name, resource_group_id: entry.resource_group_id, download: Some(download.clone()), components: entry.components, runtime_format: entry.runtime_format, usage_guide: entry.usage_guide, source_links: entry.source_links, parameters: entry.parameters, cover_path, example_paths };
    // 大模型断点直接放在用户选择的模型盘，避免系统盘出现一份同体积缓存。
    let cache_root = model_root.join(".downloads").join("website-models");
    fs::create_dir_all(&cache_root).map_err(|error| format!("创建网站底模下载目录失败：{error}"))?;
    let partial = cache_root.join(format!("{}.part", view.id));
    let completed = cache_root.join(format!("{}-{}.safetensors", view.id, &download.sha256[..12]));
    if completed.is_file() && completed.metadata().map(|value| value.len()).ok() == Some(download.byte_size) && sha256_file(&completed)? == download.sha256 { return Ok(WebsiteModelDownload { view, path: completed }); }
    let mut offset = partial.metadata().map(|value| value.len()).unwrap_or(0);
    if offset > download.byte_size { fs::remove_file(&partial).map_err(|error| format!("清理异常底模断点失败：{error}"))?; offset = 0; }
    let mut request = client.get(auth::api_url(&download.content_url)).bearer_auth(&session.token);
    if offset > 0 { request = request.header("range", format!("bytes={offset}-")); }
    let mut response = request.send().map_err(|_| "连接网站底模下载服务失败".to_string())?;
    validate_download_response(&response, offset, download.byte_size)?;
    let mut output = OpenOptions::new().create(true).write(true).truncate(offset == 0).append(offset > 0).open(&partial).map_err(|error| format!("打开底模下载断点失败：{error}"))?;
    let started = Instant::now();
    let mut downloaded = offset;
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    loop { let read = response.read(&mut buffer).map_err(|_| "网站底模下载连接中断，已保留断点".to_string())?; if read == 0 { break; } output.write_all(&buffer[..read]).map_err(|error| format!("写入底模下载断点失败：{error}"))?; downloaded += read as u64; if downloaded > download.byte_size { return Err("网站底模下载字节数超过目录声明".into()); } let elapsed = started.elapsed().as_secs_f64().max(0.001); emit_progress(app, &view.id, "downloading", downloaded, download.byte_size, ((downloaded - offset) as f64 / elapsed) as u64, None); }
    output.sync_all().map_err(|error| format!("同步底模下载文件失败：{error}"))?;
    if downloaded != download.byte_size { return Err("网站底模下载尚未完整，已保留断点".into()); }
    emit_progress(app, &view.id, "verifying", downloaded, download.byte_size, 0, None);
    if sha256_file(&partial)? != download.sha256 { quarantine(&partial)?; return Err("网站底模 SHA-256 校验失败，异常文件已隔离".into()); }
    if completed.exists() { fs::remove_file(&completed).map_err(|error| format!("清理旧底模缓存失败：{error}"))?; }
    fs::rename(&partial, &completed).map_err(|error| format!("提交底模下载缓存失败：{error}"))?;
    Ok(WebsiteModelDownload { view, path: completed })
}

/** 安装阶段与终态沿用同一事件，避免页面把下载完成误认为已经可生成。 */
pub fn emit_install_state(app: &AppHandle, model_id: &str, total_bytes: u64, status: &str, error: Option<String>) {
    emit_progress(app, model_id, status, total_bytes, total_bytes, 0, error);
}

fn network_client() -> Result<Client, String> { online_client_builder().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(30)).build().map_err(|error| format!("创建网站底模客户端失败：{error}")) }
/** 大模型下载只限制连接建立与六小时总时长，网络中断保留真实断点。 */
fn download_client() -> Result<Client, String> { online_client_builder().connect_timeout(Duration::from_secs(12)).timeout(Duration::from_secs(6 * 60 * 60)).build().map_err(|error| format!("创建网站底模下载客户端失败：{error}")) }

fn parse_json<T: DeserializeOwned>(result: Result<Response, reqwest::Error>) -> Result<T, String> {
    let response = result.map_err(|_| "网站底模服务连接失败".to_string())?;
    let status = response.status();
    let payload: ApiEnvelope<T> = response.json().map_err(|_| "网站底模服务返回格式不正确".to_string())?;
    if !status.is_success() || !payload.ok { return Err(payload.message.or(payload.code).unwrap_or_else(|| format!("网站底模服务 HTTP {}", status.as_u16()))); }
    payload.data.ok_or_else(|| "网站底模服务未返回数据".into())
}

fn validate_download_response(response: &Response, offset: u64, total: u64) -> Result<(), String> { if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN { return Err("网站底模下载权限已失效".into()); } if offset > 0 { if response.status() != StatusCode::PARTIAL_CONTENT { return Err("网站底模下载端点未接受断点范围".into()); } let expected = format!("bytes {offset}-{}/{total}", total - 1); if response.headers().get("content-range").and_then(|value| value.to_str().ok()) != Some(expected.as_str()) { return Err("网站底模断点范围响应不正确".into()); } } else if response.status() != StatusCode::OK { return Err(format!("网站底模下载返回 HTTP {}", response.status().as_u16())); } if response.content_length() != Some(total - offset) { return Err("网站底模下载长度与目录声明不一致".into()); } Ok(()) }
fn sha256_file(path: &Path) -> Result<String, String> { let mut file = File::open(path).map_err(|error| format!("读取底模文件失败：{error}"))?; file.seek(SeekFrom::Start(0)).map_err(|error| format!("定位底模文件失败：{error}"))?; let mut hash = Sha256::new(); let mut buffer = [0_u8; 4 * 1024 * 1024]; loop { let read = file.read(&mut buffer).map_err(|error| format!("计算底模哈希失败：{error}"))?; if read == 0 { break; } hash.update(&buffer[..read]); } Ok(hex::encode(hash.finalize())) }
fn quarantine(path: &Path) -> Result<(), String> { let target = path.with_extension(format!("invalid-{}", Utc::now().timestamp())); fs::rename(path, target).map_err(|error| format!("隔离异常底模失败：{error}")) }
fn uuid_like(value: &str) -> bool { value.len() == 36 && value.chars().all(|character| character.is_ascii_hexdigit() || character == '-') }
fn emit_progress(app: &AppHandle, model_id: &str, status: &str, downloaded_bytes: u64, total_bytes: u64, bytes_per_second: u64, error: Option<String>) { let _ = app.emit("desktop-website-model-progress", DesktopWebsiteModelInstallProgress { model_id: model_id.into(), status: status.into(), downloaded_bytes, total_bytes: total_bytes.max(1), bytes_per_second, error }); }
