/**
 * 本文件把独立训练集打标工具与分步骤 LoRA 训练流程拆分为两个桌面页面。
 */
import { resolveTrainingCycles, type DesktopAiCleanJobView, type DesktopBackgroundRemovalJobView, type DesktopCaptionJobCreateInput, type DesktopCaptionJobView, type DesktopLocalModelView, type DesktopTrainingDatasetCreateInput, type DesktopTrainingDatasetImportPreview, type DesktopTrainingDatasetView, type DesktopTrainingJobCreateInput, type DesktopTrainingJobView, type TrainingTagTranslationView } from "@drawhime/contracts";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ArrowDownAZ, ArrowLeft, ArrowRight, ArrowUpAZ, BookOpenCheck, Check, CircleHelp, Copy, Download, FileArchive, FlaskConical, FolderOpen, FolderPlus, Grid2X2, Images, ListChecks, LoaderCircle, Paintbrush, Pause, Play, Plus, Power, RotateCcw, Save, Scissors, ShieldCheck, Sparkles, Tags, Trash2, Upload, X } from "lucide-react";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addDesktopTrainingImages, applyDesktopAiClean, batchUpdateDesktopTrainingTags, cancelDesktopAiCleanJob, cancelDesktopBackgroundRemovalJob, cancelDesktopCaptionJob, cancelDesktopTrainingJob, confirmDesktopTrainingDataset, createDesktopAiCleanJob, createDesktopBackgroundRemovalJob, createDesktopCaptionJob, createDesktopTrainingDataset, createDesktopTrainingJob, deleteDesktopTrainingAsset, deleteDesktopTrainingDataset, importDesktopTrainingDataset, listDesktopAiCleanJobs, pauseDesktopAiCleanJob, pauseDesktopBackgroundRemovalJob, pauseDesktopCaptionJob, previewDesktopTrainingDatasetImport, resumeDesktopAiCleanJob, resumeDesktopBackgroundRemovalJob, resumeDesktopCaptionJob, selectDesktopTrainingAssetVariant, translateDesktopTrainingTags, undoDesktopAiClean, updateDesktopTrainingCaption, updateDesktopTrainingTriggerWords } from "./desktop-api";
import { TrainingMaskEditor } from "./TrainingMaskEditor";

type TagTranslation = TrainingTagTranslationView["translations"][number];
type TranslationMap = Record<string, TagTranslation>;

interface CaptioningPageProps {
  datasets: DesktopTrainingDatasetView[];
  captionJobs: DesktopCaptionJobView[];
  backgroundRemovalJobs: DesktopBackgroundRemovalJobView[];
  aiCleanJobs: DesktopAiCleanJobView[];
  captioningReady: boolean;
  segmenterReady: boolean;
  onUpdated: (dataset: DesktopTrainingDatasetView) => void;
  onDeleted: (datasetId: string) => void;
  onCaptionJobUpdated: (job: DesktopCaptionJobView) => void;
  onBackgroundRemovalJobUpdated: (job: DesktopBackgroundRemovalJobView) => void;
  onAiCleanJobUpdated: (job: DesktopAiCleanJobView) => void;
  onOpenResources: () => void;
  onError: (message: string) => void;
}

interface LoraTrainingPageProps {
  datasets: DesktopTrainingDatasetView[];
  trainingJobs: DesktopTrainingJobView[];
  models: DesktopLocalModelView[];
  trainingReady: boolean;
  coreRunning: boolean;
  onTrainingJobUpdated: (job: DesktopTrainingJobView) => void;
  onOpenResources: () => void;
  onError: (message: string) => void;
}

