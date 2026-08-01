//! 本模块管理桌面 AI 辅助凭据，并调用真实 OpenAI Chat Completions 或 Responses 多模态端点。

use crate::{
    models::{
        DesktopAiAnalyzeInput, DesktopAiAnalyzeView, DesktopAiCleanProposal,
        DesktopAiCleanTagSuggestion, DesktopAiSettings, DesktopAiSettingsUpdate,
    },
    network::online_client_builder,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use keyring::{Entry, Error as KeyringError};
use reqwest::blocking::Response;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::Path, time::Duration};

const CREDENTIAL_SERVICE: &str = "ink.xanime.drawhime.desktop.ai";
const CREDENTIAL_USER: &str = "assistant-api-key";
const MAXIMUM_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const VISION_TEST_IMAGE: &[u8] = include_bytes!("../icons/icon-source.png");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisionTestResult {
    subject: String,
    colors: Vec<String>,
    contains_text: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCleanProposal {
    keep: Vec<DesktopAiCleanTagSuggestion>,
    remove: Vec<DesktopAiCleanTagSuggestion>,
    add: Vec<DesktopAiCleanTagSuggestion>,
}

/** 返回 AI Key 是否已经安全写入 Windows Credential Manager。 */
pub fn api_key_configured() -> Result<bool, String> {
    Ok(read_api_key()?.is_some())
}

/** 校验并写入 AI 设置和系统凭据；空密钥保留原值，显式清除才删除。 */
pub fn prepare_settings(
    input: DesktopAiSettingsUpdate,
) -> Result<(bool, String, String, String, bool), String> {
    if !matches!(
        input.endpoint_type.as_str(),
        "openai_chat" | "openai_responses"
    ) {
        return Err("AI 端点类型不正确".into());
    }
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    let model = input.model.trim().to_string();
    if input.enabled && (base_url.is_empty() || model.is_empty()) {
        return Err("启用 AI 辅助前需要填写端点和模型".into());
    }
    if !base_url.is_empty()
        && !(base_url.starts_with("https://")
            || base_url.starts_with("http://127.0.0.1")
            || base_url.starts_with("http://localhost"))
    {
        return Err("AI 端点必须使用 HTTPS；本机回环地址允许 HTTP".into());
    }
    if input.clear_api_key {
        delete_api_key()?;
    }
    if let Some(api_key) = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        write_api_key(api_key)?;
    }
    let configured = api_key_configured()?;
    if input.enabled && !configured {
        return Err("启用 AI 辅助前需要保存 API Key".into());
    }
    Ok((
        input.enabled,
        input.endpoint_type,
        base_url,
        model,
        configured,
    ))
}

/** 使用内置本地测试图执行真实视觉请求，验证鉴权、格式、模型和结构化识别能力。 */
pub fn test_settings(settings: &DesktopAiSettings) -> Result<String, String> {
    let api_key = required_api_key()?;
    let image = format!(
        "data:image/png;base64,{}",
        STANDARD.encode(VISION_TEST_IMAGE)
    );
    let text = call_endpoint(settings, &api_key, "识别这张应用图标，只返回 JSON 对象：subject 为主体描述，colors 为主要颜色字符串数组，containsText 为是否包含文字。不得输出 Markdown。", Some(&image))?;
    let result: VisionTestResult = parse_json_text(&text)
        .map_err(|error| format!("AI 视觉测试未返回要求的结构化结果：{error}"))?;
    if result.subject.trim().is_empty() || result.colors.is_empty() {
        return Err("AI 视觉测试返回的主体或颜色为空".into());
    }
    Ok(format!(
        "视觉能力测试通过：识别到{}，主要颜色 {} 种，文字识别 {}",
        result.subject.trim(),
        result.colors.len(),
        if result.contains_text { "有" } else { "无" }
    ))
}

