//! 本模块集中管理底模、LoRA 受管文件删除和可预览的无引用文件清理，不触碰作品与训练集原图。

use crate::{
    models::{
        DesktopManagedFileDeleteInput, DesktopManagedFileRemovalView, DesktopSettings,
        DesktopStorageCleanupCategory, DesktopStorageCleanupInput, DesktopStorageCleanupView,
    },
    resource,
};
use rusqlite::{Connection, OptionalExtension};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Clone)]
struct CleanupCandidate {
    path: PathBuf,
    key: &'static str,
    label: &'static str,
}

/** 删除底模主文件；共享文本编码器和 VAE 继续供其他 Anima 底模复用。 */
pub fn delete_model_file(
    database: &Connection,
    settings: &DesktopSettings,
    input: DesktopManagedFileDeleteInput,
) -> Result<DesktopManagedFileRemovalView, String> {
    validate_id(&input.id)?;
    let model = database.query_row("SELECT model_file_name,model_relative_path,text_encoder_relative_path,vae_relative_path FROM local_models WHERE id=?1", [&input.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?))).optional().map_err(|error| format!("读取待删除底模失败：{error}"))?.ok_or_else(|| "本地底模不存在".to_string())?;
    let active: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM local_jobs WHERE model_id=?1 AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM local_training_jobs WHERE model_id=?1 AND status IN ('queued','running'))", [&input.id], |row| row.get(0)).map_err(|error| format!("检查底模活动任务失败：{error}"))?;
    if active {
        return Err("该底模仍被排队中或运行中的任务使用，请先完成或取消任务".into());
    }
    let (removed, freed_bytes) = remove_managed_file(
        Path::new(&settings.model_root),
        &model.1,
        "diffusion_models",
    )?;
    let retained_shared_files = [model.2, model.3]
        .into_iter()
        .flatten()
        .filter(|path| {
            managed_path(Path::new(&settings.model_root), path, None)
                .is_ok_and(|value| value.is_file())
        })
        .count() as u32;
    Ok(DesktopManagedFileRemovalView {
        id: input.id,
        kind: "model".into(),
        file_name: model.0,
        removed,
        freed_bytes,
        retained_shared_files,
    })
}

/** 删除 LoRA 文件；历史任务继续读取自己的标题、权重和哈希快照。 */
pub fn delete_lora_file(
    database: &Connection,
    settings: &DesktopSettings,
    input: DesktopManagedFileDeleteInput,
) -> Result<DesktopManagedFileRemovalView, String> {
    validate_id(&input.id)?;
    let lora = database
        .query_row(
            "SELECT file_name,relative_path FROM local_loras WHERE id=?1",
            [&input.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("读取待删除 LoRA 失败：{error}"))?
        .ok_or_else(|| "本地 LoRA 不存在".to_string())?;
    let active: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM local_job_loras l JOIN local_jobs j ON j.id=l.job_id WHERE l.lora_id=?1 AND j.status IN ('queued','running'))", [&input.id], |row| row.get(0)).map_err(|error| format!("检查 LoRA 活动任务失败：{error}"))?;
    if active {
        return Err("该 LoRA 仍被排队中或运行中的任务使用，请先完成或取消任务".into());
    }
    let (removed, freed_bytes) =
        remove_managed_file(Path::new(&settings.model_root), &lora.1, "loras")?;
    Ok(DesktopManagedFileRemovalView {
        id: input.id,
        kind: "lora".into(),
        file_name: lora.0,
        removed,
        freed_bytes,
        retained_shared_files: 0,
    })
}

