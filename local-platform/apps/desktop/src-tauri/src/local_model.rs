//! 本模块负责把用户已有 safetensors 原子导入受控模型目录，并返回可审计的哈希登记信息。

use crate::{
    models::{
        DesktopLocalLoraImportInput, DesktopLocalModelImportInput, DesktopSettings,
        DesktopWebsiteLoraView, DesktopWebsiteModelComponent, DesktopWebsiteModelView,
    },
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
const ANIMA_TEXT_ENCODER_FILE: &str = "qwen_3_06b_base.safetensors";
const ANIMA_VAE_FILE: &str = "qwen_image_vae.safetensors";

pub(crate) struct ImportedAsset {
    pub file_name: String,
    pub relative_path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub modified_ms: u64,
}

/** 校验 LoRA 元数据并复用相同的 safetensors 原子导入链路。 */
pub fn import_local_lora(
    settings: &DesktopSettings,
    input: DesktopLocalLoraImportInput,
) -> Result<LocalLoraRegistration, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 191 {
        return Err("LoRA 标题长度必须是 1–191 个字符".into());
    }
    if !matches!(
        input.r#type.as_str(),
        "style" | "character" | "concept" | "clothing" | "pose" | "other"
    ) {
        return Err("LoRA 类型不正确".into());
    }
    if input.trigger_words.len() > 50
        || input
            .trigger_words
            .iter()
            .any(|word| word.trim().is_empty() || word.trim().chars().count() > 100)
    {
        return Err("LoRA 触发词最多 50 个，每个长度必须是 1–100 个字符".into());
    }
    let mut keys = std::collections::HashSet::new();
    let trigger_words = input
        .trigger_words
        .into_iter()
        .map(|word| word.trim().to_owned())
        .filter(|word| keys.insert(word.to_lowercase()))
        .collect::<Vec<_>>();
    let asset = import_asset(
        Path::new(&input.source_path),
        Path::new(&settings.model_root),
        "loras",
    )?;
    Ok(LocalLoraRegistration {
        title: title.into(),
        r#type: input.r#type,
        file_name: asset.file_name,
        relative_path: asset.relative_path,
        sha256: asset.sha256,
        base_model_sha256: None,
        byte_size: asset.byte_size,
        modified_ms: asset.modified_ms,
        trigger_words,
    })
}

/** 当前只导入 Anima 主模型；默认复用签名共享组件，高级输入可成对覆盖。 */
pub fn import_local_model(
    settings: &DesktopSettings,
    input: DesktopLocalModelImportInput,
) -> Result<LocalModelRegistration, String> {
    let display_name = input.display_name.trim();
    let family = input.family.trim();
    if display_name.is_empty() || display_name.chars().count() > 191 {
        return Err("模型名称长度必须是 1–191 个字符".into());
    }
    if family != "anima" || input.workflow_kind != "anima" {
        return Err("桌面端当前只支持导入 Anima 底模".into());
    }
    let custom_components = match (
        input
            .text_encoder_source_path
            .as_deref()
            .filter(|value| !value.is_empty()),
        input
            .vae_source_path
            .as_deref()
            .filter(|value| !value.is_empty()),
    ) {
        (None, None) => None,
        (Some(text_encoder), Some(vae)) => Some((text_encoder, vae)),
        _ => return Err("高级组件必须同时选择文本编码器和 VAE".into()),
    };

    let model_root = Path::new(&settings.model_root);
    validate_source(Path::new(&input.model_source_path))?;
    if let Some((text_encoder, vae)) = custom_components {
        validate_source(Path::new(text_encoder))?;
        validate_source(Path::new(vae))?;
    }
    let (text_encoder, vae) = match custom_components {
        Some((text_encoder, vae)) => (
            import_asset(Path::new(text_encoder), model_root, "text_encoders")?,
            import_asset(Path::new(vae), model_root, "vae")?,
        ),
        None => (
            signed_shared_component(model_root, "text_encoders", ANIMA_TEXT_ENCODER_FILE)?,
            signed_shared_component(model_root, "vae", ANIMA_VAE_FILE)?,
        ),
    };
    let model = import_asset(
        Path::new(&input.model_source_path),
        model_root,
        "diffusion_models",
    )?;
    Ok(LocalModelRegistration {
        display_name: display_name.into(),
        family: family.into(),
        workflow_kind: "anima".into(),
        model_file_name: model.file_name,
        model_relative_path: model.relative_path,
        model_sha256: model.sha256,
        byte_size: model.byte_size,
        model_modified_ms: model.modified_ms,
        text_encoder_file_name: Some(text_encoder.file_name),
        text_encoder_relative_path: Some(text_encoder.relative_path),
        text_encoder_sha256: Some(text_encoder.sha256),
        vae_file_name: Some(vae.file_name),
        vae_relative_path: Some(vae.relative_path),
        vae_sha256: Some(vae.sha256),
        resource_group_id: None,
        generation_profile_json: None,
    })
}

