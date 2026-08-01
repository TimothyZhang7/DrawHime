//! 本模块把需要设备会话鉴权的网站仓库封面缓存到桌面应用数据目录，供 WebView 安全展示。

use crate::auth;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAXIMUM_COVER_BYTES: u64 = 12 * 1024 * 1024;

/** 网站仓库条目返回的受保护示例图片引用。 */
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteImageRef {
    pub id: String,
    pub content_url: String,
}

/** 按服务端顺序缓存全部示例图片；任意单张失败只跳过该图，不阻断仓库加载。 */
pub fn cache_images(
    client: &Client,
    token: &str,
    app_data_dir: &Path,
    namespace: &str,
    images: &[WebsiteImageRef],
    force_refresh: bool,
) -> Vec<String> {
    let mut paths = Vec::new();
    // 每批最多四张并发，兼顾仓库首屏速度与主站媒体端点压力；批次和句柄顺序保持服务端图片顺序。
    for (batch_index, batch) in images.chunks(4).enumerate() {
        let resolved = std::thread::scope(|scope| {
            batch
                .iter()
                .enumerate()
                .map(|(image_index, image)| {
                    // 手动刷新只强制更新首图；新示例因本机尚无缓存仍会下载，既保证封面实时又避免重复传输全部图库。
                    let refresh_image = force_refresh && batch_index == 0 && image_index == 0;
                    scope.spawn(move || {
                        cache_cover_inner(
                            client,
                            token,
                            app_data_dir,
                            namespace,
                            image,
                            refresh_image,
                        )
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().ok().and_then(Result::ok))
                .collect::<Vec<_>>()
        });
        paths.extend(
            resolved
                .into_iter()
                .flatten()
                .map(|path| path.to_string_lossy().into_owned()),
        );
    }
    paths
}

/** 离线目录只返回已经完整落盘的示例图，缺失图片不会阻断其余仓库条目。 */
pub fn cached_image_paths(
    app_data_dir: &Path,
    namespace: &str,
    images: &[WebsiteImageRef],
) -> Vec<String> {
    images
        .iter()
        .filter_map(|image| {
            let safe_id: String = image
                .id
                .chars()
                .filter(|value| value.is_ascii_alphanumeric() || *value == '-')
                .collect();
            if safe_id.is_empty() {
                return None;
            }
            ["webp", "png", "jpg"]
                .into_iter()
                .map(|extension| {
                    app_data_dir
                        .join("catalog-covers")
                        .join(namespace)
                        .join(format!("{safe_id}.{extension}"))
                })
                .find(|path| {
                    path.metadata()
                        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
                })
                .map(|path| path.to_string_lossy().into_owned())
        })
        .collect()
}

fn cache_cover_inner(
    client: &Client,
    token: &str,
    app_data_dir: &Path,
    namespace: &str,
    image: &WebsiteImageRef,
    force_refresh: bool,
) -> Result<PathBuf, String> {
    let safe_id: String = image
        .id
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || *value == '-')
        .collect();
    if safe_id.is_empty() {
        return Err("仓库封面 ID 不正确".into());
    }
    let directory = app_data_dir.join("catalog-covers").join(namespace);
    fs::create_dir_all(&directory).map_err(|error| format!("创建仓库封面缓存失败：{error}"))?;
    let cached = ["webp", "png", "jpg"]
        .into_iter()
        .map(|extension| directory.join(format!("{safe_id}.{extension}")))
        .find(|path| path.metadata().is_ok_and(|metadata| metadata.len() > 0));
    if !force_refresh {
        if let Some(path) = cached.clone() {
            return Ok(path);
        }
    }
    let refreshed = (|| -> Result<PathBuf, String> {
        let url = authenticated_media_url(&image.content_url)?;
        let mut response = client
            .get(url)
            .bearer_auth(token)
            .send()
            .map_err(|_| "仓库封面下载连接失败".to_string())?;
        if !response.status().is_success() {
            return Err(format!("仓库封面下载 HTTP {}", response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length == 0 || length > MAXIMUM_COVER_BYTES)
        {
            return Err("仓库封面文件大小不正确".into());
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let extension = match content_type {
            "image/webp" => "webp",
            "image/png" => "png",
            "image/jpeg" => "jpg",
            _ => return Err("仓库封面格式不受支持".into()),
        };
        let target = directory.join(format!("{safe_id}.{extension}"));
        let temporary = directory.join(format!("{safe_id}.part"));
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(MAXIMUM_COVER_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("读取仓库封面失败：{error}"))?;
        if bytes.is_empty() || bytes.len() as u64 > MAXIMUM_COVER_BYTES {
            return Err("仓库封面文件大小不正确".into());
        }
        let mut file = File::create(&temporary)
            .map_err(|error| format!("创建仓库封面缓存文件失败：{error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("写入仓库封面缓存失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步仓库封面缓存失败：{error}"))?;
        replace_cached_file(&temporary, &target)?;
        Ok(target)
    })();
    match refreshed {
        Ok(target) => {
            if let Some(previous) = cached.filter(|path| path != &target) {
                let _ = fs::remove_file(previous);
            }
            Ok(target)
        }
        Err(error) => cached.ok_or(error),
    }
}

/** 使用同目录备份替换正在使用的缓存文件，提交失败时恢复旧封面。 */
fn replace_cached_file(temporary: &Path, target: &Path) -> Result<(), String> {
    let backup = target.with_extension("previous");
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    if target.exists() {
        fs::rename(target, &backup).map_err(|error| format!("暂存旧仓库封面失败：{error}"))?;
    }
    if let Err(error) = fs::rename(temporary, target) {
        if backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        return Err(format!("提交仓库封面缓存失败：{error}"));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn authenticated_media_url(path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err("仓库封面地址不正确".into());
    }
    let normalized = path.strip_prefix("/local-model-api").unwrap_or(path);
    Ok(auth::api_url(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refreshed_cover_replaces_existing_file_atomically() {
        let directory = tempfile::tempdir().expect("创建缓存测试目录");
        let target = directory.path().join("cover.webp");
        let temporary = directory.path().join("cover.part");
        fs::write(&target, b"old").expect("写入旧封面");
        fs::write(&temporary, b"new").expect("写入新封面");
        replace_cached_file(&temporary, &target).expect("替换封面");
        assert_eq!(fs::read(&target).expect("读取新封面"), b"new");
        assert!(!target.with_extension("previous").exists());
    }
}
