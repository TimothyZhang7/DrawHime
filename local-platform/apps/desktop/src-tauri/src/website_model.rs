//! 本模块读取主站底模仓库并把受保护封面缓存成本机文件，不直接暴露设备会话。

use crate::{auth::{self, DesktopSessionError}, models::{DesktopWebsiteModelParameters, DesktopWebsiteModelView, DesktopWebsiteSourceLink}, website_media::{self, WebsiteImageRef}};
use reqwest::blocking::{Client, Response};
use serde::{de::DeserializeOwned, Deserialize};
use std::{path::Path, time::Duration};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteModelEntry { id: String, display_name: String, description: String, family: String, family_name: String, model_file_name: String, runtime_format: String, usage_guide: String, source_links: Vec<DesktopWebsiteSourceLink>, parameters: DesktopWebsiteModelParameters, examples: Vec<WebsiteImageRef> }

#[derive(Debug, Deserialize)]
struct WebsiteModelList { entries: Vec<WebsiteModelEntry> }

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> { ok: bool, data: Option<T>, code: Option<String>, message: Option<String> }

/** 读取当前账号可见的底模仓库，并逐张容错缓存全部示例图。 */
pub fn load_catalog(app_data_dir: &Path) -> Result<Vec<DesktopWebsiteModelView>, String> {
    let session = match auth::authenticated_session() {
        Ok(Some(session)) => session,
        Ok(None) => return Err("请先连接绘图姬账号".into()),
        Err(DesktopSessionError::Network) => return Err("账号服务当前不可达".into()),
        Err(DesktopSessionError::Service(message)) => return Err(message),
    };
    let client = network_client()?;
    let payload: WebsiteModelList = parse_json(client.get(auth::api_url("/v1/model-library")).bearer_auth(&session.token).send())?;
    Ok(payload.entries.into_iter().map(|entry| {
        let example_paths = website_media::cache_images(&client, &session.token, app_data_dir, "models", &entry.examples);
        let cover_path = example_paths.first().cloned();
        DesktopWebsiteModelView { id: entry.id, display_name: entry.display_name, description: entry.description, family: entry.family, family_name: entry.family_name, model_file_name: entry.model_file_name, runtime_format: entry.runtime_format, usage_guide: entry.usage_guide, source_links: entry.source_links, parameters: entry.parameters, cover_path, example_paths }
    }).collect())
}

fn network_client() -> Result<Client, String> { Client::builder().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(30)).user_agent("DrawHime-Desktop/0.1").build().map_err(|error| format!("创建网站底模客户端失败：{error}")) }

fn parse_json<T: DeserializeOwned>(result: Result<Response, reqwest::Error>) -> Result<T, String> {
    let response = result.map_err(|_| "网站底模服务连接失败".to_string())?;
    let status = response.status();
    let payload: ApiEnvelope<T> = response.json().map_err(|_| "网站底模服务返回格式不正确".to_string())?;
    if !status.is_success() || !payload.ok { return Err(payload.message.or(payload.code).unwrap_or_else(|| format!("网站底模服务 HTTP {}", status.as_u16()))); }
    payload.data.ok_or_else(|| "网站底模服务未返回数据".into())
}