/** 网站 LoRA 使用目录声明的文件名与哈希在模型盘内原子落位，完成后不保留第二份下载。 */
pub fn install_website_lora(
    settings: &DesktopSettings,
    lora: &DesktopWebsiteLoraView,
    downloaded_path: &Path,
) -> Result<LocalLoraRegistration, String> {
    let asset = install_verified_asset(
        downloaded_path,
        Path::new(&settings.model_root),
        "loras",
        &lora.file_name,
        &lora.sha256,
        lora.byte_size,
    )?;
    Ok(LocalLoraRegistration {
        title: lora.title.clone(),
        r#type: lora.r#type.clone(),
        file_name: asset.file_name,
        relative_path: asset.relative_path,
        sha256: asset.sha256,
        base_model_sha256: None,
        byte_size: asset.byte_size,
        modified_ms: asset.modified_ms,
        trigger_words: lora.trigger_words.clone(),
    })
}

/** 把主站已经完成 SHA-256 校验的 Anima 底模原子安装，并复用目录声明的共享组件。 */
pub fn install_website_model(
    settings: &DesktopSettings,
    model: &DesktopWebsiteModelView,
    downloaded_path: &Path,
) -> Result<LocalModelRegistration, String> {
    if model.runtime_format != "anima" || model.family != "anima" {
        return Err("桌面端当前只支持安装 Anima 系列底模".into());
    }
    let download = model
        .download
        .as_ref()
        .ok_or_else(|| "网站底模缺少下载信息".to_string())?;
    let model_root = Path::new(&settings.model_root);
    // 先校验共享组件，缺失时保留已下载断点，用户补齐初始化依赖后无需重新下载底模。
    let text_encoder =
        existing_component(model_root, "text_encoders", &model.components.text_encoder)?;
    let vae = existing_component(model_root, "vae", &model.components.vae)?;
    let primary = install_verified_asset(
        downloaded_path,
        model_root,
        "diffusion_models",
        &download.file_name,
        &download.sha256,
        download.byte_size,
    )?;
    let generation_profile_json = serde_json::to_string(&model.parameters)
        .map_err(|error| format!("序列化底模生成参数失败：{error}"))?;
    Ok(LocalModelRegistration {
        display_name: model.display_name.clone(),
        family: model.family.clone(),
        workflow_kind: model.runtime_format.clone(),
        model_file_name: primary.file_name,
        model_relative_path: primary.relative_path,
        model_sha256: primary.sha256,
        byte_size: primary.byte_size,
        model_modified_ms: primary.modified_ms,
        text_encoder_file_name: Some(text_encoder.file_name),
        text_encoder_relative_path: Some(text_encoder.relative_path),
        text_encoder_sha256: Some(text_encoder.sha256),
        vae_file_name: Some(vae.file_name),
        vae_relative_path: Some(vae.relative_path),
        vae_sha256: Some(vae.sha256),
        resource_group_id: model.resource_group_id.clone(),
        generation_profile_json: Some(generation_profile_json),
    })
}

