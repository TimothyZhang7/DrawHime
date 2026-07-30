/**
 * 本文件把独立训练集打标工具与分步骤 LoRA 训练流程拆分为两个桌面页面。
 */
import type { DesktopCaptionJobCreateInput, DesktopCaptionJobView, DesktopLocalModelView, DesktopTrainingDatasetCreateInput, DesktopTrainingDatasetView, DesktopTrainingJobCreateInput, DesktopTrainingJobView } from "@drawhime/contracts";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ArrowLeft, ArrowRight, BookOpenCheck, Check, Copy, Download, FlaskConical, FolderPlus, Images, LoaderCircle, Save, Tags, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { addDesktopTrainingImages, cancelDesktopCaptionJob, cancelDesktopTrainingJob, confirmDesktopTrainingDataset, createDesktopCaptionJob, createDesktopTrainingDataset, createDesktopTrainingJob, updateDesktopTrainingCaption, updateDesktopTrainingTriggerWords } from "./desktop-api";

interface CaptioningPageProps {
  datasets: DesktopTrainingDatasetView[];
  captionJobs: DesktopCaptionJobView[];
  captioningReady: boolean;
  onUpdated: (dataset: DesktopTrainingDatasetView) => void;
  onCaptionJobUpdated: (job: DesktopCaptionJobView) => void;
  onOpenResources: () => void;
  onError: (message: string) => void;
}

interface LoraTrainingPageProps {
  datasets: DesktopTrainingDatasetView[];
  trainingJobs: DesktopTrainingJobView[];
  models: DesktopLocalModelView[];
  trainingReady: boolean;
  onTrainingJobUpdated: (job: DesktopTrainingJobView) => void;
  onOpenResources: () => void;
  onError: (message: string) => void;
}