/** 扫描或执行受管文件清理；执行前再次检查全部 GPU 任务，避免与写入过程竞争。 */
pub fn cleanup(
    database: &Connection,
    settings: &DesktopSettings,
    app_data_dir: &Path,
    input: DesktopStorageCleanupInput,
) -> Result<DesktopStorageCleanupView, String> {
    if input.execute {
        let active: bool = database.query_row("SELECT EXISTS(SELECT 1 FROM local_jobs WHERE status IN ('queued','running')) OR EXISTS(SELECT 1 FROM local_training_jobs WHERE status IN ('queued','running')) OR EXISTS(SELECT 1 FROM local_caption_jobs WHERE status IN ('queued','running'))", [], |row| row.get(0)).map_err(|error| format!("检查本地活动任务失败：{error}"))?;
        if active {
            return Err("存在排队中或运行中的本地任务，完成或取消后才能清理存储".into());
        }
    }
    let candidates = cleanup_candidates(database, settings, app_data_dir)?;
    let mut measured = Vec::new();
    for candidate in candidates {
        if let Some((files, bytes)) = measure_managed_path(&candidate.path)? {
            measured.push((candidate, files, bytes));
        }
    }
    let view = summarize(&measured, input.execute);
    if input.execute {
        for (candidate, _, _) in measured {
            remove_candidate(&candidate.path)?;
        }
    }
    Ok(view)
}

fn cleanup_candidates(
    database: &Connection,
    settings: &DesktopSettings,
    app_data_dir: &Path,
) -> Result<Vec<CleanupCandidate>, String> {
    let mut candidates = Vec::new();
    for path in resource::reclaimable_installed_cache_paths(settings, app_data_dir) {
        candidates.push(candidate(path, "dependency_cache", "已安装依赖缓存"));
    }
    collect_installed_lora_downloads(database, app_data_dir, &mut candidates)?;
    collect_terminal_training_workspaces(database, app_data_dir, &mut candidates)?;
    collect_residue_files(&app_data_dir.join("resource-cache"), &mut candidates);
    collect_residue_files(
        &app_data_dir.join("downloads").join("website-loras"),
        &mut candidates,
    );
    collect_residue_files(
        &Path::new(&settings.model_root)
            .join(".downloads")
            .join("website-models"),
        &mut candidates,
    );
    let runtime_root = Path::new(&settings.runtime_root);
    let model_root = Path::new(&settings.model_root);
    // 安装器会在目标目录的父级留下旧版本或失败暂存，按已知受管目录逐一扫描，不递归未知目录。
    for root in [
        runtime_root.to_path_buf(),
        runtime_root.join("components/captioner"),
        runtime_root.join("components/trainer"),
    ] {
        collect_install_residue(&root, &mut candidates);
    }
    for root in [
        model_root.to_path_buf(),
        model_root.join("diffusion_models"),
        model_root.join("text_encoders"),
        model_root.join("vae"),
        model_root.join("loras"),
    ] {
        collect_install_residue(&root, &mut candidates);
    }
    let mut seen = HashSet::new();
    candidates.retain(|item| seen.insert(path_key(&item.path)));
    Ok(candidates)
}

fn collect_installed_lora_downloads(
    database: &Connection,
    app_data_dir: &Path,
    candidates: &mut Vec<CleanupCandidate>,
) -> Result<(), String> {
    let mut statement = database
        .prepare("SELECT sha256,byte_size FROM local_loras")
        .map_err(|error| format!("读取 LoRA 清理引用失败：{error}"))?;
    let installed = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })
        .map_err(|error| format!("查询 LoRA 清理引用失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析 LoRA 清理引用失败：{error}"))?;
    let root = app_data_dir.join("downloads").join("website-loras");
    for path in read_files(&root) {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let size = path.metadata().map(|value| value.len()).unwrap_or(0);
        if path
            .extension()
            .is_some_and(|value| value.to_string_lossy().eq_ignore_ascii_case("safetensors"))
            && installed
                .iter()
                .any(|(sha256, bytes)| *bytes == size && name.contains(&sha256[..12]))
        {
            candidates.push(candidate(path, "download_residue", "重复下载与失败残留"));
        }
    }
    Ok(())
}

fn collect_terminal_training_workspaces(
    database: &Connection,
    app_data_dir: &Path,
    candidates: &mut Vec<CleanupCandidate>,
) -> Result<(), String> {
    let mut statement = database
        .prepare("SELECT id FROM local_training_jobs WHERE status NOT IN ('queued','running')")
        .map_err(|error| format!("读取训练工作区清理状态失败：{error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询训练工作区清理状态失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析训练工作区清理状态失败：{error}"))?;
    let root = app_data_dir.join("training-workspaces");
    for id in ids
        .into_iter()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
    {
        let path = root.join(id);
        if path.is_dir() {
            candidates.push(candidate(path, "training_workspace", "已结束训练工作区"));
        }
    }
    Ok(())
}