/** 校验目录声明的共享组件，禁止仅凭固定文件名把错误权重注册为可用模型。 */
fn existing_component(
    model_root: &Path,
    category: &str,
    component: &DesktopWebsiteModelComponent,
) -> Result<ImportedAsset, String> {
    validate_file_name(&component.file_name)?;
    let path = model_root.join(category).join(&component.file_name);
    validate_source(&path)
        .map_err(|error| format!("Anima 共享组件 {} 不可用：{error}", component.file_name))?;
    let sha256 = hash_file(&path)?;
    if sha256 != component.sha256 {
        return Err(format!(
            "Anima 共享组件 {} 的 SHA-256 与主站目录不一致",
            component.file_name
        ));
    }
    asset_from_existing(&path, category, sha256)
}

/** 默认共享组件必须来自资源安装器写入的哈希标记，禁止按固定文件名误用未知权重。 */
fn signed_shared_component(
    model_root: &Path,
    category: &str,
    file_name: &str,
) -> Result<ImportedAsset, String> {
    let path = model_root.join(category).join(file_name);
    let marker = path.with_file_name(format!("{file_name}.drawhime-resource.json"));
    let value = fs::read(&marker)
        .ok()
        .and_then(|content| serde_json::from_slice::<serde_json::Value>(&content).ok())
        .ok_or_else(|| format!("Anima 共享组件 {file_name} 尚未通过签名安装，请先完成初始化"))?;
    let expected = value
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .filter(|sha256| {
            sha256.len() == 64
                && sha256
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
        })
        .ok_or_else(|| format!("Anima 共享组件 {file_name} 的安装标记无效"))?;
    validate_source(&path)
        .map_err(|error| format!("Anima 共享组件 {file_name} 不可用：{error}"))?;
    let actual = hash_file(&path)?;
    if actual != expected.to_ascii_lowercase() {
        return Err(format!(
            "Anima 共享组件 {file_name} 的 SHA-256 与安装标记不一致"
        ));
    }
    asset_from_existing(&path, category, actual)
}

/** 在用户模型盘内提交已验证下载；同盘优先原子移动，避免复制 4GB 以上底模。 */
fn install_verified_asset(
    source: &Path,
    model_root: &Path,
    category: &str,
    file_name: &str,
    expected_sha256: &str,
    expected_bytes: u64,
) -> Result<ImportedAsset, String> {
    validate_file_name(file_name)?;
    validate_source(source)?;
    let metadata = source
        .metadata()
        .map_err(|error| format!("读取网站底模失败：{error}"))?;
    if metadata.len() != expected_bytes || hash_file(source)? != expected_sha256 {
        return Err("网站底模安装前校验与主站目录不一致".into());
    }
    let directory = model_root.join(category);
    fs::create_dir_all(&directory).map_err(|error| format!("创建底模安装目录失败：{error}"))?;
    let destination = collision_safe_destination(&directory, file_name, expected_sha256)?;
    if destination.exists() {
        fs::remove_file(source).map_err(|error| format!("清理重复底模下载缓存失败：{error}"))?;
    } else if let Err(rename_error) = fs::rename(source, &destination) {
        // 极少数自定义目录跨卷时使用校验复制，失败时保留原下载供重试。
        let temporary = directory.join(format!(".drawhime-install-{}.tmp", Uuid::new_v4()));
        let copied = copy_and_hash(source, &temporary);
        match copied {
            Ok((sha256, byte_size)) if sha256 == expected_sha256 && byte_size == expected_bytes => {
                fs::rename(&temporary, &destination)
                    .map_err(|error| format!("提交网站底模失败：{error}"))?;
                fs::remove_file(source)
                    .map_err(|error| format!("清理网站底模下载缓存失败：{error}"))?;
            }
            Ok(_) => {
                let _ = fs::remove_file(&temporary);
                return Err("复制后底模哈希发生变化".into());
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(format!("原子移动底模失败：{rename_error}；{error}"));
            }
        }
    }
    asset_from_existing(&destination, category, expected_sha256.to_owned())
}