/** 打标页只管理可复用训练集，不因是否训练过 LoRA 改变编辑能力。 */
export function CaptioningPage({ datasets, captionJobs, captioningReady, onUpdated, onCaptionJobUpdated, onOpenResources, onError }: CaptioningPageProps) {
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<DesktopTrainingDatasetCreateInput>({ title: "", type: "character", triggerWords: [] });
  const [triggerText, setTriggerText] = useState("");
  const [detailTriggerText, setDetailTriggerText] = useState("");
  const [busy, setBusy] = useState(false);
  const [captionOptions, setCaptionOptions] = useState<Pick<DesktopCaptionJobCreateInput, "generalThreshold" | "characterThreshold" | "includeCharacterTags">>({ generalThreshold: 0.35, characterThreshold: 0.85, includeCharacterTags: false });
  const selected = datasets.find((dataset) => dataset.id === selectedId) || null;
  const activeCaptionJob = captionJobs.find((job) => job.datasetId === selectedId && ["queued", "running"].includes(job.status)) || null;
  const latestCaptionJob = captionJobs.find((job) => job.datasetId === selectedId) || null;
  useEffect(() => { if (selectedId && !datasets.some((dataset) => dataset.id === selectedId)) setSelectedId(""); }, [datasets, selectedId]);
  useEffect(() => { setDetailTriggerText(selected?.triggerWords.join(", ") || ""); }, [selected?.id, selected?.triggerWords]);

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
  const caption = async (assetId: string | null) => {
    if (!selected || busy || activeCaptionJob || !captioningReady) return;
    setBusy(true);
    try { onCaptionJobUpdated(await createDesktopCaptionJob({ datasetId: selected.id, assetId, ...captionOptions })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const cancelCaption = async () => {
    if (!activeCaptionJob || busy) return;
    setBusy(true);
    try { onCaptionJobUpdated(await cancelDesktopCaptionJob(activeCaptionJob.id)); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const missingCaptions = selected?.assets.filter((asset) => !asset.caption?.trim()).length || 0;
  const unavailableAssets = selected?.assets.filter((asset) => !asset.available).length || 0;
  const batchCandidates = selected?.assets.filter((asset) => asset.captionSource !== "manual").length || 0;

  if (!selected) return <div className="desktop-page training-page captioning-page captioning-library-page">
    <section className="section-card training-create"><header><div><span>DATASET WORKSPACE</span><h2>创建训练集</h2></div><small>训练集创建后进入独立页面管理图片、触发词与标签</small></header><div><label><span>训练集标题</span><input maxLength={191} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="例如：角色立绘训练集" /></label><label><span>训练类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as DesktopTrainingDatasetCreateInput["type"] })}><option value="character">角色</option><option value="style">画风</option><option value="concept">概念</option></select></label><label><span>初始触发词</span><input value={triggerText} onChange={(event) => setTriggerText(event.target.value)} placeholder="建议使用唯一、无语义的英文词" /></label><button disabled={busy || !form.title.trim()} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" /> : <FolderPlus />}创建训练集</button></div></section>
    <section className="section-card caption-dataset-library"><header><div><span>DATASET LIBRARY</span><h2>训练集</h2></div><small>{datasets.length} 个训练集</small></header>{datasets.length ? <div className="caption-dataset-grid">{datasets.map((dataset) => { const missing = dataset.assets.filter((asset) => !asset.caption?.trim()).length; return <button key={dataset.id} type="button" onClick={() => setSelectedId(dataset.id)}><i><Images /></i><span><strong>{dataset.title}</strong><small>{trainingTypeLabel(dataset.type)} · {dataset.assets.length} 张 · {missing ? `${missing} 张待打标` : "标签完整"}</small><em>{dataset.triggerWords.join(", ") || "未设置触发词"}</em></span><b className={`is-${dataset.status}`}>{trainingStatusLabel(dataset.status)}</b><ArrowRight /></button>; })}</div> : <div className="empty-block">创建第一个训练集后，可在独立详情页逐图打标和维护触发词。</div>}</section>
  </div>;

  return <div className="desktop-page training-page captioning-page">
    <section className="section-card training-editor training-dataset-detail">
        <header><div><button className="training-back" type="button" onClick={() => setSelectedId("")}><ArrowLeft />返回训练集</button><span>{trainingTypeLabel(selected.type)} · {selected.assets.length} 张图片</span><h2>{selected.title}</h2></div><div className="training-editor-actions"><button disabled={busy || selected.assets.length >= 200} onClick={() => void addImages()}><Upload />导入图片</button><button disabled={busy || Boolean(activeCaptionJob) || selected.assets.length < 5 || missingCaptions > 0 || unavailableAssets > 0} onClick={() => void confirm()}><BookOpenCheck />{selected.status === "confirmed" ? "重新确认" : "确认可训练"}</button></div></header>
        <div className="training-trigger-editor"><label><span>训练触发词</span><input value={detailTriggerText} maxLength={5049} onChange={(event) => setDetailTriggerText(event.target.value)} placeholder="使用英文逗号分隔；建议填写唯一、无语义的标签" /></label><button disabled={busy || parseTriggerWords(detailTriggerText).join("\n") === selected.triggerWords.join("\n")} onClick={() => void saveTriggerWords()}>{busy ? <LoaderCircle className="spin" /> : <Save />}保存触发词</button></div>
        <div className="training-gate"><span><strong>{selected.assets.length}/200 张</strong><small>{unavailableAssets ? `${unavailableAssets} 张文件缺失或已变化` : missingCaptions ? `${missingCaptions} 张缺少 Caption` : selected.assets.length >= 5 ? "全部 Caption 已填写，可随时继续编辑" : `还需 ${5 - selected.assets.length} 张图片`}</small></span><b className={`is-${selected.status}`}>{trainingStatusLabel(selected.status)}</b></div>
        <section className="caption-control"><div className="caption-control-title"><Tags /><span><strong>离线自动打标</strong><small>每张图片均可单独识别；批量操作只补齐非人工内容</small></span></div>{captioningReady ? <div className="caption-options"><label><span>通用阈值</span><input type="number" min={0.05} max={0.95} step={0.05} value={captionOptions.generalThreshold} onChange={(event) => setCaptionOptions({ ...captionOptions, generalThreshold: Number(event.target.value) })} /></label><label><span>角色阈值</span><input type="number" min={0.05} max={0.99} step={0.05} value={captionOptions.characterThreshold} onChange={(event) => setCaptionOptions({ ...captionOptions, characterThreshold: Number(event.target.value) })} /></label><label className="caption-character-toggle"><input type="checkbox" checked={captionOptions.includeCharacterTags} onChange={(event) => setCaptionOptions({ ...captionOptions, includeCharacterTags: event.target.checked })} /><span>包含角色标签</span></label><button disabled={busy || Boolean(activeCaptionJob) || batchCandidates === 0 || unavailableAssets > 0} onClick={() => void caption(null)}>{busy ? <LoaderCircle className="spin" /> : <Tags />}{activeCaptionJob ? "打标进行中" : `批量补齐 ${batchCandidates} 张`}</button></div> : <button className="caption-install" onClick={onOpenResources}><Download />安装打标组件</button>}{latestCaptionJob && <CaptionJobStatus job={latestCaptionJob} active={Boolean(activeCaptionJob)} busy={busy} onCancel={() => void cancelCaption()} />}</section>
        {selected.assets.length ? <div className="training-asset-list">{selected.assets.map((asset) => <TrainingAssetRow key={asset.id} datasetId={selected.id} asset={asset} captionItem={latestCaptionJob?.items.find((item) => item.assetId === asset.id) || null} captioningReady={captioningReady} captionJobActive={Boolean(activeCaptionJob)} onRetag={() => void caption(asset.id)} onUpdated={onUpdated} onError={onError} />)}</div> : <div className="empty-block">导入 5–200 张 PNG、JPEG 或 WebP 开始整理训练集</div>}
    </section>
  </div>;
}

/** LoRA 训练页通过可回退步骤验证训练集、参数和最终提交，不承担打标职责。 */
export function LoraTrainingPage({ datasets, trainingJobs, models, trainingReady, onTrainingJobUpdated, onOpenResources, onError }: LoraTrainingPageProps) {
  const [selectedId, setSelectedId] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, DesktopTrainingJobCreateInput>>({});
  const selected = datasets.find((dataset) => dataset.id === selectedId) || null;
  const animaModels = useMemo(() => models.filter((model) => model.workflowKind === "anima" && model.available), [models]);
  const draft = selected ? drafts[selected.id] || defaultDesktopTrainingDraft(selected, animaModels[0]?.id || "") : null;
  const datasetReady = Boolean(selected && selected.status === "confirmed" && selected.assets.length >= 5 && selected.assets.every((asset) => asset.available && asset.caption?.trim()));
  const parametersReady = Boolean(draft?.title.trim() && (draft.modelId || animaModels[0]?.id));
  useEffect(() => { if (!datasets.some((dataset) => dataset.id === selectedId)) { setSelectedId(datasets[0]?.id || ""); setStep(1); } }, [datasets, selectedId]);
  useEffect(() => { if (!datasetReady && step > 1) setStep(1); }, [datasetReady, step]);
  const updateDraft = (next: DesktopTrainingJobCreateInput) => { if (selected) setDrafts((current) => ({ ...current, [selected.id]: next })); };
  const submit = async () => {
    if (!selected || !draft || busy || !trainingReady || !datasetReady) return;
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
    {step === 3 && selected && draft && <section className="section-card training-step-panel training-review"><header><div><span>STEP 3</span><h2>确认并提交</h2></div><small>提交后立即进入持久队列，不锁定原训练集</small></header><div className="training-review-grid"><div><span>训练集</span><strong>{selected.title}</strong><small>{selected.assets.length} 张 · {trainingTypeLabel(selected.type)}</small></div><div><span>LoRA</span><strong>{draft.title}</strong><small>{draft.parameters.resolution}px · Rank {draft.parameters.rank}</small></div><div><span>底模</span><strong>{animaModels.find((model) => model.id === (draft.modelId || animaModels[0]?.id))?.displayName || "未选择"}</strong><small>{selected.assets.length * draft.parameters.repeats * draft.parameters.epochs} 次图片遍历</small></div></div><div className="desktop-training-submit"><span><strong>单卡串行 · BF16 · Latent 缓存</strong><small>训练任务保存独立快照；之后修改训练集不会影响已提交任务。</small></span>{trainingReady ? <button disabled={busy || !datasetReady || !parametersReady} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <FlaskConical />}提交训练任务</button> : <button onClick={onOpenResources}><Download />安装 Trainer</button>}</div><TrainingJobList jobs={trainingJobs.filter((job) => job.datasetId === selected.id)} busy={busy} onCancel={(id) => void cancel(id)} /><footer><button className="secondary" onClick={() => setStep(2)}><ArrowLeft />返回参数</button><span /></footer></section>}
  </div>;
}

/** 训练参数独立成一步，任何输入都按训练集保存草稿。 */
function TrainingParameterStep({ dataset, draft, models, onDraft, onBack, onNext }: { dataset: DesktopTrainingDatasetView; draft: DesktopTrainingJobCreateInput; models: DesktopLocalModelView[]; onDraft: (draft: DesktopTrainingJobCreateInput) => void; onBack: () => void; onNext: () => void }) {
  const updateParameter = <Key extends keyof DesktopTrainingJobCreateInput["parameters"]>(key: Key, value: DesktopTrainingJobCreateInput["parameters"][Key]) => onDraft({ ...draft, parameters: { ...draft.parameters, [key]: value } });
  const modelId = draft.modelId || models[0]?.id || "";
  return <section className="section-card training-step-panel"><header><div><span>STEP 2</span><h2>配置训练参数</h2></div><small>{dataset.title} · {dataset.assets.length} 张</small></header><div className="desktop-training-parameters">
    <label><span>LoRA 标题</span><input maxLength={191} value={draft.title} onChange={(event) => onDraft({ ...draft, title: event.target.value })} /></label>
    <label><span>Anima 底模</span><select value={modelId} onChange={(event) => onDraft({ ...draft, modelId: event.target.value })}>{models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>) : <option value="">尚未安装可训练底模</option>}</select></label>
    <label><span>训练分辨率</span><select value={draft.parameters.resolution} onChange={(event) => updateParameter("resolution", Number(event.target.value))}>{[512, 640, 768, 896, 1024, 1280, 1536].map((value) => <option key={value} value={value}>{value}px</option>)}</select></label>
    <label><span>Rank / Alpha</span><div><select value={draft.parameters.rank} onChange={(event) => { const rank = Number(event.target.value); onDraft({ ...draft, parameters: { ...draft.parameters, rank, alpha: Math.min(rank, draft.parameters.alpha) } }); }}>{[8, 16, 32, 64].map((value) => <option key={value} value={value}>Rank {value}</option>)}</select><select value={draft.parameters.alpha} onChange={(event) => updateParameter("alpha", Number(event.target.value))}>{[1, 4, 8, 16, 32, 64].filter((value) => value <= draft.parameters.rank).map((value) => <option key={value} value={value}>Alpha {value}</option>)}</select></div></label>
    <label><span>Epoch / 重复</span><div><input type="number" min={1} max={20} value={draft.parameters.epochs} onChange={(event) => updateParameter("epochs", Number(event.target.value))} /><input type="number" min={1} max={50} value={draft.parameters.repeats} onChange={(event) => updateParameter("repeats", Number(event.target.value))} /></div></label>
    <label><span>学习率</span><input type="number" min={0.000001} max={0.01} step={0.00001} value={draft.parameters.learningRate} onChange={(event) => updateParameter("learningRate", Number(event.target.value))} /></label>
    <label><span>学习率调度</span><select value={draft.parameters.lrScheduler} onChange={(event) => updateParameter("lrScheduler", event.target.value as DesktopTrainingJobCreateInput["parameters"]["lrScheduler"])}><option value="constant">Constant</option><option value="cosine">Cosine</option><option value="cosine_with_restarts">Cosine Restarts</option></select></label>
    <label><span>梯度累积</span><select value={draft.parameters.gradientAccumulationSteps} onChange={(event) => updateParameter("gradientAccumulationSteps", Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    <label><span>预热 / Dropout</span><div><input type="number" min={0} max={0.2} step={0.01} value={draft.parameters.warmupRatio} onChange={(event) => updateParameter("warmupRatio", Number(event.target.value))} /><input type="number" min={0} max={0.3} step={0.01} value={draft.parameters.captionDropoutRate} onChange={(event) => updateParameter("captionDropoutRate", Number(event.target.value))} /></div></label>
    <label><span>保留前置标签</span><input type="number" min={0} max={10} value={draft.parameters.keepTokens} onChange={(event) => updateParameter("keepTokens", Number(event.target.value))} /></label>
    <label className="training-checkbox"><input type="checkbox" checked={draft.parameters.shuffleCaption} onChange={(event) => updateParameter("shuffleCaption", event.target.checked)} /><span>随机打乱 Caption 标签</span></label>
    <label><span>随机种子</span><input type="number" min={0} max={2147483647} value={draft.parameters.seed} onChange={(event) => updateParameter("seed", Number(event.target.value))} /></label>
  </div><footer><button className="secondary" onClick={onBack}><ArrowLeft />返回训练集</button><button disabled={!draft.title.trim() || !modelId} onClick={onNext}>下一步：确认提交<ArrowRight /></button></footer></section>;
}

/** 训练集选择器在打标和训练页共享同一份 SQLite 数据。 */
function DatasetList({ datasets, selectedId, onSelect, expanded = false }: { datasets: DesktopTrainingDatasetView[]; selectedId: string; onSelect: (id: string) => void; expanded?: boolean }) {
  return <aside className={`section-card training-dataset-list ${expanded ? "is-expanded" : ""}`}><header><strong>训练集</strong><small>{datasets.length} 个</small></header>{datasets.length ? datasets.map((dataset) => <button key={dataset.id} className={dataset.id === selectedId ? "active" : ""} onClick={() => onSelect(dataset.id)}><span><strong>{dataset.title}</strong><small>{trainingTypeLabel(dataset.type)} · {dataset.assets.length} 张</small></span><b className={`is-${dataset.status}`}>{trainingStatusLabel(dataset.status)}</b></button>) : <div className="empty-block">请先在训练集打标页创建训练集</div>}</aside>;
}

/** 自动打标进度只读取持久化任务状态。 */
function CaptionJobStatus({ job, active, busy, onCancel }: { job: DesktopCaptionJobView; active: boolean; busy: boolean; onCancel: () => void }) {
  return <div className={`caption-job is-${job.status}`}><div><span><strong>{captionJobStatusLabel(job.status)}</strong><small>{job.processedAssets}/{job.totalAssets} · 成功 {job.succeededAssets} · 失败 {job.failedAssets} · 保留人工 {job.skippedAssets}</small></span><b>{job.progress}%</b></div><i><em style={{ width: `${job.progress}%` }} /></i>{job.error && <small>{job.error}</small>}{active && <button disabled={busy} onClick={onCancel}><X />取消任务</button>}</div>;
}

/** 单图编辑器独立保存草稿，并支持直接复制标准 Caption。 */
function TrainingAssetRow({ datasetId, asset, captionItem, captioningReady, captionJobActive, onRetag, onUpdated, onError }: { datasetId: string; asset: DesktopTrainingDatasetView["assets"][number]; captionItem: DesktopCaptionJobView["items"][number] | null; captioningReady: boolean; captionJobActive: boolean; onRetag: () => void; onUpdated: (dataset: DesktopTrainingDatasetView) => void; onError: (message: string) => void }) {
  const [caption, setCaption] = useState(asset.caption || "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setCaption(asset.caption || ""), [asset.caption]);
  const changed = caption.trim() !== (asset.caption || "").trim();
  const save = async () => {
    if (busy || !changed) return;
    setBusy(true);
    try { onUpdated(await updateDesktopTrainingCaption({ datasetId, assetId: asset.id, caption: caption.trim() || null })); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const sourceText = asset.captionSource === "manual" ? "人工 Caption" : asset.captionSource === "auto" ? "自动 Caption" : "尚未打标";
  return <article className={asset.available ? "" : "is-missing"}><div className="training-asset-image">{asset.available ? <img loading="lazy" src={convertFileSrc(asset.path)} alt={asset.fileName} /> : <div><AlertTriangle /><span>文件缺失</span></div>}<span>{asset.width}×{asset.height}</span></div><div className="training-asset-caption"><header><strong>{asset.fileName}</strong><small>{asset.sha256.slice(0, 12)} · {formatResourceBytes(asset.byteSize)}</small></header><textarea value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="使用英文逗号分隔准确标签；人工保存后批量任务不会改写" /><footer><span className={asset.available ? asset.confirmed ? "confirmed" : "pending" : "missing"}>{asset.available ? asset.confirmed ? "已确认" : `${sourceText}${captionItem ? ` · ${captionItemStatusLabel(captionItem.status)}` : ""}` : "文件缺失或已变化"}</span><div><button className="caption-row-action" disabled={!caption.trim()} onClick={() => void navigator.clipboard.writeText(caption.trim())}><Copy />复制</button><button className="caption-row-action" disabled={!captioningReady || captionJobActive || busy || !asset.available} onClick={onRetag}><Tags />{asset.caption?.trim() ? "重新打标" : "单图打标"}</button><button disabled={!changed || busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" /> : <Save />}{busy ? "保存中" : "保存 Caption"}</button></div></footer>{captionItem?.error && <small className="caption-item-error">{captionItem.error}</small>}</div></article>;
}

/** 当前训练集的历史任务不会反向锁定训练集编辑。 */
function TrainingJobList({ jobs, busy, onCancel }: { jobs: DesktopTrainingJobView[]; busy: boolean; onCancel: (id: string) => void }) {
  return <div className="desktop-training-jobs">{jobs.length ? jobs.map((job) => <article key={job.id} className={`is-${job.status}`}><header><span><b>{desktopTrainingStatusLabel(job.status)}</b><strong>{job.title}</strong><small>{job.modelDisplayName} · {job.assetCount} 张 · Rank {job.parameters.rank}</small></span><em>{job.progress}%</em></header><i><u style={{ width: `${job.progress}%` }} /></i><footer><span>{job.status === "queued" ? `队列第 ${job.queuePosition} 位` : job.status === "running" ? `Epoch ${job.currentEpoch}/${job.totalEpochs}` : job.outputLoraId ? "LoRA 已登记到本地仓库" : job.error || "任务已结束"}</span>{["queued", "running"].includes(job.status) && <button disabled={busy} onClick={() => onCancel(job.id)}><X />取消</button>}</footer>{job.suggestion && <p><AlertTriangle />{job.suggestion.message}{job.suggestion.resolution ? ` 建议分辨率 ${job.suggestion.resolution}px。` : ""}{job.suggestion.rank ? ` 建议 Rank ${job.suggestion.rank}。` : ""}</p>}</article>) : <div className="empty-block">提交后，当前训练集的任务会显示在这里</div>}</div>;
}

/** 8 GiB 设备默认使用约 80 次 512px 图片遍历，兼顾半小时内完成与可用 LoRA 质量。 */
function defaultDesktopTrainingDraft(dataset: DesktopTrainingDatasetView, modelId: string): DesktopTrainingJobCreateInput {
  const count = Math.max(5, dataset.assets.length);
  const epochs = count >= 80 ? 1 : count >= 40 ? 2 : 4;
  const repeats = Math.max(1, Math.round(80 / count / epochs));
  return { datasetId: dataset.id, modelId, title: `${dataset.title} LoRA`, parameters: { rank: 8, alpha: 8, epochs, repeats, resolution: 512, learningRate: 0.0001, lrScheduler: "constant", warmupRatio: 0, gradientAccumulationSteps: 1, captionDropoutRate: 0, shuffleCaption: false, keepTokens: 1, seed: Math.floor(Math.random() * 2147483647) } };
}

function trainingTypeLabel(type: DesktopTrainingDatasetView["type"]): string { return { character: "角色", style: "画风", concept: "概念" }[type]; }
function trainingStatusLabel(status: DesktopTrainingDatasetView["status"]): string { return { draft: "整理中", review_ready: "可确认", confirmed: "已确认" }[status]; }
function captionJobStatusLabel(status: DesktopCaptionJobView["status"]): string { return { queued: "等待离线打标", running: "正在离线打标", succeeded: "自动打标完成", failed: "自动打标部分或全部失败", cancelled: "自动打标已取消" }[status]; }
function captionItemStatusLabel(status: DesktopCaptionJobView["items"][number]["status"]): string { return { queued: "等待打标", running: "识别中", succeeded: "识别完成", failed: "识别失败", skipped: "保留人工内容", cancelled: "已取消" }[status]; }
function desktopTrainingStatusLabel(status: DesktopTrainingJobView["status"]): string { return { queued: "排队中", running: "训练中", succeeded: "训练完成", failed: "训练失败", cancelled: "已取消" }[status]; }
function formatResourceBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 ** 2).toFixed(1)} MiB`; }
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
