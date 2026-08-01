//! 本模块管理本地 LoRA 训练集、真实图片原子导入、逐图 Caption 与人工确认门禁。

use crate::models::{
    DesktopTrainingAssetDeleteInput, DesktopTrainingAssetDerivativeView, DesktopTrainingAssetView,
    DesktopTrainingBatchTagsInput, DesktopTrainingCaptionUpdateInput,
    DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetIdInput,
    DesktopTrainingDatasetImportInput, DesktopTrainingDatasetView, DesktopTrainingImagesAddInput,
    DesktopTrainingTriggerWordsUpdateInput,
};
use crate::training_files::{
    finalize_caption_file, finalize_caption_files, rollback_caption_file, rollback_caption_files,
    stage_caption_file,
};
use crate::training_tags;
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

/** 安全预检模块交给训练集存储层的单张不可变来源。 */
pub(crate) struct TrainingImportAsset {
    pub source_path: PathBuf,
    pub original_file_name: String,
    pub caption: Option<String>,
    pub tags: Option<Vec<training_tags::TrainingTag>>,
}

struct StagedImportAsset {
    asset: StagedAsset,
    caption: Option<String>,
    tags: Vec<training_tags::TrainingTag>,
    label_temporary_path: Option<PathBuf>,
    label_final_path: Option<PathBuf>,
}

/** 创建角色、画风或概念训练集并立即返回持久化视图。 */
pub fn create_dataset(
    database: &Connection,
    input: DesktopTrainingDatasetCreateInput,
) -> Result<DesktopTrainingDatasetView, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 191 {
        return Err("训练集标题长度必须是 1–191 个字符".into());
    }
    if !matches!(
        input.r#type.as_str(),
        "character" | "style" | "object" | "concept"
    ) {
        return Err("训练集类型不正确".into());
    }
    let trigger_words = validate_trigger_words(input.trigger_words)?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let trigger_words_json = serde_json::to_string(&trigger_words)
        .map_err(|error| format!("序列化训练触发词失败：{error}"))?;
    database.execute("INSERT INTO local_training_datasets (id,title,type,trigger_words_json,status,created_at,updated_at) VALUES (?1,?2,?3,?4,'draft',?5,?5)", params![id,title,input.r#type,trigger_words_json,now]).map_err(|error| format!("创建本地训练集失败：{error}"))?;
    read_dataset(database, &id)?.ok_or_else(|| "训练集创建后不存在".into())
}

/** 把已通过安全预检的图片与同名标签作为一个事务创建成新训练集。 */
pub(crate) fn import_dataset_snapshot(
    database: &mut Connection,
    app_data_dir: &Path,
    input: DesktopTrainingDatasetImportInput,
    assets: Vec<TrainingImportAsset>,
) -> Result<DesktopTrainingDatasetView, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 191 {
        return Err("训练集标题长度必须是 1–191 个字符".into());
    }
    if !matches!(
        input.r#type.as_str(),
        "character" | "style" | "object" | "concept"
    ) {
        return Err("训练集类型不正确".into());
    }
    if assets.is_empty() || assets.len() > MAX_DATASET_ASSETS {
        return Err("训练集图片数量必须是 1–200 张".into());
    }
    let trigger_words = validate_trigger_words(input.trigger_words)?;
    let dataset_id = Uuid::new_v4().to_string();
    let dataset_root = app_data_dir.join("datasets").join(&dataset_id);
    fs::create_dir_all(&dataset_root).map_err(|error| format!("创建训练集目录失败：{error}"))?;
    let mut staged = Vec::with_capacity(assets.len());
    let mut hashes = HashSet::new();
    for source in assets {
        let normalized_tags = match source.tags {
            Some(tags) => training_tags::reconcile_trigger_tags(&tags, &trigger_words),
            None => {
                training_tags::initial_tags(source.caption.as_deref(), "imported", &trigger_words)
            }
        };
        let normalized_tags = match normalized_tags {
            Ok(tags) => tags,
            Err(error) => {
                cleanup_import_staged(&staged);
                let _ = fs::remove_dir(&dataset_root);
                return Err(error);
            }
        };
        let normalized_caption = training_tags::caption_from_tags(&normalized_tags);
        let mut asset = match stage_asset(&source.source_path, &dataset_root, &dataset_id) {
            Ok(asset) => asset,
            Err(error) => {
                cleanup_import_staged(&staged);
                let _ = fs::remove_dir(&dataset_root);
                return Err(error);
            }
        };
        if !hashes.insert(asset.sha256.clone()) {
            let _ = fs::remove_file(&asset.temporary_path);
            cleanup_import_staged(&staged);
            let _ = fs::remove_dir(&dataset_root);
            return Err("训练集预检快照包含重复图片".into());
        }
        asset.file_name = source.original_file_name.chars().take(255).collect();
        let (label_temporary_path, label_final_path) =
            if let Some(caption) = normalized_caption.as_deref() {
                let temporary = dataset_root.join(format!(".{}.txt.importing", asset.id));
                let final_path = dataset_root.join(format!("{}.txt", asset.id));
                if let Err(error) = write_caption_file(&temporary, caption) {
                    let _ = fs::remove_file(&asset.temporary_path);
                    cleanup_import_staged(&staged);
                    let _ = fs::remove_dir(&dataset_root);
                    return Err(error);
                }
                (Some(temporary), Some(final_path))
            } else {
                (None, None)
            };
        staged.push(StagedImportAsset {
            asset,
            caption: normalized_caption,
            tags: normalized_tags,
            label_temporary_path,
            label_final_path,
        });
    }
    let transaction = database.transaction().map_err(|error| {
        cleanup_import_staged(&staged);
        let _ = fs::remove_dir(&dataset_root);
        format!("开启训练集导入事务失败：{error}")
    })?;
    let now = Utc::now().to_rfc3339();
    let trigger_words_json = serde_json::to_string(&trigger_words)
        .map_err(|error| format!("序列化训练触发词失败：{error}"))?;
    let status = if staged.len() >= MIN_CONFIRMED_ASSETS as usize
        && staged.iter().all(|item| {
            item.caption
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        }) {
        "review_ready"
    } else {
        "draft"
    };
    transaction.execute("INSERT INTO local_training_datasets (id,title,type,trigger_words_json,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)", params![dataset_id,title,input.r#type,trigger_words_json,status,now]).map_err(|error| {
        cleanup_import_staged(&staged);
        let _ = fs::remove_dir(&dataset_root);
        format!("创建导入训练集失败：{error}")
    })?;
    let mut committed = Vec::new();
    for item in &staged {
        if let Err(error) = fs::rename(&item.asset.temporary_path, &item.asset.final_path) {
            cleanup_import_staged(&staged);
            cleanup_paths(&committed);
            let _ = fs::remove_dir(&dataset_root);
            return Err(format!("提交训练图片失败：{error}"));
        }
        committed.push(item.asset.final_path.clone());
        if let (Some(temporary), Some(final_path)) =
            (&item.label_temporary_path, &item.label_final_path)
        {
            if let Err(error) = fs::rename(temporary, final_path) {
                cleanup_import_staged(&staged);
                cleanup_paths(&committed);
                let _ = fs::remove_dir(&dataset_root);
                return Err(format!("提交训练标签失败：{error}"));
            }
            committed.push(final_path.clone());
        }
        if let Err(error) = transaction.execute("INSERT INTO local_training_assets (id,dataset_id,file_name,relative_path,sha256,byte_size,width,height,caption,caption_source,confirmed,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?11)", params![item.asset.id,dataset_id,item.asset.file_name,item.asset.relative_path,item.asset.sha256,item.asset.byte_size,item.asset.width,item.asset.height,item.caption,item.caption.as_ref().map(|_| "imported"),now]) {
            cleanup_import_staged(&staged);
            cleanup_paths(&committed);
            let _ = fs::remove_dir(&dataset_root);
            return Err(format!("登记导入训练图片失败：{error}"));
        }
        if let Err(error) = training_tags::replace_tags(
            &transaction,
            &item.asset.id,
            &item.tags,
            "import",
            Some("从通用训练集同名标签文件导入"),
            &now,
        ) {
            cleanup_import_staged(&staged);
            cleanup_paths(&committed);
            let _ = fs::remove_dir(&dataset_root);
            return Err(error);
        }
    }
    if let Err(error) = transaction.commit() {
        cleanup_paths(&committed);
        let _ = fs::remove_dir(&dataset_root);
        return Err(format!("提交训练集导入事务失败：{error}"));
    }
    read_dataset_with_assets(database, app_data_dir, &dataset_id)
}

