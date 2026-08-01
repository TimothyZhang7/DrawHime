//! 本模块负责训练集文件夹与压缩包的安全预检、受控暂存和确认导入。

use crate::{
    models::{
        DesktopTrainingDatasetImportAnomaly, DesktopTrainingDatasetImportInput,
        DesktopTrainingDatasetImportPreview, DesktopTrainingDatasetImportPreviewInput,
        DesktopTrainingDatasetView,
    },
    training_dataset::{self, TrainingImportAsset},
};
use chrono::{Duration as ChronoDuration, Utc};
use flate2::read::GzDecoder;
use image::{ImageFormat, ImageReader};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};
use tar::Archive as TarArchive;
use uuid::Uuid;
use zip::ZipArchive;

const PREVIEW_TTL_HOURS: i64 = 24;
const MAX_ARCHIVE_ENTRIES: usize = 2_000;
const MAX_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_LABEL_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DATASET_ASSETS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportManifest {
    preview: DesktopTrainingDatasetImportPreview,
    assets: Vec<ManifestAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestAsset {
    relative_path: String,
    staged_relative_path: String,
    sha256: String,
    byte_size: u64,
    width: u32,
    height: u32,
    caption: Option<String>,
}

/** 复制或安全解压用户来源，并返回不会写入训练集数据库的预检快照。 */
pub fn preview_import(
    app_data_dir: &Path,
    input: DesktopTrainingDatasetImportPreviewInput,
) -> Result<DesktopTrainingDatasetImportPreview, String> {
    cleanup_expired_previews(app_data_dir)?;
    let source = PathBuf::from(input.source_path.trim());
    let metadata =
        fs::symlink_metadata(&source).map_err(|_| "所选训练集目录或压缩包不存在".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("训练集来源不能是软链接".into());
    }
    let source_kind = detect_source_kind(&source, &metadata)?;
    let preview_id = Uuid::new_v4().to_string();
    let preview_root = preview_root(app_data_dir, &preview_id);
    let content_root = preview_root.join("content");
    fs::create_dir_all(&content_root)
        .map_err(|error| format!("创建训练集预检目录失败：{error}"))?;
    let extraction = match source_kind.as_str() {
        "folder" => copy_folder_safely(&source, &content_root),
        "zip" => extract_zip_safely(&source, &content_root),
        "7z" => extract_7z_safely(&source, &content_root),
        "tar" => extract_tar_safely(
            File::open(&source).map_err(|error| format!("打开 TAR 失败：{error}"))?,
            &content_root,
        ),
        "tar_gz" => extract_tar_safely(
            GzDecoder::new(
                File::open(&source).map_err(|error| format!("打开 TAR.GZ 失败：{error}"))?,
            ),
            &content_root,
        ),
        _ => Err("训练集来源格式不受支持".into()),
    };
    if let Err(error) = extraction {
        let _ = fs::remove_dir_all(&preview_root);
        return Err(error);
    }
    let source_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("训练集")
        .to_string();
    let suggested_title = suggested_title(&source_name);
    let manifest = inspect_staged_content(
        &preview_id,
        &source_name,
        &source_kind,
        &suggested_title,
        &content_root,
    )?;
    write_manifest(&preview_root, &manifest)?;
    Ok(manifest.preview)
}

/** 复核预检快照后原子创建训练集，成功后才删除临时目录。 */
pub fn commit_import(
    database: &mut Connection,
    app_data_dir: &Path,
    input: DesktopTrainingDatasetImportInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.preview_id, "训练集预检 ID")?;
    let root = preview_root(app_data_dir, &input.preview_id);
    let manifest = read_manifest(&root)?;
    if manifest.preview.id != input.preview_id {
        return Err("训练集预检清单与请求不一致".into());
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&manifest.preview.expires_at)
        .map_err(|_| "训练集预检有效期损坏".to_string())?;
    if expires_at < Utc::now() {
        return Err("训练集预检已过期，请重新选择来源".into());
    }
    if !manifest.preview.can_import {
        return Err("训练集预检仍有阻断异常，不能导入".into());
    }
    let content_root = root.join("content");
    let mut assets = Vec::with_capacity(manifest.assets.len());
    for asset in manifest.assets {
        let source = content_root.join(&asset.staged_relative_path);
        if !source.starts_with(&content_root)
            || source.metadata().map(|value| value.len()).ok() != Some(asset.byte_size)
            || sha256_file(&source)? != asset.sha256
        {
            return Err(format!("训练集预检文件已变化：{}", asset.relative_path));
        }
        assets.push(TrainingImportAsset {
            source_path: source,
            original_file_name: Path::new(&asset.relative_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("training-image")
                .to_string(),
            caption: asset.caption,
            tags: None,
        });
    }
    let result = training_dataset::import_dataset_snapshot(database, app_data_dir, input, assets)?;
    fs::remove_dir_all(&root).map_err(|error| format!("清理训练集预检目录失败：{error}"))?;
    Ok(result)
}

fn detect_source_kind(source: &Path, metadata: &fs::Metadata) -> Result<String, String> {
    if metadata.is_dir() {
        return Ok("folder".into());
    }
    if !metadata.is_file() {
        return Err("训练集来源必须是普通文件夹或压缩包".into());
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        Ok("tar_gz".into())
    } else if name.ends_with(".zip") {
        Ok("zip".into())
    } else if name.ends_with(".7z") {
        Ok("7z".into())
    } else if name.ends_with(".tar") {
        Ok("tar".into())
    } else {
        Err("训练集压缩包仅支持 ZIP、7Z、TAR、TAR.GZ 和 TGZ".into())
    }
}

fn copy_folder_safely(source: &Path, destination: &Path) -> Result<(), String> {
    let canonical_source = source
        .canonicalize()
        .map_err(|error| format!("读取训练集目录失败：{error}"))?;
    let mut files = Vec::new();
    collect_folder_files(&canonical_source, &canonical_source, &mut files)?;
    if files.len() > MAX_ARCHIVE_ENTRIES {
        return Err("训练集目录文件数量超过 2000 个".into());
    }
    let mut total = 0_u64;
    for (path, relative) in files {
        let size = path
            .metadata()
            .map_err(|error| format!("读取训练集文件失败：{error}"))?
            .len();
        accumulate_expanded_bytes(&mut total, size, "训练集目录")?;
        if !is_relevant_file(&relative) {
            continue;
        }
        validate_entry_size(&relative, size)?;
        copy_file_limited(&path, &destination.join(relative), size)?;
    }
    Ok(())
}

fn collect_folder_files(
    root: &Path,
    current: &Path,
    output: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("读取训练集目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取训练集目录项失败：{error}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("读取训练集目录项失败：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "训练集目录包含软链接：{}",
                entry.file_name().to_string_lossy()
            ));
        }
        let canonical = entry
            .path()
            .canonicalize()
            .map_err(|error| format!("解析训练集路径失败：{error}"))?;
        if !canonical.starts_with(root) {
            return Err("训练集目录项越过所选目录".into());
        }
        if metadata.is_dir() {
            collect_folder_files(root, &canonical, output)?;
        } else if metadata.is_file() {
            let relative = canonical
                .strip_prefix(root)
                .map_err(|_| "训练集路径不受控".to_string())?
                .to_path_buf();
            validate_relative_path(&relative)?;
            output.push((canonical, relative));
        }
    }
    Ok(())
}

