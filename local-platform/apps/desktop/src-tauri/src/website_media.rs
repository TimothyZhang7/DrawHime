//! 本模块把需要设备会话鉴权的网站仓库封面缓存到桌面应用数据目录，供 WebView 安全展示。

use crate::auth;
use reqwest::blocking::Client;
use serde::Deserialize;
use std::{fs::{self, File}, io::{Read, Write}, path::{Path, PathBuf}};

const MAXIMUM_COVER_BYTES: u64 = 12 * 1024 * 1024;

/** 网站仓库条目返回的受保护示例图片引用。 */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteImageRef { pub id: String, pub content_url: String }

/** 按服务端顺序缓存全部示例图片；任意单张失败只跳过该图，不阻断仓库加载。 */
pub fn cache_images(client: &Client, token: &str, app_data_dir: &Path, namespace: &str, images: &[WebsiteImageRef]) -> Vec<String> {
    let mut paths = Vec::new();
    // 每批最多四张并发，兼顾仓库首屏速度与主站媒体端点压力；批次和句柄顺序保持服务端图片顺序。
    for batch in images.chunks(4) {
        let resolved = std::thread::scope(|scope| {
            batch.iter().map(|image| scope.spawn(move || cache_cover_inner(client, token, app_data_dir, namespace, image))).collect::<Vec<_>>().into_iter().map(|handle| handle.join().ok().and_then(Result::ok)).collect::<Vec<_>>()
        });
        paths.extend(resolved.into_iter().flatten().map(|path| path.to_string_lossy().into_owned()));
    }
    paths
}

fn cache_cover_inner(client: &Client, token: &str, app_data_dir: &Path, namespace: &str, image: &WebsiteImageRef) -> Result<PathBuf, String> {
    let safe_id: String = image.id.chars().filter(|value| value.is_ascii_alphanumeric() || *value == '-').collect();
    if safe_id.is_empty() { return Err("仓库封面 ID 不正确".into()); }
    let directory = app_data_dir.join("catalog-covers").join(namespace);
    fs::create_dir_all(&directory).map_err(|error| format!("创建仓库封面缓存失败：{error}"))?;
    for extension in ["webp", "png", "jpg"] {
        let cached = directory.join(format!("{safe_id}.{extension}"));
        if cached.metadata().is_ok_and(|metadata| metadata.len() > 0) { return Ok(cached); }
    }
    let url = authenticated_media_url(&image.content_url)?;
    let mut response = client.get(url).bearer_auth(token).send().map_err(|_| "仓库封面下载连接失败".to_string())?;
    if !response.status().is_success() { return Err(format!("仓库封面下载 HTTP {}", response.status().as_u16())); }
    if response.content_length().is_some_and(|length| length == 0 || length > MAXIMUM_COVER_BYTES) { return Err("仓库封面文件大小不正确".into()); }
    let content_type = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim();
    let extension = match content_type { "image/webp" => "webp", "image/png" => "png", "image/jpeg" => "jpg", _ => return Err("仓库封面格式不受支持".into()) };
    let target = directory.join(format!("{safe_id}.{extension}"));
    let temporary = directory.join(format!("{safe_id}.part"));
    let mut bytes = Vec::new();
    response.by_ref().take(MAXIMUM_COVER_BYTES + 1).read_to_end(&mut bytes).map_err(|error| format!("读取仓库封面失败：{error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAXIMUM_COVER_BYTES { return Err("仓库封面文件大小不正确".into()); }
    let mut file = File::create(&temporary).map_err(|error| format!("创建仓库封面缓存文件失败：{error}"))?;
    file.write_all(&bytes).map_err(|error| format!("写入仓库封面缓存失败：{error}"))?;
    file.sync_all().map_err(|error| format!("同步仓库封面缓存失败：{error}"))?;
    fs::rename(&temporary, &target).map_err(|error| format!("提交仓库封面缓存失败：{error}"))?;
    Ok(target)
}

fn authenticated_media_url(path: &str) -> Result<String, String> {
    if !path.starts_with('/') { return Err("仓库封面地址不正确".into()); }
    let normalized = path.strip_prefix("/local-model-api").unwrap_or(path);
    Ok(auth::api_url(normalized))
}