/** 返回当前设备全部训练集和逐图 Caption，新的训练集优先。 */
pub fn list_datasets(
    database: &Connection,
    app_data_dir: &Path,
) -> Result<Vec<DesktopTrainingDatasetView>, String> {
    let mut statement = database.prepare("SELECT id,title,type,trigger_words_json,status,created_at,updated_at FROM local_training_datasets WHERE deleted_at IS NULL ORDER BY updated_at DESC").map_err(|error| format!("读取本地训练集失败：{error}"))?;
    let rows = statement
        .query_map([], dataset_from_row)
        .map_err(|error| format!("查询本地训练集失败：{error}"))?;
    let mut datasets = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析本地训练集失败：{error}"))?;
    for dataset in &mut datasets {
        dataset.assets = read_assets(database, app_data_dir, &dataset.id)?;
    }
    Ok(datasets)
}

/** 更新训练集触发词并原子同步每张图片的 TRIGGER 标签和同名 Caption 文件。 */
pub fn update_trigger_words(
    database: &Connection,
    app_data_dir: &Path,
    input: DesktopTrainingTriggerWordsUpdateInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    let trigger_words = validate_trigger_words(input.trigger_words)?;
    let trigger_words_json = serde_json::to_string(&trigger_words)
        .map_err(|error| format!("序列化训练触发词失败：{error}"))?;
    let exists: bool = database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM local_training_datasets WHERE id=?1 AND deleted_at IS NULL)",
            [&input.dataset_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取训练集失败：{error}"))?;
    if !exists {
        return Err("训练集不存在".into());
    }
    let asset_paths = {
        let mut statement = database.prepare("SELECT id,relative_path FROM local_training_assets WHERE dataset_id=?1 ORDER BY created_at ASC,id ASC").map_err(|error| format!("读取触发词同步图片失败：{error}"))?;
        let paths = statement
            .query_map([&input.dataset_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("查询触发词同步图片失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析触发词同步图片失败：{error}"))?;
        paths
    };
    let dataset_root = app_data_dir.join("datasets").join(&input.dataset_id);
    let mut desired = Vec::with_capacity(asset_paths.len());
    for (asset_id, relative_path) in asset_paths {
        let current = training_tags::read_tags(database, &asset_id)?;
        let tags = training_tags::reconcile_trigger_tags(&current, &trigger_words)?;
        let caption = training_tags::caption_from_tags(&tags);
        let source = training_tags::aggregate_source(&tags);
        let image_path = app_data_dir.join(relative_path);
        if !image_path.starts_with(&dataset_root) {
            return Err("训练图片存储路径不受控".into());
        }
        desired.push((asset_id, image_path, tags, caption, source));
    }
    let mut file_swaps = Vec::with_capacity(desired.len());
    for (_, image_path, _, caption, _) in &desired {
        match stage_caption_file(&dataset_root, image_path, caption.as_deref()) {
            Ok(swap) => file_swaps.push(swap),
            Err(error) => {
                rollback_caption_files(file_swaps);
                return Err(error);
            }
        }
    }
    let now = Utc::now().to_rfc3339();
    let outcome = (|| {
        let transaction = database
            .unchecked_transaction()
            .map_err(|error| format!("开启触发词同步事务失败：{error}"))?;
        if transaction
        .execute(
            "UPDATE local_training_datasets SET trigger_words_json=?2,updated_at=?3 WHERE id=?1",
            params![input.dataset_id, trigger_words_json, now],
        )
        .map_err(|error| format!("更新训练触发词失败：{error}"))?
        != 1
        {
            return Err("训练集不存在".into());
        }
        for (asset_id, _, tags, caption, source) in &desired {
            training_tags::replace_tags(
                &transaction,
                asset_id,
                tags,
                "trigger_sync",
                Some("训练集触发词更新"),
                &now,
            )?;
            transaction.execute("UPDATE local_training_assets SET caption=?2,caption_source=?3,confirmed=0,updated_at=?4 WHERE id=?1", params![asset_id,caption,source,now]).map_err(|error| format!("同步训练图片触发词失败：{error}"))?;
        }
        update_dataset_review_status(&transaction, &input.dataset_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("提交触发词同步事务失败：{error}"))
    })();
    if let Err(error) = outcome {
        rollback_caption_files(file_swaps);
        return Err(error);
    }
    finalize_caption_files(file_swaps);
    read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 原子导入多张真实图片；任一文件失败时本批次不产生半完成数据库记录。 */
pub fn add_images(
    database: &mut Connection,
    app_data_dir: &Path,
    input: DesktopTrainingImagesAddInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    if input.source_paths.is_empty() || input.source_paths.len() > MAX_DATASET_ASSETS {
        return Err("每次必须选择 1–200 张训练图片".into());
    }
    let exists: bool = database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM local_training_datasets WHERE id=?1 AND deleted_at IS NULL)",
            [&input.dataset_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取训练集失败：{error}"))?;
    if !exists {
        return Err("训练集不存在".into());
    }
    let current_count: usize = database
        .query_row(
            "SELECT COUNT(*) FROM local_training_assets WHERE dataset_id=?1",
            [&input.dataset_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("统计训练图片失败：{error}"))?;
    let existing_hashes = dataset_hashes(database, &input.dataset_id)?;
    let dataset_root = app_data_dir.join("datasets").join(&input.dataset_id);
    fs::create_dir_all(&dataset_root).map_err(|error| format!("创建训练集目录失败：{error}"))?;
    let mut staged = Vec::new();
    let mut batch_hashes = HashSet::new();
    for source_path in input.source_paths {
        match stage_asset(Path::new(&source_path), &dataset_root, &input.dataset_id) {
            Ok(asset)
                if existing_hashes.contains(&asset.sha256)
                    || !batch_hashes.insert(asset.sha256.clone()) =>
            {
                let _ = fs::remove_file(asset.temporary_path);
            }
            Ok(asset) => staged.push(asset),
            Err(error) => {
                cleanup_staged(&staged);
                return Err(error);
            }
        }
    }
    if current_count + staged.len() > MAX_DATASET_ASSETS {
        cleanup_staged(&staged);
        return Err("训练集图片总数不能超过 200 张".into());
    }
    if staged.is_empty() {
        return read_dataset_with_assets(database, app_data_dir, &input.dataset_id);
    }
    let transaction = database.transaction().map_err(|error| {
        cleanup_staged(&staged);
        format!("开启训练图片事务失败：{error}")
    })?;
    let now = Utc::now().to_rfc3339();
    let mut committed_files = Vec::new();
    for asset in &staged {
        if let Err(error) = fs::rename(&asset.temporary_path, &asset.final_path) {
            cleanup_staged(&staged);
            cleanup_paths(&committed_files);
            return Err(format!("原子提交训练图片失败：{error}"));
        }
        committed_files.push(asset.final_path.clone());
        if let Err(error) = transaction.execute("INSERT INTO local_training_assets (id,dataset_id,file_name,relative_path,sha256,byte_size,width,height,caption,confirmed,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,0,?9,?9)", params![asset.id,input.dataset_id,asset.file_name,asset.relative_path,asset.sha256,asset.byte_size,asset.width,asset.height,now]) { cleanup_paths(&committed_files); return Err(format!("登记训练图片失败：{error}")); }
    }
    transaction
        .execute(
            "UPDATE local_training_assets SET confirmed=0,updated_at=?2 WHERE dataset_id=?1",
            params![input.dataset_id, now],
        )
        .and_then(|_| {
            transaction.execute(
                "UPDATE local_training_datasets SET status='draft',updated_at=?2 WHERE id=?1",
                params![input.dataset_id, now],
            )
        })
        .map_err(|error| {
            cleanup_paths(&committed_files);
            format!("重置训练集确认状态失败：{error}")
        })?;
    if let Err(error) = transaction.commit() {
        cleanup_paths(&committed_files);
        return Err(format!("提交训练图片事务失败：{error}"));
    }
    read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 保存单图 Caption，并按全量图片是否有描述重新计算确认前状态。 */
pub fn update_caption(
    database: &Connection,
    app_data_dir: &Path,
    input: DesktopTrainingCaptionUpdateInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.asset_id, "训练图片 ID")?;
    if input
        .caption
        .as_ref()
        .is_some_and(|value| value.chars().count() > 10_000)
    {
        return Err("单张图片 Caption 不能超过 10000 个字符".into());
    }
    let (relative_path, trigger_words_json): (String, String) = database
        .query_row(
            "SELECT asset.relative_path,dataset.trigger_words_json FROM local_training_assets asset JOIN local_training_datasets dataset ON dataset.id=asset.dataset_id WHERE asset.id=?1 AND asset.dataset_id=?2",
            params![input.asset_id, input.dataset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("读取训练图片路径失败：{error}"))?
        .ok_or_else(|| "训练图片不存在".to_string())?;
    let trigger_words = serde_json::from_str::<Vec<String>>(&trigger_words_json)
        .map_err(|error| format!("解析训练集触发词失败：{error}"))?;
    let current_tags = training_tags::read_tags(database, &input.asset_id)?;
    let tags = training_tags::reconcile_manual_tags(
        &current_tags,
        input.caption.as_deref(),
        &trigger_words,
    )?;
    let caption = training_tags::caption_from_tags(&tags);
    let caption_source = training_tags::aggregate_source(&tags);
    let dataset_root = app_data_dir.join("datasets").join(&input.dataset_id);
    let image_path = app_data_dir.join(relative_path);
    if !image_path.starts_with(&dataset_root) {
        return Err("训练图片存储路径不受控".into());
    }
    let file_swap = stage_caption_file(&dataset_root, &image_path, caption.as_deref())?;
    let now = Utc::now().to_rfc3339();
    let outcome = (|| {
        let transaction = database
            .unchecked_transaction()
            .map_err(|error| format!("开启 Caption 事务失败：{error}"))?;
        training_tags::replace_tags(
            &transaction,
            &input.asset_id,
            &tags,
            "manual_edit",
            Some("用户保存逐图标签"),
            &now,
        )?;
        if transaction.execute("UPDATE local_training_assets SET caption=?3,caption_source=?4,confirmed=0,updated_at=?5 WHERE id=?1 AND dataset_id=?2", params![input.asset_id,input.dataset_id,caption,caption_source,now]).map_err(|error| format!("保存图片 Caption 失败：{error}"))? != 1 { return Err("训练图片不存在".into()); }
        transaction
            .execute(
                "UPDATE local_training_assets SET confirmed=0 WHERE dataset_id=?1",
                [&input.dataset_id],
            )
            .map_err(|error| format!("重置图片确认状态失败：{error}"))?;
        update_dataset_review_status(&transaction, &input.dataset_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("提交 Caption 事务失败：{error}"))
    })();
    if let Err(error) = outcome {
        rollback_caption_file(file_swap);
        return Err(error);
    }
    finalize_caption_file(file_swap);
    read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 批量标签只执行一次 IPC，并让全部 Caption 文件与 SQLite 在失败时整体回滚。 */
pub fn batch_update_tags(
    database: &Connection,
    app_data_dir: &Path,
    input: DesktopTrainingBatchTagsInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    if input.asset_ids.is_empty() || input.asset_ids.len() > MAX_DATASET_ASSETS {
        return Err("批量编辑必须选择 1–200 张训练图片".into());
    }
    let unique_ids = input.asset_ids.iter().collect::<HashSet<_>>();
    if unique_ids.len() != input.asset_ids.len()
        || input
            .asset_ids
            .iter()
            .any(|id| validate_uuid(id, "训练图片 ID").is_err())
    {
        return Err("批量编辑包含重复或格式不正确的训练图片 ID".into());
    }
    if !matches!(input.operation.as_str(), "add" | "remove") {
        return Err("批量标签操作必须是添加或删除".into());
    }
    let requested = training_tags::parse_caption(&input.tags.join(", "))?;
    if requested.is_empty() {
        return Err("批量编辑至少需要一个有效标签".into());
    }
    let trigger_words_json: String = database
        .query_row(
            "SELECT trigger_words_json FROM local_training_datasets WHERE id=?1 AND deleted_at IS NULL",
            [&input.dataset_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取训练集触发词失败：{error}"))?
        .ok_or_else(|| "训练集不存在".to_string())?;
    let trigger_words = serde_json::from_str::<Vec<String>>(&trigger_words_json)
        .map_err(|error| format!("解析训练集触发词失败：{error}"))?;
    let dataset_root = app_data_dir.join("datasets").join(&input.dataset_id);
    let requested_keys = requested
        .iter()
        .map(|tag| training_tags::normalize_tag(tag))
        .collect::<HashSet<_>>();
    let mut prepared = Vec::with_capacity(input.asset_ids.len());
    for asset_id in &input.asset_ids {
        let relative_path: String = database
            .query_row(
                "SELECT relative_path FROM local_training_assets WHERE id=?1 AND dataset_id=?2",
                params![asset_id, input.dataset_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("读取批量训练图片失败：{error}"))?
            .ok_or_else(|| "批量编辑包含不属于当前训练集的图片".to_string())?;
        let current = training_tags::read_tags(database, asset_id)?;
        let mut values = current
            .iter()
            .map(|tag| tag.value.clone())
            .collect::<Vec<_>>();
        if input.operation == "add" {
            let existing = values
                .iter()
                .map(|tag| training_tags::normalize_tag(tag))
                .collect::<HashSet<_>>();
            values.extend(
                requested
                    .iter()
                    .filter(|tag| !existing.contains(&training_tags::normalize_tag(tag)))
                    .cloned(),
            );
        } else {
            values.retain(|tag| !requested_keys.contains(&training_tags::normalize_tag(tag)));
        }
        let tags = training_tags::reconcile_manual_tags(
            &current,
            Some(&values.join(", ")),
            &trigger_words,
        )?;
        let image_path = app_data_dir.join(relative_path);
        if !image_path.starts_with(&dataset_root) {
            return Err("训练图片存储路径不受控".into());
        }
        prepared.push((asset_id.clone(), image_path, tags));
    }

    let mut file_swaps = Vec::with_capacity(prepared.len());
    for (_, image_path, tags) in &prepared {
        let caption = training_tags::caption_from_tags(tags);
        match stage_caption_file(&dataset_root, image_path, caption.as_deref()) {
            Ok(swap) => file_swaps.push(swap),
            Err(error) => {
                rollback_caption_files(file_swaps);
                return Err(error);
            }
        }
    }
    let now = Utc::now().to_rfc3339();
    let outcome = (|| {
        let transaction = database
            .unchecked_transaction()
            .map_err(|error| format!("开启批量标签事务失败：{error}"))?;
        for (asset_id, _, tags) in &prepared {
            training_tags::replace_tags(
                &transaction,
                asset_id,
                tags,
                "manual_batch_edit",
                Some("用户批量编辑训练标签"),
                &now,
            )?;
            let caption = training_tags::caption_from_tags(tags);
            let caption_source = training_tags::aggregate_source(tags);
            if transaction.execute("UPDATE local_training_assets SET caption=?3,caption_source=?4,confirmed=0,updated_at=?5 WHERE id=?1 AND dataset_id=?2", params![asset_id,input.dataset_id,caption,caption_source,now]).map_err(|error| format!("批量保存训练标签失败：{error}"))? != 1 {
                return Err("批量编辑期间训练图片已经变化".into());
            }
        }
        transaction
            .execute(
                "UPDATE local_training_assets SET confirmed=0 WHERE dataset_id=?1",
                [&input.dataset_id],
            )
            .map_err(|error| format!("重置批量标签确认状态失败：{error}"))?;
        update_dataset_review_status(&transaction, &input.dataset_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("提交批量标签事务失败：{error}"))
    })();
    if let Err(error) = outcome {
        rollback_caption_files(file_swaps);
        return Err(error);
    }
    finalize_caption_files(file_swaps);
    read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 删除原训练集中的单张图片；独立训练快照使用内容寻址 Blob，不受本操作影响。 */
pub fn delete_asset(
    database: &Connection,
    app_data_dir: &Path,
    input: DesktopTrainingAssetDeleteInput,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    validate_uuid(&input.asset_id, "训练图片 ID")?;
    let relative_path: String = database
        .query_row(
            "SELECT relative_path FROM local_training_assets WHERE id=?1 AND dataset_id=?2",
            params![input.asset_id, input.dataset_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取待删除训练图片失败：{error}"))?
        .ok_or_else(|| "训练图片不存在".to_string())?;
    let derivative_relative_paths = {
        let mut statement = database
            .prepare("SELECT relative_path FROM local_training_asset_derivatives WHERE asset_id=?1")
            .map_err(|error| format!("读取待删除派生图片失败：{error}"))?;
        let paths = statement
            .query_map([&input.asset_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("查询待删除派生图片失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析待删除派生图片失败：{error}"))?;
        paths
    };
    let captioning: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM local_caption_jobs WHERE dataset_id=?1 AND status IN ('queued','running','paused'))", [&input.dataset_id], |row| row.get(0)).map_err(|error| format!("检查活动打标任务失败：{error}"))?;
    let ai_cleaning: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM local_ai_clean_job_items item JOIN local_ai_clean_jobs job ON job.id=item.job_id WHERE item.asset_id=?1 AND job.status IN ('queued','running','paused'))", [&input.asset_id], |row| row.get(0)).map_err(|error| format!("检查活动 AI 清洗任务失败：{error}"))?;
    if captioning || ai_cleaning {
        return Err("当前图片仍有打标或 AI 清洗任务运行，请完成或取消后再删除".into());
    }
    let dataset_root = app_data_dir.join("datasets").join(&input.dataset_id);
    let source = app_data_dir.join(&relative_path);
    if !source.starts_with(&dataset_root) {
        return Err("训练图片存储路径不受控".into());
    }
    let staged = source
        .is_file()
        .then(|| source.with_file_name(format!(".deleting-{}", Uuid::new_v4())));
    if let Some(staged) = &staged {
        fs::rename(&source, staged).map_err(|error| format!("暂存待删除训练图片失败：{error}"))?;
    }
    let label_path = source.with_extension("txt");
    let staged_label = label_path
        .is_file()
        .then(|| label_path.with_file_name(format!(".deleting-{}.txt", Uuid::new_v4())));
    if let Some(staged_label) = &staged_label {
        if let Err(error) = fs::rename(&label_path, staged_label) {
            if let Some(staged) = &staged {
                let _ = fs::rename(staged, &source);
            }
            return Err(format!("暂存待删除训练标签失败：{error}"));
        }
    }
    // 派生图与原图一起先移入同目录临时名，数据库失败时可逐一恢复。
    let mut staged_derivatives = Vec::new();
    for relative in derivative_relative_paths {
        let derivative = app_data_dir.join(relative);
        if !derivative.starts_with(&dataset_root) {
            restore_staged_paths(&staged_derivatives);
            if let Some(staged) = &staged {
                let _ = fs::rename(staged, &source);
            }
            if let Some(staged_label) = &staged_label {
                let _ = fs::rename(staged_label, &label_path);
            }
            return Err("训练派生图片存储路径不受控".into());
        }
        if derivative.is_file() {
            let temporary = derivative.with_file_name(format!(".deleting-{}", Uuid::new_v4()));
            if let Err(error) = fs::rename(&derivative, &temporary) {
                restore_staged_paths(&staged_derivatives);
                if let Some(staged) = &staged {
                    let _ = fs::rename(staged, &source);
                }
                if let Some(staged_label) = &staged_label {
                    let _ = fs::rename(staged_label, &label_path);
                }
                return Err(format!("暂存待删除训练派生图片失败：{error}"));
            }
            staged_derivatives.push((derivative, temporary));
        }
    }
    let outcome = (|| {
        let now = Utc::now().to_rfc3339();
        let transaction = database
            .unchecked_transaction()
            .map_err(|error| format!("开启删除训练图片事务失败：{error}"))?;
        transaction
            .execute(
                "DELETE FROM local_caption_job_items WHERE asset_id=?1",
                [&input.asset_id],
            )
            .map_err(|error| format!("清理训练图片打标关联失败：{error}"))?;
        transaction
            .execute(
                "DELETE FROM local_ai_clean_job_items WHERE asset_id=?1",
                [&input.asset_id],
            )
            .map_err(|error| format!("清理训练图片 AI 清洗关联失败：{error}"))?;
        transaction
            .execute(
                "DELETE FROM local_background_removal_job_items WHERE asset_id=?1",
                [&input.asset_id],
            )
            .map_err(|error| format!("清理训练图片抠图关联失败：{error}"))?;
        if transaction
            .execute(
                "DELETE FROM local_training_assets WHERE id=?1 AND dataset_id=?2",
                params![input.asset_id, input.dataset_id],
            )
            .map_err(|error| format!("删除训练图片记录失败：{error}"))?
            != 1
        {
            return Err("训练图片不存在".into());
        }
        transaction
            .execute(
                "UPDATE local_training_assets SET confirmed=0 WHERE dataset_id=?1",
                [&input.dataset_id],
            )
            .map_err(|error| format!("重置训练集确认状态失败：{error}"))?;
        update_dataset_review_status(&transaction, &input.dataset_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("提交删除训练图片事务失败：{error}"))?;
        Ok(())
    })();
    if let Err(error) = outcome {
        restore_staged_paths(&staged_derivatives);
        if let Some(staged) = &staged {
            let _ = fs::rename(staged, &source);
        }
        if let Some(staged_label) = &staged_label {
            let _ = fs::rename(staged_label, &label_path);
        }
        return Err(error);
    }
    if let Some(staged) = &staged {
        let _ = fs::remove_file(staged);
    }
    if let Some(staged_label) = &staged_label {
        let _ = fs::remove_file(staged_label);
    }
    for (_, temporary) in &staged_derivatives {
        let _ = fs::remove_file(temporary);
    }
    read_dataset_with_assets(database, app_data_dir, &input.dataset_id)
}

/** 删除可编辑训练集目录并保留审计行、训练任务、内容寻址快照和 LoRA 产物。 */
pub fn delete_dataset(
    database: &Connection,
    app_data_dir: &Path,
    input: DesktopTrainingDatasetIdInput,
) -> Result<String, String> {
    validate_uuid(&input.dataset_id, "训练集 ID")?;
    let exists: bool = database.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_training_datasets WHERE id=?1 AND deleted_at IS NULL)",
        [&input.dataset_id],
        |row| row.get(0),
    ).map_err(|error| format!("读取待删除训练集失败：{error}"))?;
    if !exists {
        return Err("训练集不存在或已经删除".into());
    }
    let active: bool = database.query_row(
        "SELECT EXISTS(SELECT 1 FROM local_caption_jobs WHERE dataset_id=?1 AND status IN ('queued','running','paused') UNION ALL SELECT 1 FROM local_ai_clean_jobs WHERE dataset_id=?1 AND status IN ('queued','running','paused'))",
        [&input.dataset_id],
        |row| row.get(0),
    ).map_err(|error| format!("检查训练集后台任务失败：{error}"))?;
    if active {
        return Err("训练集仍有打标或 AI 清洗任务，请完成或取消后再删除".into());
    }
    let datasets_root = app_data_dir.join("datasets");
    let dataset_root = datasets_root.join(&input.dataset_id);
    if !dataset_root.starts_with(&datasets_root) {
        return Err("训练集目录不受控".into());
    }
    let staged = datasets_root.join(format!(".deleting-dataset-{}", Uuid::new_v4()));
    if dataset_root.exists() {
        fs::rename(&dataset_root, &staged)
            .map_err(|error| format!("暂存待删除训练集目录失败：{error}"))?;
    }
    let now = Utc::now().to_rfc3339();
    let outcome = database.unchecked_transaction()
        .and_then(|transaction| {
            let changed = transaction.execute(
                "UPDATE local_training_datasets SET status='deleted',deleted_at=?2,updated_at=?2 WHERE id=?1 AND deleted_at IS NULL",
                params![input.dataset_id, now],
            )?;
            if changed != 1 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            transaction.commit()
        });
    if let Err(error) = outcome {
        if staged.exists() {
            let _ = fs::rename(&staged, &dataset_root);
        }
        return Err(format!("提交删除训练集事务失败：{error}"));
    }
    // 数据库已隐藏训练集后再清理暂存目录；清理失败保留受控隐藏目录供存储清理功能处理。
    if staged.exists() {
        let safe_staged = staged.parent() == Some(datasets_root.as_path())
            && staged
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.starts_with(".deleting-dataset-"));
        if safe_staged {
            let _ = fs::remove_dir_all(&staged);
        }
    }
    Ok(input.dataset_id)
}

/** 恢复尚未提交删除的派生文件，避免 SQLite 失败造成文件丢失。 */
fn restore_staged_paths(paths: &[(PathBuf, PathBuf)]) {
    for (original, temporary) in paths.iter().rev() {
        if temporary.is_file() {
            let _ = fs::rename(temporary, original);
        }
    }
}

/** 全量校验图片数量和 Caption 后确认训练集，后续训练参数页只能读取该终态。 */
pub fn confirm_dataset(
    database: &Connection,
    app_data_dir: &Path,
    dataset_id: &str,
) -> Result<DesktopTrainingDatasetView, String> {
    validate_uuid(dataset_id, "训练集 ID")?;
    let (count, missing): (u64, u64) = database.query_row("SELECT COUNT(*),COALESCE(SUM(CASE WHEN caption IS NULL OR TRIM(caption)='' THEN 1 ELSE 0 END),0) FROM local_training_assets WHERE dataset_id=?1", [dataset_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|error| format!("校验训练集失败：{error}"))?;
    if !(MIN_CONFIRMED_ASSETS..=MAX_DATASET_ASSETS as u64).contains(&count) {
        return Err("确认训练集需要 5–200 张图片".into());
    }
    if missing > 0 {
        return Err(format!("仍有 {missing} 张图片缺少 Caption"));
    }
    let mut unavailable = 0_usize;
    for asset in read_assets(database, app_data_dir, dataset_id)? {
        if !asset.available
            || sha256_file(Path::new(&asset.path)).ok().as_deref() != Some(asset.sha256.as_str())
        {
            unavailable += 1;
        }
    }
    if unavailable > 0 {
        return Err(format!("仍有 {unavailable} 张训练图片文件缺失或已变化"));
    }
    let now = Utc::now().to_rfc3339();
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启训练集确认事务失败：{error}"))?;
    transaction
        .execute(
            "UPDATE local_training_assets SET confirmed=1,updated_at=?2 WHERE dataset_id=?1",
            params![dataset_id, now],
        )
        .and_then(|_| {
            transaction.execute(
                "UPDATE local_training_datasets SET status='confirmed',updated_at=?2 WHERE id=?1",
                params![dataset_id, now],
            )
        })
        .map_err(|error| format!("确认训练集失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交训练集确认事务失败：{error}"))?;
    read_dataset_with_assets(database, app_data_dir, dataset_id)
}

pub(crate) fn read_dataset_with_assets(
    database: &Connection,
    app_data_dir: &Path,
    id: &str,
) -> Result<DesktopTrainingDatasetView, String> {
    let mut dataset = read_dataset(database, id)?.ok_or_else(|| "训练集不存在".to_string())?;
    dataset.assets = read_assets(database, app_data_dir, id)?;
    Ok(dataset)
}

fn read_dataset(
    database: &Connection,
    id: &str,
) -> Result<Option<DesktopTrainingDatasetView>, String> {
    database.query_row("SELECT id,title,type,trigger_words_json,status,created_at,updated_at FROM local_training_datasets WHERE id=?1 AND deleted_at IS NULL", [id], dataset_from_row).optional().map_err(|error| format!("读取训练集失败：{error}"))
}

fn dataset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DesktopTrainingDatasetView> {
    let trigger_words_json: String = row.get(3)?;
    let trigger_words = serde_json::from_str(&trigger_words_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(DesktopTrainingDatasetView {
        id: row.get(0)?,
        title: row.get(1)?,
        r#type: row.get(2)?,
        trigger_words,
        status: row.get(4)?,
        assets: Vec::new(),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn read_assets(
    database: &Connection,
    app_data_dir: &Path,
    dataset_id: &str,
) -> Result<Vec<DesktopTrainingAssetView>, String> {
    let mut statement = database.prepare("SELECT id,file_name,relative_path,sha256,byte_size,width,height,caption,caption_source,selected_derivative_id,confirmed,created_at,updated_at FROM local_training_assets WHERE dataset_id=?1 ORDER BY created_at ASC,id ASC").map_err(|error| format!("读取训练图片失败：{error}"))?;
    let rows = statement
        .query_map([dataset_id], |row| {
            let relative_path: String = row.get(2)?;
            let path = app_data_dir.join(relative_path);
            let byte_size: u64 = row.get(4)?;
            let available = path
                .metadata()
                .ok()
                .is_some_and(|metadata| metadata.is_file() && metadata.len() == byte_size);
            Ok(DesktopTrainingAssetView {
                id: row.get(0)?,
                file_name: row.get(1)?,
                path: path.to_string_lossy().into_owned(),
                sha256: row.get(3)?,
                byte_size,
                width: row.get(5)?,
                height: row.get(6)?,
                available,
                caption: row.get(7)?,
                caption_source: row.get(8)?,
                tags: Vec::new(),
                derivatives: Vec::new(),
                selected_derivative_id: row.get(9)?,
                confirmed: row.get::<_, i64>(10)? != 0,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })
        .map_err(|error| format!("查询训练图片失败：{error}"))?;
    let mut assets = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析训练图片失败：{error}"))?;
    drop(statement);
    for asset in &mut assets {
        asset.tags = training_tags::to_views(training_tags::read_tags(database, &asset.id)?);
        asset.derivatives = read_asset_derivatives(database, app_data_dir, &asset.id)?;
        if asset.selected_derivative_id.as_ref().is_some_and(|id| {
            !asset
                .derivatives
                .iter()
                .any(|derivative| derivative.id == *id && derivative.available)
        }) {
            asset.selected_derivative_id = None;
        }
    }
    Ok(assets)
}

/** 读取受管派生文件并实时检查文件可用性，损坏派生不会影响原图。 */
fn read_asset_derivatives(
    database: &Connection,
    app_data_dir: &Path,
    asset_id: &str,
) -> Result<Vec<DesktopTrainingAssetDerivativeView>, String> {
    let mut statement = database.prepare("SELECT id,kind,source,relative_path,sha256,byte_size,width,height,created_at FROM local_training_asset_derivatives WHERE asset_id=?1 ORDER BY created_at DESC,id DESC").map_err(|error| format!("读取训练图片派生版本失败：{error}"))?;
    let rows = statement
        .query_map([asset_id], |row| {
            let relative_path: String = row.get(3)?;
            let byte_size: u64 = row.get(5)?;
            let path = app_data_dir.join(&relative_path);
            let available = path
                .metadata()
                .ok()
                .is_some_and(|metadata| metadata.is_file() && metadata.len() == byte_size);
            Ok(DesktopTrainingAssetDerivativeView {
                id: row.get(0)?,
                kind: row.get(1)?,
                source: row.get(2)?,
                path: path.to_string_lossy().into_owned(),
                sha256: row.get(4)?,
                byte_size,
                width: row.get(6)?,
                height: row.get(7)?,
                available,
                created_at: row.get(8)?,
            })
        })
        .map_err(|error| format!("查询训练图片派生版本失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析训练图片派生版本失败：{error}"))?;
    Ok(rows)
}

fn stage_asset(
    source: &Path,
    dataset_root: &Path,
    dataset_id: &str,
) -> Result<StagedAsset, String> {
    let metadata = source
        .metadata()
        .map_err(|_| "所选训练图片不存在".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
        return Err("训练图片必须是 1B–100MiB 的普通文件".into());
    }
    let reader = ImageReader::open(source)
        .map_err(|error| format!("读取训练图片失败：{error}"))?
        .with_guessed_format()
        .map_err(|error| format!("识别训练图片格式失败：{error}"))?;
    let format = reader
        .format()
        .ok_or_else(|| "训练图片格式不可识别".to_string())?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("训练图片仅支持 PNG、JPEG 和 WebP".into());
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("读取训练图片尺寸失败：{error}"))?;
    if width < 32 || height < 32 || width > 16_384 || height > 16_384 {
        return Err("训练图片尺寸必须在 32–16384 像素范围内".into());
    }
    let extension = match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::WebP => "webp",
        _ => unreachable!(),
    };
    let id = Uuid::new_v4().to_string();
    let temporary_path = dataset_root.join(format!(".{id}.importing"));
    let final_path = dataset_root.join(format!("{id}.{extension}"));
    let (copied, sha256) = copy_asset_bytes(source, &temporary_path, metadata.len())?;
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("training-image")
        .chars()
        .take(255)
        .collect();
    Ok(StagedAsset {
        id: id.clone(),
        file_name,
        temporary_path,
        final_path,
        relative_path: format!("datasets/{dataset_id}/{id}.{extension}"),
        sha256,
        byte_size: copied,
        width,
        height,
    })
}

/** 流式复制并计算哈希，任意失败都会清理未完成临时文件。 */
fn copy_asset_bytes(
    source: &Path,
    temporary_path: &Path,
    expected_size: u64,
) -> Result<(u64, String), String> {
    let outcome = (|| {
        let source_file =
            File::open(source).map_err(|error| format!("打开训练图片失败：{error}"))?;
        let mut reader = BufReader::new(source_file);
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(temporary_path)
            .map_err(|error| format!("创建训练图片临时文件失败：{error}"))?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("读取训练图片失败：{error}"))?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("写入训练图片失败：{error}"))?;
            hasher.update(&buffer[..read]);
            copied += read as u64;
        }
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|error| format!("同步训练图片失败：{error}"))?;
        if copied != expected_size {
            return Err("训练图片复制期间发生变化".into());
        }
        Ok((copied, hex::encode(hasher.finalize())))
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(temporary_path);
    }
    outcome
}

/** 同名标签文件使用 UTF-8 英文逗号格式并在提交前强制刷盘。 */
fn write_caption_file(path: &Path, caption: &str) -> Result<(), String> {
    let normalized = caption
        .split([',', '，', '\n', '\r', ';', '；'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if normalized.is_empty() || normalized.chars().count() > 10_000 {
        return Err("训练标签必须是 1–10000 个字符".into());
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("创建训练标签文件失败：{error}"))?;
    file.write_all(normalized.as_bytes())
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("保存训练标签文件失败：{error}"))
}

fn dataset_hashes(database: &Connection, dataset_id: &str) -> Result<HashSet<String>, String> {
    let mut statement = database
        .prepare("SELECT sha256 FROM local_training_assets WHERE dataset_id=?1")
        .map_err(|error| format!("读取训练图片哈希失败：{error}"))?;
    let rows = statement
        .query_map([dataset_id], |row| row.get(0))
        .map_err(|error| format!("查询训练图片哈希失败：{error}"))?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("解析训练图片哈希失败：{error}"))
}

/** 确认训练集时重新计算完整哈希，防止同尺寸文件替换绕过门禁。 */
fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("读取训练图片失败：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("校验训练图片失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub(crate) fn update_dataset_review_status(
    database: &Connection,
    dataset_id: &str,
    now: &str,
) -> Result<(), String> {
    let (count, missing): (u64, u64) = database.query_row("SELECT COUNT(*),COALESCE(SUM(CASE WHEN caption IS NULL OR TRIM(caption)='' THEN 1 ELSE 0 END),0) FROM local_training_assets WHERE dataset_id=?1", [dataset_id], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|error| format!("统计 Caption 状态失败：{error}"))?;
    let status = if count >= MIN_CONFIRMED_ASSETS && missing == 0 {
        "review_ready"
    } else {
        "draft"
    };
    database
        .execute(
            "UPDATE local_training_datasets SET status=?2,updated_at=?3 WHERE id=?1",
            params![dataset_id, status, now],
        )
        .map_err(|error| format!("更新训练集阶段失败：{error}"))?;
    Ok(())
}

fn validate_trigger_words(words: Vec<String>) -> Result<Vec<String>, String> {
    if words.len() > 50
        || words
            .iter()
            .any(|word| word.trim().is_empty() || word.trim().chars().count() > 100)
    {
        return Err("训练触发词最多 50 个，每个长度必须是 1–100 个字符".into());
    }
    let mut seen = HashSet::new();
    Ok(words
        .into_iter()
        .map(|word| word.trim().to_owned())
        .filter(|word| seen.insert(word.to_lowercase()))
        .collect())
}

fn validate_uuid(value: &str, label: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{label} 不正确"))
}
fn cleanup_staged(assets: &[StagedAsset]) {
    for asset in assets {
        let _ = fs::remove_file(&asset.temporary_path);
    }
}
fn cleanup_import_staged(assets: &[StagedImportAsset]) {
    for item in assets {
        let _ = fs::remove_file(&item.asset.temporary_path);
        if let Some(path) = &item.label_temporary_path {
            let _ = fs::remove_file(path);
        }
    }
}
fn cleanup_paths(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::DesktopState;
    use image::{Rgb, RgbImage};

    #[test]
    fn dataset_images_and_captions_persist_through_confirmation_gate() {
        let temporary = tempfile::tempdir().expect("创建训练集测试目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "测试角色".into(),
                r#type: "character".into(),
                trigger_words: vec!["dh_test".into()],
            })
            .expect("创建训练集");
        let updated = state
            .update_training_trigger_words(DesktopTrainingTriggerWordsUpdateInput {
                dataset_id: dataset.id.clone(),
                trigger_words: vec!["dh_updated".into(), "DH_UPDATED".into()],
            })
            .expect("更新训练触发词");
        assert_eq!(updated.trigger_words, vec!["dh_updated"]);
        let mut source_paths = Vec::new();
        for (index, extension) in ["png", "jpg", "webp", "png", "jpg"].iter().enumerate() {
            let path = temporary.path().join(format!("source-{index}.{extension}"));
            RgbImage::from_pixel(64, 64, Rgb([index as u8, 40, 80]))
                .save(&path)
                .expect("写入测试图片");
            source_paths.push(path.to_string_lossy().into_owned());
        }
        let imported = {
            let mut database = state.database.lock().expect("锁定训练集数据库");
            add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths: source_paths.clone(),
                },
            )
            .expect("导入训练图片")
        };
        assert_eq!(imported.assets.len(), 5);
        assert!(source_paths.iter().all(|path| Path::new(path).is_file()));
        for asset in &imported.assets {
            state
                .update_training_caption(DesktopTrainingCaptionUpdateInput {
                    dataset_id: dataset.id.clone(),
                    asset_id: asset.id.clone(),
                    caption: Some("dh_test, 1girl, solo".into()),
                })
                .expect("保存 Caption");
        }
        let trigger_updated = state
            .update_training_trigger_words(DesktopTrainingTriggerWordsUpdateInput {
                dataset_id: dataset.id.clone(),
                trigger_words: vec!["dh_second".into()],
            })
            .expect("同步新触发词");
        for asset in &trigger_updated.assets {
            assert_eq!(asset.tags[0].value, "dh_second");
            assert_eq!(asset.tags[0].source, "trigger");
            assert!(asset
                .tags
                .iter()
                .any(|tag| tag.value == "dh_test" && tag.source == "manual"));
            assert_eq!(
                fs::read_to_string(Path::new(&asset.path).with_extension("txt"))
                    .expect("读取触发词同步标签文件"),
                asset.caption.as_deref().expect("同步后 Caption 存在")
            );
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
        assert!(confirmed
            .assets
            .iter()
            .all(|asset| asset.confirmed && asset.caption.is_some()));
        let restored = state.list_training_datasets().expect("恢复训练集");
        assert_eq!(restored[0].assets.len(), 5);
        assert_eq!(restored[0].status, "confirmed");
    }

    #[test]
    fn deleting_unreferenced_asset_preserves_original_source() {
        let temporary = tempfile::tempdir().expect("创建删除图片测试目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化桌面状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "删除测试".into(),
                r#type: "style".into(),
                trigger_words: vec![],
            })
            .expect("创建训练集");
        let source = temporary.path().join("delete-source.png");
        RgbImage::from_pixel(64, 64, Rgb([40, 80, 120]))
            .save(&source)
            .expect("写入原始图片");
        let imported = {
            let mut database = state.database.lock().expect("锁定训练集数据库");
            add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths: vec![source.to_string_lossy().into_owned()],
                },
            )
            .expect("导入训练图片")
        };
        let managed_path = imported.assets[0].path.clone();
        state
            .update_training_caption(DesktopTrainingCaptionUpdateInput {
                dataset_id: dataset.id.clone(),
                asset_id: imported.assets[0].id.clone(),
                caption: Some("delete_test, solo".into()),
            })
            .expect("为待删除图片写入 Caption");
        let managed_label_path = Path::new(&managed_path).with_extension("txt");
        assert!(managed_label_path.is_file());
        let deleted = {
            let database = state.database.lock().expect("锁定训练集数据库");
            delete_asset(
                &database,
                &state.app_data_dir,
                DesktopTrainingAssetDeleteInput {
                    dataset_id: dataset.id,
                    asset_id: imported.assets[0].id.clone(),
                },
            )
            .expect("删除训练图片")
        };
        assert!(deleted.assets.is_empty());
        assert!(source.is_file());
        assert!(!Path::new(&managed_path).exists());
        assert!(!managed_label_path.exists());
    }

    #[test]
    fn batch_tags_update_sqlite_and_all_caption_files_once() {
        let temporary = tempfile::tempdir().expect("创建批量标签测试目录");
        let state = DesktopState::initialize(temporary.path()).expect("初始化批量标签状态");
        let dataset = state
            .create_training_dataset(DesktopTrainingDatasetCreateInput {
                title: "批量标签".into(),
                r#type: "style".into(),
                trigger_words: vec!["dh_batch".into()],
            })
            .expect("创建批量标签训练集");
        let source_paths = (0..2)
            .map(|index| {
                let path = temporary.path().join(format!("batch-{index}.png"));
                RgbImage::from_pixel(32, 32, Rgb([index, 40, 80]))
                    .save(&path)
                    .expect("写入批量标签测试图");
                path.to_string_lossy().into_owned()
            })
            .collect::<Vec<_>>();
        let imported = {
            let mut database = state.database.lock().expect("锁定批量标签导入数据库");
            add_images(
                &mut database,
                &state.app_data_dir,
                DesktopTrainingImagesAddInput {
                    dataset_id: dataset.id.clone(),
                    source_paths,
                },
            )
            .expect("导入批量标签测试图")
        };
        let updated = {
            let database = state.database.lock().expect("锁定批量标签数据库");
            batch_update_tags(
                &database,
                &state.app_data_dir,
                DesktopTrainingBatchTagsInput {
                    dataset_id: dataset.id.clone(),
                    asset_ids: imported
                        .assets
                        .iter()
                        .map(|asset| asset.id.clone())
                        .collect(),
                    operation: "add".into(),
                    tags: vec!["Blue_Hair".into(), "blue hair".into(), "solo".into()],
                },
            )
            .expect("批量添加标签")
        };
        for asset in &updated.assets {
            assert_eq!(asset.caption.as_deref(), Some("dh_batch, Blue_Hair, solo"));
            assert!(asset
                .tags
                .iter()
                .any(|tag| { tag.normalized_value == "blue hair" && tag.source == "manual" }));
            assert_eq!(
                fs::read_to_string(Path::new(&asset.path).with_extension("txt"))
                    .expect("读取批量 Caption 文件"),
                asset.caption.as_deref().expect("批量 Caption 存在")
            );
        }
        let removed = {
            let database = state.database.lock().expect("锁定批量删除标签数据库");
            batch_update_tags(
                &database,
                &state.app_data_dir,
                DesktopTrainingBatchTagsInput {
                    dataset_id: dataset.id,
                    asset_ids: updated
                        .assets
                        .iter()
                        .map(|asset| asset.id.clone())
                        .collect(),
                    operation: "remove".into(),
                    tags: vec!["solo".into(), "dh_batch".into()],
                },
            )
            .expect("批量删除标签")
        };
        assert!(removed.assets.iter().all(|asset| {
            asset.caption.as_deref() == Some("dh_batch, Blue_Hair")
                && asset.tags.iter().any(|tag| tag.source == "trigger")
        }));
    }
}