fn extract_zip_safely(source: &Path, destination: &Path) -> Result<(), String> {
    let mut archive =
        ZipArchive::new(File::open(source).map_err(|error| format!("打开 ZIP 失败：{error}"))?)
            .map_err(|error| format!("读取 ZIP 失败：{error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("训练集 ZIP 文件数量超过 2000 个".into());
    }
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 ZIP 项失败：{error}"))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("训练集 ZIP 包含链接文件".into());
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "训练集 ZIP 包含路径穿越项".to_string())?;
        validate_relative_path(&relative)?;
        accumulate_expanded_bytes(&mut total, entry.size(), "训练集 ZIP")?;
        if entry.is_dir() || !is_relevant_file(&relative) {
            continue;
        }
        // ZIP 条目读取需要独占可变借用，因此先固化归档声明的大小。
        let entry_size = entry.size();
        validate_entry_size(&relative, entry_size)?;
        write_reader_limited(&mut entry, &destination.join(relative), entry_size)?;
    }
    Ok(())
}

fn extract_7z_safely(source: &Path, destination: &Path) -> Result<(), String> {
    let archive = sevenz_rust::Archive::open(source)
        .map_err(|error| format!("读取训练集 7Z 失败：{error}"))?;
    if archive.files.len() > MAX_ARCHIVE_ENTRIES {
        return Err("训练集 7Z 文件数量超过 2000 个".into());
    }
    let mut total = 0_u64;
    for entry in &archive.files {
        // sevenz-rust 会用空名称 anti 目录表示来源目录根节点，它没有数据且不会落盘。
        if is_7z_root_marker(entry) {
            continue;
        }
        validate_7z_entry(entry)?;
        accumulate_expanded_bytes(&mut total, entry.size(), "训练集 7Z")?;
    }
    let mut count = 0_usize;
    sevenz_rust::decompress_file_with_extract_fn(source, destination, |entry, reader, _| {
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(sevenz_rust::Error::other("训练集 7Z 文件数量超过限制"));
        }
        if is_7z_root_marker(entry) {
            return Ok(true);
        }
        let relative = validate_7z_entry(entry).map_err(sevenz_rust::Error::other)?;
        if entry.is_directory() || !is_relevant_file(&relative) {
            return Ok(true);
        }
        validate_entry_size(&relative, entry.size()).map_err(sevenz_rust::Error::other)?;
        write_reader_limited(reader, &destination.join(relative), entry.size())
            .map_err(sevenz_rust::Error::other)?;
        Ok(true)
    })
    .map_err(|error| format!("解压训练集 7Z 失败：{error}"))
}

