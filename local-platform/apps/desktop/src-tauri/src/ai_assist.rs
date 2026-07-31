//! 本模块管理桌面 AI 辅助凭据，并调用真实 OpenAI Chat Completions 或 Responses 多模态端点。

use crate::{models::{DesktopAiAnalyzeInput, DesktopAiAnalyzeView, DesktopAiSettings, DesktopAiSettingsUpdate}, network::online_client_builder};
use base64::{engine::general_purpose::STANDARD, Engine};
use keyring::{Entry, Error as KeyringError};
use reqwest::blocking::Response;
use serde_json::{json, Value};
use std::{fs, path::Path, time::Duration};

const CREDENTIAL_SERVICE: &str = "ink.xanime.drawhime.desktop.ai";
const CREDENTIAL_USER: &str = "assistant-api-key";
const MAXIMUM_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/** 返回 AI Key 是否已经安全写入 Windows Credential Manager。 */
pub fn api_key_configured() -> Result<bool, String> { Ok(read_api_key()?.is_some()) }

/** 校验并写入 AI 设置和系统凭据；空密钥保留原值，显式清除才删除。 */
pub fn prepare_settings(input: DesktopAiSettingsUpdate) -> Result<(bool, String, String, String, bool), String> {
    if !matches!(input.endpoint_type.as_str(), "openai_chat" | "openai_responses") { return Err("AI 端点类型不正确".into()); }
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    let model = input.model.trim().to_string();
    if input.enabled && (base_url.is_empty() || model.is_empty()) { return Err("启用 AI 辅助前需要填写端点和模型".into()); }
    if !base_url.is_empty() && !(base_url.starts_with("https://") || base_url.starts_with("http://127.0.0.1") || base_url.starts_with("http://localhost")) { return Err("AI 端点必须使用 HTTPS；本机回环地址允许 HTTP".into()); }
    if input.clear_api_key { delete_api_key()?; }
    if let Some(api_key) = input.api_key.as_deref().map(str::trim).filter(|value| !value.is_empty()) { write_api_key(api_key)?; }
    let configured = api_key_configured()?;
    if input.enabled && !configured { return Err("启用 AI 辅助前需要保存 API Key".into()); }
    Ok((input.enabled, input.endpoint_type, base_url, model, configured))
}

/** 使用已保存配置执行一次轻量真实请求，验证鉴权、端点类型与模型。 */
pub fn test_settings(settings: &DesktopAiSettings) -> Result<String, String> {
    let api_key = required_api_key()?;
    let text = call_endpoint(settings, &api_key, "只回复 DrawHime AI ready。", None)?;
    if text.trim().is_empty() { return Err("AI 端点测试未返回文本".into()); }
    Ok("AI 端点连接、鉴权与模型响应正常".into())
}

/** 按固定用途读取并校验本机图片，再调用用户配置的真实多模态端点。 */
pub fn analyze_image(settings: &DesktopAiSettings, input: DesktopAiAnalyzeInput) -> Result<DesktopAiAnalyzeView, String> {
    if !settings.enabled { return Err("请先在设置中启用 AI 辅助".into()); }
    if !matches!(input.purpose.as_str(), "caption" | "reverse") { return Err("AI 分析用途不正确".into()); }
    let image = read_image_data_url(Path::new(&input.image_path))?;
    let instruction = input.user_instruction.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or("");
    let prompt = if input.purpose == "caption" {
        format!("分析这一张训练图片，只输出适合 LoRA 训练的英文逗号标签。使用稳定、常见、无重复的 Danbooru 风格词汇；先写主体数量和核心身份，再写外观、服装、姿势、构图、背景与画风。不要解释，不要编号，不要翻译。用户补充要求：{instruction}")
    } else {
        format!("准确反推这一张图片，只输出可直接用于图像生成的详细英文提示词。依次描述主体、身份与关系、外观、服装、姿势、构图、镜头、背景、光影、色彩、材质与画风；忠实于图片，不添加图中不存在的内容，不输出解释或标题。用户补充要求：{instruction}")
    };
    let text = call_endpoint(settings, &required_api_key()?, &prompt, Some(&image))?;
    let normalized = text.trim().trim_matches('`').trim().to_string();
    if normalized.is_empty() { return Err("AI 辅助未返回可用文本".into()); }
    Ok(DesktopAiAnalyzeView { purpose: input.purpose, text: normalized })
}

