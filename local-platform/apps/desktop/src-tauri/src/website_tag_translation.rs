//! 本模块通过设备会话读取主站训练标签翻译集，原始会话密钥不会进入 WebView。

use crate::{
    auth::{self, DesktopSessionError},
    models::{DesktopTrainingTagTranslationInput, DesktopTrainingTagTranslationView},
    network::online_client_builder,
};
use reqwest::blocking::Response;
use serde::Deserialize;
use std::{collections::HashSet, time::Duration};

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    ok: bool,
    data: Option<T>,
    code: Option<String>,
    message: Option<String>,
}

/** 校验并批量读取最多 200 个标签的中英对照和稳定颜色。 */
pub fn translate(
    input: DesktopTrainingTagTranslationInput,
) -> Result<DesktopTrainingTagTranslationView, String> {
    if input.tags.is_empty() || input.tags.len() > 200 {
        return Err("每次必须翻译 1–200 个训练标签".into());
    }
    let mut seen = HashSet::new();
    let tags = input
        .tags
        .into_iter()
        .map(|tag| tag.trim().to_owned())
        .filter(|tag| {
            !tag.is_empty() && tag.chars().count() <= 200 && seen.insert(tag.to_lowercase())
        })
        .collect::<Vec<_>>();
    if tags.is_empty() {
        return Err("训练标签内容为空".into());
    }
    let session = match auth::authenticated_session() {
        Ok(Some(session)) => session,
        Ok(None) => return Err("连接绘图姬账号后可读取标签翻译".into()),
        Err(DesktopSessionError::Network) => return Err("标签翻译服务当前不可达".into()),
        Err(DesktopSessionError::Service(message)) => return Err(message),
    };
    let client = online_client_builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("创建标签翻译客户端失败：{error}"))?;
    let response = client
        .post(auth::api_url("/v1/training/tag-translations"))
        .bearer_auth(session.token)
        .json(&DesktopTrainingTagTranslationInput { tags })
        .send();
    parse_response(response)
}

fn parse_response(
    result: Result<Response, reqwest::Error>,
) -> Result<DesktopTrainingTagTranslationView, String> {
    let response = result.map_err(|error| {
        if error.is_timeout() {
            "标签翻译请求超时".to_string()
        } else {
            "标签翻译服务连接失败".to_string()
        }
    })?;
    let status = response.status();
    let payload: ApiEnvelope<DesktopTrainingTagTranslationView> = response
        .json()
        .map_err(|_| "标签翻译服务返回格式不正确".to_string())?;
    if !status.is_success() || !payload.ok {
        return Err(payload
            .message
            .or(payload.code)
            .unwrap_or_else(|| format!("标签翻译服务 HTTP {}", status.as_u16())));
    }
    payload.data.ok_or_else(|| "标签翻译服务未返回数据".into())
}