fn collect_residue_files(root: &Path, candidates: &mut Vec<CleanupCandidate>) {
    for path in read_files(root) {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if name.contains(".invalid-")
            || name.contains(".checksum-invalid.")
            || name.contains(".archive-invalid.")
            || name.contains(".unverified.")
            || name.starts_with(".drawhime-import-")
            || name.starts_with(".drawhime-install-")
        {
            candidates.push(candidate(path, "download_residue", "重复下载与失败残留"));
        }
    }
}

fn collect_install_residue(root: &Path, candidates: &mut Vec<CleanupCandidate>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_install_residue_name(&name) {
            candidates.push(candidate(path, "install_residue", "旧版本与安装残留"));
        }
    }
}

/** 只接受安装器生成的严格命名，不能把用户自行放入受管目录的普通备份当成残留。 */
fn is_install_residue_name(name: &str) -> bool {
    if name.starts_with(".drawhime-install-") {
        return true;
    }
    let Some((_, suffix)) = name.rsplit_once(".previous-") else {
        return false;
    };
    let Some((timestamp, id)) = suffix.split_once('-') else {
        return false;
    };
    timestamp.len() == 14
        && timestamp
            .chars()
            .all(|character| character.is_ascii_digit())
        && uuid::Uuid::parse_str(id).is_ok()
}

fn read_files(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect()
}
fn candidate(path: PathBuf, key: &'static str, label: &'static str) -> CleanupCandidate {
    CleanupCandidate { path, key, label }
}

fn summarize(
    measured: &[(CleanupCandidate, u64, u64)],
    executed: bool,
) -> DesktopStorageCleanupView {
    let mut grouped: HashMap<&str, (&str, u64, u64)> = HashMap::new();
    for (candidate, files, bytes) in measured {
        let entry = grouped
            .entry(candidate.key)
            .or_insert((candidate.label, 0, 0));
        entry.1 += files;
        entry.2 += bytes;
    }
    let order = [
        "dependency_cache",
        "download_residue",
        "training_workspace",
        "install_residue",
    ];
    let categories = order
        .into_iter()
        .filter_map(|key| {
            grouped.remove(key).map(|(label, file_count, byte_size)| {
                DesktopStorageCleanupCategory {
                    key: key.into(),
                    label: label.into(),
                    file_count,
                    byte_size,
                }
            })
        })
        .collect::<Vec<_>>();
    DesktopStorageCleanupView {
        executed,
        total_files: categories.iter().map(|item| item.file_count).sum(),
        total_bytes: categories.iter().map(|item| item.byte_size).sum(),
        categories,
    }
}

fn remove_managed_file(root: &Path, relative: &str, category: &str) -> Result<(bool, u64), String> {
    let path = managed_path(root, relative, Some(category))?;
    if !path.exists() {
        return Ok((false, 0));
    }
    let metadata = safe_metadata(&path)?;
    if !metadata.is_file() {
        return Err("受管模型路径不是普通文件".into());
    }
    let bytes = metadata.len();
    fs::remove_file(&path).map_err(|error| format!("删除受管模型文件失败：{error}"))?;
    let marker = path.with_file_name(format!(
        "{}.drawhime-resource.json",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    if marker.is_file() {
        fs::remove_file(marker).map_err(|error| format!("删除模型安装标记失败：{error}"))?;
    }
    Ok((true, bytes))
}

fn managed_path(
    root: &Path,
    relative: &str,
    required_category: Option<&str>,
) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("受管文件路径不安全".into());
    }
    if required_category.is_some_and(|category| {
        relative
            .components()
            .next()
            .and_then(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            != Some(category)
    }) {
        return Err("受管文件目录与资源类型不一致".into());
    }
    Ok(root.join(relative))
}

fn measure_managed_path(path: &Path) -> Result<Option<(u64, u64)>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = safe_metadata(path)?;
    if metadata.is_file() {
        return Ok(Some((1, metadata.len())));
    }
    if !metadata.is_dir() {
        return Err("清理候选不是普通文件或目录".into());
    }
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    let entries = fs::read_dir(path).map_err(|error| format!("读取清理目录失败：{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取清理目录项失败：{error}"))?;
        if let Some((child_files, child_bytes)) = measure_managed_path(&entry.path())? {
            files += child_files;
            bytes += child_bytes;
        }
    }
    Ok(Some((files, bytes)))
}