/** 识别 7Z 编码器用于表示来源目录本身、不会产生文件的空根标记。 */
fn is_7z_root_marker(entry: &sevenz_rust::SevenZArchiveEntry) -> bool {
    entry.name().is_empty()
        && entry.is_directory()
        && entry.is_anti_item()
        && !entry.has_stream()
        && entry.size() == 0
}

fn validate_7z_entry(entry: &sevenz_rust::SevenZArchiveEntry) -> Result<PathBuf, String> {
    let attributes = entry.windows_attributes();
    let unix_mode = attributes >> 16;
    if entry.is_anti_item() || attributes & 0x400 != 0 || unix_mode & 0o170000 == 0o120000 {
        return Err("训练集 7Z 包含链接或删除条目".into());
    }
    let relative = PathBuf::from(
        entry
            .name()
            .trim_end_matches(['/', '\\'])
            .replace('\\', "/"),
    );
    validate_relative_path(&relative)?;
    Ok(relative)
}

fn extract_tar_safely<R: Read>(reader: R, destination: &Path) -> Result<(), String> {
    let mut archive = TarArchive::new(reader);
    let mut count = 0_usize;
    let mut total = 0_u64;
    for item in archive
        .entries()
        .map_err(|error| format!("读取 TAR 目录失败：{error}"))?
    {
        let mut entry = item.map_err(|error| format!("读取 TAR 项失败：{error}"))?;
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err("训练集 TAR 文件数量超过 2000 个".into());
        }
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            return Err("训练集 TAR 包含链接或特殊文件".into());
        }
        let relative = entry
            .path()
            .map_err(|error| format!("读取 TAR 路径失败：{error}"))?
            .to_path_buf();
        validate_relative_path(&relative)?;
        let size = entry
            .header()
            .size()
            .map_err(|error| format!("读取 TAR 文件大小失败：{error}"))?;
        accumulate_expanded_bytes(&mut total, size, "训练集 TAR")?;
        if kind.is_dir() || !is_relevant_file(&relative) {
            continue;
        }
        validate_entry_size(&relative, size)?;
        write_reader_limited(&mut entry, &destination.join(relative), size)?;
    }
    Ok(())
}

