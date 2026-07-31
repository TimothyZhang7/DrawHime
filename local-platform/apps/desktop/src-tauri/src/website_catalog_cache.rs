//! 本模块原子保存网站底模与 LoRA 最近一次成功目录，供仍保留设备会话的离线客户端浏览。

use serde::{de::DeserializeOwned, Serialize};
use std::{fs, path::{Path, PathBuf}};

const MAXIMUM_CATALOG_BYTES: u64 = 8 * 1024 * 1024;

/** 原子保存已经由真实 API 返回并完成反序列化的目录，不缓存会话密钥。 */
pub fn store<T: Serialize>(app_data_dir: &Path, namespace: &str, value: &T) -> Result<(), String> {
    let path = cache_path(app_data_dir, namespace)?;
    let bytes = serde_json::to_vec(value).map_err(|error| format!("序列化网站仓库缓存失败：{error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAXIMUM_CATALOG_BYTES { return Err("网站仓库缓存大小不正确".into()); }
    let temporary = path.with_extension("json.part");
    let previous = path.with_extension("json.previous");
    fs::write(&temporary, bytes).map_err(|error| format!("写入网站仓库缓存失败：{error}"))?;
    if previous.exists() { fs::remove_file(&previous).map_err(|error| format!("清理网站仓库旧缓存失败：{error}"))?; }
    if path.exists() { fs::rename(&path, &previous).map_err(|error| format!("暂存网站仓库旧缓存失败：{error}"))?; }
    if let Err(error) = fs::rename(&temporary, &path) {
        if previous.exists() { let _ = fs::rename(&previous, &path); }
        return Err(format!("提交网站仓库缓存失败：{error}"));
    }
    if previous.exists() { fs::remove_file(previous).map_err(|error| format!("清理网站仓库备份失败：{error}"))?; }
    Ok(())
}

/** 读取最近一次成功目录；文件损坏或超限时明确失败，不返回部分条目。 */
pub fn load<T: DeserializeOwned>(app_data_dir: &Path, namespace: &str) -> Result<T, String> {
    let path = cache_path(app_data_dir, namespace)?;
    let metadata = path.metadata().map_err(|_| "本机尚无可用的网站仓库缓存".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_CATALOG_BYTES { return Err("网站仓库缓存文件大小不正确".into()); }
    let bytes = fs::read(path).map_err(|error| format!("读取网站仓库缓存失败：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|_| "网站仓库缓存格式不正确".to_string())
}

fn cache_path(app_data_dir: &Path, namespace: &str) -> Result<PathBuf, String> {
    if namespace.is_empty() || !namespace.chars().all(|value| value.is_ascii_lowercase() || value == '-') { return Err("网站仓库缓存名称不正确".into()); }
    let directory = app_data_dir.join("catalog-cache");
    fs::create_dir_all(&directory).map_err(|error| format!("创建网站仓库缓存目录失败：{error}"))?;
    Ok(directory.join(format!("{namespace}.json")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_cache_round_trip_is_atomic() {
        let directory = tempfile::tempdir().expect("创建目录缓存测试目录");
        store(directory.path(), "models", &vec!["first"]).expect("写入首次缓存");
        store(directory.path(), "models", &vec!["second"]).expect("替换目录缓存");
        let value: Vec<String> = load(directory.path(), "models").expect("读取目录缓存");
        assert_eq!(value, vec!["second"]);
        assert!(!directory.path().join("catalog-cache/models.json.previous").exists());
    }
}