fn remove_candidate(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = safe_metadata(path)?;
    if metadata.is_file() {
        fs::remove_file(path).map_err(|error| format!("清理受管文件失败：{error}"))
    } else if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("清理受管目录失败：{error}"))
    } else {
        Err("清理候选类型不受支持".into())
    }
}

fn safe_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("读取受管文件元数据失败：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("受管清理路径不得是符号链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("受管清理路径不得是重解析点".into());
        }
    }
    Ok(metadata)
}

fn validate_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "资源 ID 不正确".to_string())
}
fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_delete_keeps_shared_components_and_blocks_active_job() {
        let temporary = tempfile::tempdir().expect("创建模型删除测试目录");
        let settings = test_settings(temporary.path());
        let model_root = Path::new(&settings.model_root);
        fs::create_dir_all(model_root.join("diffusion_models")).expect("创建底模目录");
        fs::create_dir_all(model_root.join("text_encoders")).expect("创建文本编码器目录");
        fs::create_dir_all(model_root.join("vae")).expect("创建 VAE 目录");
        fs::write(
            model_root.join("diffusion_models/model.safetensors"),
            b"model",
        )
        .expect("写入底模");
        fs::write(
            model_root.join("text_encoders/qwen.safetensors"),
            b"encoder",
        )
        .expect("写入文本编码器");
        fs::write(model_root.join("vae/vae.safetensors"), b"vae").expect("写入 VAE");
        let database = Connection::open_in_memory().expect("创建删除测试数据库");
        database.execute_batch("CREATE TABLE local_models(id TEXT PRIMARY KEY,model_file_name TEXT,model_relative_path TEXT,text_encoder_relative_path TEXT,vae_relative_path TEXT); CREATE TABLE local_jobs(id TEXT,model_id TEXT,status TEXT); CREATE TABLE local_training_jobs(id TEXT,model_id TEXT,status TEXT);").expect("创建删除测试表");
        let id = uuid::Uuid::new_v4().to_string();
        database.execute("INSERT INTO local_models VALUES(?1,'model.safetensors','diffusion_models/model.safetensors','text_encoders/qwen.safetensors','vae/vae.safetensors')", [&id]).expect("登记删除测试底模");
        database
            .execute("INSERT INTO local_jobs VALUES('job',?1,'running')", [&id])
            .expect("登记活动任务");
        assert!(delete_model_file(
            &database,
            &settings,
            DesktopManagedFileDeleteInput { id: id.clone() }
        )
        .is_err());
        database
            .execute("UPDATE local_jobs SET status='succeeded'", [])
            .expect("结束活动任务");
        let result = delete_model_file(&database, &settings, DesktopManagedFileDeleteInput { id })
            .expect("删除底模文件");
        assert!(result.removed);
        assert_eq!(result.retained_shared_files, 2);
        assert!(model_root.join("text_encoders/qwen.safetensors").is_file());
    }

    #[test]
    fn install_residue_name_rejects_unknown_user_backup() {
        let id = uuid::Uuid::new_v4();
        assert!(is_install_residue_name(&format!(
            "current.previous-20260731123045-{id}"
        )));
        assert!(is_install_residue_name(&format!(".drawhime-install-{id}")));
        assert!(!is_install_residue_name("my.previous-backup"));
        assert!(!is_install_residue_name(
            "current.previous-20260731-not-a-uuid"
        ));
    }

    fn test_settings(root: &Path) -> DesktopSettings {
        DesktopSettings {
            theme_mode: "system".into(),
            font_scale: 1.1,
            content_font_scale: 1.2,
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
}
