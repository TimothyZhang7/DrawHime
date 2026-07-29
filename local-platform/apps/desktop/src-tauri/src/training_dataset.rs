//! 本模块管理本地 LoRA 训练集、真实图片原子导入、逐图 Caption 与人工确认门禁。

use crate::models::{
    DesktopTrainingAssetView, DesktopTrainingCaptionUpdateInput,
    DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetView, DesktopTrainingImagesAddInput,
};
use chrono::Utc;
use image::{ImageFormat, ImageReader};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_DATASET_ASSETS: usize = 200;
const MIN_CONFIRMED_ASSETS: u64 = 5;
const MAX_IMAGE_BYTES: u64 = 100 * 1024 * 1024;

struct StagedAsset {
    id: String,
    file_name: String,
    temporary_path: PathBuf,
    final_path: PathBuf,
    relative_path: String,
    sha256: String,
    byte_size: u64,
    width: u32,
    height: u32,
}

/** 创建角色、画风或概念训练集并立即返回持久化视图。 */
pub fn create_dataset(database: &Connection, input: DesktopTrainingDatasetCreateInput) -> Result<DesktopTrainingDatasetView, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 191 { return Err("训练集标题长度必须是 1–191 个字符".into()); }
    if !matches!(input.r#type.as_str(), "character" | "style" | "concept") { return Err("训练集类型不正确".into()); }
    let trigger_words = validate_trigger_words(input.trigger_words)?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let trigger_words_json = serde_json::to_string(&trigger_words).map_err(|error| format!("序列化训练触发词失败：{error}"))?;
    database.execute("INSERT INTO local_training_datasets (id,title,type,trigger_words_json,status,created_at,updated_at) VALUES (?1,?2,?3,?4,'draft',?5,?5)", params![id,title,input.r#type,trigger_words_json,now]).map_err(|error| format!("创建本地训练集失败：{error}"))?;
    read_dataset(database, &id)?.ok_or_else(|| "训练集创建后不存在".into())
}

/** 返回当前设备全部训练集和逐图 Caption，新的训练集优先。 */
pub fn list_datasets(database: &Connection, app_data_dir: &Path) -> Result<Vec<DesktopTrainingDatasetView>, String> {
    let mut statement = database.prepare("SELECT id,title,type,trigger_words_json,status,created_at,updated_at FROM local_training_datasets ORDER BY updated_at DESC").map_err(|error| format!("读取本地训练集失败：{error}"))?;
    let rows = statement.query_map([], dataset_from_row).map_err(|error| format!("查询本地训练集失败：{error}"))?;
    let mut datasets = rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析本地训练集失败：{error}"))?;
    for dataset in &mut datasets { dataset.assets = read_assets(database, app_data_dir, &dataset.id)?; }
    Ok(datasets)
}

/** 原子导入多张真实图片；任一文件失败时本批次不产生半完成数据库记录。 */
pub fn add_images(database: &mut Connection, app_data_dir: &Path, input: DesktopTrainingImagesAddInput) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    if input.source_paths.is_empty() || input.source_paths.len() > MAX_DATASET_ASSETS { return Err("每次必须选择 1–200 张训练图片".into()); }
    let exists: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM local_training_datasets WHERE id=?1)", [&input.dataset_id], |row| row.get(0)).map_err(|error| format!("读取训练集失败：{error}"))?;
    if !exists { return Err("训练集不存在".into()); }
    let current_count: usize = database.query_row("SELECT COUNT(*) FROM local_training_assets WHERE dataset_id=?1", [&input.dataset_id], |row| row.get(0)).map_err(|error| format!("统计训练图片失败：{error}"))?;
    let existing_hashes = dataset_hashes(database, &input.dataset_id)?;
    let dataset_root = app_data_dir.join("datasets").join(&input.dataset_id);
    fs::create_dir_all(&dataset_root).map_err(|error| format!("创建训练集目录失败：{error}"))?;
    let mut staged = Vec::new();
    let mut batch_hashes = HashSet::new();
    for source_path in input.source_paths {
        match stage_asset(Path::new(&source_path), &dataset_root, &input.dataset_id) {
            Ok(asset) if existing_hashes.contains(&asset.sha256) || !batch_hashes.insert(asset.sha256.clone()) => { let _ = fs::remove_file(asset.temporary_path); }
            Ok(asset) => staged.push(asset),
            Err(error) => { cleanup_staged(&staged); return Err(error); }
        }
    }
    if current_count + staged.len() > MAX_DATASET_ASSETS { cleanup_staged(&staged); return Err("训练集图片总数不能超过 200 张".into()); }
    if staged.is_empty() { return read_dataset_with_assets(database, app_data_dir, &input.dataset_id); }
    let transaction = database.transaction().map_err(|error| { cleanup_staged(&staged); format!("开启训练图片事务失败：{error}") })?;
    let now = Utc::now().to_rfc3339();
    let mut committed_files = Vec::new();
    for asset in &staged {
        if let Err(error) = fs::rename(&asset.temporary_path, &asset.final_path) { cleanup_staged(&staged); cleanup_paths(&committed_files); return Err(format!("原子提交训练图片失败：{error}")); }
        committed_files.push(asset.final_path.clone());
        if let Err(error) = transaction.execute("INSERT INTO local_training_assets (id,dataset_id,file_name,relative_path,sha256,byte_size,width,height,caption,confirmed,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,0,?9,?9)", params![asset.id,input.dataset_id,asset.file_name,asset.relative_path,asset.sha256,asset.byte_size,asset.width,asset.height,now]) { cleanup_paths(&committed_files); return Err(format!("登记训练图片失败：{error}")); }
    }
    transaction.execute("UPDATE local_training_assets SET confirmed=0,updated_at=?2 WHERE dataset_id=?1", params![input.dataset_id,now]).and_then(|_| transaction.execute("UPDATE local_training_datasets SET status='draft',updated_at=?2 WHERE id=?1", params![input.dataset_id,now])).map_err(|error| { cleanup_paths(&committed_files); format!("重置训练集确认状态失败：{error}") })?;
    if let Err(error) = transaction.commit() { cleanup_paths(&committed_files); return Err(format!("提交训练图片事务失败：{error}")); }
    read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 保存单图 Caption，并按全量图片是否有描述重新计算确认前状态。 */
pub fn update_caption(database: &Connection, app_data_dir: &Path, input: DesktopTrainingCaptionUpdateInput) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.asset_id, "训练图片 ID")?;
    let caption = input.caption.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
    if caption.as_ref().is_some_and(|value| value.chars().count() > 10_000) { return Err("单张图片 Caption 不能超过 10000 个字符".into()); }
    let now = Utc::now().to_rfc3339();
    let transaction = database.unchecked_transaction().map_err(|error| format!("开启 Caption 事务失败：{error}"))?;
    if transaction.execute("UPDATE local_training_assets SET caption=?3,caption_source='manual',confirmed=0,updated_at=?4 WHERE id=?1 AND dataset_id=?2", params![input.asset_id,input.dataset_id,caption,now]).map_err(|error| format!("保存图片 Caption 失败：{error}"))? != 1 { return Err("训练图片不存在".into()); }
    transaction.execute("UPDATE local_training_assets SET confirmed=0 WHERE dataset_id=?1", [&input.dataset_id]).map_err(|error| format!("重置图片确认状态失败：{error}"))?;
    update_dataset_review_status(&transaction, &input.dataset_id, &now)?;
    transaction.commit().map_err(|error| format!("提交 Caption 事务失败：{error}"))?;
    read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 全量校验图片数量和 Caption 后确认训练集，后续训练参数页只能读取该终态。 */
