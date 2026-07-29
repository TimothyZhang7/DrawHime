//! 本模块负责把用户已有 safetensors 原子导入受控模型目录，并返回可审计的哈希登记信息。

use crate::{
    models::{DesktopLocalLoraImportInput, DesktopLocalModelImportInput, DesktopSettings},
    storage::{LocalLoraRegistration, LocalModelRegistration},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use uuid::Uuid;

const MAX_MODEL_BYTES: u64 = 100 * 1024 * 1024 * 1024;
const MAX_SAFETENSORS_HEADER_BYTES: u64 = 100 * 1024 * 1024;

pub(crate) struct ImportedAsset {
    pub file_name: String,
    pub relative_path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub modified_ms: u64,
}

/** 校验 LoRA 元数据并复用相同的 safetensors 原子导入链路。 */
pub fn import_local_lora(settings: &DesktopSettings, input: DesktopLocalLoraImportInput) -> Result<LocalLoraRegistration, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 191 { return Err("LoRA 标题长度必须是 1–191 个字符".into()); }
    if !matches!(input.r#type.as_str(), "style" | "character" | "concept" | "clothing" | "pose" | "other") { return Err("LoRA 类型不正确".into()); }
    if input.trigger_words.len() > 50 || input.trigger_words.iter().any(|word| word.trim().is_empty() || word.trim().chars().count() > 100) { return Err("LoRA 触发词最多 50 个，每个长度必须是 1–100 个字符".into()); }
    let mut keys = std::collections::HashSet::new();
    let trigger_words = input.trigger_words.into_iter().map(|word| word.trim().to_owned()).filter(|word| keys.insert(word.to_lowercase())).collect::<Vec<_>>();
    let asset = import_asset(Path::new(&input.source_path), Path::new(&settings.model_root), "loras")?;
    Ok(LocalLoraRegistration { title: title.into(), r#type: input.r#type, file_name: asset.file_name, relative_path: asset.relative_path, sha256: asset.sha256, byte_size: asset.byte_size, modified_ms: asset.modified_ms, trigger_words })
}

/** 校验输入组合并导入底模及 Anima 必需的独立文本编码器和 VAE。 */
pub fn import_local_model(
    settings: &DesktopSettings,
    input: DesktopLocalModelImportInput,
) -> Result<LocalModelRegistration, String> {
    let display_name = input.display_name.trim();
    let family = input.family.trim();
    if display_name.is_empty() || display_name.chars().count() > 191 {
        return Err("模型名称长度必须是 1–191 个字符".into());
    }
    if family.is_empty() || family.chars().count() > 100 {
        return Err("模型系列长度必须是 1–100 个字符".into());
    }
    if !matches!(input.workflow_kind.as_str(), "checkpoint" | "anima") {
        return Err("模型工作流格式不正确".into());
    }
    if input.workflow_kind == "anima"
        && (input
            .text_encoder_source_path
            .as_deref()
            .is_none_or(str::is_empty)
            || input.vae_source_path.as_deref().is_none_or(str::is_empty))
    {
        return Err("Anima 模型必须同时选择文本编码器和 VAE".into());
    }
    if input.workflow_kind == "checkpoint"
        && (input.text_encoder_source_path.is_some() || input.vae_source_path.is_some())
    {
        return Err("Checkpoint 模型不接受独立文本编码器或 VAE".into());
    }

    let model_root = Path::new(&settings.model_root);
    let model_directory = if input.workflow_kind == "anima" {
        "diffusion_models"
    } else {
        "checkpoints"
    };
    let model = import_asset(
        Path::new(&input.model_source_path),
        model_root,
        model_directory,
    )?;
    let text_encoder = input
        .text_encoder_source_path
        .as_deref()
        .map(|path| import_asset(Path::new(path), model_root, "text_encoders"))
        .transpose()?;
    let vae = input
        .vae_source_path
        .as_deref()
        .map(|path| import_asset(Path::new(path), model_root, "vae"))
        .transpose()?;
    Ok(LocalModelRegistration {
        display_name: display_name.into(),
        family: family.into(),
        workflow_kind: input.workflow_kind,
        model_file_name: model.file_name,
        model_relative_path: model.relative_path,
        model_sha256: model.sha256,
        byte_size: model.byte_size,
        model_modified_ms: model.modified_ms,
        text_encoder_file_name: text_encoder.as_ref().map(|asset| asset.file_name.clone()),
        text_encoder_relative_path: text_encoder
            .as_ref()
            .map(|asset| asset.relative_path.clone()),
        text_encoder_sha256: text_encoder.as_ref().map(|asset| asset.sha256.clone()),
        vae_file_name: vae.as_ref().map(|asset| asset.file_name.clone()),
        vae_relative_path: vae.as_ref().map(|asset| asset.relative_path.clone()),
        vae_sha256: vae.as_ref().map(|asset| asset.sha256.clone()),
    })
}

pub(crate) fn import_asset(source: &Path, model_root: &Path, category: &str) -> Result<ImportedAsset, String> {
    validate_source(source)?;
    let original_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "模型文件名不是有效 Unicode".to_string())?;
    validate_file_name(original_name)?;
    let destination_directory = model_root.join(category);
    fs::create_dir_all(&destination_directory)
        .map_err(|error| format!("创建模型目录失败：{error}"))?;
    let temporary = destination_directory.join(format!(".drawhime-import-{}.tmp", Uuid::new_v4()));
    let (sha256, byte_size) = match copy_and_hash(source, &temporary) {
        Ok(result) => result,
        Err(error) => { let _ = fs::remove_file(&temporary); return Err(error); }
    };
    let destination =
        match collision_safe_destination(&destination_directory, original_name, &sha256) {
            Ok(destination) => destination,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        };
    if destination.exists() {
        fs::remove_file(&temporary)
            .map_err(|error| format!("清理重复模型临时文件失败：{error}"))?;
    } else if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("原子安装模型文件失败：{error}"));
    }
    let metadata = destination
        .metadata()
        .map_err(|error| format!("读取已安装模型失败：{error}"))?;
    let modified_ms = metadata
        .modified()
        .map_err(|error| format!("读取模型修改时间失败：{error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "模型修改时间早于系统纪元".to_string())?
        .as_millis() as u64;
    Ok(ImportedAsset {
        file_name: destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        relative_path: format!(
            "{category}/{}",
            destination
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        ),
        sha256,
        byte_size,
        modified_ms,
    })
}

fn validate_source(source: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("读取模型源文件失败：{error}"))?;
    if !metadata.is_file() || metadata.len() < 16 || metadata.len() > MAX_MODEL_BYTES {
        return Err("模型源文件大小不正确".into());
    }
    if metadata.file_type().is_symlink() {
        return Err("模型源文件不得是符号链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("模型源文件不得是重解析点".into());
        }
    }
    if !source.extension().is_some_and(|extension| {
        extension
            .to_string_lossy()
            .eq_ignore_ascii_case("safetensors")
    }) {
        return Err("只允许导入 safetensors 模型".into());
    }
    validate_safetensors_header(source, metadata.len())
}

fn validate_safetensors_header(path: &Path, total_bytes: u64) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("打开 safetensors 失败：{error}"))?;
    let mut length_bytes = [0_u8; 8];
    file.read_exact(&mut length_bytes)
        .map_err(|error| format!("读取 safetensors 头长度失败：{error}"))?;
    let header_bytes = u64::from_le_bytes(length_bytes);
    if header_bytes < 2
        || header_bytes > MAX_SAFETENSORS_HEADER_BYTES
        || header_bytes + 8 >= total_bytes
    {
        return Err("safetensors 头长度不正确".into());
    }
    let mut header = vec![0_u8; header_bytes as usize];
    file.read_exact(&mut header)
        .map_err(|error| format!("读取 safetensors 头失败：{error}"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&header).map_err(|_| "safetensors 头不是有效 JSON".to_string())?;
    if !value.is_object() {
        return Err("safetensors 头结构不正确".into());
    }
    Ok(())
}