/** 按固定用途读取并校验本机图片，再调用用户配置的真实多模态端点。 */
pub fn analyze_image(
    settings: &DesktopAiSettings,
    input: DesktopAiAnalyzeInput,
) -> Result<DesktopAiAnalyzeView, String> {
    if !settings.enabled {
        return Err("请先在设置中启用 AI 辅助".into());
    }
    if !matches!(input.purpose.as_str(), "caption" | "reverse") {
        return Err("AI 分析用途不正确".into());
    }
    let image = read_image_data_url(Path::new(&input.image_path))?;
    let instruction = input
        .user_instruction
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let prompt = if input.purpose == "caption" {
        format!("分析这一张训练图片，只输出适合 LoRA 训练的英文逗号标签。使用稳定、常见、无重复的 Danbooru 风格词汇；先写主体数量和核心身份，再写外观、服装、姿势、构图、背景与画风。不要解释，不要编号，不要翻译。用户补充要求：{instruction}")
    } else {
        format!("准确反推这一张图片，只输出可直接用于图像生成的详细英文提示词。依次描述主体、身份与关系、外观、服装、姿势、构图、镜头、背景、光影、色彩、材质与画风；忠实于图片，不添加图中不存在的内容，不输出解释或标题。用户补充要求：{instruction}")
    };
    let text = call_endpoint(settings, &required_api_key()?, &prompt, Some(&image))?;
    let normalized = text.trim().trim_matches('`').trim().to_string();
    if normalized.is_empty() {
        return Err("AI 辅助未返回可用文本".into());
    }
    Ok(DesktopAiAnalyzeView {
        purpose: input.purpose,
        text: normalized,
    })
}

/** 结合图片、训练类型和目标生成可审计清洗建议，调用结果不会直接修改训练集。 */
pub(crate) fn clean_training_tags(
    settings: &DesktopAiSettings,
    image_path: &Path,
    dataset_type: &str,
    trigger_words: &[String],
    training_goal: &str,
    current_tags: &[String],
) -> Result<DesktopAiCleanProposal, String> {
    if !settings.enabled {
        return Err("请先在设置中启用 AI 辅助".into());
    }
    if !matches!(dataset_type, "character" | "style" | "object" | "concept") {
        return Err("AI 清洗训练类型不正确".into());
    }
    if current_tags.is_empty() {
        return Err("当前图片没有可清洗的标签".into());
    }
    let image = read_image_data_url(image_path)?;
    let type_rule = match dataset_type {
        "character" => "角色 LoRA：结合训练目标判断哪些稳定身份特征应绑定触发词、哪些服装动作背景应保留为可控变量。",
        "style" => "画风 LoRA：删除不应绑定画风的特定人物身份，保留内容、动作、构图、景别和可变主题标签。",
        _ => "概念 LoRA：结合训练目标区分概念固有特征和生成时需要可控的变量。",
    };
    let prompt = format!(
        "你正在审查 LoRA 训练标签，不是在重新打标。只返回一个 JSON 对象，字段固定为 keep、remove、add，每项均为 {{\"tag\":\"英文标签\",\"reason\":\"简短中文理由\"}} 数组。\n\
         原标签必须逐项且恰好一次出现在 keep 或 remove；add 只能补充图片中清晰存在且训练需要的常见英文标签。禁止改写标签后用新词替代，禁止重复、矛盾、低置信度或图片中不存在的内容。触发词必须放入 keep。\n\
         {type_rule}\n训练目标：{}\n触发词：{}\n原标签：{}",
        if training_goal.trim().is_empty() { "未补充；按当前训练类型保持保守且可控的标签拆分" } else { training_goal.trim() },
        trigger_words.join(", "),
        current_tags.join(", ")
    );
    let text = call_endpoint(settings, &required_api_key()?, &prompt, Some(&image))?;
    let raw: RawCleanProposal = parse_json_text(&text)
        .map_err(|error| format!("AI 清洗未返回要求的结构化结果：{error}"))?;
    validate_clean_proposal(raw, current_tags, trigger_words)
}

