//! 本模块统一管理训练图片同名 Caption 文件的原子替换、回滚和提交清理。

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

/** 一次已落盘但仍可回滚的 Caption 文件替换。 */
pub(crate) struct CaptionFileSwap {
    label_path: PathBuf,
    backup_path: PathBuf,
    had_label: bool,
}

/** 在受管训练集目录内替换或删除同名 `.txt`，数据库提交前保留旧文件备份。 */
pub(crate) fn stage_caption_file(
    dataset_root: &Path,
    image_path: &Path,
    caption: Option<&str>,
) -> Result<CaptionFileSwap, String> {
    if !image_path.starts_with(dataset_root) || image_path.parent() != Some(dataset_root) {
        return Err("训练图片存储路径不受控".into());
    }
    let label_path = image_path.with_extension("txt");
    let temporary_path = dataset_root.join(format!(".{}.txt.updating", Uuid::new_v4()));
    let backup_path = dataset_root.join(format!(".{}.txt.backup", Uuid::new_v4()));
    if let Some(caption) = caption {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|error| format!("创建 Caption 临时文件失败：{error}"))?;
        let write_result = file
            .write_all(caption.as_bytes())
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all());
        if let Err(error) = write_result {
            drop(file);
            let _ = fs::remove_file(&temporary_path);
            return Err(format!("保存 Caption 临时文件失败：{error}"));
        }
    }
    let had_label = label_path.is_file();
    if had_label {
        if let Err(error) = fs::rename(&label_path, &backup_path) {
            let _ = fs::remove_file(&temporary_path);
            return Err(format!("暂存原 Caption 文件失败：{error}"));
        }
    }
    if caption.is_some() {
        if let Err(error) = fs::rename(&temporary_path, &label_path) {
            if had_label {
                let _ = fs::rename(&backup_path, &label_path);
            }
            let _ = fs::remove_file(&temporary_path);
            return Err(format!("提交 Caption 文件失败：{error}"));
        }
    }
    Ok(CaptionFileSwap {
        label_path,
        backup_path,
        had_label,
    })
}

/** 数据库事务失败时撤销 Caption 文件替换。 */
pub(crate) fn rollback_caption_file(swap: CaptionFileSwap) {
    let _ = fs::remove_file(&swap.label_path);
    if swap.had_label {
        let _ = fs::rename(&swap.backup_path, &swap.label_path);
    }
}

/** 数据库事务成功后清理 Caption 旧文件备份。 */
pub(crate) fn finalize_caption_file(swap: CaptionFileSwap) {
    if swap.had_label {
        let _ = fs::remove_file(swap.backup_path);
    }
}

/** 批量事务失败时按逆序恢复所有 Caption 文件。 */
pub(crate) fn rollback_caption_files(mut swaps: Vec<CaptionFileSwap>) {
    while let Some(swap) = swaps.pop() {
        rollback_caption_file(swap);
    }
}

/** 批量事务成功后清理所有 Caption 文件备份。 */
pub(crate) fn finalize_caption_files(swaps: Vec<CaptionFileSwap>) {
    for swap in swaps {
        finalize_caption_file(swap);
    }
}