fn inspect_staged_content(
    id: &str,
    source_name: &str,
    source_kind: &str,
    suggested_title: &str,
    content_root: &Path,
) -> Result<ImportManifest, String> {
    let mut paths = Vec::new();
    collect_staged_files(content_root, content_root, &mut paths)?;
    let mut images: HashMap<String, PathBuf> = HashMap::new();
    let mut labels: HashMap<String, PathBuf> = HashMap::new();
    let mut anomalies = Vec::new();
    for relative in paths {
        let key = pairing_key(&relative)?;
        if is_image_path(&relative) {
            if images.insert(key, relative.clone()).is_some() {
                anomalies.push(anomaly(
                    "duplicate_image",
                    "error",
                    &relative,
                    "同一目录存在同名的多张图片",
                ));
            }
        } else if is_label_path(&relative) {
            if labels.insert(key, relative.clone()).is_some() {
                anomalies.push(anomaly(
                    "invalid_label_encoding",
                    "error",
                    &relative,
                    "同一图片存在重复标签文件",
                ));
            }
        }
    }
    // 标签编码必须独立校验，不能因对应图片稍后被内容去重而遗漏阻断异常。
    let mut label_values = HashMap::new();
    for (key, label_path) in &labels {
        match read_caption(&content_root.join(label_path)) {
            Ok(value) => {
                label_values.insert(key.clone(), value);
            }
            Err(message) => {
                anomalies.push(anomaly(
                    "invalid_label_encoding",
                    "error",
                    label_path,
                    &message,
                ));
            }
        }
    }
    let mut assets = Vec::new();
    let mut paired = 0_u32;
    let mut untagged = 0_u32;
    let mut seen_hashes = HashSet::new();
    let mut ordered_images = images.into_iter().collect::<Vec<_>>();
    ordered_images.sort_by(|left, right| left.1.cmp(&right.1));
    for (key, relative) in ordered_images {
        let full = content_root.join(&relative);
        let inspected = inspect_image(&full);
        let (sha256, byte_size, width, height) = match inspected {
            Ok(value) => value,
            Err(message) => {
                anomalies.push(anomaly("invalid_image", "error", &relative, &message));
                continue;
            }
        };
        if !seen_hashes.insert(sha256.clone()) {
            anomalies.push(anomaly(
                "duplicate_image",
                "warning",
                &relative,
                "图片内容与本次导入中的其他图片重复，将只保留一份",
            ));
            continue;
        }
        let caption = if labels.remove(&key).is_some() {
            if let Some(value) = label_values.remove(&key) {
                paired += 1;
                value
            } else {
                None
            }
        } else {
            untagged += 1;
            None
        };
        assets.push(ManifestAsset {
            relative_path: path_text(&relative),
            staged_relative_path: path_text(&relative),
            sha256,
            byte_size,
            width,
            height,
            caption,
        });
    }
    for (_, label) in labels {
        anomalies.push(anomaly(
            "orphan_label",
            "warning",
            &label,
            "没有找到同名图片，标签文件不会导入",
        ));
    }
    if assets.is_empty() {
        anomalies.push(anomaly(
            "limit_exceeded",
            "error",
            Path::new(""),
            "没有发现可导入的 PNG、JPEG 或 WebP 图片",
        ));
    } else if assets.len() > MAX_DATASET_ASSETS {
        anomalies.push(anomaly(
            "limit_exceeded",
            "error",
            Path::new(""),
            "训练集图片数量超过 200 张",
        ));
    }
    anomalies.truncate(500);
    let error_count = anomalies
        .iter()
        .filter(|item| item.severity == "error")
        .count();
    let preview = DesktopTrainingDatasetImportPreview {
        id: id.into(),
        source_name: source_name.into(),
        source_kind: source_kind.into(),
        suggested_title: suggested_title.into(),
        image_count: assets.len() as u32,
        paired_tag_count: paired,
        untagged_count: untagged,
        anomaly_count: anomalies.len() as u32,
        can_import: error_count == 0 && !assets.is_empty() && assets.len() <= MAX_DATASET_ASSETS,
        anomalies,
        expires_at: (Utc::now() + ChronoDuration::hours(PREVIEW_TTL_HOURS)).to_rfc3339(),
    };
    Ok(ImportManifest { preview, assets })
}

fn collect_staged_files(
    root: &Path,
    current: &Path,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("读取预检目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取预检文件失败：{error}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("读取预检文件失败：{error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("预检目录出现链接文件".into());
        }
        if metadata.is_dir() {
            collect_staged_files(root, &entry.path(), output)?;
        } else if metadata.is_file() {
            output.push(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| "预检路径不受控".to_string())?
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}

fn inspect_image(path: &Path) -> Result<(String, u64, u32, u32), String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("读取图片失败：{error}"))?;
    validate_entry_size(path, metadata.len())?;
    let reader = ImageReader::open(path)
        .map_err(|error| format!("打开图片失败：{error}"))?
        .with_guessed_format()
        .map_err(|error| format!("识别图片格式失败：{error}"))?;
    let format = reader
        .format()
        .ok_or_else(|| "图片格式不可识别".to_string())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("图片内容不是 PNG、JPEG 或 WebP".into());
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("图片内容损坏：{error}"))?;
    if width < 32 || height < 32 || width > 16_384 || height > 16_384 {
        return Err("图片尺寸必须在 32–16384 像素范围内".into());
    }
    Ok((sha256_file(path)?, metadata.len(), width, height))
}