/** 严格校验原标签分类和新增项，禁止上游遗漏、重复或删除触发词。 */
fn validate_clean_proposal(
    raw: RawCleanProposal,
    current_tags: &[String],
    trigger_words: &[String],
) -> Result<DesktopAiCleanProposal, String> {
    let originals = current_tags
        .iter()
        .map(|tag| (normalize_tag(tag), tag.trim().to_string()))
        .collect::<std::collections::HashMap<_, _>>();
    let trigger_keys = trigger_words
        .iter()
        .map(|tag| normalize_tag(tag))
        .collect::<std::collections::HashSet<_>>();
    let mut classified = std::collections::HashSet::new();
    let mut keep_by_key = std::collections::HashMap::new();
    let mut remove_by_key = std::collections::HashMap::new();
    for suggestion in raw.keep.into_iter().chain(
        raw.remove
            .iter()
            .filter(|item| trigger_keys.contains(&normalize_tag(&item.tag)))
            .cloned(),
    ) {
        let key = normalize_tag(&suggestion.tag);
        let Some(original) = originals.get(&key) else {
            return Err(format!(
                "AI 清洗返回了不属于原标签的保留项：{}",
                suggestion.tag
            ));
        };
        if !classified.insert(key.clone()) {
            return Err(format!("AI 清洗重复分类标签：{original}"));
        }
        keep_by_key.insert(key, clean_suggestion(original, suggestion.reason));
    }
    for suggestion in raw.remove {
        let key = normalize_tag(&suggestion.tag);
        if trigger_keys.contains(&key) {
            continue;
        }
        let Some(original) = originals.get(&key) else {
            return Err(format!(
                "AI 清洗返回了不属于原标签的删除项：{}",
                suggestion.tag
            ));
        };
        if !classified.insert(key.clone()) {
            return Err(format!("AI 清洗重复分类标签：{original}"));
        }
        remove_by_key.insert(key, clean_suggestion(original, suggestion.reason));
    }
    if classified.len() != originals.len() {
        return Err("AI 清洗没有完整分类全部原标签".into());
    }
    let mut keep = Vec::new();
    let mut remove = Vec::new();
    for tag in current_tags {
        let key = normalize_tag(tag);
        if let Some(item) = keep_by_key.remove(&key) {
            keep.push(item);
        } else if let Some(item) = remove_by_key.remove(&key) {
            remove.push(item);
        }
    }
    let mut known = originals
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let mut add = Vec::new();
    for suggestion in raw.add {
        let tag = suggestion.tag.trim();
        if tag.is_empty() || tag.chars().count() > 200 {
            return Err("AI 清洗新增标签长度不正确".into());
        }
        let key = normalize_tag(tag);
        if key.is_empty() || !known.insert(key) {
            continue;
        }
        add.push(clean_suggestion(tag, suggestion.reason));
    }
    if keep.len() + remove.len() != current_tags.len() || keep.len() + add.len() > 2_000 {
        return Err("AI 清洗标签数量不正确".into());
    }
    let final_tags = keep
        .iter()
        .chain(add.iter())
        .map(|item| item.tag.clone())
        .collect();
    Ok(DesktopAiCleanProposal {
        original_tags: current_tags.to_vec(),
        keep,
        remove,
        add,
        final_tags,
    })
}

fn clean_suggestion(tag: &str, reason: String) -> DesktopAiCleanTagSuggestion {
    let reason = reason.trim();
    DesktopAiCleanTagSuggestion {
        tag: tag.trim().to_string(),
        reason: if reason.is_empty() {
            "未提供理由".into()
        } else {
            reason.chars().take(1000).collect()
        },
    }
}

fn normalize_tag(value: &str) -> String {
    value
        .trim()
        .replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn call_endpoint(
    settings: &DesktopAiSettings,
    api_key: &str,
    prompt: &str,
    image: Option<&str>,
) -> Result<String, String> {
    if settings.base_url.trim().is_empty() || settings.model.trim().is_empty() {
        return Err("AI 端点或模型尚未配置".into());
    }
    let client = online_client_builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| format!("创建 AI 客户端失败：{error}"))?;
    let (url, body) = if settings.endpoint_type == "openai_chat" {
        let mut content = vec![json!({ "type": "text", "text": prompt })];
        if let Some(data_url) = image {
            content.push(json!({ "type": "image_url", "image_url": { "url": data_url } }));
        }
        (
            endpoint_url(&settings.base_url, "chat/completions"),
            json!({ "model": settings.model, "messages": [{ "role": "user", "content": content }] }),
        )
    } else if settings.endpoint_type == "openai_responses" {
        let mut content = vec![json!({ "type": "input_text", "text": prompt })];
        if let Some(data_url) = image {
            content.push(json!({ "type": "input_image", "image_url": data_url }));
        }
        (
            endpoint_url(&settings.base_url, "responses"),
            json!({ "model": settings.model, "input": [{ "role": "user", "content": content }] }),
        )
    } else {
        return Err("AI 端点类型不正确".into());
    };
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .map_err(|error| format!("AI 请求连接失败：{error}"))?;
    parse_response(response, &settings.endpoint_type)
}

fn parse_response(response: Response, endpoint_type: &str) -> Result<String, String> {
    let status = response.status();
    let payload: Value = response
        .json()
        .map_err(|_| format!("AI 上游返回了非 JSON 响应（HTTP {}）", status.as_u16()))?;
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("AI 上游请求失败");
        return Err(format!("{message}（HTTP {}）", status.as_u16()));
    }
    let text = if endpoint_type == "openai_chat" {
        let content = payload.pointer("/choices/0/message/content");
        content
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                content.and_then(Value::as_array).map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
            })
    } else {
        payload
            .get("output_text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                payload
                    .get("output")
                    .and_then(Value::as_array)
                    .map(|outputs| {
                        outputs
                            .iter()
                            .filter_map(|output| output.get("content").and_then(Value::as_array))
                            .flatten()
                            .filter_map(|content| content.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
            })
    };
    text.filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "AI 上游响应中没有文本结果".into())
}