fn copy_and_hash(source: &Path, temporary: &Path) -> Result<(String, u64), String> {
    let mut reader =
        BufReader::new(File::open(source).map_err(|error| format!("打开模型源文件失败：{error}"))?);
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("定位模型源文件失败：{error}"))?;
    let mut writer = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temporary)
        .map_err(|error| format!("创建模型导入临时文件失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取模型源文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入模型文件失败：{error}"))?;
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    writer
        .flush()
        .map_err(|error| format!("保存模型文件失败：{error}"))?;
    writer
        .sync_all()
        .map_err(|error| format!("同步模型文件到磁盘失败：{error}"))?;
    Ok((hex::encode(hasher.finalize()), total))
}

fn collision_safe_destination(
    directory: &Path,
    original_name: &str,
    sha256: &str,
) -> Result<PathBuf, String> {
    let original = directory.join(original_name);
    if !original.exists() {
        return Ok(original);
    }
    if hash_file(&original)? == sha256 {
        return Ok(original);
    }
    let stem = Path::new(original_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "模型文件名缺少主名称".to_string())?;
    let candidate = directory.join(format!("{}-{}.safetensors", stem, &sha256[..12]));
    if candidate.exists() && hash_file(&candidate)? != sha256 {
        return Err("模型目录存在哈希前缀冲突文件".into());
    }
    Ok(candidate)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut reader =
        BufReader::new(File::open(path).map_err(|error| format!("读取同名模型失败：{error}"))?);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("校验同名模型失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn validate_file_name(value: &str) -> Result<(), String> {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(|character| character == ' ' || character == '.')
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem.strip_prefix("COM").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || stem.strip_prefix("LPT").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        });
    if value.is_empty()
        || value.ends_with(' ')
        || value.ends_with('.')
        || value
            .chars()
            .any(|character| character.is_control() || invalid.contains(&character))
        || reserved
    {
        return Err("模型文件名不适用于 Windows".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_import_validates_and_registers_real_safetensors() {
        let temporary = tempfile::tempdir().expect("创建模型导入临时目录");
        let source = temporary.path().join("sample.safetensors");
        write_test_safetensors(&source);
        let settings = DesktopSettings {
            theme_mode: "system".into(),
            dependency_source: "auto".into(),
            default_privacy: "private".into(),
            model_root: temporary
                .path()
                .join("models")
                .to_string_lossy()
                .into_owned(),
            output_root: temporary
                .path()
                .join("outputs")
                .to_string_lossy()
                .into_owned(),
            runtime_root: temporary
                .path()
                .join("runtime")
                .to_string_lossy()
                .into_owned(),
            upload_concurrency: 2,
            wifi_only: false,
            bandwidth_limit_kib: None,
        };
        let imported = import_local_model(
            &settings,
            DesktopLocalModelImportInput {
                display_name: "测试模型".into(),
                family: "test".into(),
                workflow_kind: "checkpoint".into(),
                model_source_path: source.to_string_lossy().into_owned(),
                text_encoder_source_path: None,
                vae_source_path: None,
            },
        )
        .expect("导入模型");
        assert_eq!(imported.workflow_kind, "checkpoint");
        assert!(Path::new(&settings.model_root)
            .join(imported.model_relative_path)
            .is_file());
        assert_eq!(imported.model_sha256.len(), 64);
    }

    fn write_test_safetensors(path: &Path) {
        let header = br#"{"tensor":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}"#;
        let mut file = File::create(path).expect("创建 safetensors");
        file.write_all(&(header.len() as u64).to_le_bytes())
            .expect("写入头长度");
        file.write_all(header).expect("写入头");
        file.write_all(&[0, 0, 0, 0]).expect("写入张量");
    }
}
