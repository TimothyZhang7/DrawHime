//! 本模块构建受控 ComfyUI 工作流并执行提交、轮询、取消、下载和 PNG 产物校验。

use reqwest::blocking::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    thread,
    time::Duration,
};
use uuid::Uuid;

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 80 * 1024 * 1024;

/** 生成工作流所需的任务与模型快照。 */
pub struct GenerationRequest {
    pub job_id: String,
    pub workflow_kind: String,
    pub model_file_name: String,
    pub text_encoder_file_name: Option<String>,
    pub vae_file_name: Option<String>,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub cfg: f64,
    pub sampler_name: String,
    pub scheduler_name: String,
    pub seed: u32,
    pub output_root: PathBuf,
    pub runtime_output_root: PathBuf,
}

/** 已下载并校验的本地生成产物。 */
pub struct GenerationResult {
    pub runtime_prompt_id: String,
    pub path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

/** 区分用户取消与真实执行失败，防止取消任务被记录为故障。 */
pub enum GenerationFailure {
    Cancelled,
    Failed(String),
}

/** 向真实 ComfyUI 提交任务并轮询到终态；模型执行本身不设置整体超时。 */
pub fn generate_image<F, G>(
    endpoint: &str,
    request: GenerationRequest,
    on_submitted: F,
    should_cancel: G,
) -> Result<GenerationResult, GenerationFailure>
where
    F: Fn(&str) -> Result<(), String>,
    G: Fn() -> bool,
{
    let client = http_client().map_err(GenerationFailure::Failed)?;
    let workflow = build_workflow(&request).map_err(GenerationFailure::Failed)?;
    let submission = client.post(format!("{endpoint}/prompt")).json(&json!({ "prompt": workflow, "client_id": format!("drawhime-{}", request.job_id), "front": true })).send().map_err(|error| GenerationFailure::Failed(format!("提交 ComfyUI 任务失败：{error}")))?;
    let status = submission.status();
    let body = read_json(submission).map_err(GenerationFailure::Failed)?;
    let prompt_id = body
        .get("prompt_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GenerationFailure::Failed(format!("ComfyUI 未接受任务：HTTP {status}")))?
        .to_owned();
    on_submitted(&prompt_id).map_err(GenerationFailure::Failed)?;

    loop {
        if should_cancel() {
            cancel_prompt(endpoint, &prompt_id);
            return Err(GenerationFailure::Cancelled);
        }
        thread::sleep(Duration::from_secs(1));
        let response = match client.get(format!("{endpoint}/history/{prompt_id}")).send() {
            Ok(response) => response,
            Err(_) => continue,
        };
        if !response.status().is_success() {
            continue;
        }
        let history = read_json(response).map_err(GenerationFailure::Failed)?;
        let Some(item) = history.get(&prompt_id) else {
            continue;
        };
        if item
            .get("status")
            .and_then(|status| status.get("status_str"))
            .and_then(Value::as_str)
            == Some("error")
        {
            return Err(GenerationFailure::Failed(
                "ComfyUI 工作流执行失败，请查看 Runtime 日志".into(),
            ));
        }
        let Some(image) = first_output_image(item) else {
            continue;
        };
        let filename = image
            .get("filename")
            .and_then(Value::as_str)
            .ok_or_else(|| GenerationFailure::Failed("ComfyUI 产物缺少文件名".into()))?;
        let subfolder = image.get("subfolder").and_then(Value::as_str).unwrap_or("");
        let image_type = image
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("output");
        validate_relative_output(filename, subfolder).map_err(GenerationFailure::Failed)?;
        let downloaded = client
            .get(format!("{endpoint}/view"))
            .query(&[
                ("filename", filename),
                ("subfolder", subfolder),
                ("type", image_type),
            ])
            .send()
            .map_err(|error| {
                GenerationFailure::Failed(format!("下载 ComfyUI 产物失败：{error}"))
            })?;
        if !downloaded.status().is_success() {
            return Err(GenerationFailure::Failed(format!(
                "下载 ComfyUI 产物失败：HTTP {}",
                downloaded.status()
            )));
        }
        let bytes = read_bytes(downloaded, MAX_IMAGE_BYTES).map_err(GenerationFailure::Failed)?;
        let result =
            persist_png(&request, &prompt_id, &bytes).map_err(GenerationFailure::Failed)?;
        cleanup_runtime_output(&request.runtime_output_root, filename, subfolder);
        return Ok(result);
    }
}

/** 对运行中 prompt 同时执行队列删除和节点中断，接口失败由后续终态轮询兜底。 */
pub fn cancel_prompt(endpoint: &str, prompt_id: &str) {
    let Ok(client) = http_client() else {
        return;
    };
    let _ = client
        .post(format!("{endpoint}/queue"))
        .json(&json!({ "delete": [prompt_id] }))
        .send();
    let _ = client.post(format!("{endpoint}/interrupt")).send();
}

fn build_workflow(request: &GenerationRequest) -> Result<Value, String> {
    let positive = request.prompt.trim();
    if positive.is_empty() {
        return Err("提示词不能为空".into());
    }
    let negative = request.negative_prompt.as_deref().unwrap_or("").trim();
    let prefix = format!("drawhime_{}", request.job_id.replace('-', ""));
    if request.workflow_kind == "checkpoint" {
        return Ok(json!({
            "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": request.model_file_name } },
            "2": { "class_type": "CLIPTextEncode", "inputs": { "text": positive, "clip": ["1", 1] } },
            "3": { "class_type": "CLIPTextEncode", "inputs": { "text": negative, "clip": ["1", 1] } },
            "4": { "class_type": "EmptyLatentImage", "inputs": { "width": request.width, "height": request.height, "batch_size": 1 } },
            "5": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "seed": request.seed, "steps": request.steps, "cfg": request.cfg, "sampler_name": request.sampler_name, "scheduler": request.scheduler_name, "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0], "denoise": 1.0 } },
            "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
            "7": { "class_type": "SaveImage", "inputs": { "images": ["6", 0], "filename_prefix": prefix } }
        }));
    }
    if request.workflow_kind != "anima" {
        return Err("当前模型工作流格式未受支持".into());
    }
    let text_encoder = request
        .text_encoder_file_name
        .as_deref()
        .ok_or_else(|| "Anima 任务缺少文本编码器快照".to_string())?;
    let vae = request
        .vae_file_name
        .as_deref()
        .ok_or_else(|| "Anima 任务缺少 VAE 快照".to_string())?;
    Ok(json!({
        "1": { "class_type": "UNETLoader", "inputs": { "unet_name": request.model_file_name, "weight_dtype": "default" } },
        "2": { "class_type": "CLIPLoader", "inputs": { "clip_name": text_encoder, "type": "stable_diffusion", "device": "default" } },
        "3": { "class_type": "VAELoader", "inputs": { "vae_name": vae } },
        "4": { "class_type": "CLIPTextEncode", "inputs": { "text": positive, "clip": ["2", 0] } },
        "5": { "class_type": "CLIPTextEncode", "inputs": { "text": negative, "clip": ["2", 0] } },
        "6": { "class_type": "EmptyLatentImage", "inputs": { "width": request.width, "height": request.height, "batch_size": 1 } },
        "7": { "class_type": "KSampler", "inputs": { "model": ["1", 0], "seed": request.seed, "steps": request.steps, "cfg": request.cfg, "sampler_name": request.sampler_name, "scheduler": request.scheduler_name, "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0], "denoise": 1.0 } },
        "8": { "class_type": "VAEDecode", "inputs": { "samples": ["7", 0], "vae": ["3", 0] } },
        "9": { "class_type": "SaveImage", "inputs": { "images": ["8", 0], "filename_prefix": prefix } }
    }))
}

fn first_output_image(item: &Value) -> Option<&Value> {
    item.get("outputs")?
        .as_object()?
        .values()
        .find_map(|output| output.get("images")?.as_array()?.first())
}

fn validate_relative_output(filename: &str, subfolder: &str) -> Result<(), String> {
    for value in [filename, subfolder] {
        if Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
            && !value.is_empty()
        {
            return Err("ComfyUI 返回了不安全的产物路径".into());
        }
    }
    Ok(())
}

fn persist_png(
    request: &GenerationRequest,
    prompt_id: &str,
    bytes: &[u8],
) -> Result<GenerationResult, String> {
    let (width, height) = png_dimensions(bytes)?;
    let date_directory = request
        .output_root
        .join(chrono::Local::now().format("%Y-%m-%d").to_string());
    fs::create_dir_all(&date_directory).map_err(|error| format!("创建作品目录失败：{error}"))?;
    let final_path = date_directory.join(format!("{}.png", request.job_id));
    let temporary = date_directory.join(format!(".{}.{}.tmp", request.job_id, Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("创建作品临时文件失败：{error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("写入作品失败：{error}"))?;
    file.flush()
        .map_err(|error| format!("保存作品失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("同步作品到磁盘失败：{error}"))?;
    if final_path.exists() {
        fs::remove_file(&final_path).map_err(|error| format!("替换同任务旧产物失败：{error}"))?;
    }
    fs::rename(&temporary, &final_path).map_err(|error| format!("原子提交作品失败：{error}"))?;
    let sha256 = hex::encode(Sha256::digest(bytes));
    Ok(GenerationResult {
        runtime_prompt_id: prompt_id.into(),
        path: final_path.to_string_lossy().into_owned(),
        sha256,
        byte_size: bytes.len() as u64,
        mime_type: "image/png".into(),
        width,
        height,
    })
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("ComfyUI 产物不是有效 PNG".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap_or_default());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap_or_default());
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("ComfyUI PNG 尺寸不正确".into());
    }
    Ok((width, height))
}

fn cleanup_runtime_output(root: &Path, filename: &str, subfolder: &str) {
    let path = if subfolder.is_empty() {
        root.join(filename)
    } else {
        root.join(subfolder).join(filename)
    };
    if path.starts_with(root) {
        let _ = fs::remove_file(path);
    }
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(HTTP_TIMEOUT)
        .timeout(HTTP_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|error| format!("创建 ComfyUI 客户端失败：{error}"))
}

fn read_json(response: reqwest::blocking::Response) -> Result<Value, String> {
    let bytes = read_bytes(response, MAX_JSON_BYTES)?;
    serde_json::from_slice(&bytes).map_err(|_| "ComfyUI 返回了异常 JSON".to_string())
}

fn read_bytes(response: reqwest::blocking::Response, limit: u64) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err("ComfyUI 响应超过大小限制".into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 ComfyUI 响应失败：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err("ComfyUI 响应超过大小限制".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{models::DesktopSettings, runtime::RuntimeController};

    #[test]
    fn checkpoint_workflow_keeps_positive_and_negative_conditioning_separate() {
        let request = test_request("checkpoint");
        let workflow = build_workflow(&request).expect("构建 Checkpoint 工作流");
        assert_eq!(workflow["2"]["inputs"]["text"], "subject");
        assert_eq!(workflow["3"]["inputs"]["text"], "bad anatomy");
        assert_eq!(workflow["5"]["inputs"]["negative"], json!(["3", 0]));
    }

    #[test]
    fn anima_workflow_uses_independent_unet_clip_and_vae() {
        let request = test_request("anima");
        let workflow = build_workflow(&request).expect("构建 Anima 工作流");
        assert_eq!(workflow["1"]["class_type"], "UNETLoader");
        assert_eq!(workflow["2"]["inputs"]["clip_name"], "clip.safetensors");
        assert_eq!(workflow["3"]["inputs"]["vae_name"], "vae.safetensors");
    }

    #[test]
    fn real_anima_runtime_generates_verified_png() {
        let Ok(runtime_root) = std::env::var("DRAWHIME_GENERATION_TEST_RUNTIME_ROOT") else { return; };
        let Ok(model_root) = std::env::var("DRAWHIME_GENERATION_TEST_MODEL_ROOT") else { return; };
        let output_root = std::env::var("DRAWHIME_GENERATION_TEST_OUTPUT_ROOT").map(PathBuf::from).unwrap_or_else(|_| tempfile::tempdir().expect("创建真实生成输出目录").keep());
        let temporary = tempfile::tempdir().expect("创建真实生成状态目录");
        let settings = DesktopSettings { theme_mode: "system".into(), dependency_source: "auto".into(), default_privacy: "private".into(), model_root, output_root: output_root.to_string_lossy().into_owned(), runtime_root, upload_concurrency: 2, wifi_only: false, bandwidth_limit_kib: None };
        let controller = RuntimeController::new();
        controller.self_test(&settings, temporary.path()).expect("真实 Runtime 自检");
        let endpoint = controller.endpoint().expect("读取 Runtime 端点");
        let result = generate_image(&endpoint, GenerationRequest { job_id: Uuid::new_v4().to_string(), workflow_kind: "anima".into(), model_file_name: "animeBulldozer_anima.safetensors".into(), text_encoder_file_name: Some("qwen_3_06b_base.safetensors".into()), vae_file_name: Some("qwen_image_vae.safetensors".into()), prompt: "masterpiece, best quality, 1girl, solo, blue hair, white background".into(), negative_prompt: Some("worst quality, low quality, blurry, bad anatomy".into()), width: 512, height: 512, steps: 4, cfg: 4.0, sampler_name: "euler".into(), scheduler_name: "normal".into(), seed: 20260729, output_root, runtime_output_root: temporary.path().join("runtime-state").join("comfy-output") }, |_| Ok(()), || false).map_err(|failure| match failure { GenerationFailure::Cancelled => "生成被取消".to_string(), GenerationFailure::Failed(error) => error }).expect("真实 Anima 生图");
        assert!(Path::new(&result.path).is_file());
        assert_eq!((result.width, result.height), (512, 512));
        assert_eq!(result.sha256.len(), 64);
        controller.stop().expect("停止真实 Runtime");
    }

    fn test_request(workflow_kind: &str) -> GenerationRequest {
        GenerationRequest {
            job_id: Uuid::new_v4().to_string(),
            workflow_kind: workflow_kind.into(),
            model_file_name: "model.safetensors".into(),
            text_encoder_file_name: Some("clip.safetensors".into()),
            vae_file_name: Some("vae.safetensors".into()),
            prompt: "subject".into(),
            negative_prompt: Some("bad anatomy".into()),
            width: 512,
            height: 512,
            steps: 10,
            cfg: 5.0,
            sampler_name: "euler".into(),
            scheduler_name: "normal".into(),
            seed: 1,
            output_root: PathBuf::from("outputs"),
            runtime_output_root: PathBuf::from("runtime-output"),
        }
    }
}