/** 兼容纯 JSON、代码围栏和少量前后说明，但最终对象仍必须完整反序列化。 */
fn parse_json_text<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    let trimmed = text.trim();
    let candidate = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };
    if let Ok(value) = serde_json::from_str(candidate) {
        return Ok(value);
    }
    let start = candidate
        .find('{')
        .ok_or_else(|| "响应中没有 JSON 对象".to_string())?;
    let mut depth = 0_u32;
    let mut quoted = false;
    let mut escaped = false;
    for (offset, character) in candidate[start..].char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
            continue;
        }
        match character {
            '"' => quoted = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return serde_json::from_str(&candidate[start..start + offset + 1])
                        .map_err(|error| error.to_string());
                }
            }
            _ => {}
        }
    }
    Err("响应中的 JSON 对象不完整".into())
}

fn endpoint_url(base_url: &str, suffix: &str) -> String {
    let normalized = base_url.trim_end_matches('/');
    if normalized.ends_with(suffix) {
        normalized.to_string()
    } else {
        format!("{normalized}/{suffix}")
    }
}

fn read_image_data_url(path: &Path) -> Result<String, String> {
    let metadata = path
        .metadata()
        .map_err(|_| "AI 辅助图片不存在或不可读".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_IMAGE_BYTES {
        return Err("AI 辅助图片必须是 20 MiB 以内的有效文件".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 AI 辅助图片失败：{error}"))?;
    let mime_type = match image::guess_format(&bytes)
        .map_err(|_| "AI 辅助图片格式不受支持".to_string())?
    {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err("AI 辅助仅支持 PNG、JPEG 与 WebP".into()),
    };
    Ok(format!(
        "data:{mime_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}

fn credential_entry() -> Result<Entry, String> {
    Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER)
        .map_err(|_| "初始化 AI Credential Manager 失败".into())
}
fn required_api_key() -> Result<String, String> {
    read_api_key()?.ok_or_else(|| "尚未保存 AI API Key".into())
}
fn read_api_key() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err("读取 AI API Key 失败".into()),
    }
}
fn write_api_key(value: &str) -> Result<(), String> {
    credential_entry()?
        .set_password(value)
        .map_err(|_| "保存 AI API Key 失败".into())
}
fn delete_api_key() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err("删除 AI API Key 失败".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_accepts_base_or_full_path() {
        assert_eq!(
            endpoint_url("https://example.com/v1", "chat/completions"),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint_url(
                "https://example.com/v1/chat/completions",
                "chat/completions"
            ),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn vision_test_result_requires_structured_json() {
        let parsed: VisionTestResult = parse_json_text(
            "```json\n{\"subject\":\"动漫角色\",\"colors\":[\"紫色\"],\"containsText\":false}\n```",
        )
        .expect("解析视觉测试结果");
        assert_eq!(parsed.subject, "动漫角色");
        assert_eq!(parsed.colors, vec!["紫色"]);
        assert!(!parsed.contains_text);
    }

    #[test]
    fn json_parser_extracts_one_complete_object_from_explanation() {
        let parsed: VisionTestResult = parse_json_text(
            "分析完成：\n{\"subject\":\"角色\",\"colors\":[\"蓝色\"],\"containsText\":false}\n以上为结果。",
        )
        .expect("提取说明中的 JSON");
        assert_eq!(parsed.subject, "角色");
    }

    #[test]
    fn clean_proposal_partitions_originals_and_protects_trigger() {
        let proposal = validate_clean_proposal(
            RawCleanProposal {
                keep: vec![DesktopAiCleanTagSuggestion {
                    tag: "school uniform".into(),
                    reason: "服装需要可控".into(),
                }],
                remove: vec![
                    DesktopAiCleanTagSuggestion {
                        tag: "my_token".into(),
                        reason: "错误建议删除触发词".into(),
                    },
                    DesktopAiCleanTagSuggestion {
                        tag: "blue hair".into(),
                        reason: "绑定角色身份".into(),
                    },
                ],
                add: vec![DesktopAiCleanTagSuggestion {
                    tag: "indoors".into(),
                    reason: "画面中存在".into(),
                }],
            },
            &[
                "my_token".into(),
                "blue hair".into(),
                "school uniform".into(),
            ],
            &["my_token".into()],
        )
        .expect("校验 AI 清洗建议");
        assert!(proposal.keep.iter().any(|item| item.tag == "my_token"));
        assert!(proposal.remove.iter().any(|item| item.tag == "blue hair"));
        assert_eq!(
            proposal.final_tags,
            vec!["my_token", "school uniform", "indoors"]
        );
    }
}