pub fn confirm_dataset(database: &Connection, app_data_dir: &Path, dataset_id: &str) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(dataset_id, "训练集 ID")?;
    let (count, missing): (u64, u64) = database.query_row("SELECT COUNT(*),COALESCE(SUM(CASE WHEN caption IS NULL OR TRIM(caption)='' THEN 1 ELSE 0 END),0) FROM local_training_assets WHERE dataset_id=?1", [dataset_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|error| format!("校验训练集失败：{error}"))?;
    if !(MIN_CONFIRMED_ASSETS..=MAX_DATASET_ASSETS as u64).contains(&count) { return Err("确认训练集需要 5–200 张图片".into()); }
    if missing > 0 { return Err(format!("仍有 {missing} 张图片缺少 Caption")); }
    let mut unavailable = 0_usize;
    for asset in read_assets(database, app_data_dir, dataset_id)? {
        if !asset.available || sha256_file(Path::new(&asset.path)).ok().as_deref() != Some(asset.sha256.as_str()) { unavailable += 1; }
    }
    if unavailable > 0 { return Err(format!("仍有 {unavailable} 张训练图片文件缺失或已变化")); }
    let now = Utc::now().to_rfc3339();
    let transaction = database.unchecked_transaction().map_err(|error| format!("开启训练集确认事务失败：{error}"))?;
    transaction.execute("UPDATE local_training_assets SET confirmed=1,updated_at=?2 WHERE dataset_id=?1", params![dataset_id,now]).and_then(|_| transaction.execute("UPDATE local_training_datasets SET status='confirmed',updated_at=?2 WHERE id=?1", params![dataset_id,now])).map_err(|error| format!("确认训练集失败：{error}"))?;
    transaction.commit().map_err(|error| format!("提交训练集确认事务失败：{error}"))?;
    read_dataset_with_assets(database, app_data_dir, dataset_id)
}