/** 打标页只管理可复用训练集，不因是否训练过 LoRA 改变编辑能力。 */
export function CaptioningPage({ datasets, captionJobs, backgroundRemovalJobs, aiCleanJobs, captioningReady, segmenterReady, onUpdated, onDeleted, onCaptionJobUpdated, onBackgroundRemovalJobUpdated, onAiCleanJobUpdated, onOpenResources, onError }: CaptioningPageProps) {
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<DesktopTrainingDatasetCreateInput>({ title: "", type: "character", triggerWords: [] });
  const [triggerText, setTriggerText] = useState("");
  const [detailTriggerText, setDetailTriggerText] = useState("");
  const [translations, setTranslations] = useState<TranslationMap>({});
  const [translationError, setTranslationError] = useState("");
  const requestedTranslations = useRef(new Set<string>());
  const translationsSnapshot = useRef<TranslationMap>({});
  const completedTranslationRefresh = useRef(0);
  const [translationRefresh, setTranslationRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<DesktopTrainingDatasetImportPreview | null>(null);
  const [importTitle, setImportTitle] = useState("");
  const [importType, setImportType] = useState<DesktopTrainingDatasetCreateInput["type"]>("character");
  const [importTriggers, setImportTriggers] = useState("");
  const [captionOptions, setCaptionOptions] = useState<Pick<DesktopCaptionJobCreateInput, "generalThreshold" | "characterThreshold" | "includeCharacterTags">>({ generalThreshold: 0.35, characterThreshold: 0.85, includeCharacterTags: false });
  const [trainingGoal, setTrainingGoal] = useState("");
  const [layout, setLayout] = useState<"cards" | "batch">(() => window.localStorage.getItem("drawhime-caption-layout") === "batch" ? "batch" : "cards");
  const [sortKey, setSortKey] = useState<"created" | "name" | "untagged">("created");
  const [sortAscending, setSortAscending] = useState(true);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [focusedAssetId, setFocusedAssetId] = useState("");
  const [batchTagText, setBatchTagText] = useState("");
  const [batchProgress, setBatchProgress] = useState<{ total: number; completed: number; succeeded: number; failed: number } | null>(null);
  const [maskAssetId, setMaskAssetId] = useState("");
  const selected = datasets.find((dataset) => dataset.id === selectedId) || null;
  const activeCaptionJob = captionJobs.find((job) => job.datasetId === selectedId && ["queued", "running", "paused"].includes(job.status)) || null;
  const latestCaptionJob = captionJobs.find((job) => job.datasetId === selectedId) || null;
  const activeBackgroundRemovalJob = backgroundRemovalJobs.find((job) => job.datasetId === selectedId && ["queued", "running", "paused"].includes(job.status)) || null;
  const latestBackgroundRemovalJob = backgroundRemovalJobs.find((job) => job.datasetId === selectedId) || null;
  const activeAiCleanJob = aiCleanJobs.find((job) => job.datasetId === selectedId && ["queued", "running", "paused"].includes(job.status)) || null;
  const latestAiCleanJob = aiCleanJobs.find((job) => job.datasetId === selectedId) || null;
  const allTags = useMemo(() => [...new Set((selected?.assets || []).flatMap((asset) => splitTags(asset.caption || "")))], [selected?.assets]);
  const sortedAssets = useMemo(() => [...(selected?.assets || [])].sort((left, right) => {
    const direction = sortAscending ? 1 : -1;
    if (sortKey === "name") return direction * left.fileName.localeCompare(right.fileName, "zh-CN");
    if (sortKey === "untagged") return direction * (Number(Boolean(left.caption?.trim())) - Number(Boolean(right.caption?.trim())) || left.createdAt.localeCompare(right.createdAt));
    return direction * left.createdAt.localeCompare(right.createdAt);
  }), [selected?.assets, sortAscending, sortKey]);
  useEffect(() => { if (selectedId && !datasets.some((dataset) => dataset.id === selectedId)) setSelectedId(""); }, [datasets, selectedId]);
  useEffect(() => { window.localStorage.setItem("drawhime-caption-layout", layout); }, [layout]);
  useEffect(() => {
    const available = new Set(selected?.assets.map((asset) => asset.id) || []);
    setSelectedAssetIds((current) => new Set([...current].filter((id) => available.has(id))));
    if (!focusedAssetId || !available.has(focusedAssetId)) setFocusedAssetId(selected?.assets[0]?.id || "");
  }, [selected?.id, selected?.assets, focusedAssetId]);
  useEffect(() => { setDetailTriggerText(selected?.triggerWords.join(", ") || ""); }, [selected?.id, selected?.triggerWords]);
  useEffect(() => { translationsSnapshot.current = translations; }, [translations]);
  useEffect(() => { translationsSnapshot.current = {}; setTranslations({}); setTranslationError(""); requestedTranslations.current.clear(); completedTranslationRefresh.current = 0; setTranslationRefresh(0); }, [selected?.id]);
  // 已登录时定期刷新当前训练集的翻译映射；窗口重新获得焦点也立即与网页词库对齐。
  useEffect(() => {
    if (!selected) return undefined;
    const refresh = () => setTranslationRefresh((current) => current + 1);
    const timer = window.setInterval(refresh, 5 * 60_000);
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [selected?.id]);
  useEffect(() => {
    const forceRefresh = translationRefresh !== completedTranslationRefresh.current;
    const pending = forceRefresh ? allTags : allTags.filter((tag) => !translationsSnapshot.current[tag] && !requestedTranslations.current.has(tag));
    if (!pending.length) { if (forceRefresh) completedTranslationRefresh.current = translationRefresh; return; }
    pending.forEach((tag) => requestedTranslations.current.add(tag));
    let cancelled = false;
    void (async () => {
      const received: TranslationMap = {};
      for (let index = 0; index < pending.length; index += 200) {
        const result = await translateDesktopTrainingTags({ tags: pending.slice(index, index + 200) });
        if (cancelled) return;
        Object.assign(received, Object.fromEntries(result.translations.map((item) => [item.tag, item])));
      }
      if (!cancelled) {
        const next = { ...translationsSnapshot.current, ...received };
        translationsSnapshot.current = next;
        completedTranslationRefresh.current = translationRefresh;
        setTranslations(next);
        setTranslationError("");
      }
    })().catch((error) => { pending.forEach((tag) => requestedTranslations.current.delete(tag)); if (!cancelled) setTranslationError(errorMessage(error)); });
    return () => { cancelled = true; pending.forEach((tag) => requestedTranslations.current.delete(tag)); };
  }, [allTags, translationRefresh]);

  /** 新训练集只登记元数据，图片仍由用户明确选择后原子导入。 */
  const create = async () => {
    if (busy || !form.title.trim()) return;
    setBusy(true);
    try {
      const triggerWords = triggerText.split(/[,，\n]/).map((word) => word.trim()).filter(Boolean);
      const dataset = await createDesktopTrainingDataset({ ...form, title: form.title.trim(), triggerWords });
      onUpdated(dataset); setSelectedId(dataset.id); setForm((current) => ({ ...current, title: "", triggerWords: [] })); setTriggerText("");
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 目录与压缩包先进入受控预检，不在用户确认前创建训练集记录。 */
  const chooseDatasetSource = async (kind: "folder" | "archive") => {
    if (busy) return;
    try {
      const chosen = await open(kind === "folder" ? { directory: true, multiple: false } : { directory: false, multiple: false, filters: [{ name: "训练集压缩包", extensions: ["zip", "7z", "tar", "gz", "tgz"] }] });
      if (typeof chosen !== "string") return;
      setBusy(true);
      const preview = await previewDesktopTrainingDatasetImport({ sourcePath: chosen });
      setImportPreview(preview);
      setImportTitle(preview.suggestedTitle);
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 正式导入只提交预检 UUID，核心会再次校验哈希和有效期。 */
  const confirmDatasetImport = async () => {
    if (!importPreview?.canImport || !importTitle.trim() || busy) return;
    setBusy(true);
    try {
      const dataset = await importDesktopTrainingDataset({ previewId: importPreview.id, title: importTitle.trim(), type: importType, triggerWords: parseTriggerWords(importTriggers) });
      onUpdated(dataset);
      setSelectedId(dataset.id);
      setImportOpen(false);
      setImportPreview(null);
      setImportTriggers("");
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 图片导入后训练集回到可编辑状态，既有训练任务及其快照不受影响。 */
  const addImages = async () => {
    if (!selected || busy) return;
    try {
      const chosen = await open({ multiple: true, directory: false, filters: [{ name: "训练图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      const sourcePaths = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : [];
      if (!sourcePaths.length) return;
      setBusy(true); onUpdated(await addDesktopTrainingImages({ datasetId: selected.id, sourcePaths }));
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 确认只标记当前内容可用于下一次训练，不冻结训练集。 */
  const confirm = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try { onUpdated(await confirmDesktopTrainingDataset({ datasetId: selected.id })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 触发词属于训练集可编辑元数据，保存后只影响后续训练任务快照。 */
  const saveTriggerWords = async () => {
    if (!selected || busy) return;
    const triggerWords = parseTriggerWords(detailTriggerText);
    if (triggerWords.join("\n") === selected.triggerWords.join("\n")) return;
    setBusy(true);
    try { onUpdated(await updateDesktopTrainingTriggerWords({ datasetId: selected.id, triggerWords })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 批量任务保护人工 Caption；单图按钮代表用户明确要求覆盖识别。 */
  const caption = async (target: string | string[] | null) => {
    if (!selected || busy || activeCaptionJob || !captioningReady) return;
    setBusy(true);
    try { onCaptionJobUpdated(await createDesktopCaptionJob({ datasetId: selected.id, assetId: typeof target === "string" ? target : null, assetIds: Array.isArray(target) ? target : null, ...captionOptions })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 打标暂停、恢复与取消共用持久化任务控制，不在前端伪造状态。 */
  const controlCaption = async (action: "pause" | "resume" | "cancel") => {
    if (!activeCaptionJob || busy) return;
    setBusy(true);
    try {
      const job = action === "pause" ? await pauseDesktopCaptionJob(activeCaptionJob.id) : action === "resume" ? await resumeDesktopCaptionJob(activeCaptionJob.id) : await cancelDesktopCaptionJob(activeCaptionJob.id);
      onCaptionJobUpdated(job);
    }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** AI 清洗只创建建议任务，单图或批量结果都需要用户逐项确认后才会写入标签。 */
  const cleanTags = async (assetIds: string[]) => {
    if (!selected || busy || activeAiCleanJob || !assetIds.length) return;
    setBusy(true);
    try { onAiCleanJobUpdated(await createDesktopAiCleanJob({ datasetId: selected.id, assetIds, trainingGoal: trainingGoal.trim() })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** AI 清洗暂停后保留已有建议，恢复时只继续未完成图片。 */
  const controlAiClean = async (action: "pause" | "resume" | "cancel") => {
    if (!activeAiCleanJob || busy) return;
    setBusy(true);
    try {
      const job = action === "pause" ? await pauseDesktopAiCleanJob(activeAiCleanJob.id) : action === "resume" ? await resumeDesktopAiCleanJob(activeAiCleanJob.id) : await cancelDesktopAiCleanJob(activeAiCleanJob.id);
      onAiCleanJobUpdated(job);
    }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 自动抠图只生成派生文件，用户需要明确选择训练使用的版本。 */
  const removeBackground = async (assetIds: string[]) => {
    if (!selected || busy || activeBackgroundRemovalJob || !segmenterReady || !assetIds.length) return;
    setBusy(true);
    try { onBackgroundRemovalJobUpdated(await createDesktopBackgroundRemovalJob({ datasetId: selected.id, assetIds })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 暂停、恢复和取消都写入 SQLite，Worker 重启后仍按持久状态收敛。 */
  const controlBackgroundRemoval = async (action: "pause" | "resume" | "cancel") => {
    if (!activeBackgroundRemovalJob || busy) return;
    setBusy(true);
    try {
      const job = action === "pause" ? await pauseDesktopBackgroundRemovalJob(activeBackgroundRemovalJob.id) : action === "resume" ? await resumeDesktopBackgroundRemovalJob(activeBackgroundRemovalJob.id) : await cancelDesktopBackgroundRemovalJob(activeBackgroundRemovalJob.id);
      onBackgroundRemovalJobUpdated(job);
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 删除单图前明确确认；训练任务读取独立 Blob，不会锁住原训练集图片。 */
  const deleteAsset = async (assetId: string) => {
    if (!selected || busy || !window.confirm("删除这张训练图片及其当前标签？原始导入文件不会被修改。")) return;
    setBusy(true);
    try { onUpdated(await deleteDesktopTrainingAsset({ datasetId: selected.id, assetId })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 删除训练集只清理当前可编辑资产，历史训练任务和 LoRA 始终保留。 */
  const deleteDataset = async () => {
    if (!selected || busy || !window.confirm(`删除训练集“${selected.title}”及其当前图片和标签？历史训练快照、训练记录和 LoRA 不会删除。`)) return;
    setBusy(true);
    try {
      const deletedId = await deleteDesktopTrainingDataset({ datasetId: selected.id });
      setSelectedId("");
      onDeleted(deletedId);
      onError("训练集已删除，历史训练快照和 LoRA 已保留");
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  /** 批量标签只跨越一次 IPC，由核心整体同步 SQLite 与全部同名 TXT。 */
  const editSelectedTags = async (mode: "add" | "remove") => {
    if (!selected || busy || batchProgress || !selectedAssetIds.size) return;
    const requested = splitTags(batchTagText);
    if (!requested.length) { onError("请输入至少一个有效英文标签"); return; }
    const assetIds = [...selectedAssetIds];
    setBatchProgress({ total: assetIds.length, completed: 0, succeeded: 0, failed: 0 });
    try {
      onUpdated(await batchUpdateDesktopTrainingTags({ datasetId: selected.id, assetIds, operation: mode, tags: requested }));
      setBatchProgress({ total: assetIds.length, completed: assetIds.length, succeeded: assetIds.length, failed: 0 });
      setBatchTagText("");
    } catch (error) {
      setBatchProgress({ total: assetIds.length, completed: assetIds.length, succeeded: 0, failed: assetIds.length });
      onError(errorMessage(error));
    }
    window.setTimeout(() => setBatchProgress(null), 1500);
  };
  /** 批量删除逐张执行受控文件事务，任何失败不会中断或回滚已完成图片。 */
  const deleteSelectedAssets = async () => {
    if (!selected || busy || batchProgress || !selectedAssetIds.size || !window.confirm(`删除选中的 ${selectedAssetIds.size} 张训练图片及标签？原始导入文件不会被修改。`)) return;
    const targets = selected.assets.filter((asset) => selectedAssetIds.has(asset.id));
    setBatchProgress({ total: targets.length, completed: 0, succeeded: 0, failed: 0 });
    let latest: DesktopTrainingDatasetView | null = null;
    let succeeded = 0;
    let failed = 0;
    for (const asset of targets) {
      try { latest = await deleteDesktopTrainingAsset({ datasetId: selected.id, assetId: asset.id }); succeeded += 1; }
      catch { failed += 1; }
      setBatchProgress({ total: targets.length, completed: succeeded + failed, succeeded, failed });
    }
    if (latest) onUpdated(latest);
    setSelectedAssetIds(new Set());
    setBatchProgress(null);
    onError(failed ? `批量删除完成：成功 ${succeeded}，失败 ${failed}` : `已删除 ${succeeded} 张图片`);
  };
  const missingCaptions = selected?.assets.filter((asset) => !asset.caption?.trim()).length || 0;
  const unavailableAssets = selected?.assets.filter((asset) => !asset.available).length || 0;
  const batchCandidates = selected?.assets.filter((asset) => asset.tags.every((tag) => ["auto", "trigger"].includes(tag.source))).length || 0;
  const renderAsset = (asset: DesktopTrainingDatasetView["assets"][number]) => <TrainingAssetRow key={asset.id} datasetId={selected?.id || ""} asset={asset} captionItem={latestCaptionJob?.items.find((item) => item.assetId === asset.id) || null} aiCleanJob={latestAiCleanJob} aiCleanItem={latestAiCleanJob?.items.find((item) => item.assetId === asset.id) || null} translations={translations} captioningReady={captioningReady} segmenterReady={segmenterReady} captionJobActive={Boolean(activeCaptionJob)} aiCleanJobActive={Boolean(activeAiCleanJob)} backgroundRemovalActive={Boolean(activeBackgroundRemovalJob)} onRetag={() => void caption(asset.id)} onClean={() => void cleanTags([asset.id])} onAutoRemove={() => void removeBackground([asset.id])} onManualRemove={() => setMaskAssetId(asset.id)} onDelete={() => void deleteAsset(asset.id)} onUpdated={onUpdated} onAiCleanJobUpdated={onAiCleanJobUpdated} onError={onError} />;

  if (!selected) return <div className="desktop-page training-page captioning-page captioning-library-page">
    <section className="section-card training-create"><header><div><span>DATASET WORKSPACE</span><h2>创建训练集</h2></div><small>训练集创建后进入独立页面管理图片、触发词与标签</small></header><div><label><span>训练集标题</span><input maxLength={191} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：角色立绘训练集" /></label><label><span>训练类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as DesktopTrainingDatasetCreateInput["type"] })}><option value="character">角色</option><option value="style">画风</option><option value="object">服装 / 物体</option><option value="concept">概念</option></select></label><label><span>初始触发词</span><input value={triggerText} onChange={(event) => setTriggerText(event.target.value)} placeholder="建议使用唯一、无语义的英文词" /></label><button disabled={busy || !form.title.trim()} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" /> : <FolderPlus />}创建训练集</button></div></section>
    <section className="section-card caption-dataset-library"><header><div><span>DATASET LIBRARY</span><h2>训练集</h2></div><div className="dataset-library-actions"><small>{datasets.length} 个训练集</small><button type="button" onClick={() => { setImportOpen(true); setImportPreview(null); }}><FolderOpen />导入训练集</button></div></header>{datasets.length ? <div className="caption-dataset-grid">{datasets.map((dataset) => { const missing = dataset.assets.filter((asset) => !asset.caption?.trim()).length; return <button key={dataset.id} type="button" onClick={() => setSelectedId(dataset.id)}><i><Images /></i><span><strong>{dataset.title}</strong><small>{trainingTypeLabel(dataset.type)} · {dataset.assets.length} 张 · {missing ? `${missing} 张待打标` : "标签完整"}</small><em>{dataset.triggerWords.join(", ") || "未设置触发词"}</em></span><b className={`is-${dataset.status}`}>{trainingStatusLabel(dataset.status)}</b><ArrowRight /></button>; })}</div> : <div className="empty-block">创建第一个训练集后，可在独立详情页逐图打标和维护触发词。</div>}</section>
    {importOpen && <div className="dataset-import-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) setImportOpen(false); }}><section className="dataset-import-dialog" role="dialog" aria-modal="true" aria-label="导入训练集"><header><div><span>DATASET IMPORT</span><h2>导入通用训练集</h2><p>图片与同名 TXT 自动配对；确认前不会修改训练集。</p></div><button type="button" disabled={busy} onClick={() => setImportOpen(false)} aria-label="关闭"><X /></button></header><div className="dataset-import-source"><button type="button" disabled={busy} onClick={() => void chooseDatasetSource("folder")}><FolderOpen /><span><strong>选择文件夹</strong><small>递归读取图片和同名 TXT</small></span></button><button type="button" disabled={busy} onClick={() => void chooseDatasetSource("archive")}><FileArchive /><span><strong>选择压缩包</strong><small>ZIP、7Z、TAR、TAR.GZ、TGZ</small></span></button></div>{busy && !importPreview && <div className="dataset-import-loading"><LoaderCircle className="spin" />正在安全预检训练集</div>}{importPreview && <><div className="dataset-import-summary"><span><strong>{importPreview.imageCount}</strong><small>图片</small></span><span><strong>{importPreview.pairedTagCount}</strong><small>已配对标签</small></span><span><strong>{importPreview.untaggedCount}</strong><small>未打标</small></span><span className={importPreview.anomalyCount ? "has-anomaly" : ""}><strong>{importPreview.anomalyCount}</strong><small>异常</small></span></div><div className={`dataset-import-gate ${importPreview.canImport ? "ready" : "blocked"}`}>{importPreview.canImport ? <ShieldCheck /> : <AlertTriangle />}<span><strong>{importPreview.canImport ? "预检通过" : "存在阻断异常"}</strong><small>{importPreview.sourceName} · {datasetImportKindLabel(importPreview.sourceKind)}</small></span></div>{importPreview.anomalies.length > 0 && <div className="dataset-import-anomalies">{importPreview.anomalies.map((item, index) => <div key={`${item.code}-${item.path}-${index}`} className={`is-${item.severity}`}><AlertTriangle /><span><strong>{item.message}</strong><small>{item.path || "训练集整体"}</small></span></div>)}</div>}<div className="dataset-import-fields"><label><span>训练集标题</span><input maxLength={191} value={importTitle} onChange={(event) => setImportTitle(event.target.value)} /></label><label><span>训练类型</span><select value={importType} onChange={(event) => setImportType(event.target.value as DesktopTrainingDatasetCreateInput["type"])}><option value="character">角色</option><option value="style">画风</option><option value="object">服装 / 物体</option><option value="concept">概念</option></select></label><label className="wide"><span>初始触发词</span><input value={importTriggers} onChange={(event) => setImportTriggers(event.target.value)} placeholder="可选，使用英文逗号分隔" /></label></div></>}<footer><button type="button" className="secondary" disabled={busy} onClick={() => setImportOpen(false)}>取消</button><button type="button" disabled={busy || !importPreview?.canImport || !importTitle.trim()} onClick={() => void confirmDatasetImport()}>{busy ? <LoaderCircle className="spin" /> : <Check />}{busy ? "正在导入" : "确认导入"}</button></footer></section></div>}
  </div>;

  return <div className="desktop-page training-page captioning-page">
    <section className="section-card training-editor training-dataset-detail">
        <header><div><button className="training-back" type="button" onClick={() => setSelectedId("")}><ArrowLeft />返回训练集</button><span>{trainingTypeLabel(selected.type)} · {selected.assets.length} 张图片</span><h2>{selected.title}</h2></div><div className="training-editor-actions"><button className="danger" disabled={busy || Boolean(activeCaptionJob) || Boolean(activeAiCleanJob) || Boolean(activeBackgroundRemovalJob)} onClick={() => void deleteDataset()}><Trash2 />删除训练集</button><button disabled={busy || selected.assets.length >= 200} onClick={() => void addImages()}><Upload />导入图片</button><button disabled={busy || Boolean(activeCaptionJob) || selected.assets.length < 5 || missingCaptions > 0 || unavailableAssets > 0} onClick={() => void confirm()}><BookOpenCheck />{selected.status === "confirmed" ? "重新确认" : "确认可训练"}</button></div></header>
        <div className="training-trigger-editor"><label><span>训练触发词</span><input value={detailTriggerText} maxLength={5049} onChange={(event) => setDetailTriggerText(event.target.value)} placeholder="使用英文逗号分隔；建议填写唯一、无语义的标签" /></label><button disabled={busy || parseTriggerWords(detailTriggerText).join("\n") === selected.triggerWords.join("\n")} onClick={() => void saveTriggerWords()}>{busy ? <LoaderCircle className="spin" /> : <Save />}保存触发词</button></div>
        <div className="training-gate"><span><strong>{selected.assets.length}/200 张</strong><small>{unavailableAssets ? `${unavailableAssets} 张文件缺失或已变化` : missingCaptions ? `${missingCaptions} 张缺少 Caption` : selected.assets.length >= 5 ? "全部 Caption 已填写，可随时继续编辑" : `还需 ${5 - selected.assets.length} 张图片`}</small></span><b className={`is-${selected.status}`}>{trainingStatusLabel(selected.status)}</b></div>
        <section className="caption-control"><div className="caption-control-title"><Tags /><span><strong>离线自动打标</strong><small>每张图片均可单独识别；批量操作只补齐非人工内容</small></span></div>{captioningReady ? <div className="caption-options"><label><span>通用阈值</span><input type="number" min={0.05} max={0.95} step={0.05} value={captionOptions.generalThreshold} onChange={(event) => setCaptionOptions({ ...captionOptions, generalThreshold: Number(event.target.value) })} /></label><label><span>角色阈值</span><input type="number" min={0.05} max={0.99} step={0.05} value={captionOptions.characterThreshold} onChange={(event) => setCaptionOptions({ ...captionOptions, characterThreshold: Number(event.target.value) })} /></label><label className="caption-character-toggle"><input type="checkbox" checked={captionOptions.includeCharacterTags} onChange={(event) => setCaptionOptions({ ...captionOptions, includeCharacterTags: event.target.checked })} /><span>包含角色标签</span></label><button disabled={busy || Boolean(activeCaptionJob) || batchCandidates === 0 || unavailableAssets > 0} onClick={() => void caption(null)}>{busy ? <LoaderCircle className="spin" /> : <Tags />}{activeCaptionJob ? "打标任务未结束" : `批量补齐 ${batchCandidates} 张`}</button></div> : <button className="caption-install" onClick={onOpenResources}><Download />安装打标组件</button>}{translationError && <small className="caption-translation-error">{translationError}；英文标签和编辑功能仍可使用。</small>}{latestCaptionJob && <CaptionJobStatus job={latestCaptionJob} active={Boolean(activeCaptionJob)} busy={busy} onControl={(action) => void controlCaption(action)} />}</section>
        <section className="caption-control ai-clean-control"><div className="caption-control-title"><Sparkles /><span><strong>AI 标签清洗</strong><small>结合训练类型、目标和图片生成建议；不会自动修改标签</small></span></div><div className="ai-clean-options"><label><span>训练目标</span><input maxLength={4000} value={trainingGoal} onChange={(event) => setTrainingGoal(event.target.value)} placeholder="例如：固定角色身份，保留服装、动作和背景为可控变量" /></label><button disabled={busy || Boolean(activeAiCleanJob) || selected.assets.length === 0 || unavailableAssets > 0 || missingCaptions > 0} onClick={() => void cleanTags(selected.assets.map((asset) => asset.id))}>{busy ? <LoaderCircle className="spin" /> : <Sparkles />}{activeAiCleanJob ? "清洗任务未结束" : `分析全部 ${selected.assets.length} 张`}</button></div>{latestAiCleanJob && <AiCleanJobStatus job={latestAiCleanJob} active={Boolean(activeAiCleanJob)} busy={busy} onControl={(action) => void controlAiClean(action)} />}</section>
        <section className="caption-control background-removal-control"><div className="caption-control-title"><Scissors /><span><strong>背景移除</strong><small>离线生成透明 PNG 派生版本；原图始终保留，训练版本可逐图选择</small></span></div>{segmenterReady ? <div className="background-removal-actions"><button disabled={busy || Boolean(activeBackgroundRemovalJob) || selected.assets.length === 0 || unavailableAssets > 0} onClick={() => void removeBackground(selected.assets.map((asset) => asset.id))}><Scissors />批量自动抠图</button>{activeBackgroundRemovalJob?.status === "running" && <button className="secondary" onClick={() => void controlBackgroundRemoval("pause")}><Pause />暂停</button>}{activeBackgroundRemovalJob?.status === "paused" && <button className="secondary" onClick={() => void controlBackgroundRemoval("resume")}><Play />恢复</button>}{activeBackgroundRemovalJob && <button className="secondary" onClick={() => void controlBackgroundRemoval("cancel")}><X />取消</button>}</div> : <button className="caption-install" onClick={onOpenResources}><Download />安装抠图组件</button>}{latestBackgroundRemovalJob && <BackgroundRemovalJobStatus job={latestBackgroundRemovalJob} />}</section>
        {selected.assets.length ? <><BatchWorkspaceToolbar layout={layout} sortKey={sortKey} sortAscending={sortAscending} selectedCount={selectedAssetIds.size} totalCount={selected.assets.length} batchTagText={batchTagText} progress={batchProgress} busy={busy || Boolean(activeCaptionJob) || Boolean(activeAiCleanJob) || Boolean(activeBackgroundRemovalJob)} onLayout={setLayout} onSortKey={setSortKey} onSortAscending={setSortAscending} onBatchTagText={setBatchTagText} onSelectAll={() => setSelectedAssetIds(selectedAssetIds.size === selected.assets.length ? new Set() : new Set(selected.assets.map((asset) => asset.id)))} onCaption={() => void caption([...selectedAssetIds])} onClean={() => void cleanTags([...selectedAssetIds])} onBackground={() => void removeBackground([...selectedAssetIds])} onAdd={() => void editSelectedTags("add")} onRemove={() => void editSelectedTags("remove")} onDelete={() => void deleteSelectedAssets()} /><div className={layout === "cards" ? "training-asset-list" : "training-batch-workspace"}>{layout === "cards" ? sortedAssets.map(renderAsset) : <><aside className="training-batch-thumbnails">{sortedAssets.map((asset) => <button key={asset.id} type="button" className={`${focusedAssetId === asset.id ? "active" : ""} ${selectedAssetIds.has(asset.id) ? "selected" : ""}`} onClick={() => setFocusedAssetId(asset.id)}><input type="checkbox" checked={selectedAssetIds.has(asset.id)} onClick={(event) => event.stopPropagation()} onChange={() => setSelectedAssetIds((current) => { const next = new Set(current); if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id); return next; })} aria-label={`选择 ${asset.fileName}`} />{asset.available ? <img loading="lazy" src={convertFileSrc(asset.path)} alt={asset.fileName} /> : <AlertTriangle />}<span><strong>{asset.fileName}</strong><small>{asset.tags.length} 个标签</small></span></button>)}</aside><div className="training-batch-editor">{sortedAssets.find((asset) => asset.id === focusedAssetId) ? renderAsset(sortedAssets.find((asset) => asset.id === focusedAssetId)!) : <div className="empty-block">选择一张图片开始编辑</div>}</div></>}</div></> : <div className="empty-block">导入 5–200 张 PNG、JPEG 或 WebP 开始整理训练集</div>}
        {maskAssetId && selected.assets.find((asset) => asset.id === maskAssetId) && <TrainingMaskEditor datasetId={selected.id} asset={selected.assets.find((asset) => asset.id === maskAssetId)!} onSaved={onUpdated} onClose={() => setMaskAssetId("")} onError={onError} />}
    </section>
  </div>;
}

/** LoRA 训练页通过可回退步骤验证训练集、参数和最终提交，不承担打标职责。 */
export function LoraTrainingPage({ datasets, trainingJobs, models, trainingReady, coreRunning, onTrainingJobUpdated, onOpenResources, onError }: LoraTrainingPageProps) {
  const [selectedId, setSelectedId] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, DesktopTrainingJobCreateInput>>({});
  const selected = datasets.find((dataset) => dataset.id === selectedId) || null;
  // 8-Step 蒸馏底模只用于推理，桌面训练页不允许创建不受支持的训练快照。
  const animaModels = useMemo(() => models.filter((model) => model.workflowKind === "anima" && model.available && !model.modelFileName.toLowerCase().includes("anima8step")), [models]);
  const draft = selected ? drafts[selected.id] || defaultDesktopTrainingDraft(selected, animaModels[0]?.id || "") : null;
  const datasetReady = Boolean(selected && selected.status === "confirmed" && selected.assets.length >= 5 && selected.assets.every((asset) => asset.available && asset.caption?.trim()));
  const parametersReady = Boolean(draft?.title.trim() && (draft.modelId || animaModels[0]?.id));
  useEffect(() => { if (!datasets.some((dataset) => dataset.id === selectedId)) { setSelectedId(datasets[0]?.id || ""); setStep(1); } }, [datasets, selectedId]);
  useEffect(() => { if (!datasetReady && step > 1) setStep(1); }, [datasetReady, step]);
  const updateDraft = (next: DesktopTrainingJobCreateInput) => { if (selected) setDrafts((current) => ({ ...current, [selected.id]: next })); };
  const submit = async () => {
    if (!selected || !draft || busy || !trainingReady || !coreRunning || !datasetReady) return;
    const modelId = draft.modelId || animaModels[0]?.id || "";
    if (!modelId) { onError("请先安装或导入可用 Anima 底模"); return; }
    setBusy(true);
    try { onTrainingJobUpdated(await createDesktopTrainingJob({ ...draft, datasetId: selected.id, modelId, title: draft.title.trim() })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try { onTrainingJobUpdated(await cancelDesktopTrainingJob(id)); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };

  return <div className="desktop-page lora-training-page">
    <nav className="training-stepper" aria-label="LoRA 训练步骤">{[{ id: 1, label: "选择训练集" }, { id: 2, label: "训练参数" }, { id: 3, label: "确认与任务" }].map((item) => { const enabled = item.id === 1 || datasetReady && (item.id === 2 || parametersReady); return <button key={item.id} className={step === item.id ? "active" : step > item.id ? "complete" : ""} disabled={!enabled} onClick={() => setStep(item.id as 1 | 2 | 3)}><i>{step > item.id ? <Check /> : item.id}</i><span>{item.label}</span></button>; })}</nav>
    {step === 1 && <section className="section-card training-step-panel"><header><div><span>STEP 1</span><h2>选择已确认训练集</h2></div><small>训练只读取提交时快照，完成后训练集仍可继续编辑和复用</small></header><DatasetList datasets={datasets} selectedId={selectedId} onSelect={setSelectedId} expanded />{selected && <div className={`training-selection-check ${datasetReady ? "ready" : "blocked"}`}>{datasetReady ? <BookOpenCheck /> : <AlertTriangle />}<span><strong>{datasetReady ? "训练集检查通过" : "训练集尚未确认"}</strong><small>{datasetReady ? `${selected.assets.length} 张图片及 Caption 均可用` : "请先到“训练集打标”完成图片、Caption 与确认"}</small></span></div>}<footer><span /><button disabled={!datasetReady} onClick={() => setStep(2)}>下一步：训练参数<ArrowRight /></button></footer></section>}
    {step === 2 && selected && draft && <TrainingParameterStep dataset={selected} draft={draft} models={animaModels} onDraft={updateDraft} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
    {step === 3 && selected && draft && <section className="section-card training-step-panel training-review"><header><div><span>STEP 3</span><h2>确认并提交</h2></div><small>提交后立即进入持久队列，不锁定原训练集</small></header><div className="training-review-grid"><div><span>训练集</span><strong>{selected.title}</strong><small>{selected.assets.length} 张 · {trainingTypeLabel(selected.type)}</small></div><div><span>LoRA</span><strong>{draft.title}</strong><small>{draft.parameters.resolution}px · Rank {draft.parameters.rank}</small></div><div><span>标签处理</span><strong>{draft.useAiTagProcessing ? "AI 处理任务快照" : "使用已确认标签"}</strong><small>{draft.useAiTagProcessing ? "完成后进入 GPU 队列" : "不增加预处理阶段"}</small></div><div><span>底模</span><strong>{animaModels.find((model) => model.id === (draft.modelId || animaModels[0]?.id))?.displayName || "未选择"}</strong><small>{selected.assets.length * draft.parameters.repeats * draft.parameters.epochs} 次图片遍历</small></div></div><div className="desktop-training-submit"><span><strong>单卡串行 · BF16 · Latent 缓存</strong><small>训练任务保存独立快照；AI 标签处理也只修改该快照。</small></span>{!trainingReady ? <button onClick={onOpenResources}><Download />安装 Trainer</button> : !coreRunning ? <button onClick={onOpenResources}><Power />启动本地核心</button> : <button disabled={busy || !datasetReady || !parametersReady} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <FlaskConical />}提交训练任务</button>}</div><TrainingJobList jobs={trainingJobs.filter((job) => job.datasetId === selected.id)} busy={busy} onCancel={(id) => void cancel(id)} /><footer><button className="secondary" onClick={() => setStep(2)}><ArrowLeft />返回参数</button><span /></footer></section>}
  </div>;
}

/** 训练参数独立成一步，任何输入都按训练集保存草稿。 */
function TrainingParameterStep({ dataset, draft, models, onDraft, onBack, onNext }: { dataset: DesktopTrainingDatasetView; draft: DesktopTrainingJobCreateInput; models: DesktopLocalModelView[]; onDraft: (draft: DesktopTrainingJobCreateInput) => void; onBack: () => void; onNext: () => void }) {
  const updateParameter = <Key extends keyof DesktopTrainingJobCreateInput["parameters"]>(key: Key, value: DesktopTrainingJobCreateInput["parameters"][Key]) => onDraft({ ...draft, parameters: { ...draft.parameters, preset: "custom", [key]: value } });
  const applyPreset = (preset: Exclude<DesktopTrainingJobCreateInput["parameters"]["preset"], "custom">) => onDraft({ ...draft, parameters: trainingPresetParameters(dataset, preset, draft.parameters.seed) });
  const modelId = draft.modelId || models[0]?.id || "";
  return <section className="section-card training-step-panel"><header><div><span>STEP 2</span><h2>配置训练参数</h2></div><small>{dataset.title} · {dataset.assets.length} 张</small></header><div className="training-preset-picker">{(["quick", "balanced", "high_quality", "extreme"] as const).map((preset) => <button type="button" key={preset} className={draft.parameters.preset === preset ? "active" : ""} onClick={() => applyPreset(preset)}><strong>{trainingPresetLabel(preset)}</strong><small>{trainingPresetDescription(preset)}</small></button>)}{draft.parameters.preset === "custom" && <span>已偏离预设</span>}</div><div className="desktop-training-parameters">
    <label><span>LoRA 标题</span><input maxLength={191} value={draft.title} onChange={(event) => onDraft({ ...draft, title: event.target.value })} /></label>
    <label><span>Anima 底模</span><select value={modelId} onChange={(event) => onDraft({ ...draft, modelId: event.target.value })}>{models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>) : <option value="">尚未安装可训练底模</option>}</select></label>
    <label><span>训练分辨率</span><select value={draft.parameters.resolution} onChange={(event) => updateParameter("resolution", Number(event.target.value))}>{[512, 640, 768, 896, 1024, 1280, 1536].map((value) => <option key={value} value={value}>{value}px</option>)}</select></label>
    <label><span>Rank / Alpha</span><div><select value={draft.parameters.rank} onChange={(event) => { const rank = Number(event.target.value); onDraft({ ...draft, parameters: { ...draft.parameters, rank, alpha: Math.min(rank, draft.parameters.alpha) } }); }}>{[8, 16, 32, 64].map((value) => <option key={value} value={value}>Rank {value}</option>)}</select><select value={draft.parameters.alpha} onChange={(event) => updateParameter("alpha", Number(event.target.value))}>{[1, 4, 8, 16, 32, 64].filter((value) => value <= draft.parameters.rank).map((value) => <option key={value} value={value}>Alpha {value}</option>)}</select></div></label>
    <label><span>Epoch / 重复</span><div><input type="number" min={1} max={20} value={draft.parameters.epochs} onChange={(event) => updateParameter("epochs", Number(event.target.value))} /><input type="number" min={1} max={50} value={draft.parameters.repeats} onChange={(event) => updateParameter("repeats", Number(event.target.value))} /></div></label>
    <label><span>学习率</span><input type="number" min={0.000001} max={0.01} step={0.00001} value={draft.parameters.learningRate} onChange={(event) => updateParameter("learningRate", Number(event.target.value))} /></label>
    <label className="training-checkbox"><input type="checkbox" checked={draft.useAiTagProcessing} onChange={(event) => onDraft({ ...draft, useAiTagProcessing: event.target.checked })} /><span>使用 AI 标签处理任务快照</span></label>
    {draft.useAiTagProcessing && <label><span>训练目标</span><input maxLength={4000} value={draft.trainingGoal} onChange={(event) => onDraft({ ...draft, trainingGoal: event.target.value })} placeholder="例如：固定角色身份，服装和动作保持可控" /></label>}
  </div><details className="training-advanced-parameters"><summary>高级训练参数</summary><div className="desktop-training-parameters">
    <TrainingFieldHelp label="优化器" help="AdamW8bit 显存最低；AdamW 占用更高；Adafactor 适合显存受限但收敛特性不同。"><select value={draft.parameters.optimizer} onChange={(event) => updateParameter("optimizer", event.target.value as DesktopTrainingJobCreateInput["parameters"]["optimizer"])}><option value="AdamW8bit">AdamW 8-bit</option><option value="AdamW">AdamW</option><option value="Adafactor">Adafactor</option></select></TrainingFieldHelp>
    <TrainingFieldHelp label="Batch Size" help="单步同时处理的图片数；提高可增加吞吐，但显著增加显存占用。"><select value={draft.parameters.batchSize} onChange={(event) => updateParameter("batchSize", Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></TrainingFieldHelp>
    <TrainingFieldHelp label="学习率调度" help="Constant 稳定；Cosine 后期逐步降低；Cosine Restarts 会周期性重启学习率。"><select value={draft.parameters.lrScheduler} onChange={(event) => updateParameter("lrScheduler", event.target.value as DesktopTrainingJobCreateInput["parameters"]["lrScheduler"])}><option value="constant">Constant</option><option value="cosine">Cosine</option><option value="cosine_with_restarts">Cosine Restarts</option></select></TrainingFieldHelp>
    <TrainingFieldHelp label="梯度累积" help="用多步累积模拟更大 Batch；提高数值稳定性但会降低参数更新频率。"><select value={draft.parameters.gradientAccumulationSteps} onChange={(event) => updateParameter("gradientAccumulationSteps", Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></TrainingFieldHelp>
    <TrainingFieldHelp label="预热 / Dropout" help="预热降低训练初期震荡；Caption Dropout 随机丢弃整条描述以增强触发词学习。"><div><input type="number" min={0} max={0.2} step={0.01} value={draft.parameters.warmupRatio} onChange={(event) => updateParameter("warmupRatio", Number(event.target.value))} /><input type="number" min={0} max={0.3} step={0.01} value={draft.parameters.captionDropoutRate} onChange={(event) => updateParameter("captionDropoutRate", Number(event.target.value))} /></div></TrainingFieldHelp>
    <TrainingFieldHelp label="保留前置标签" help="Caption 打乱时保持开头标签不动；Runtime 会自动保证不小于触发词数量。"><input type="number" min={0} max={10} value={draft.parameters.keepTokens} onChange={(event) => updateParameter("keepTokens", Number(event.target.value))} /></TrainingFieldHelp>
    <TrainingFieldHelp label="Text Encoder" help="Anima 当前冻结文本编码器；缓存更快，但 Caption 打乱时必须改为逐步重算。"><select value={draft.parameters.textEncoderStrategy} onChange={(event) => updateParameter("textEncoderStrategy", event.target.value as DesktopTrainingJobCreateInput["parameters"]["textEncoderStrategy"])}><option value="frozen_cached">冻结并缓存</option><option value="frozen_recompute">冻结并逐步重算</option></select></TrainingFieldHelp>
    <TrainingFieldHelp label="保存间隔" help="每隔指定 Epoch 保存一次中间权重；间隔越小占用磁盘越多。"><input type="number" min={1} max={20} value={draft.parameters.saveEveryEpochs} onChange={(event) => updateParameter("saveEveryEpochs", Number(event.target.value))} /></TrainingFieldHelp>
    <TrainingFieldHelp label="总步数上限" help="留空时按 Epoch 训练；填写后由总优化步数终止，适合需要精确控制训练量的用户。"><input type="number" min={1} max={100000} value={draft.parameters.maxTrainSteps ?? ""} placeholder="按 Epoch" onChange={(event) => updateParameter("maxTrainSteps", event.target.value ? Number(event.target.value) : null)} /></TrainingFieldHelp>
    <TrainingFieldHelp label="混合精度" help="BF16 数值范围更稳但需要较新 GPU；FP16 兼容范围更广。"><select value={draft.parameters.mixedPrecision} onChange={(event) => updateParameter("mixedPrecision", event.target.value as DesktopTrainingJobCreateInput["parameters"]["mixedPrecision"])}><option value="bf16">BF16</option><option value="fp16">FP16</option></select></TrainingFieldHelp>
    <TrainingFieldHelp label="分桶范围" help="按图片画幅分桶可减少裁切；最小、最大和步长必须整除对齐。"><div><input type="number" min={256} max={1536} step={64} value={draft.parameters.bucketMinResolution} onChange={(event) => updateParameter("bucketMinResolution", Number(event.target.value))} /><input type="number" min={512} max={2048} step={64} value={draft.parameters.bucketMaxResolution} onChange={(event) => updateParameter("bucketMaxResolution", Number(event.target.value))} /><input type="number" min={32} max={256} step={32} value={draft.parameters.bucketResolutionSteps} onChange={(event) => updateParameter("bucketResolutionSteps", Number(event.target.value))} /></div></TrainingFieldHelp>
    <TrainingFieldHelp label="最大梯度范数" help="限制梯度爆炸；1.0 是稳定默认值，0 表示不裁剪。"><input type="number" min={0} max={10} step={0.1} value={draft.parameters.maxGradNorm} onChange={(event) => updateParameter("maxGradNorm", Number(event.target.value))} /></TrainingFieldHelp>
    <label className="training-checkbox"><input type="checkbox" checked={draft.parameters.shuffleCaption} onChange={(event) => onDraft({ ...draft, parameters: { ...draft.parameters, preset: "custom", shuffleCaption: event.target.checked, textEncoderStrategy: event.target.checked ? "frozen_recompute" : draft.parameters.textEncoderStrategy } })} /><span>随机打乱 Caption 标签</span></label>
    <label className="training-checkbox"><input type="checkbox" checked={draft.parameters.cacheLatents} onChange={(event) => onDraft({ ...draft, parameters: { ...draft.parameters, preset: "custom", cacheLatents: event.target.checked, colorAugmentation: event.target.checked ? false : draft.parameters.colorAugmentation } })} /><span>缓存 Latent（更快）</span></label>
    <label className="training-checkbox"><input type="checkbox" checked={draft.parameters.gradientCheckpointing} onChange={(event) => updateParameter("gradientCheckpointing", event.target.checked)} /><span>梯度检查点（降低显存）</span></label>
    <label className="training-checkbox"><input type="checkbox" checked={draft.parameters.flipAugmentation} onChange={(event) => updateParameter("flipAugmentation", event.target.checked)} /><span>水平翻转增强</span></label>
    <label className="training-checkbox"><input type="checkbox" checked={draft.parameters.colorAugmentation} onChange={(event) => onDraft({ ...draft, parameters: { ...draft.parameters, preset: "custom", colorAugmentation: event.target.checked, cacheLatents: event.target.checked ? false : draft.parameters.cacheLatents } })} /><span>颜色增强（关闭 Latent 缓存）</span></label>
    <TrainingFieldHelp label="随机种子" help="相同数据与参数使用相同种子便于复现。"><input type="number" min={0} max={2147483647} value={draft.parameters.seed} onChange={(event) => updateParameter("seed", Number(event.target.value))} /></TrainingFieldHelp>
  </div></details><footer><button className="secondary" onClick={onBack}><ArrowLeft />返回训练集</button><button disabled={!draft.title.trim() || !modelId} onClick={onNext}>下一步：确认提交<ArrowRight /></button></footer></section>;
}

/** 参数帮助只在悬浮或键盘聚焦图标时出现，避免说明文字改变网格尺寸。 */
function TrainingFieldHelp({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return <label><span>{label}<i className="training-help" tabIndex={0} aria-label={`${label}说明`}><CircleHelp /><em>{help}</em></i></span>{children}</label>;
}

/** 训练集选择器在打标和训练页共享同一份 SQLite 数据。 */
function DatasetList({ datasets, selectedId, onSelect, expanded = false }: { datasets: DesktopTrainingDatasetView[]; selectedId: string; onSelect: (id: string) => void; expanded?: boolean }) {
  return <aside className={`section-card training-dataset-list ${expanded ? "is-expanded" : ""}`}><header><strong>训练集</strong><small>{datasets.length} 个</small></header>{datasets.length ? datasets.map((dataset) => <button key={dataset.id} className={dataset.id === selectedId ? "active" : ""} onClick={() => onSelect(dataset.id)}><span><strong>{dataset.title}</strong><small>{trainingTypeLabel(dataset.type)} · {dataset.assets.length} 张</small></span><b className={`is-${dataset.status}`}>{trainingStatusLabel(dataset.status)}</b></button>) : <div className="empty-block">请先在训练集打标页创建训练集</div>}</aside>;
}

/** 批量工作区工具栏保存布局、排序和选择状态，所有批量任务展示真实完成计数。 */
function BatchWorkspaceToolbar({ layout, sortKey, sortAscending, selectedCount, totalCount, batchTagText, progress, busy, onLayout, onSortKey, onSortAscending, onBatchTagText, onSelectAll, onCaption, onClean, onBackground, onAdd, onRemove, onDelete }: { layout: "cards" | "batch"; sortKey: "created" | "name" | "untagged"; sortAscending: boolean; selectedCount: number; totalCount: number; batchTagText: string; progress: { total: number; completed: number; succeeded: number; failed: number } | null; busy: boolean; onLayout: (value: "cards" | "batch") => void; onSortKey: (value: "created" | "name" | "untagged") => void; onSortAscending: (value: boolean) => void; onBatchTagText: (value: string) => void; onSelectAll: () => void; onCaption: () => void; onClean: () => void; onBackground: () => void; onAdd: () => void; onRemove: () => void; onDelete: () => void }) {
  return <section className="training-batch-toolbar"><div className="training-layout-switch"><button className={layout === "cards" ? "active" : ""} onClick={() => onLayout("cards")}><Grid2X2 />逐图卡片</button><button className={layout === "batch" ? "active" : ""} onClick={() => onLayout("batch")}><ListChecks />批量工作区</button></div><div className="training-sort"><select value={sortKey} onChange={(event) => onSortKey(event.target.value as "created" | "name" | "untagged")}><option value="created">上传时间</option><option value="name">文件名称</option><option value="untagged">未打标优先</option></select><button title={sortAscending ? "当前正序" : "当前倒序"} onClick={() => onSortAscending(!sortAscending)}>{sortAscending ? <ArrowDownAZ /> : <ArrowUpAZ />}</button></div>{layout === "batch" && <><div className="training-batch-selection"><button onClick={onSelectAll}>{selectedCount === totalCount ? "取消全选" : "全选"}</button><span>已选 {selectedCount}/{totalCount}</span></div><div className="training-batch-actions"><button disabled={busy || selectedCount === 0} onClick={onCaption}><Tags />重新打标</button><button disabled={busy || selectedCount === 0} onClick={onClean}><Sparkles />AI 清洗</button><button disabled={busy || selectedCount === 0} onClick={onBackground}><Scissors />自动抠图</button><label><input value={batchTagText} onChange={(event) => onBatchTagText(event.target.value)} placeholder="批量标签，英文逗号分隔" /><button disabled={busy || selectedCount === 0 || !batchTagText.trim()} onClick={onAdd}><Plus />添加</button><button disabled={busy || selectedCount === 0 || !batchTagText.trim()} onClick={onRemove}><X />删除标签</button></label><button className="danger" disabled={busy || selectedCount === 0} onClick={onDelete}><Trash2 />删除图片</button></div></>}{progress && <div className="training-batch-progress"><span><strong>{progress.completed}/{progress.total}</strong><small>成功 {progress.succeeded} · 失败 {progress.failed}</small></span><i><em style={{ width: `${progress.total ? progress.completed * 100 / progress.total : 0}%` }} /></i></div>}</section>;
}

/** 自动打标进度只读取持久化任务状态。 */
function CaptionJobStatus({ job, active, busy, onControl }: { job: DesktopCaptionJobView; active: boolean; busy: boolean; onControl: (action: "pause" | "resume" | "cancel") => void }) {
  return <div className={`caption-job is-${job.status}`}><div><span><strong>{captionJobStatusLabel(job.status)}</strong><small>{job.processedAssets}/{job.totalAssets} · 成功 {job.succeededAssets} · 失败 {job.failedAssets} · 保留人工 {job.skippedAssets}</small></span><b>{job.progress}%</b></div><i><em style={{ width: `${job.progress}%` }} /></i>{job.error && <small>{job.error}</small>}{active && <div className="caption-job-actions"><button disabled={busy} onClick={() => onControl(job.status === "paused" ? "resume" : "pause")}>{job.status === "paused" ? <Play /> : <Pause />}{job.status === "paused" ? "继续" : "暂停"}</button><button disabled={busy} onClick={() => onControl("cancel")}><X />取消</button></div>}</div>;
}

/** 自动抠图任务展示真实部分成功计数，暂停状态不会被误报为失败。 */
function BackgroundRemovalJobStatus({ job }: { job: DesktopBackgroundRemovalJobView }) {
  const label = { queued: "等待自动抠图", running: "正在自动抠图", paused: "自动抠图已暂停", succeeded: "自动抠图完成", failed: "自动抠图部分或全部失败", cancelled: "自动抠图已取消" }[job.status];
  return <div className={`caption-job background-removal-job is-${job.status}`}><div><span><strong>{label}</strong><small>{job.processedAssets}/{job.totalAssets} · 成功 {job.succeededAssets} · 失败 {job.failedAssets}</small></span><b>{job.progress}%</b></div><i><em style={{ width: `${job.progress}%` }} /></i>{job.error && <small>{job.error}</small>}</div>;
}

/** AI 清洗进度与建议分离展示，终态失败不会遮住已经成功的逐图建议。 */
function AiCleanJobStatus({ job, active, busy, onControl }: { job: DesktopAiCleanJobView; active: boolean; busy: boolean; onControl: (action: "pause" | "resume" | "cancel") => void }) {
  return <div className={`caption-job ai-clean-job is-${job.status}`}><div><span><strong>{aiCleanJobStatusLabel(job.status)}</strong><small>{job.processedAssets}/{job.totalAssets} · 成功 {job.succeededAssets} · 失败 {job.failedAssets}</small></span><b>{job.progress}%</b></div><i><em style={{ width: `${job.progress}%` }} /></i>{job.error && <small>{job.error}</small>}{active && <div className="caption-job-actions"><button disabled={busy} onClick={() => onControl(job.status === "paused" ? "resume" : "pause")}>{job.status === "paused" ? <Play /> : <Pause />}{job.status === "paused" ? "继续" : "暂停"}</button><button disabled={busy} onClick={() => onControl("cancel")}><X />取消</button></div>}</div>;
}

/** 单图编辑器使用中英标签卡片保存标准 Caption，并提供独立打标和删除入口。 */
function TrainingAssetRow({ datasetId, asset, captionItem, aiCleanJob, aiCleanItem, translations, captioningReady, segmenterReady, captionJobActive, aiCleanJobActive, backgroundRemovalActive, onRetag, onClean, onAutoRemove, onManualRemove, onDelete, onUpdated, onAiCleanJobUpdated, onError }: { datasetId: string; asset: DesktopTrainingDatasetView["assets"][number]; captionItem: DesktopCaptionJobView["items"][number] | null; aiCleanJob: DesktopAiCleanJobView | null; aiCleanItem: DesktopAiCleanJobView["items"][number] | null; translations: TranslationMap; captioningReady: boolean; segmenterReady: boolean; captionJobActive: boolean; aiCleanJobActive: boolean; backgroundRemovalActive: boolean; onRetag: () => void; onClean: () => void; onAutoRemove: () => void; onManualRemove: () => void; onDelete: () => void; onUpdated: (dataset: DesktopTrainingDatasetView) => void; onAiCleanJobUpdated: (job: DesktopAiCleanJobView) => void; onError: (message: string) => void }) {
  const [caption, setCaption] = useState(asset.caption || "");
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setCaption(asset.caption || ""), [asset.caption]);
  const changed = caption.trim() !== (asset.caption || "").trim();
  const tags = splitTags(caption);
  const addTag = () => {
    const additions = splitTags(newTag).filter((tag) => !tags.includes(tag));
    if (!additions.length) {
      onError(newTag.trim() ? "输入的标签已经存在" : "请输入至少一个有效英文标签");
      return;
    }
    setCaption([...tags, ...additions].join(", "));
    setNewTag("");
  };
  const removeTag = (tag: string) => setCaption(tags.filter((item) => item !== tag).join(", "));
  const save = async () => {
    if (busy || !changed) return;
    setBusy(true);
    try { onUpdated(await updateDesktopTrainingCaption({ datasetId, assetId: asset.id, caption: caption.trim() || null })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const selectedDerivative = asset.derivatives.find((derivative) => derivative.id === asset.selectedDerivativeId && derivative.available) || null;
  const displayPath = selectedDerivative?.path || asset.path;
  const selectVariant = async (derivativeId: string | null) => {
    if (busy) return;
    setBusy(true);
    try { onUpdated(await selectDesktopTrainingAssetVariant({ datasetId, assetId: asset.id, derivativeId })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const sourceByTag = new Map(asset.tags.map((tag) => [tag.normalizedValue, tag.source]));
  const sourceText = asset.tags.length ? `${asset.tags.length} 个标签已记录来源` : "尚未打标";
  return <article className={asset.available ? "" : "is-missing"}>
    <div className="training-asset-image">{asset.available ? <img loading="lazy" src={convertFileSrc(displayPath)} alt={asset.fileName} /> : <div><AlertTriangle /><span>文件缺失</span></div>}<span>{asset.width}×{asset.height}</span>{selectedDerivative && <em>{selectedDerivative.source === "manual" ? "手动抠图" : "自动抠图"}</em>}</div>
    <div className="training-asset-caption">
      <header><strong>{asset.fileName}</strong><small>{(selectedDerivative?.sha256 || asset.sha256).slice(0, 12)} · {formatResourceBytes(selectedDerivative?.byteSize || asset.byteSize)}</small></header>
      <div className="training-asset-variants"><label><span>训练图片版本</span><select value={asset.selectedDerivativeId || "original"} disabled={busy} onChange={(event) => void selectVariant(event.target.value === "original" ? null : event.target.value)}><option value="original">原图</option>{asset.derivatives.filter((derivative) => derivative.available).map((derivative, index) => <option key={derivative.id} value={derivative.id}>{derivative.source === "manual" ? "手动抠图" : "自动抠图"} {asset.derivatives.length - index}</option>)}</select></label><button disabled={!segmenterReady || backgroundRemovalActive || busy || !asset.available} onClick={onAutoRemove}><Scissors />自动抠图</button><button disabled={busy || !asset.available} onClick={onManualRemove}><Paintbrush />手动抠图</button></div>
      <div className="desktop-caption-tag-list">{tags.length ? tags.map((tag) => { const translation = translations[tag]; const source = sourceByTag.get(normalizeTag(tag)) || "manual"; return <span key={tag} className={`${translation ? "" : "is-pending"} is-source-${source}`} style={{ "--tag-color": translation?.color || tagColor(tag) } as CSSProperties}><b>{tag}</b><small>{translation?.translated || "待翻译"}</small><em>{trainingTagSourceLabel(source)}</em><button onClick={() => removeTag(tag)} aria-label={`删除标签 ${tag}`}><X /></button></span>; }) : <p>尚未添加标签，可单图打标或手动添加。</p>}</div>
      <div className="desktop-caption-add"><input value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="输入英文标签" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} /><button disabled={!normalizeTag(newTag)} onClick={addTag}><Plus />添加</button></div>
      <footer><span className={asset.available ? asset.confirmed ? "confirmed" : "pending" : "missing"}>{asset.available ? asset.confirmed ? "已确认" : `${sourceText}${captionItem ? ` · ${captionItemStatusLabel(captionItem.status)}` : ""}` : "文件缺失或已变化"}</span><div><button className="caption-row-action" disabled={!tags.length} onClick={() => void navigator.clipboard.writeText(tags.join(", "))}><Copy />复制</button><button className="caption-row-action" disabled={!captioningReady || captionJobActive || busy || !asset.available} onClick={onRetag}><Tags />{asset.caption?.trim() ? "重新打标" : "单图打标"}</button><button className="caption-row-action" disabled={aiCleanJobActive || busy || !asset.available || !tags.length || changed} onClick={onClean}><Sparkles />AI 清洗</button><button disabled={!changed || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <Save />}{busy ? "保存中" : "保存标签"}</button><button className="caption-delete-image" disabled={captionJobActive || aiCleanJobActive || backgroundRemovalActive || busy} onClick={onDelete}><Trash2 />删除图片</button></div></footer>
      {captionItem?.error && <small className="caption-item-error">{captionItem.error}</small>}{aiCleanJob && aiCleanItem && <AiCleanReview job={aiCleanJob} item={aiCleanItem} datasetId={datasetId} assetId={asset.id} onUpdated={onUpdated} onJobUpdated={onAiCleanJobUpdated} onError={onError} />}
    </div>
  </article>;
}

/** 逐项接受或拒绝 AI 建议；应用和撤销始终重新读取 SQLite 事实状态。 */
function AiCleanReview({ job, item, datasetId, assetId, onUpdated, onJobUpdated, onError }: { job: DesktopAiCleanJobView; item: DesktopAiCleanJobView["items"][number]; datasetId: string; assetId: string; onUpdated: (dataset: DesktopTrainingDatasetView) => void; onJobUpdated: (job: DesktopAiCleanJobView) => void; onError: (message: string) => void }) {
  const proposal = item.proposal;
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [add, setAdd] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const proposalKey = proposal ? JSON.stringify(proposal) : "";
  useEffect(() => {
    setKeep(new Set(proposal?.keep.map((entry) => normalizeTag(entry.tag)) || []));
    setRemove(new Set(proposal?.remove.map((entry) => normalizeTag(entry.tag)) || []));
    setAdd(new Set(proposal?.add.map((entry) => normalizeTag(entry.tag)) || []));
  }, [proposalKey]);
  const toggle = (setter: Dispatch<SetStateAction<Set<string>>>, value: string) => setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  const refreshJob = async () => { const current = (await listDesktopAiCleanJobs()).find((entry) => entry.id === job.id); if (current) onJobUpdated(current); };
  const apply = async () => {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      const rejectedKeep = proposal.keep.filter((entry) => !keep.has(normalizeTag(entry.tag))).map((entry) => entry.tag);
      const acceptedRemove = proposal.remove.filter((entry) => remove.has(normalizeTag(entry.tag))).map((entry) => entry.tag);
      const acceptedAdd = proposal.add.filter((entry) => add.has(normalizeTag(entry.tag))).map((entry) => entry.tag);
      onUpdated(await applyDesktopAiClean({ jobId: job.id, datasetId, assetId, removeTags: [...rejectedKeep, ...acceptedRemove], addTags: acceptedAdd }));
      await refreshJob();
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    if (busy) return;
    setBusy(true);
    try { onUpdated(await undoDesktopAiClean({ jobId: job.id, datasetId, assetId })); await refreshJob(); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  if (item.status === "failed") return <div className="ai-clean-review is-failed"><AlertTriangle /><span>AI 清洗失败（尝试 {item.attemptCount}/3）：{item.error || "未返回有效建议"}</span></div>;
  if (["queued", "running"].includes(item.status)) return <div className="ai-clean-review is-running"><LoaderCircle className="spin" /><span>{item.status === "queued" ? "等待 AI 清洗" : `正在分析（第 ${item.attemptCount}/3 次）`}</span></div>;
  if (!proposal) return null;
  return <section className="ai-clean-review"><header><span><Sparkles /><strong>AI 清洗建议</strong></span><b className={`is-${item.applyStatus}`}>{item.applyStatus === "applied" ? "已应用" : item.applyStatus === "undone" ? "已撤销" : "待确认"}</b></header><div className="ai-clean-suggestion-groups"><AiCleanSuggestionGroup title="建议保留" kind="keep" items={proposal.keep} selected={keep} onToggle={(tag) => toggle(setKeep, tag)} disabled={item.applyStatus === "applied"} /><AiCleanSuggestionGroup title="建议删除" kind="remove" items={proposal.remove} selected={remove} onToggle={(tag) => toggle(setRemove, tag)} disabled={item.applyStatus === "applied"} /><AiCleanSuggestionGroup title="建议新增" kind="add" items={proposal.add} selected={add} onToggle={(tag) => toggle(setAdd, tag)} disabled={item.applyStatus === "applied"} /></div><footer><span>最终标签由当前勾选结果计算，未勾选“保留”等同于用户明确删除。</span>{item.applyStatus === "applied" ? <button disabled={busy} onClick={() => void undo()}>{busy ? <LoaderCircle className="spin" /> : <RotateCcw />}撤销本次清洗</button> : <button disabled={busy} onClick={() => void apply()}>{busy ? <LoaderCircle className="spin" /> : <Check />}应用所选建议</button>}</footer></section>;
}

function AiCleanSuggestionGroup({ title, kind, items, selected, onToggle, disabled }: { title: string; kind: "keep" | "remove" | "add"; items: NonNullable<DesktopAiCleanJobView["items"][number]["proposal"]>["keep"]; selected: Set<string>; onToggle: (tag: string) => void; disabled: boolean }) {
  return <div className={`ai-clean-suggestion is-${kind}`}><strong>{title} · {items.length}</strong>{items.length ? items.map((entry) => { const key = normalizeTag(entry.tag); return <label key={`${kind}-${key}`}><input type="checkbox" checked={selected.has(key)} disabled={disabled} onChange={() => onToggle(key)} /><span><b>{entry.tag}</b><small>{entry.reason}</small></span></label>; }) : <p>没有此类建议</p>}</div>;
}

/** 当前训练集的历史任务不会反向锁定训练集编辑。 */
function TrainingJobList({ jobs, busy, onCancel }: { jobs: DesktopTrainingJobView[]; busy: boolean; onCancel: (id: string) => void }) {
  return <div className="desktop-training-jobs">{jobs.length ? jobs.map((job) => { const preprocessing = job.useAiTagProcessing && !["succeeded", "failed"].includes(job.preprocessingStatus); const progress = preprocessing ? job.preprocessingProgress : job.progress; return <article key={job.id} className={`is-${job.status}`}><header><span><b>{preprocessing ? "AI 标签处理中" : desktopTrainingStatusLabel(job.status)}</b><strong>{job.title}</strong><small>{job.modelDisplayName} · {job.assetCount} 张 · Rank {job.parameters.rank}</small></span><em>{progress}%</em></header><i><u style={{ width: `${progress}%` }} /></i><footer><span>{preprocessing ? `处理训练快照标签 · ${job.preprocessingProgress}%` : job.preprocessingStatus === "failed" ? job.preprocessingError || "AI 标签处理失败" : job.status === "queued" ? `队列第 ${job.queuePosition} 位` : job.status === "running" ? `Epoch ${job.currentEpoch}/${job.totalEpochs}` : job.outputLoraId ? "LoRA 已登记到本地仓库" : job.error || "任务已结束"}</span>{["queued", "running"].includes(job.status) && <button disabled={busy} onClick={() => onCancel(job.id)}><X />取消</button>}</footer>{job.suggestion && <p><AlertTriangle />{job.suggestion.message}{job.suggestion.resolution ? ` 建议分辨率 ${job.suggestion.resolution}px。` : ""}{job.suggestion.rank ? ` 建议 Rank ${job.suggestion.rank}。` : ""}</p>}</article>; }) : <div className="empty-block">提交后，当前训练集的任务会显示在这里</div>}</div>;
}

/** 8 GiB 设备保留 512px 安全分辨率，但提高到至少 320 次遍历，避免角色 LoRA 完全欠拟合。 */
function defaultDesktopTrainingDraft(dataset: DesktopTrainingDatasetView, modelId: string): DesktopTrainingJobCreateInput {
  const seed = Math.floor(Math.random() * 2147483647);
  return { datasetId: dataset.id, modelId, title: `${dataset.title} LoRA`, useAiTagProcessing: false, trainingGoal: "", parameters: trainingPresetParameters(dataset, "balanced", seed) };
}

/** 四档预设生成完整 Runtime 参数，训练目标会真实影响 Rank、学习率和图像遍历量。 */
function trainingPresetParameters(dataset: DesktopTrainingDatasetView, preset: "quick" | "balanced" | "high_quality" | "extreme", seed: number): DesktopTrainingJobCreateInput["parameters"] {
  const count = Math.max(5, dataset.assets.length);
  const targetPasses = { quick: 160, balanced: 320, high_quality: 480, extreme: 720 }[preset];
  const { epochs, repeats } = resolveTrainingCycles(count, targetPasses);
  const baseRank = dataset.type === "style" ? 32 : 16;
  const rank = Math.min(64, preset === "extreme" ? baseRank * 2 : baseRank);
  const resolution = { quick: 512, balanced: 512, high_quality: 640, extreme: 768 }[preset];
  const learningRate = dataset.type === "style" ? 0.00008 : 0.0001;
  return {
    preset, rank, alpha: rank, epochs, repeats, resolution, learningRate,
    lrScheduler: preset === "quick" ? "constant" : "cosine", warmupRatio: preset === "quick" ? 0 : 0.03,
    gradientAccumulationSteps: preset === "extreme" ? 2 : 1, captionDropoutRate: dataset.type === "style" ? 0.05 : 0,
    shuffleCaption: false, keepTokens: 1, seed, optimizer: "AdamW8bit", batchSize: 1,
    maxTrainSteps: null, bucketEnabled: true, bucketNoUpscale: true, bucketMinResolution: 256,
    bucketMaxResolution: Math.max(1024, resolution), bucketResolutionSteps: 64,
    textEncoderStrategy: "frozen_cached", cacheLatents: true,
    saveEveryEpochs: Math.max(1, Math.ceil(epochs / 4)), mixedPrecision: "bf16",
    gradientCheckpointing: true, flipAugmentation: false, colorAugmentation: false, maxGradNorm: 1,
  };
}

function trainingPresetLabel(preset: "quick" | "balanced" | "high_quality" | "extreme"): string { return { quick: "快速", balanced: "均衡", high_quality: "高质量", extreme: "极致" }[preset]; }
function trainingPresetDescription(preset: "quick" | "balanced" | "high_quality" | "extreme"): string { return { quick: "较少遍历，快速验证", balanced: "默认稳定参数", high_quality: "提高分辨率与遍历", extreme: "更高 Rank 与训练量" }[preset]; }

function trainingTypeLabel(type: DesktopTrainingDatasetView["type"]): string { return { character: "角色", style: "画风", object: "服装 / 物体", concept: "概念" }[type]; }
function trainingStatusLabel(status: DesktopTrainingDatasetView["status"]): string { return { draft: "整理中", review_ready: "可确认", confirmed: "已确认" }[status]; }
function datasetImportKindLabel(kind: DesktopTrainingDatasetImportPreview["sourceKind"]): string { return { folder: "文件夹", zip: "ZIP", "7z": "7Z", tar: "TAR", tar_gz: "TAR.GZ / TGZ" }[kind]; }
function captionJobStatusLabel(status: DesktopCaptionJobView["status"]): string { return { queued: "等待离线打标", running: "正在离线打标", paused: "自动打标已暂停", succeeded: "自动打标完成", failed: "自动打标部分或全部失败", cancelled: "自动打标已取消" }[status]; }
function captionItemStatusLabel(status: DesktopCaptionJobView["items"][number]["status"]): string { return { queued: "等待打标", running: "识别中", succeeded: "识别完成", failed: "识别失败", skipped: "保留人工内容", cancelled: "已取消" }[status]; }
function aiCleanJobStatusLabel(status: DesktopAiCleanJobView["status"]): string { return { queued: "等待 AI 清洗", running: "正在 AI 清洗", paused: "AI 清洗已暂停", succeeded: "AI 清洗建议完成", failed: "AI 清洗部分或全部失败", cancelled: "AI 清洗已取消" }[status]; }
/** 逐标签来源使用短文本展示，避免把内部枚举直接暴露给用户。 */
function trainingTagSourceLabel(source: DesktopTrainingDatasetView["assets"][number]["tags"][number]["source"]): string { return { auto: "自动", ai_cleaned: "AI 清洗", manual: "人工", imported: "导入", trigger: "触发词" }[source]; }
function desktopTrainingStatusLabel(status: DesktopTrainingJobView["status"]): string { return { queued: "排队中", running: "训练中", succeeded: "训练完成", failed: "训练失败", cancelled: "已取消" }[status]; }
function formatResourceBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 ** 2).toFixed(1)} MiB`; }
/** 把 Caption 拆成去重的标准英文标签，翻译只影响展示而不写入训练内容。 */
function splitTags(value: string): string[] { return [...new Set(value.split(/[,，\n;；]+/).map(normalizeTag).filter(Boolean))]; }
function normalizeTag(value: string): string { return value.trim().replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase(); }
/** 未返回服务端颜色时仍使用标签哈希生成稳定可读颜色。 */
function tagColor(tag: string): string { let hash = 0; for (const character of tag) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return `hsl(${hash % 360} 55% 43%)`; }
/** 训练触发词按英文或中文逗号和换行拆分，并在提交前保持用户顺序去重。 */
function parseTriggerWords(value: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean)) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "操作失败"); }
