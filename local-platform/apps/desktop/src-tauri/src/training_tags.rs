//! 本模块管理训练图片逐标签来源、兼容 Caption 投影、旧数据回填和可审计变更历史。

use crate::models::DesktopTrainingTagView;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

const MAX_TAGS_PER_ASSET: usize = 2_000;
const MAX_TAG_LENGTH: usize = 200;

/** SQLite 内部使用的逐标签记录。 */
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingTag {
    pub value: String,
    pub normalized_value: String,
    pub source: String,
    pub position: u32,
}

/** 把用户或打标器 Caption 解析为有序、大小写及下划线归一去重的英文标签。 */
pub(crate) fn parse_caption(caption: &str) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut tags = Vec::new();
    for value in caption.split([',', '，', '\n', '\r', ';', '；']) {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.chars().count() > MAX_TAG_LENGTH {
            return Err("单个训练标签不能超过 200 个字符".into());
        }
        let normalized = normalize_tag(value);
        if normalized.is_empty() {
            continue;
        }
        if seen.insert(normalized) {
            tags.push(value.to_string());
        }
        if tags.len() > MAX_TAGS_PER_ASSET {
            return Err("单张图片最多保存 2000 个训练标签".into());
        }
    }
    Ok(tags)
}

/** 生成标签唯一键，使大小写、重复空白和下划线差异不会制造同义重复项。 */
pub(crate) fn normalize_tag(value: &str) -> String {
    value
        .trim()
        .replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/** 读取单张图片的稳定有序标签。 */
pub(crate) fn read_tags(database: &Connection, asset_id: &str) -> Result<Vec<TrainingTag>, String> {
    let mut statement = database.prepare("SELECT value,normalized_value,source,position FROM local_training_asset_tags WHERE asset_id=?1 ORDER BY position ASC,normalized_value ASC").map_err(|error| format!("读取逐标签来源失败：{error}"))?;
    let tags = statement
        .query_map([asset_id], |row| {
            Ok(TrainingTag {
                value: row.get(0)?,
                normalized_value: row.get(1)?,
                source: row.get(2)?,
                position: row.get(3)?,
            })
        })
        .map_err(|error| format!("查询逐标签来源失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析逐标签来源失败：{error}"))?;
    Ok(tags)
}

/** 转换为桌面契约视图，避免业务层暴露数据库内部结构。 */
pub(crate) fn to_views(tags: Vec<TrainingTag>) -> Vec<DesktopTrainingTagView> {
    tags.into_iter()
        .map(|tag| DesktopTrainingTagView {
            value: tag.value,
            normalized_value: tag.normalized_value,
            source: tag.source,
            position: tag.position,
        })
        .collect()
}

/** 首次导入时按触发词和来源创建逐标签记录。 */
pub(crate) fn initial_tags(
    caption: Option<&str>,
    default_source: &str,
    trigger_words: &[String],
) -> Result<Vec<TrainingTag>, String> {
    let values = caption.map(parse_caption).transpose()?.unwrap_or_default();
    let trigger_keys = trigger_words
        .iter()
        .map(|value| normalize_tag(value))
        .collect::<HashSet<_>>();
    let mut pairs = trigger_pairs(trigger_words);
    pairs.extend(values.into_iter().filter_map(|value| {
        if trigger_keys.contains(&normalize_tag(&value)) {
            None
        } else {
            Some((value, default_source.to_string()))
        }
    }));
    make_tags(pairs)
}

/** 人工提交完整 Caption 时保留仍存在标签的原来源，新标签标记为 MANUAL。 */
pub(crate) fn reconcile_manual_tags(
    current: &[TrainingTag],
    requested_caption: Option<&str>,
    trigger_words: &[String],
) -> Result<Vec<TrainingTag>, String> {
    let current_by_key = current
        .iter()
        .map(|tag| (tag.normalized_value.clone(), tag))
        .collect::<HashMap<_, _>>();
    let mut ordered = trigger_pairs(trigger_words);
    for value in requested_caption
        .map(parse_caption)
        .transpose()?
        .unwrap_or_default()
    {
        let key = normalize_tag(&value);
        if ordered
            .iter()
            .any(|(existing, _)| normalize_tag(existing) == key)
        {
            continue;
        }
        let source = current_by_key
            .get(&key)
            .map(|tag| tag.source.clone())
            .filter(|source| source != "trigger")
            .unwrap_or_else(|| "manual".into());
        ordered.push((value, source));
    }
    make_tags(ordered)
}

/** 重新打标仅移除 AUTO 标签，保留其他来源并写入新的 AUTO 结果。 */
pub(crate) fn reconcile_auto_tags(
    current: &[TrainingTag],
    auto_values: Vec<String>,
    trigger_words: &[String],
) -> Result<Vec<TrainingTag>, String> {
    let mut ordered = trigger_pairs(trigger_words);
    ordered.extend(
        current
            .iter()
            .filter(|tag| tag.source != "auto" && tag.source != "trigger")
            .map(|tag| (tag.value.clone(), tag.source.clone())),
    );
    ordered.extend(auto_values.into_iter().map(|value| (value, "auto".into())));
    make_tags(ordered)
}

/** 仅替换 TRIGGER 标签，用于训练集触发词更新时保持其他来源不变。 */
pub(crate) fn reconcile_trigger_tags(
    current: &[TrainingTag],
    trigger_words: &[String],
) -> Result<Vec<TrainingTag>, String> {
    let mut ordered = trigger_pairs(trigger_words);
    ordered.extend(
        current
            .iter()
            .filter(|tag| tag.source != "trigger")
            .map(|tag| (tag.value.clone(), tag.source.clone())),
    );
    make_tags(ordered)
}

/** 应用用户接受的 AI 建议，保留未删除标签来源并把新增项标记为 AI_CLEANED。 */
pub(crate) fn reconcile_ai_clean_tags(
    current: &[TrainingTag],
    remove_values: &[String],
    add_values: &[String],
    trigger_words: &[String],
) -> Result<Vec<TrainingTag>, String> {
    let remove_keys = remove_values
        .iter()
        .map(|value| normalize_tag(value))
        .collect::<HashSet<_>>();
    let trigger_keys = trigger_words
        .iter()
        .map(|value| normalize_tag(value))
        .collect::<HashSet<_>>();
    if remove_keys.iter().any(|key| trigger_keys.contains(key)) {
        return Err("AI 清洗不能删除训练触发词".into());
    }
    let mut ordered = trigger_pairs(trigger_words);
    ordered.extend(
        current
            .iter()
            .filter(|tag| tag.source != "trigger" && !remove_keys.contains(&tag.normalized_value))
            .map(|tag| (tag.value.clone(), tag.source.clone())),
    );
    ordered.extend(
        add_values
            .iter()
            .map(|value| (value.clone(), "ai_cleaned".into())),
    );
    make_tags(ordered)
}

/** 在调用方事务中替换一张图片的逐标签记录，并记录完整前后快照。 */
pub(crate) fn replace_tags(
    database: &Connection,
    asset_id: &str,
    tags: &[TrainingTag],
    operation: &str,
    reason: Option<&str>,
    now: &str,
) -> Result<String, String> {
    let before = read_tags(database, asset_id)?;
    database
        .execute(
            "DELETE FROM local_training_asset_tags WHERE asset_id=?1",
            [asset_id],
        )
        .map_err(|error| format!("清理旧逐标签来源失败：{error}"))?;
    for tag in tags {
        validate_source(&tag.source)?;
        database.execute("INSERT INTO local_training_asset_tags (asset_id,normalized_value,value,source,position,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)", params![asset_id,tag.normalized_value,tag.value,tag.source,tag.position,now]).map_err(|error| format!("保存逐标签来源失败：{error}"))?;
    }
    let before_json = serde_json::to_string(&before)
        .map_err(|error| format!("序列化标签变更前快照失败：{error}"))?;
    let after_json = serde_json::to_string(tags)
        .map_err(|error| format!("序列化标签变更后快照失败：{error}"))?;
    let change_id = Uuid::new_v4().to_string();
    database.execute("INSERT INTO local_training_tag_changes (id,asset_id,operation,before_json,after_json,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![change_id,asset_id,operation,before_json,after_json,reason,now]).map_err(|error| format!("记录标签变更历史失败：{error}"))?;
    Ok(change_id)
}

/** 将逐标签记录投影成当前 Runtime 使用的英文逗号 Caption。 */
pub(crate) fn caption_from_tags(tags: &[TrainingTag]) -> Option<String> {
    let caption = tags
        .iter()
        .map(|tag| tag.value.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    (!caption.is_empty()).then_some(caption)
}

/** 计算旧兼容字段的主来源；新界面应优先读取逐标签来源。 */
pub(crate) fn aggregate_source(tags: &[TrainingTag]) -> Option<String> {
    ["manual", "ai_cleaned", "imported", "auto", "trigger"]
        .into_iter()
        .find(|source| tags.iter().any(|tag| tag.source == *source))
        .map(str::to_string)
}

/** 启动时仅为尚未迁移的旧 Caption 回填逐标签来源，不修改原 Caption 或文件。 */
pub(crate) fn backfill_existing_tags(database: &Connection) -> Result<(), String> {
    let rows = {
        let mut statement = database.prepare("SELECT asset.id,asset.caption,asset.caption_source,dataset.trigger_words_json,asset.created_at FROM local_training_assets asset JOIN local_training_datasets dataset ON dataset.id=asset.dataset_id WHERE asset.caption IS NOT NULL AND TRIM(asset.caption)<>'' AND NOT EXISTS(SELECT 1 FROM local_training_asset_tags tag WHERE tag.asset_id=asset.id) ORDER BY asset.created_at ASC,asset.id ASC").map_err(|error| format!("读取待迁移旧 Caption 失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| format!("查询待迁移旧 Caption 失败：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("解析待迁移旧 Caption 失败：{error}"))?;
        rows
    };
    let transaction = database
        .unchecked_transaction()
        .map_err(|error| format!("开启旧 Caption 迁移事务失败：{error}"))?;
    for (asset_id, caption, source, trigger_json, created_at) in rows {
        let triggers = serde_json::from_str::<Vec<String>>(&trigger_json)
            .map_err(|error| format!("解析旧训练集触发词失败：{error}"))?;
        let source = source
            .filter(|value| validate_source(value).is_ok())
            .unwrap_or_else(|| "manual".into());
        let tags = initial_tags(Some(&caption), &source, &triggers)?;
        for tag in tags {
            transaction.execute("INSERT OR IGNORE INTO local_training_asset_tags (asset_id,normalized_value,value,source,position,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)", params![asset_id,tag.normalized_value,tag.value,tag.source,tag.position,created_at]).map_err(|error| format!("迁移旧逐标签来源失败：{error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("提交旧 Caption 迁移失败：{error}"))
}

fn trigger_pairs(trigger_words: &[String]) -> Vec<(String, String)> {
    trigger_words
        .iter()
        .map(|value| (value.trim().to_string(), "trigger".into()))
        .filter(|(value, _)| !value.is_empty())
        .collect()
}

fn make_tags(
    pairs: impl IntoIterator<Item = (String, String)>,
) -> Result<Vec<TrainingTag>, String> {
    let mut seen = HashSet::new();
    let mut tags = Vec::new();
    for (value, source) in pairs {
        validate_source(&source)?;
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.chars().count() > MAX_TAG_LENGTH {
            return Err("单个训练标签不能超过 200 个字符".into());
        }
        let normalized_value = normalize_tag(value);
        if normalized_value.is_empty() || !seen.insert(normalized_value.clone()) {
            continue;
        }
        tags.push(TrainingTag {
            value: value.to_string(),
            normalized_value,
            source,
            position: tags.len() as u32,
        });
        if tags.len() > MAX_TAGS_PER_ASSET {
            return Err("单张图片最多保存 2000 个训练标签".into());
        }
    }
    Ok(tags)
}

fn validate_source(source: &str) -> Result<(), String> {
    if matches!(
        source,
        "auto" | "ai_cleaned" | "manual" | "imported" | "trigger"
    ) {
        Ok(())
    } else {
        Err("训练标签来源不正确".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /** 重新打标只替换 AUTO，并保留人工、导入和触发词来源。 */
    #[test]
    fn automatic_retag_preserves_non_auto_sources() {
        let current = make_tags([
            ("my_trigger".into(), "trigger".into()),
            ("blue hair".into(), "imported".into()),
            ("solo".into(), "auto".into()),
            ("custom pose".into(), "manual".into()),
        ])
        .expect("创建原标签");
        let updated = reconcile_auto_tags(
            &current,
            vec!["1girl".into(), "standing".into()],
            &["my_trigger".into()],
        )
        .expect("重新打标");
        assert!(updated
            .iter()
            .any(|tag| tag.value == "blue hair" && tag.source == "imported"));
        assert!(updated
            .iter()
            .any(|tag| tag.value == "custom pose" && tag.source == "manual"));
        assert!(!updated.iter().any(|tag| tag.value == "solo"));
        assert!(updated
            .iter()
            .any(|tag| tag.value == "standing" && tag.source == "auto"));
    }

    /** 规范键消除大小写、下划线和空白造成的同义重复。 */
    #[test]
    fn caption_parser_deduplicates_normalized_tags() {
        let tags =
            parse_caption("Blue_Hair, blue hair,  BLUE   HAIR , solo").expect("解析 Caption");
        assert_eq!(tags, vec!["Blue_Hair", "solo"]);
    }
}