fn read_caption(path: &Path) -> Result<Option<String>, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("读取标签文件失败：{error}"))?;
    if metadata.len() > MAX_LABEL_BYTES {
        return Err("标签文件超过 1 MiB".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("读取标签文件失败：{error}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "标签文件不是 UTF-8 编码".to_string())?;
    let mut seen = HashSet::new();
    let tags = text
        .split([',', '，', '\n', '\r', ';', '；'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.to_lowercase()))
        .collect::<Vec<_>>();
    let caption = tags.join(", ");
    if caption.chars().count() > 10_000 {
        return Err("标签内容超过 10000 个字符".into());
    }
    Ok((!caption.is_empty()).then_some(caption))
}

fn validate_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("训练集包含空路径或绝对路径".into());
    }
    for component in path.components() {
        let Component::Normal(value) = component else {
            return Err("训练集包含路径穿越项".into());
        };
        let value = value.to_string_lossy();
        if value.is_empty() || value.contains(':') || value.contains('\0') || value.len() > 255 {
            return Err("训练集包含 Windows 不安全路径".into());
        }
    }
    Ok(())
}

fn validate_entry_size(path: &Path, size: u64) -> Result<(), String> {
    if size == 0 {
        return Err(format!("训练集文件为空：{}", path.display()));
    }
    let limit = if is_label_path(path) {
        MAX_LABEL_BYTES
    } else {
        MAX_IMAGE_BYTES
    };
    if size > limit {
        return Err(format!("训练集文件超过大小限制：{}", path.display()));
    }
    Ok(())
}

/** 累计归档声明大小，统一阻断整数溢出和超过 2 GiB 的解压炸弹。 */
fn accumulate_expanded_bytes(total: &mut u64, size: u64, label: &str) -> Result<(), String> {
    *total = total
        .checked_add(size)
        .ok_or_else(|| format!("{label} 解压大小溢出"))?;
    if *total > MAX_EXPANDED_BYTES {
        return Err(format!("{label} 解压内容超过 2 GiB"));
    }
    Ok(())
}

fn is_relevant_file(path: &Path) -> bool {
    is_image_path(path) || is_label_path(path)
}
fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp"
            )
        })
}
fn is_label_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("txt"))
}

fn pairing_key(path: &Path) -> Result<String, String> {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "训练集文件名不是有效 UTF-8".to_string())?;
    Ok(format!(
        "{}/{}",
        path_text(parent).to_lowercase(),
        stem.to_lowercase()
    ))
}

fn suggested_title(source_name: &str) -> String {
    let lower = source_name.to_ascii_lowercase();
    let stripped = [".tar.gz", ".tgz", ".zip", ".7z", ".tar"]
        .into_iter()
        .find(|suffix| lower.ends_with(suffix))
        .map(|suffix| &source_name[..source_name.len() - suffix.len()])
        .unwrap_or(source_name)
        .trim();
    if stripped.is_empty() {
        "导入训练集".into()
    } else {
        stripped.chars().take(191).collect()
    }
}

fn copy_file_limited(source: &Path, destination: &Path, size: u64) -> Result<(), String> {
    let mut reader = File::open(source).map_err(|error| format!("打开训练集文件失败：{error}"))?;
    write_reader_limited(&mut reader, destination, size)
}

fn write_reader_limited<R: Read + ?Sized>(
    reader: &mut R,
    destination: &Path,
    expected_size: u64,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建预检目录失败：{error}"))?;
    }
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| format!("创建预检文件失败：{error}"))?;
    let written = std::io::copy(
        &mut reader.take(expected_size.saturating_add(1)),
        &mut output,
    )
    .map_err(|error| format!("暂存训练集文件失败：{error}"))?;
    if written != expected_size {
        let _ = fs::remove_file(destination);
        return Err("训练集文件长度与归档声明不一致".into());
    }
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("同步预检文件失败：{error}"))
}