fn asset_from_existing(
    path: &Path,
    category: &str,
    sha256: String,
) -> Result<ImportedAsset, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("读取已安装模型失败：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "已安装模型文件名不是有效 Unicode".to_string())?
        .to_owned();
    let modified_ms = metadata
        .modified()
        .map_err(|error| format!("读取模型修改时间失败：{error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "模型修改时间早于系统纪元".to_string())?
        .as_millis() as u64;
    Ok(ImportedAsset {
        file_name: file_name.clone(),
        relative_path: format!("{category}/{file_name}"),
        sha256,
        byte_size: metadata.len(),
        modified_ms,
    })
}

pub(crate) fn import_asset(
    source: &Path,
    model_root: &Path,
    category: &str,
) -> Result<ImportedAsset, String> {
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
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
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
    use crate::models::{
        DesktopWebsiteModelComponents, DesktopWebsiteModelDownload, DesktopWebsiteModelParameters,
        DesktopWebsiteModelPreset, DesktopWebsiteModelPresets,
    };

    #[test]
    fn anima_import_reuses_signed_components_and_registers_real_safetensors() {
        let temporary = tempfile::tempdir().expect("创建模型导入临时目录");
        let source = temporary.path().join("sample.safetensors");
        write_test_safetensors(&source);
        let settings = DesktopSettings {
            theme_mode: "system".into(),
            font_scale: 1.1,
            default_privacy: "private".into(),
            auto_upload: true,
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
        let model_root = Path::new(&settings.model_root);
        for (category, file_name) in [
            ("text_encoders", ANIMA_TEXT_ENCODER_FILE),
            ("vae", ANIMA_VAE_FILE),
        ] {
            let path = model_root.join(category).join(file_name);
            fs::create_dir_all(path.parent().expect("读取共享组件目录")).expect("创建共享组件目录");
            write_test_safetensors(&path);
            let sha256 = hash_file(&path).expect("计算共享组件哈希");
            fs::write(
                path.with_file_name(format!("{file_name}.drawhime-resource.json")),
                serde_json::to_vec(&serde_json::json!({ "sha256": sha256 }))
                    .expect("编码共享组件标记"),
            )
            .expect("写入共享组件标记");
        }
        let imported = import_local_model(
            &settings,
            DesktopLocalModelImportInput {
                display_name: "测试模型".into(),
                family: "anima".into(),
                workflow_kind: "anima".into(),
                model_source_path: source.to_string_lossy().into_owned(),
                text_encoder_source_path: None,
                vae_source_path: None,
            },
        )
        .expect("导入模型");
        assert_eq!(imported.workflow_kind, "anima");
        assert_eq!(
            imported.text_encoder_file_name.as_deref(),
            Some(ANIMA_TEXT_ENCODER_FILE)
        );
        assert_eq!(imported.vae_file_name.as_deref(), Some(ANIMA_VAE_FILE));
        assert!(Path::new(&settings.model_root)
            .join(imported.model_relative_path)
            .is_file());
        assert_eq!(imported.model_sha256.len(), 64);
    }

    #[test]
    fn website_anima_install_validates_components_and_is_idempotent() {
        let temporary = tempfile::tempdir().expect("创建网站底模安装测试目录");
        let settings = test_settings(temporary.path());
        let model_root = Path::new(&settings.model_root);
        fs::create_dir_all(model_root.join("text_encoders")).expect("创建文本编码器目录");
        fs::create_dir_all(model_root.join("vae")).expect("创建 VAE 目录");
        let text_encoder = model_root.join("text_encoders/qwen.safetensors");
        let vae = model_root.join("vae/anima-vae.safetensors");
        let downloaded = temporary.path().join("downloaded.safetensors");
        write_test_safetensors(&text_encoder);
        write_test_safetensors(&vae);
        write_test_safetensors(&downloaded);
        let primary_sha256 = hash_file(&downloaded).expect("计算底模哈希");
        let primary_bytes = downloaded.metadata().expect("读取底模大小").len();
        let model = website_model_fixture(
            primary_sha256.clone(),
            primary_bytes,
            hash_file(&text_encoder).expect("计算文本编码器哈希"),
            hash_file(&vae).expect("计算 VAE 哈希"),
        );
        let installed =
            install_website_model(&settings, &model, &downloaded).expect("安装网站底模");
        assert!(!downloaded.exists());
        assert!(model_root.join(&installed.model_relative_path).is_file());
        assert_eq!(installed.model_sha256, primary_sha256);
        assert!(installed.generation_profile_json.is_some());

        let duplicate = temporary.path().join("duplicate.safetensors");
        write_test_safetensors(&duplicate);
        let second =
            install_website_model(&settings, &model, &duplicate).expect("幂等安装同一底模");
        assert_eq!(second.model_relative_path, installed.model_relative_path);
        assert!(!duplicate.exists());

        let retained = temporary.path().join("retained.safetensors");
        write_test_safetensors(&retained);
        let mut invalid = model;
        invalid.components.text_encoder.sha256 = "0".repeat(64);
        assert!(install_website_model(&settings, &invalid, &retained).is_err());
        assert!(retained.exists());
    }

    /** 构造只包含当前在线目录字段的 Anima 模型，不依赖标题或文件名推断。 */
    fn website_model_fixture(
        model_sha256: String,
        model_bytes: u64,
        text_encoder_sha256: String,
        vae_sha256: String,
    ) -> DesktopWebsiteModelView {
        let preset = DesktopWebsiteModelPreset {
            steps: 12,
            aspect_adjusted_steps: 12,
            sampling_max_edge: 1024,
            sampling_pixel_budget: 1_048_576,
        };
        DesktopWebsiteModelView {
            id: Uuid::new_v4().to_string(),
            display_name: "测试在线 Anima".into(),
            description: "测试".into(),
            family: "anima".into(),
            family_name: "Anima".into(),
            model_file_name: "online-anima.safetensors".into(),
            resource_group_id: None,
            download: Some(DesktopWebsiteModelDownload {
                file_name: "online-anima.safetensors".into(),
                sha256: model_sha256,
                byte_size: model_bytes,
                content_url: "/v1/model-library/test/download".into(),
            }),
            components: DesktopWebsiteModelComponents {
                text_encoder: DesktopWebsiteModelComponent {
                    file_name: "qwen.safetensors".into(),
                    sha256: text_encoder_sha256,
                },
                vae: DesktopWebsiteModelComponent {
                    file_name: "anima-vae.safetensors".into(),
                    sha256: vae_sha256,
                },
            },
            runtime_format: "anima".into(),
            usage_guide: "测试".into(),
            source_links: Vec::new(),
            parameters: DesktopWebsiteModelParameters {
                steps: 12,
                cfg: 1.0,
                sampler: "euler_ancestral".into(),
                scheduler: "normal".into(),
                sampling_max_edge: 1024,
                sampling_pixel_budget: 1_048_576,
                aspect_step_threshold: 1.5,
                max_edge: 1536,
                quality_prefix: "best quality".into(),
                default_negative_prompt: "low quality".into(),
                training_supported: false,
                available_samplers: vec!["euler_ancestral".into()],
                available_schedulers: vec!["normal".into()],
                presets: DesktopWebsiteModelPresets {
                    fast: preset.clone(),
                    quality: preset.clone(),
                    extreme: preset,
                },
            },
            cover_path: None,
            example_paths: Vec::new(),
        }
    }

    /** 网站安装测试使用隔离目录，避免读取真实用户设置。 */
    fn test_settings(root: &Path) -> DesktopSettings {
        DesktopSettings {
            theme_mode: "system".into(),
            font_scale: 1.1,
            default_privacy: "private".into(),
            auto_upload: false,
            model_root: root.join("models").to_string_lossy().into_owned(),
            output_root: root.join("outputs").to_string_lossy().into_owned(),
            runtime_root: root.join("runtime").to_string_lossy().into_owned(),
            upload_concurrency: 1,
            wifi_only: false,
            bandwidth_limit_kib: None,
        }
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