fn read_dataset_with_assets(database: &Connection, app_data_dir: &Path, id: &str) -> Result<DesktopTrainingDatasetView, String> {
    let mut dataset = read_dataset(database, id)?.ok_or_else(|| "训练集不存在".to_string())?;
    dataset.assets = read_assets(database, app_data_dir, id)?;
    Ok(dataset)
}

fn read_dataset(database: &Connection, id: &str) -> Result<Option<DesktopTrainingDatasetView>, String> {
    database.query_row("SELECT id,title,type,trigger_words_json,status,created_at,updated_at FROM local_training_datasets WHERE id=?1", [id], dataset_from_row).optional().map_err(|error| format!("读取训练集失败：{error}"))
}

fn dataset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DesktopTrainingDatasetView> {
    let trigger_words_json: String = row.get(3)?;
    let trigger_words = serde_json::from_str(&trigger_words_json).map_err(|error| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error)))?;
    Ok(DesktopTrainingDatasetView { id: row.get(0)?, title: row.get(1)?, r#type: row.get(2)?, trigger_words, status: row.get(4)?, assets: Vec::new(), created_at: row.get(5)?, updated_at: row.get(6)? })
}

fn read_assets(database: &Connection, app_data_dir: &Path, dataset_id: &str) -> Result<Vec<DesktopTrainingAssetView>, String> {
    let mut statement = database.prepare("SELECT id,file_name,relative_path,sha256,byte_size,width,height,caption,caption_source,confirmed,created_at,updated_at FROM local_training_assets WHERE dataset_id=?1 ORDER BY created_at ASC,id ASC").map_err(|error| format!("读取训练图片失败：{error}"))?;
    let rows = statement.query_map([dataset_id], |row| { let relative_path: String = row.get(2)?; let path = app_data_dir.join(relative_path); let byte_size: u64 = row.get(4)?; let available = path.metadata().ok().is_some_and(|metadata| metadata.is_file() && metadata.len() == byte_size); Ok(DesktopTrainingAssetView { id: row.get(0)?, file_name: row.get(1)?, path: path.to_string_lossy().into_owned(), sha256: row.get(3)?, byte_size, width: row.get(5)?, height: row.get(6)?, available, caption: row.get(7)?, caption_source: row.get(8)?, confirmed: row.get::<_, i64>(9)? != 0, created_at: row.get(10)?, updated_at: row.get(11)? }) }).map_err(|error| format!("查询训练图片失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("解析训练图片失败：{error}"))
}

fn stage_asset(source: &Path, dataset_root: &Path, dataset_id: &str) -> Result<StagedAsset, String> {
    let metadata = source.metadata().map_err(|_| "所选训练图片不存在".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES { return Err("训练图片必须是 1B–100MiB 的普通文件".into()); }
    let reader = ImageReader::open(source).map_err(|error| format!("读取训练图片失败：{error}"))?.with_guessed_format().map_err(|error| format!("识别训练图片格式失败：{error}"))?;
    let format = reader.format().ok_or_else(|| "训练图片格式不可识别".to_string())?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP) { return Err("训练图片仅支持 PNG、JPEG 和 WebP".into()); }
    let (width, height) = reader.into_dimensions().map_err(|error| format!("读取训练图片尺寸失败：{error}"))?;
    if width < 32 || height < 32 || width > 16_384 || height > 16_384 { return Err("训练图片尺寸必须在 32–16384 像素范围内".into()); }
    let extension = match format { ImageFormat::Png => "png", ImageFormat::Jpeg => "jpg", ImageFormat::WebP => "webp", _ => unreachable!() };
    let id = Uuid::new_v4().to_string();
    let temporary_path = dataset_root.join(format!(".{id}.importing"));
    let final_path = dataset_root.join(format!("{id}.{extension}"));
    let (copied, sha256) = copy_asset_bytes(source, &temporary_path, metadata.len())?;
    let file_name = source.file_name().and_then(|value| value.to_str()).filter(|value| !value.trim().is_empty()).unwrap_or("training-image").chars().take(255).collect();
    Ok(StagedAsset { id: id.clone(), file_name, temporary_path, final_path, relative_path: format!("datasets/{dataset_id}/{id}.{extension}"), sha256, byte_size: copied, width, height })
}

/** 流式复制并计算哈希，任意失败都会清理未完成临时文件。 */
fn copy_asset_bytes(source: &Path, temporary_path: &Path, expected_size: u64) -> Result<(u64, String), String> {
    let outcome = (|| {
        let source_file = File::open(source).map_err(|error| format!("打开训练图片失败：{error}"))?;
        let mut reader = BufReader::new(source_file);
        let mut output = OpenOptions::new().create_new(true).write(true).open(temporary_path).map_err(|error| format!("创建训练图片临时文件失败：{error}"))?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 1024 * 1024];
        loop { let read = reader.read(&mut buffer).map_err(|error| format!("读取训练图片失败：{error}"))?; if read == 0 { break; } output.write_all(&buffer[..read]).map_err(|error| format!("写入训练图片失败：{error}"))?; hasher.update(&buffer[..read]); copied += read as u64; }
        output.flush().and_then(|_| output.sync_all()).map_err(|error| format!("同步训练图片失败：{error}"))?;
        if copied != expected_size { return Err("训练图片复制期间发生变化".into()); }
        Ok((copied, hex::encode(hasher.finalize())))
    })();
    if outcome.is_err() { let _ = fs::remove_file(temporary_path); }
    outcome
}

fn dataset_hashes(database: &Connection, dataset_id: &str) -> Result<HashSet<String>, String> {
    let mut statement = database.prepare("SELECT sha256 FROM local_training_assets WHERE dataset_id=?1").map_err(|error| format!("读取训练图片哈希失败：{error}"))?;
    let rows = statement.query_map([dataset_id], |row| row.get(0)).map_err(|error| format!("查询训练图片哈希失败：{error}"))?;
    rows.collect::<Result<HashSet<_>, _>>().map_err(|error| format!("解析训练图片哈希失败：{error}"))
}

/** 确认训练集时重新计算完整哈希，防止同尺寸文件替换绕过门禁。 */
fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("读取训练图片失败：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop { let read = reader.read(&mut buffer).map_err(|error| format!("校验训练图片失败：{error}"))?; if read == 0 { break; } hasher.update(&buffer[..read]); }
    Ok(hex::encode(hasher.finalize()))
}

fn update_dataset_review_status(database: &Connection, dataset_id: &str, now: &str) -> Result<(), String> {
    let (count, missing): (u64, u64) = database.query_row("SELECT COUNT(*),COALESCE(SUM(CASE WHEN caption IS NULL OR TRIM(caption)='' THEN 1 ELSE 0 END),0) FROM local_training_assets WHERE dataset_id=?1", [dataset_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|error| format!("统计 Caption 状态失败：{error}"))?;
    let status = if count >= MIN_CONFIRMED_ASSETS && missing == 0 { "review_ready" } else { "draft" };
    database.execute("UPDATE local_training_datasets SET status=?2,updated_at=?3 WHERE id=?1", params![dataset_id,status,now]).map_err(|error| format!("更新训练集阶段失败：{error}"))?;
    Ok(())
}

fn validate_trigger_words(words: Vec<String>) -> Result<Vec<String>, String> {
    if words.len() > 50 || words.iter().any(|word| word.trim().is_empty() || word.trim().chars().count() > 100) { return Err("训练触发词最多 50 个，每个长度必须是 1–100 个字符".into()); }
    let mut seen = HashSet::new();
    Ok(words.into_iter().map(|word| word.trim().to_owned()).filter(|word| seen.insert(word.to_lowercase())).collect())
}

fn validate_uuid(value: &str, label: &str) -> Result<(), String> { Uuid::parse_str(value).map(|_| ()).map_err(|_| format!("{label} 不正确")) }
fn cleanup_staged(assets: &[StagedAsset]) { for asset in assets { let _ = fs::remove_file(&asset.temporary_path); } }
fn cleanup_paths(paths: &[PathBuf]) { for path in paths { let _ = fs::remove_file(path); } }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::DesktopState;
    use image::{Rgb, RgbImage};

    #[test]
    fn dataset_images_and_captions_persist_through_confirmation_gate() {
        let temporary = tempfile::tempdir().expect("创建训练集测试目录");
        let state = DesktopState::initialize(temporary.path(), temporary.path()).expect("初始化桌面状态");
        let dataset = state.create_training_dataset(DesktopTrainingDatasetCreateInput { title: "测试角色".into(), r#type: "character".into(), trigger_words: vec!["dh_test".into()] }).expect("创建训练集");
        let mut source_paths = Vec::new();
        for (index, extension) in ["png", "jpg", "webp", "png", "jpg"].iter().enumerate() {
            let path = temporary.path().join(format!("source-{index}.{extension}"));
            RgbImage::from_pixel(64, 64, Rgb([index as u8, 40, 80])).save(&path).expect("写入测试图片");
            source_paths.push(path.to_string_lossy().into_owned());
        }
        let imported = {
            let mut database = state.database.lock().expect("锁定训练集数据库");
            add_images(&mut database, &state.app_data_dir, DesktopTrainingImagesAddInput { dataset_id: dataset.id.clone(), source_paths: source_paths.clone() }).expect("导入训练图片")
        };
        assert_eq!(imported.assets.len(), 5);
        assert!(source_paths.iter().all(|path| Path::new(path).is_file()));
        for asset in &imported.assets {
            state.update_training_caption(DesktopTrainingCaptionUpdateInput { dataset_id: dataset.id.clone(), asset_id: asset.id.clone(), caption: Some("dh_test, 1girl, solo".into()) }).expect("保存 Caption");
        }
        let missing_bytes = fs::read(&imported.assets[0].path).expect("读取待模拟缺失的训练图片");
        fs::remove_file(&imported.assets[0].path).expect("模拟训练图片缺失");
        {
            let database = state.database.lock().expect("锁定训练集数据库");
            assert!(confirm_dataset(&database, &state.app_data_dir, &dataset.id).is_err());
        }
        fs::write(&imported.assets[0].path, missing_bytes).expect("恢复训练图片");
        let confirmed = {
            let database = state.database.lock().expect("锁定训练集数据库");
            confirm_dataset(&database, &state.app_data_dir, &dataset.id).expect("确认训练集")
        };
        assert_eq!(confirmed.status, "confirmed");
        assert!(confirmed.assets.iter().all(|asset| asset.confirmed && asset.caption.is_some()));
        let restored = state.list_training_datasets().expect("恢复训练集");
        assert_eq!(restored[0].assets.len(), 5);
        assert_eq!(restored[0].status, "confirmed");
    }
}