fn write_manifest(root: &Path, manifest: &ImportManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("生成训练集预检清单失败：{error}"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("训练集预检清单超过限制".into());
    }
    let temporary = root.join("manifest.json.tmp");
    let final_path = root.join("manifest.json");
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("创建预检清单失败：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("保存预检清单失败：{error}"))?;
    fs::rename(temporary, final_path).map_err(|error| format!("提交预检清单失败：{error}"))
}

fn read_manifest(root: &Path) -> Result<ImportManifest, String> {
    let path = root.join("manifest.json");
    let metadata = path
        .metadata()
        .map_err(|_| "训练集预检不存在，请重新选择来源".to_string())?;
    if metadata.len() == 0 || metadata.len() > MAX_MANIFEST_BYTES {
        return Err("训练集预检清单大小异常".into());
    }
    serde_json::from_reader(BufReader::new(
        File::open(path).map_err(|error| format!("打开预检清单失败：{error}"))?,
    ))
    .map_err(|error| format!("读取预检清单失败：{error}"))
}

fn cleanup_expired_previews(app_data_dir: &Path) -> Result<(), String> {
    let root = app_data_dir.join("import-previews");
    fs::create_dir_all(&root).map_err(|error| format!("创建预检根目录失败：{error}"))?;
    for entry in fs::read_dir(&root).map_err(|error| format!("读取预检根目录失败：{error}"))?
    {
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let expired = metadata
            .modified()
            .ok()
            .and_then(|value| SystemTime::now().duration_since(value).ok())
            .is_some_and(|age| age > Duration::from_secs((PREVIEW_TTL_HOURS as u64 + 1) * 3600));
        if metadata.is_dir() && expired {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

fn anomaly(
    code: &str,
    severity: &str,
    path: &Path,
    message: &str,
) -> DesktopTrainingDatasetImportAnomaly {
    DesktopTrainingDatasetImportAnomaly {
        code: code.into(),
        severity: severity.into(),
        path: path_text(path),
        message: message.into(),
    }
}
fn preview_root(app_data_dir: &Path, id: &str) -> PathBuf {
    app_data_dir.join("import-previews").join(id)
}
fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{label} 不正确"))
}
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut reader =
        BufReader::new(File::open(path).map_err(|error| format!("读取训练集文件失败：{error}"))?);
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("校验训练集文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{models::DesktopTrainingDatasetImportInput, storage::DesktopState};
    use flate2::{write::GzEncoder, Compression};
    use image::{Rgb, RgbImage};
    use std::io::Cursor;
    use tar::{Builder as TarBuilder, Header as TarHeader};
    use zip::{write::SimpleFileOptions, ZipWriter};

    /** 创建包含一张已打标图片和一张未打标图片的通用训练集目录。 */
    fn create_dataset_source(root: &Path) -> PathBuf {
        let source = root.join("source-dataset");
        fs::create_dir_all(&source).expect("创建训练集来源目录");
        RgbImage::from_pixel(64, 64, Rgb([20, 40, 60]))
            .save(source.join("image_001.png"))
            .expect("写入第一张测试图片");
        RgbImage::from_pixel(64, 64, Rgb([80, 100, 120]))
            .save(source.join("image_002.webp"))
            .expect("写入第二张测试图片");
        fs::write(
            source.join("image_001.txt"),
            "test_character, 1girl, TEST_CHARACTER",
        )
        .expect("写入测试标签");
        source
    }

    /** 把通用训练集写成真实 ZIP，供正式预检入口读取。 */
    fn create_zip(source: &Path, destination: &Path) {
        let file = File::create(destination).expect("创建 ZIP");
        let mut writer = ZipWriter::new(file);
        for name in ["image_001.png", "image_001.txt", "image_002.webp"] {
            writer
                .start_file(name, SimpleFileOptions::default())
                .expect("创建 ZIP 项");
            writer
                .write_all(&fs::read(source.join(name)).expect("读取 ZIP 来源"))
                .expect("写入 ZIP 项");
        }
        writer.finish().expect("完成 ZIP");
    }

    /** 把通用训练集写成 TAR 或 GZip TAR，覆盖 tar、tar.gz 与 tgz。 */
    fn create_tar(source: &Path, destination: &Path, gzip: bool) {
        let file = File::create(destination).expect("创建 TAR");
        if gzip {
            let encoder = GzEncoder::new(file, Compression::default());
            let mut builder = TarBuilder::new(encoder);
            builder
                .append_dir_all("dataset", source)
                .expect("写入压缩 TAR");
            builder
                .into_inner()
                .expect("完成压缩 TAR")
                .finish()
                .expect("完成 GZip");
        } else {
            let mut builder = TarBuilder::new(file);
            builder.append_dir_all("dataset", source).expect("写入 TAR");
            builder.finish().expect("完成 TAR");
        }
    }

    /** 所有正式声明格式必须通过同一个安全预检并得到一致统计。 */
    #[test]
    fn supported_sources_are_really_previewed() {
        let temporary = tempfile::tempdir().expect("创建导入测试目录");
        let source = create_dataset_source(temporary.path());
        let zip_path = temporary.path().join("dataset.zip");
        let seven_z_path = temporary.path().join("dataset.7z");
        let tar_path = temporary.path().join("dataset.tar");
        let tar_gz_path = temporary.path().join("dataset.tar.gz");
        let tgz_path = temporary.path().join("dataset.tgz");
        create_zip(&source, &zip_path);
        sevenz_rust::compress_to_path(&source, &seven_z_path).expect("创建 7Z");
        create_tar(&source, &tar_path, false);
        create_tar(&source, &tar_gz_path, true);
        create_tar(&source, &tgz_path, true);

        let cases = [
            (source, "folder"),
            (zip_path, "zip"),
            (seven_z_path, "7z"),
            (tar_path, "tar"),
            (tar_gz_path, "tar_gz"),
            (tgz_path, "tar_gz"),
        ];
        for (index, (path, kind)) in cases.into_iter().enumerate() {
            let app_data = temporary.path().join(format!("app-data-{index}"));
            let preview = preview_import(
                &app_data,
                DesktopTrainingDatasetImportPreviewInput {
                    source_path: path.to_string_lossy().into_owned(),
                },
            )
            .unwrap_or_else(|error| panic!("{kind} 预检失败：{error}"));
            assert_eq!(preview.source_kind, kind);
            assert_eq!(preview.image_count, 2);
            assert_eq!(preview.paired_tag_count, 1);
            assert_eq!(preview.untagged_count, 1);
            assert!(preview.can_import);
        }
    }

    /** 正式导入只写受管目录，保留用户来源并同步 UUID 同名标签文件。 */
    #[test]
    fn confirmed_import_persists_image_caption_and_source() {
        let temporary = tempfile::tempdir().expect("创建确认导入测试目录");
        let source = create_dataset_source(temporary.path());
        let original_image = fs::read(source.join("image_001.png")).expect("读取原图片");
        let state =
            DesktopState::initialize(&temporary.path().join("app-data")).expect("初始化桌面状态");
        let preview = preview_import(
            &state.app_data_dir,
            DesktopTrainingDatasetImportPreviewInput {
                source_path: source.to_string_lossy().into_owned(),
            },
        )
        .expect("预检训练集");
        let imported = {
            let mut database = state.database.lock().expect("锁定训练集数据库");
            commit_import(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingDatasetImportInput {
                    preview_id: preview.id,
                    title: "导入测试".into(),
                    r#type: "character".into(),
                    trigger_words: vec!["test_character".into()],
                },
            )
            .expect("确认导入训练集")
        };
        assert_eq!(imported.assets.len(), 2);
        let tagged = imported
            .assets
            .iter()
            .find(|asset| asset.file_name == "image_001.png")
            .expect("找到已打标图片");
        assert_eq!(tagged.caption_source.as_deref(), Some("imported"));
        assert_eq!(
            tagged
                .tags
                .iter()
                .map(|tag| (tag.value.as_str(), tag.source.as_str()))
                .collect::<Vec<_>>(),
            vec![("test_character", "trigger"), ("1girl", "imported")]
        );
        assert_eq!(
            fs::read_to_string(Path::new(&tagged.path).with_extension("txt"))
                .expect("读取受管标签"),
            "test_character, 1girl"
        );
        assert_eq!(
            fs::read(source.join("image_001.png")).expect("重新读取原图片"),
            original_image
        );
        assert!(source.join("image_001.txt").is_file());
    }

    /** 可恢复异常作为告警展示，损坏图片和编码错误必须阻断导入。 */
    #[test]
    fn preview_reports_dataset_anomalies_without_mutating_source() {
        let temporary = tempfile::tempdir().expect("创建异常预检目录");
        let source = temporary.path().join("anomaly-source");
        fs::create_dir_all(&source).expect("创建异常来源目录");
        RgbImage::from_pixel(64, 64, Rgb([1, 2, 3]))
            .save(source.join("valid.png"))
            .expect("写入有效图片");
        fs::copy(source.join("valid.png"), source.join("duplicate.webp")).expect("写入重复图片");
        fs::write(source.join("orphan.txt"), "orphan_tag").expect("写入孤立标签");
        fs::write(source.join("valid.txt"), [0xff, 0xfe]).expect("写入非法编码标签");
        fs::write(source.join("broken.png"), "not an image").expect("写入损坏图片");
        let preview = preview_import(
            &temporary.path().join("app-data"),
            DesktopTrainingDatasetImportPreviewInput {
                source_path: source.to_string_lossy().into_owned(),
            },
        )
        .expect("异常应进入预检结果");
        assert!(!preview.can_import);
        for code in [
            "duplicate_image",
            "orphan_label",
            "invalid_label_encoding",
            "invalid_image",
        ] {
            assert!(
                preview.anomalies.iter().any(|item| item.code == code),
                "缺少异常：{code}"
            );
        }
        assert!(source.join("valid.png").is_file());
        assert!(source.join("valid.txt").is_file());
    }

    /** 路径穿越、归档链接和解压炸弹在写入预检目录前被拒绝。 */
    #[test]
    fn unsafe_archives_and_expanded_size_are_rejected() {
        assert!(validate_relative_path(Path::new("../escape.png")).is_err());
        let mut total = MAX_EXPANDED_BYTES;
        assert!(accumulate_expanded_bytes(&mut total, 1, "测试归档").is_err());
        let mut overflow = u64::MAX;
        assert!(accumulate_expanded_bytes(&mut overflow, 1, "测试归档").is_err());

        let temporary = tempfile::tempdir().expect("创建恶意归档测试目录");
        let zip_path = temporary.path().join("traversal.zip");
        let mut zip = ZipWriter::new(File::create(&zip_path).expect("创建恶意 ZIP"));
        zip.start_file("../escape.png", SimpleFileOptions::default())
            .expect("写入穿越 ZIP 项");
        zip.write_all(b"escape").expect("写入穿越内容");
        zip.finish().expect("完成恶意 ZIP");
        let zip_error = preview_import(
            &temporary.path().join("zip-app-data"),
            DesktopTrainingDatasetImportPreviewInput {
                source_path: zip_path.to_string_lossy().into_owned(),
            },
        )
        .expect_err("路径穿越 ZIP 必须失败");
        assert!(zip_error.contains("路径穿越"));

        let tar_path = temporary.path().join("link.tar");
        let mut builder = TarBuilder::new(File::create(&tar_path).expect("创建链接 TAR"));
        let mut header = TarHeader::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_cksum();
        builder
            .append_link(&mut header, "dataset/link.png", "../escape.png")
            .expect("写入 TAR 链接");
        builder.finish().expect("完成链接 TAR");
        let tar_error = preview_import(
            &temporary.path().join("tar-app-data"),
            DesktopTrainingDatasetImportPreviewInput {
                source_path: tar_path.to_string_lossy().into_owned(),
            },
        )
        .expect_err("链接 TAR 必须失败");
        assert!(tar_error.contains("链接或特殊文件"));
        assert!(!temporary.path().join("escape.png").exists());
    }

    /** 长度不匹配时删除半成品，避免损坏文件留在预检目录。 */
    #[test]
    fn limited_writer_removes_partial_file() {
        let temporary = tempfile::tempdir().expect("创建流写入测试目录");
        let destination = temporary.path().join("partial.bin");
        let mut reader = Cursor::new(vec![1_u8, 2, 3]);
        assert!(write_reader_limited(&mut reader, &destination, 4).is_err());
        assert!(!destination.exists());
    }
}