fn call_endpoint(settings: &DesktopAiSettings, api_key: &str, prompt: &str, image: Option<&str>) -> Result<String, String> {
    if settings.base_url.trim().is_empty() || settings.model.trim().is_empty() { return Err("AI 端点或模型尚未配置".into()); }
    let client = online_client_builder().connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(120)).build().map_err(|error| format!("创建 AI 客户端失败：{error}"))?;
    let (url, body) = if settings.endpoint_type == "openai_chat" {
        let mut content = vec![json!({ "type": "text", "text": prompt })];
        if let Some(data_url) = image { content.push(json!({ "type": "image_url", "image_url": { "url": data_url } })); }
        (endpoint_url(&settings.base_url, "chat/completions"), json!({ "model": settings.model, "messages": [{ "role": "user", "content": content }] }))
    } else if settings.endpoint_type == "openai_responses" {
        let mut content = vec![json!({ "type": "input_text", "text": prompt })];
        if let Some(data_url) = image { content.push(json!({ "type": "input_image", "image_url": data_url })); }
        (endpoint_url(&settings.base_url, "responses"), json!({ "model": settings.model, "input": [{ "role": "user", "content": content }] }))
    } else { return Err("AI 端点类型不正确".into()); };
    let response = client.post(url).bearer_auth(api_key).json(&body).send().map_err(|error| format!("AI 请求连接失败：{error}"))?;
    parse_response(response, &settings.endpoint_type)
}

fn parse_response(response: Response, endpoint_type: &str) -> Result<String, String> {
    let status = response.status();
    let payload: Value = response.json().map_err(|_| format!("AI 上游返回了非 JSON 响应（HTTP {}）", status.as_u16()))?;
    if !status.is_success() {
        let message = payload.pointer("/error/message").and_then(Value::as_str).or_else(|| payload.get("message").and_then(Value::as_str)).unwrap_or("AI 上游请求失败");
        return Err(format!("{message}（HTTP {}）", status.as_u16()));
    }
    let text = if endpoint_type == "openai_chat" {
        let content = payload.pointer("/choices/0/message/content");
        content.and_then(Value::as_str).map(str::to_string).or_else(|| content.and_then(Value::as_array).map(|items| items.iter().filter_map(|item| item.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")))
    } else {
        payload.get("output_text").and_then(Value::as_str).map(str::to_string).or_else(|| payload.get("output").and_then(Value::as_array).map(|outputs| outputs.iter().filter_map(|output| output.get("content").and_then(Value::as_array)).flatten().filter_map(|content| content.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")))
    };
    text.filter(|value| !value.trim().is_empty()).ok_or_else(|| "AI 上游响应中没有文本结果".into())
}

fn endpoint_url(base_url: &str, suffix: &str) -> String {
    let normalized = base_url.trim_end_matches('/');
    if normalized.ends_with(suffix) { normalized.to_string() } else { format!("{normalized}/{suffix}") }
}

fn read_image_data_url(path: &Path) -> Result<String, String> {
    let metadata = path.metadata().map_err(|_| "AI 辅助图片不存在或不可读".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_IMAGE_BYTES { return Err("AI 辅助图片必须是 20 MiB 以内的有效文件".into()); }
    let bytes = fs::read(path).map_err(|error| format!("读取 AI 辅助图片失败：{error}"))?;
    let mime_type = match image::guess_format(&bytes).map_err(|_| "AI 辅助图片格式不受支持".to_string())? {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err("AI 辅助仅支持 PNG、JPEG 与 WebP".into()),
    };
    Ok(format!("data:{mime_type};base64,{}", STANDARD.encode(bytes)))
}

fn credential_entry() -> Result<Entry, String> { Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER).map_err(|_| "初始化 AI Credential Manager 失败".into()) }
fn required_api_key() -> Result<String, String> { read_api_key()?.ok_or_else(|| "尚未保存 AI API Key".into()) }
fn read_api_key() -> Result<Option<String>, String> { match credential_entry()?.get_password() { Ok(value) if !value.trim().is_empty() => Ok(Some(value)), Ok(_) | Err(KeyringError::NoEntry) => Ok(None), Err(_) => Err("读取 AI API Key 失败".into()) } }
fn write_api_key(value: &str) -> Result<(), String> { credential_entry()?.set_password(value).map_err(|_| "保存 AI API Key 失败".into()) }
fn delete_api_key() -> Result<(), String> { match credential_entry()?.delete_credential() { Ok(()) | Err(KeyringError::NoEntry) => Ok(()), Err(_) => Err("删除 AI API Key 失败".into()) } }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_accepts_base_or_full_path() {
        assert_eq!(endpoint_url("https://example.com/v1", "chat/completions"), "https://example.com/v1/chat/completions");
        assert_eq!(endpoint_url("https://example.com/v1/chat/completions", "chat/completions"), "https://example.com/v1/chat/completions");
    }
}
