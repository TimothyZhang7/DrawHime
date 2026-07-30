/**
 * 本文件实现分阶段 LoRA 训练工作区：数据上传、持久化自动打标、人工确认、动态计价、训练提交与历史审计。
 */
import type { InferenceModelView, TrainingCaptionStageView, TrainingDatasetView, TrainingJobView, TrainingParameters, TrainingPriceQuoteView } from "@drawhime/contracts";
import { ArrowLeft, ArrowRight, BrainCircuit, Check, Circle, Eye, ImagePlus, LoaderCircle, Play, RefreshCw, Sparkles, Tags, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatQueueCompletion, formatQueueSummary } from "./queue-display";
import { TrainingCaptionReview, TrainingPrivateImage } from "./TrainingCaptionReview";
import { trainingBinary, trainingJson } from "./training-client";

const minimumTrainingImages = 5;
type TrainingStepId = "images" | "caption" | "review" | "configure" | "jobs";
const trainingSteps: Array<{ id: TrainingStepId; label: string; hint: string }> = [
  { id: "images", label: "准备图片", hint: "上传并检查训练素材" },
  { id: "caption", label: "自动打标", hint: "生成当前图片快照标签" },
  { id: "review", label: "核对标签", hint: "逐图编辑并确认" },
  { id: "configure", label: "训练设置", hint: "参数、价格与提交" },
  { id: "jobs", label: "训练任务", hint: "排队、进度与结果" },
];

/** 用户训练工作区。 */
export function TrainingPage({ token, models }: { token: string; models: InferenceModelView[] }) {
  const [datasets, setDatasets] = useState<TrainingDatasetView[]>([]);
  const [jobs, setJobs] = useState<TrainingJobView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedJob, setSelectedJob] = useState<TrainingJobView | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (quiet = false): Promise<{ datasets: TrainingDatasetView[]; jobs: TrainingJobView[] } | null> => {
    if (!token) { setDatasets([]); setJobs([]); setLoading(false); return null; }
    if (!quiet) setLoading(true);
    try {
      const [datasetPayload, jobPayload] = await Promise.all([
        trainingJson<{ datasets: TrainingDatasetView[] }>("/v1/training/datasets", token),
        trainingJson<{ jobs: TrainingJobView[] }>("/v1/training/jobs", token),
      ]);
      setDatasets(datasetPayload.datasets);
      setJobs(jobPayload.jobs);
      setSelectedId((current) => {
        const requested = new URLSearchParams(window.location.search).get("dataset") || "";
        if (requested && datasetPayload.datasets.some((item) => item.id === requested)) return requested;
        return datasetPayload.datasets.some((item) => item.id === current) ? current : datasetPayload.datasets[0]?.id || "";
      });
      if (!quiet) setMessage("");
      return { datasets: datasetPayload.datasets, jobs: jobPayload.jobs };
    } catch (error) { setMessage(errorMessage(error)); return null; }
    finally { if (!quiet) setLoading(false); }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasActiveWork = jobs.some((job) => !isTrainingFinal(job.status)) || datasets.some((dataset) => [dataset.captionStage, ...dataset.assets.map((asset) => asset.captionStage)].some((stage) => ["queued", "running"].includes(stage?.status || "")));
  useEffect(() => {
    if (!token || !hasActiveWork) return;
    const timer = window.setInterval(() => void refresh(true), 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveWork, refresh, token]);

  const selected = datasets.find((item) => item.id === selectedId) ?? null;
  /** 数据集切换同步地址栏并回到该数据集的权威进度，避免轮询把选择恢复成旧项目。 */
  const selectDataset = (datasetId: string) => {
    setSelectedId(datasetId);
    const url = new URL(window.location.href);
    url.searchParams.set("dataset", datasetId);
    url.searchParams.delete("trainingStep");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };
  return (
    <div className="training-page">
      <section className="training-sidebar card">
        <div className="card-head"><div><span>训练项目</span><h2>我的数据集</h2></div><button className="small-icon" onClick={() => void refresh()} aria-label="刷新训练数据"><RefreshCw size={15} className={loading ? "spin" : ""} /></button></div>
        <DatasetCreator token={token} onCreated={async (dataset) => { selectDataset(dataset.id); await refresh(); }} onError={setMessage} />
        {datasets.length === 0 ? <div className="training-empty">先建立项目，再按页面引导完成数据准备</div> : <div className="dataset-list">{datasets.map((dataset) => <button className={dataset.id === selectedId ? "active" : ""} key={dataset.id} onClick={() => selectDataset(dataset.id)}><strong>{dataset.title}</strong><small>{dataset.assets.length} 张 · {captionStageShortLabel(dataset.captionStage)}</small></button>)}</div>}
      </section>
      <main className="training-main">
        {message && <div className="notice error training-message"><span>{message}</span><button onClick={() => setMessage("")} aria-label="关闭提示"><X size={14} /></button></div>}
        {selected ? <TrainingWorkspace key={selected.id} token={token} dataset={selected} jobs={jobs.filter((job) => job.datasetId === selected.id)} models={models} onReload={async () => { const payload = await refresh(true); return payload?.datasets.find((item) => item.id === selected.id) || null; }} onDeleted={async () => { const url = new URL(window.location.href); url.searchParams.delete("dataset"); url.searchParams.delete("trainingStep"); window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`); await refresh(); }} onDetail={setSelectedJob} onError={setMessage} /> : <section className="card training-welcome"><BrainCircuit size={38} /><h2>建立专属 LoRA</h2><p>每个阶段使用独立页面；上一步通过服务端校验后才开放下一步，刷新后按权威状态恢复。</p></section>}
      </main>
      {selectedJob && <TrainingJobDialog token={token} job={selectedJob} onClose={() => setSelectedJob(null)} />}
    </div>
  );
}

/** 单个训练集使用独立分步页面；回退会截断前端通行状态，重新前进时再次读取服务端校验。 */
function TrainingWorkspace({ token, dataset, jobs, models, onReload, onDeleted, onDetail, onError }: { token: string; dataset: TrainingDatasetView; jobs: TrainingJobView[]; models: InferenceModelView[]; onReload: () => Promise<TrainingDatasetView | null>; onDeleted: () => Promise<void>; onDetail: (job: TrainingJobView) => void; onError: (message: string) => void }) {
  const initialIndex = initialTrainingStepIndex(dataset);
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [verifiedIndex, setVerifiedIndex] = useState(initialIndex);
  const [visited, setVisited] = useState<Set<TrainingStepId>>(() => new Set([trainingSteps[initialIndex]!.id]));
  const [checking, setChecking] = useState(false);
  const activeStep = trainingSteps[activeIndex]!.id;

  useEffect(() => { writeTrainingStep(activeStep); }, [activeStep]);
  useEffect(() => {
    if (isTrainingStepReachable(dataset, activeStep)) return;
    const fallback = highestReachableStepIndex(dataset);
    setActiveIndex(fallback);
    setVerifiedIndex(fallback);
    setVisited((current) => new Set(current).add(trainingSteps[fallback]!.id));
  }, [activeStep, dataset]);

  /** 回到之前阶段时立即收回后续页面通行权，后续必须逐页重新校验。 */
  const openStep = (index: number) => {
    if (index > verifiedIndex) return;
    setActiveIndex(index);
    if (index < activeIndex) setVerifiedIndex(index);
    setVisited((current) => new Set(current).add(trainingSteps[index]!.id));
  };
  /** 下一步前重新请求当前数据集，避免使用页面缓存跳过图片快照或确认状态校验。 */
  const advance = async () => {
    setChecking(true);
    try {
      const current = await onReload();
      if (!current) return onError("训练集刷新失败，请重试");
      const issue = trainingStepIssue(current, activeStep);
      if (issue) return onError(issue);
      const nextIndex = Math.min(trainingSteps.length - 1, activeIndex + 1);
      setVerifiedIndex(nextIndex);
      setActiveIndex(nextIndex);
      setVisited((items) => new Set(items).add(trainingSteps[nextIndex]!.id));
    } finally { setChecking(false); }
  };
  const changed = async () => { await onReload(); };
  const finishTraining = async () => { await onReload(); setVerifiedIndex(4); setActiveIndex(4); setVisited((current) => new Set(current).add("jobs")); };

  return <div className="training-flow">
    <TrainingStepNavigation dataset={dataset} activeIndex={activeIndex} verifiedIndex={verifiedIndex} onOpen={openStep} />
    {visited.has("images") && <div className="training-flow-panel" hidden={activeStep !== "images"}><DatasetEditor token={token} dataset={dataset} onChanged={changed} onDeleted={onDeleted} onError={onError} /><TrainingFlowFooter activeIndex={activeIndex} checking={checking} onBack={() => openStep(activeIndex - 1)} onNext={() => void advance()} /></div>}
    {visited.has("caption") && <div className="training-flow-panel" hidden={activeStep !== "caption"}><CaptionStage token={token} dataset={dataset} onChanged={changed} onError={onError} /><TrainingFlowFooter activeIndex={activeIndex} checking={checking} onBack={() => openStep(activeIndex - 1)} onNext={() => void advance()} /></div>}
    {visited.has("review") && <div className="training-flow-panel" hidden={activeStep !== "review"}><TrainingCaptionReview token={token} dataset={dataset} onChanged={changed} onConfirmed={async () => undefined} onError={onError} /><TrainingFlowFooter activeIndex={activeIndex} checking={checking} onBack={() => openStep(activeIndex - 1)} onNext={() => void advance()} /></div>}
    {visited.has("configure") && <div className="training-flow-panel" hidden={activeStep !== "configure"}><TrainingCreator token={token} dataset={dataset} models={models} onCreated={finishTraining} /><TrainingFlowFooter activeIndex={activeIndex} checking={checking} onBack={() => openStep(activeIndex - 1)} onNext={dataset.trainingJobCount > 0 ? () => void advance() : undefined} /></div>}
    {visited.has("jobs") && <div className="training-flow-panel" hidden={activeStep !== "jobs"}><TrainingJobs token={token} jobs={jobs} onChanged={changed} onDetail={onDetail} onError={onError} /><TrainingFlowFooter activeIndex={activeIndex} checking={checking} onBack={() => openStep(activeIndex - 1)} /></div>}
  </div>;
}

/** 顶部步骤条复用 Bot 绑定式单页流程，禁用尚未通过重新校验的后续页面。 */
function TrainingStepNavigation({ dataset, activeIndex, verifiedIndex, onOpen }: { dataset: TrainingDatasetView; activeIndex: number; verifiedIndex: number; onOpen: (index: number) => void }) {
  return <nav className="training-step-navigation" aria-label="LoRA 训练步骤">{trainingSteps.map((step, index) => { const completed = trainingStepCompleted(dataset, step.id); const needsRecheck = completed && index > verifiedIndex; return <button key={step.id} className={`${index === activeIndex ? "active" : ""}${completed && !needsRecheck ? " done" : ""}${needsRecheck ? " recheck" : ""}`} disabled={index > verifiedIndex} onClick={() => onOpen(index)}><i>{completed && !needsRecheck ? <Check size={13} /> : index + 1}</i><span><strong>{step.label}</strong><small>{needsRecheck ? "需重新校验" : step.hint}</small></span></button>; })}</nav>;
}

/** 每个阶段底部只提供回退或重新校验后继续，避免跨页跳步。 */
function TrainingFlowFooter({ activeIndex, checking, onBack, onNext }: { activeIndex: number; checking: boolean; onBack: () => void; onNext?: () => void }) {
  return <footer className="training-flow-footer">{activeIndex > 0 && <button onClick={onBack}><ArrowLeft size={14} />返回上一步</button>}<span>返回后，后续步骤需要按顺序重新校验。</span>{onNext && <button className="next" disabled={checking} onClick={onNext}>{checking ? <LoaderCircle className="spin" /> : <>重新校验并继续<ArrowRight size={14} /></>}</button>}</footer>;
}

/** 创建带用途说明的数据集。 */
function DatasetCreator({ token, onCreated, onError }: { token: string; onCreated: (dataset: TrainingDatasetView) => Promise<void>; onError: (message: string) => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const dataset = await trainingJson<TrainingDatasetView>("/v1/training/datasets", token, { method: "POST", body: JSON.stringify({ title: title.trim(), description: null }) });
      setTitle(""); await onCreated(dataset);
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <div className="dataset-create"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="新训练项目名称" maxLength={191} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} /><button disabled={busy || !title.trim()} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : "创建"}</button></div>;
}

/** 图片准备页只负责上传、预览和移除，标签编辑固定放在后续独立核对页面。 */
function DatasetEditor({ token, dataset, onChanged, onDeleted, onError }: { token: string; dataset: TrainingDatasetView; onChanged: () => Promise<void>; onDeleted: () => Promise<void>; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const captionActive = ["queued", "running"].includes(dataset.captionStage?.status || "");
  const locked = dataset.trainingJobCount > 0 || captionActive;
  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      for (let index = 0; index < files.length; index += 1) {
        setProgress(`上传 ${index + 1}/${files.length}`);
        await trainingBinary(`/v1/training/datasets/${dataset.id}/assets`, token, files[index]!, "POST");
      }
      setProgress("上传完成"); await onChanged();
    } catch (error) { const message = errorMessage(error); setProgress(message); onError(message); }
    finally { setBusy(false); }
  };
  const remove = async (assetId: string) => {
    if (!window.confirm("移除这张训练图片？图片快照变化后需要重新自动打标。")) return;
    try { await trainingJson(`/v1/training/datasets/${dataset.id}/assets/${assetId}`, token, { method: "DELETE" }); await onChanged(); }
    catch (error) { onError(errorMessage(error)); }
  };
  const archive = async () => {
    if (dataset.trainingJobCount > 0 || !window.confirm(`归档数据集“${dataset.title}”？训练图片会保留用于审计。`)) return;
    try { await trainingJson(`/v1/training/datasets/${dataset.id}`, token, { method: "DELETE" }); await onDeleted(); }
    catch (error) { onError(errorMessage(error)); }
  };
  return <section className="card dataset-editor training-stage-card">
    <header className="training-page-heading"><div><span>STEP 01</span><h2>准备训练图片</h2><p>上传 {minimumTrainingImages}–200 张同一角色、画风或概念的清晰图片；重复图片会被 SHA-256 拒绝。</p></div><strong>{dataset.assets.length}/200</strong></header>
    <div className="dataset-toolbar"><span>{dataset.assets.length}/200 张</span><label className="dataset-upload"><ImagePlus size={15} />{progress || "添加图片"}<input type="file" accept="image/*,.avif,.heic,.heif,.webp" multiple disabled={busy || locked} onChange={(event) => void upload(Array.from(event.target.files || []).slice(0, 200 - dataset.assets.length))} /></label><button className="dataset-archive" disabled={busy || dataset.trainingJobCount > 0} onClick={() => void archive()}><Trash2 size={14} />归档</button></div>
    {dataset.trainingJobCount > 0 && <div className="dataset-lock">该数据集已经用于训练，内容已锁定以保证任务可审计。</div>}
    {captionActive && <div className="dataset-lock">自动打标正在读取当前图片快照，完成前暂不允许增删或编辑。</div>}
    <div className="dataset-assets">{dataset.assets.map((asset) => <article className="dataset-asset-preview" key={asset.id}><TrainingPrivateImage token={token} datasetId={dataset.id} assetId={asset.id} /><span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "训练图片"}</span><button disabled={locked} onClick={() => void remove(asset.id)} aria-label="移除训练图片"><Trash2 size={14} /></button></article>)}{dataset.assets.length === 0 && <label className="dataset-drop"><ImagePlus /><strong>拖入角色、画风或概念图片</strong><small>常见格式会统一方向、色彩空间并保存为高质量 WebP</small><input type="file" accept="image/*,.avif,.heic,.heif,.webp" multiple disabled={busy} onChange={(event) => void upload(Array.from(event.target.files || []).slice(0, 200))} /></label>}</div>
  </section>;
}

/** 持久化自动打标、进度、人工检查和确认操作。 */
function CaptionStage({ token, dataset, onChanged, onError }: { token: string; dataset: TrainingDatasetView; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [mode, setMode] = useState<"character" | "style" | "concept">("character");
  const [busy, setBusy] = useState(false);
  const stage = dataset.captionStage;
  const active = ["queued", "running"].includes(stage?.status || "");
  const start = async () => {
    setBusy(true);
    try { await trainingJson(`/v1/training/datasets/${dataset.id}/caption-jobs`, token, { method: "POST", body: JSON.stringify({ mode }) }); await onChanged(); }
    catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <section className="card training-stage-card caption-stage">
    <header className="training-page-heading"><div><span>STEP 02</span><h2>自动打标</h2><p>AI 按当前图片快照逐图生成英文 Anima 标签；本页只负责生成，下一页单独核对和确认。</p></div><strong>{stage ? `${Math.round(stage.progress)}%` : "待开始"}</strong></header>
    <div className="caption-controls"><label><span>打标重点</span><select value={mode} disabled={active || busy} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="character">角色 LoRA：外观、服装、姿势</option><option value="style">画风 LoRA：媒介、线条、色彩、光影</option><option value="concept">概念 LoRA：主体、场景、画风平衡</option></select></label><button className="caption-run" disabled={busy || active || dataset.assets.length < minimumTrainingImages || dataset.trainingJobCount > 0} onClick={() => void start()}>{busy ? <LoaderCircle className="spin" /> : <Sparkles size={15} />}{stage ? "重新自动打标" : "开始自动打标"}</button></div>
    {stage ? <div className={`caption-status is-${stage.status}`}><div><Tags size={18} /><span><strong>{captionStageLabel(stage.status)}</strong><small>{stage.completedAssets}/{stage.totalAssets} 张 · {Math.round(stage.progress)}%</small></span></div><div className="training-progress"><i style={{ width: `${stage.progress}%` }} /></div>{stage.errorMessage && <p>{stage.errorMessage}</p>}</div> : <div className="caption-hint">上传至少 {minimumTrainingImages} 张图片后开始；任务会持久化，关闭或刷新页面不会丢失进度。</div>}
    {["awaiting_confirmation", "confirmed"].includes(stage?.status || "") && <div className="caption-review"><div><strong>当前图片快照已完成打标</strong><span>进入下一页后逐图核对中英标签；任何修改都需要重新确认。</span></div><Check size={18} /></div>}
  </section>;
}

/** 创建使用真实 Runtime 参数和服务端动态计价的训练任务。 */
function TrainingCreator({ token, dataset, models, onCreated }: { token: string; dataset: TrainingDatasetView; models: InferenceModelView[]; onCreated: () => Promise<void> }) {
  // 蒸馏推理底模不具备稳定训练语义，只展示目录明确允许训练的 Anima 模型。
  const animaModels = useMemo(() => models.filter((model) => model.family === "anima" && model.defaultParameters.trainingSupported !== false), [models]);
  const [modelId, setModelId] = useState("");
  const [title, setTitle] = useState("");
  const [triggers, setTriggers] = useState(() => dataset.triggerWords.join(", "));
  const [parameters, setParameters] = useState<TrainingParameters>(() => defaultTrainingParameters(dataset.assets.length));
  const [quote, setQuote] = useState<TrainingPriceQuoteView | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmed = dataset.captionStage?.status === "confirmed";
  useEffect(() => { if (!modelId && animaModels[0]) setModelId(animaModels[0].modelVersionId); }, [animaModels, modelId]);
  useEffect(() => {
    if (!modelId || dataset.assets.length < minimumTrainingImages) { setQuote(null); return; }
    const timer = window.setTimeout(() => {
      setQuoteLoading(true);
      void trainingJson<TrainingPriceQuoteView>("/v1/training/quotes", token, { method: "POST", body: JSON.stringify({ datasetId: dataset.id, baseModelVersionId: modelId, parameters }) }).then((value) => { setQuote(value); setError(""); }).catch((requestError) => { setQuote(null); setError(errorMessage(requestError)); }).finally(() => setQuoteLoading(false));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [dataset.assets.length, dataset.id, modelId, parameters, token]);
  const update = <Key extends keyof TrainingParameters>(key: Key, value: TrainingParameters[Key]) => setParameters((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    const triggerWords = triggers.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
    if (!confirmed) return setError("请先完成自动打标并确认 Caption");
    if (!title.trim() || triggerWords.length === 0 || !modelId) return setError("请填写 LoRA 标题、触发词并选择基础模型");
    if (!quote) return setError("动态价格尚未完成试算");
    setBusy(true); setError("");
    try {
      const finalParameters = { ...parameters, samplePrompt: parameters.samplePrompt.trim() || triggerWords.join(", ") };
      await trainingJson("/v1/training/jobs", token, { method: "POST", body: JSON.stringify({ idempotencyKey: `web-training:${crypto.randomUUID()}`, datasetId: dataset.id, baseModelVersionId: modelId, title: title.trim(), triggerWords, parameters: finalParameters }) });
      setTitle(""); setTriggers(""); setParameters(defaultTrainingParameters(dataset.assets.length)); await onCreated();
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setBusy(false); }
  };
  return <section className={`card training-stage-card training-create${confirmed ? "" : " is-locked"}`}>
    <header className="training-page-heading"><div><span>STEP 04</span><h2>训练设置</h2><p>配置参数并核对动态价格；提交时服务端再次复算并按相同单位预留余额。</p></div><strong>{quote ? `¥${quote.estimatedPrice}` : "试算中"}</strong></header>
    {!confirmed && <div className="training-locked"><Circle size={16} />服务端确认状态已变化，请返回标签核对页重新确认。</div>}
    <fieldset disabled={!confirmed || busy}>
      <div className="field-grid"><label className="field"><span>LoRA 标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：角色名 · 夏日服装" /></label><label className="field"><span>基础模型</span><select value={modelId} onChange={(event) => setModelId(event.target.value)}>{animaModels.map((model) => <option key={model.modelVersionId} value={model.modelVersionId}>{model.displayName}</option>)}</select></label></div>
      <label className="field"><span>触发词 <small>逗号分隔，训练图片 Caption 中不会自动加入</small></span><input value={triggers} onChange={(event) => setTriggers(event.target.value)} placeholder="例如：my_character" /></label>
      <div className="parameter-section"><header><strong>模型容量</strong><span>Rank 越高容量和价格越高</span></header><div className="training-parameters"><ParameterSelect label="Rank" value={parameters.rank} values={[8, 16, 32, 64]} onChange={(value) => setParameters((current) => ({ ...current, rank: value, alpha: Math.min(current.alpha, value) }))} /><ParameterSelect label="Alpha" value={parameters.alpha} values={[1, 4, 8, 16, 32, 64].filter((value) => value <= parameters.rank)} onChange={(value) => update("alpha", value)} /></div></div>
      <div className="parameter-section"><header><strong>训练强度</strong><span>快速默认会按图片数控制在约 160 次图片遍历，兼顾半小时目标与基础收敛</span></header><div className="training-parameters"><ParameterNumber label="Epoch" value={parameters.epochs} min={1} max={20} onChange={(value) => update("epochs", value)} /><ParameterNumber label="重复次数" value={parameters.repeats} min={1} max={50} onChange={(value) => update("repeats", value)} /><ParameterSelect label="分辨率" value={parameters.resolution} values={[512, 768, 1024, 1280, 1536]} onChange={(value) => update("resolution", value)} /><label>学习率<input value={parameters.learningRate} onChange={(event) => update("learningRate", Number(event.target.value))} /></label></div></div>
      <div className="parameter-section"><header><strong>优化过程</strong><span>所有选项都会进入 sd-scripts Runtime</span></header><div className="training-parameters"><label>调度器<select value={parameters.lrScheduler} onChange={(event) => update("lrScheduler", event.target.value as TrainingParameters["lrScheduler"])}><option value="constant">Constant</option><option value="cosine">Cosine</option><option value="cosine_with_restarts">Cosine Restarts</option></select></label><label>预热比例<input type="number" min="0" max="0.2" step="0.01" value={parameters.warmupRatio} onChange={(event) => update("warmupRatio", Number(event.target.value))} /></label><ParameterSelect label="梯度累积" value={parameters.gradientAccumulationSteps} values={[1, 2, 4]} onChange={(value) => update("gradientAccumulationSteps", value)} /><ParameterSelect label="失败尝试" value={parameters.maxAttempts} values={[1, 2, 3]} onChange={(value) => update("maxAttempts", value)} /></div></div>
      <div className="parameter-section"><header><strong>Caption 策略</strong><span>随机打乱启用时自动切换到兼容的非缓存文本编码路径</span></header><div className="training-parameters"><label>Caption Dropout<input type="number" min="0" max="0.3" step="0.05" value={parameters.captionDropoutRate} onChange={(event) => update("captionDropoutRate", Number(event.target.value))} /></label><ParameterNumber label="保留前置 Token" value={parameters.keepTokens} min={0} max={10} onChange={(value) => update("keepTokens", value)} /><label className="parameter-check"><input type="checkbox" checked={parameters.shuffleCaption} onChange={(event) => update("shuffleCaption", event.target.checked)} />随机打乱 Caption</label><ParameterNumber label="随机种子" value={parameters.seed} min={0} max={2147483647} onChange={(value) => update("seed", value)} /></div></div>
      <label className="field"><span>训练后测试提示词</span><textarea rows={3} value={parameters.samplePrompt} onChange={(event) => update("samplePrompt", event.target.value)} placeholder="留空时使用触发词" /></label>
    </fieldset>
    <div className="training-quote"><div><span>动态试算</span><strong>{quoteLoading ? "计算中…" : quote ? `¥${quote.estimatedPrice}` : "等待参数"}</strong></div>{quote && <p>{quote.assetCount} 张 × {parameters.repeats} 重复 × {parameters.epochs} Epoch = {quote.imagePasses.toLocaleString()} 次图片遍历；约 {quote.estimatedOptimizerSteps.toLocaleString()} 个优化步，{quote.priceUnits} 个计价单位 × ¥{quote.baseUnitPrice}。</p>}</div>
    {error && <div className="notice error compact">{error}</div>}<button className="primary-button" disabled={busy || !confirmed || !quote || quoteLoading || animaModels.length === 0} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <Play size={16} />}{busy ? "正在创建训练任务" : quote ? `确认 ¥${quote.estimatedPrice} 并提交训练` : "等待价格试算"}</button>
  </section>;
}

/** 统一渲染数字参数。 */
function ParameterNumber({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) { return <label>{label}<input type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>; }
/** 统一渲染有限枚举数字参数。 */
function ParameterSelect({ label, value, values, onChange }: { label: string; value: number; values: number[]; onChange: (value: number) => void }) { return <label>{label}<select value={value} onChange={(event) => onChange(Number(event.target.value))}>{values.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>; }
/** 持久化训练任务状态列表。 */
function TrainingJobs({ token, jobs, onChanged, onDetail, onError }: { token: string; jobs: TrainingJobView[]; onChanged: () => Promise<void>; onDetail: (job: TrainingJobView) => void; onError: (message: string) => void }) {
  const cancel = async (job: TrainingJobView) => { if (!window.confirm("取消训练并释放预留余额？")) return; try { await trainingJson(`/v1/training/jobs/${job.id}/cancel`, token, { method: "POST", body: "{}" }); await onChanged(); } catch (error) { onError(errorMessage(error)); } };
  const remove = async (job: TrainingJobView) => { if (!window.confirm("删除该训练记录？训练出的 LoRA、余额和计费审计会保留。")) return; try { await trainingJson(`/v1/training/jobs/${job.id}`, token, { method: "DELETE" }); await onChanged(); } catch (error) { onError(errorMessage(error)); } };
  return <section className="training-jobs"><div className="section-title"><div><span>训练记录</span><h2>持久化任务</h2></div><b>{jobs.length}</b></div>{jobs.length === 0 ? <div className="card training-empty">参数确认并提交后，任务会立即显示在这里</div> : jobs.map((job) => <article className="card training-job" key={job.id}><div><span className={`status ${job.status}`}>{trainingStatusLabel(job.status)}</span><h3>{job.title}</h3><p>{job.datasetTitle} · {job.baseModelDisplayName}</p></div><div className="training-progress"><i style={{ width: `${job.progress}%` }} /><span>{Math.round(job.progress)}%</span></div><div><small>{job.billing ? `¥${job.billing.amount} · ${job.billing.status}` : "等待计费"}</small><button className="training-detail-button" onClick={() => onDetail(job)}><Eye size={13} />详情</button>{["queued", "reserving", "ready"].includes(job.status) && <button onClick={() => void cancel(job)}><X size={13} />取消</button>}{isTrainingFinal(job.status) && <button className="dataset-archive" onClick={() => void remove(job)}><Trash2 size={13} />删除记录</button>}</div>{job.queue && <p className="training-queue-summary">{formatQueueSummary(job.queue)} · {formatQueueCompletion(job.queue)}</p>}{job.errorMessage && <em>{job.errorMessage}</em>}{job.outputLoraVersionId && <strong className="training-result">LoRA 已生成，可直接在 LoRA 仓库使用并补充示例图</strong>}</article>)}</section>;
}

/** 展示固化参数、动态计费、Runtime 尝试和结果。 */
function TrainingJobDialog({ token, job, onClose }: { token: string; job: TrainingJobView; onClose: () => void }) {
  const [detail, setDetail] = useState(job); const [error, setError] = useState("");
  useEffect(() => { let active = true; const load = async () => { try { const current = await trainingJson<TrainingJobView>(`/v1/training/jobs/${job.id}`, token); if (active) { setDetail(current); setError(""); } } catch (requestError) { if (active) setError(errorMessage(requestError)); } }; void load(); const timer = isTrainingFinal(detail.status) ? undefined : window.setInterval(() => void load(), 5000); return () => { active = false; if (timer) window.clearInterval(timer); }; }, [detail.status, job.id, token]);
  useEffect(() => { const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", closeOnEscape); return () => window.removeEventListener("keydown", closeOnEscape); }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="task-dialog training-dialog" role="dialog" aria-modal="true" aria-label="训练任务详情"><header><div><span>训练任务详情</span><h2>{detail.id}</h2></div><button onClick={onClose} aria-label="关闭"><X /></button></header><div className="task-detail-body">{error && <div className="notice error">{error}</div>}<div className="detail-summary"><div><span>状态</span><strong>{trainingStatusLabel(detail.status)} · {Math.round(detail.progress)}%</strong></div><div><span>基础模型</span><strong>{detail.baseModelDisplayName}</strong></div><div><span>实际计费</span><strong>{detail.billing ? `¥${detail.billing.amount} · ${detail.billing.status}` : "等待计费"}</strong></div><div><span>创建</span><strong>{new Date(detail.createdAt).toLocaleString("zh-CN")}</strong></div>{detail.queue && <div className="queue-detail"><span>排队信息</span><strong>{formatQueueSummary(detail.queue)}</strong><small>{formatQueueCompletion(detail.queue)}</small></div>}</div><section className="detail-block"><h3>数据集</h3><p>{detail.datasetTitle} · {detail.datasetId}</p></section><TrainingJsonBlock title="固化训练参数与价格 JSON" value={detail.parameters} /><section className="execution-list"><h3>Runtime 尝试</h3>{detail.attempts.length === 0 ? <p>尚未进入训练 Runtime</p> : detail.attempts.map((attempt) => <article key={attempt.id}><b>第 {attempt.attemptNumber} 次 · {attempt.runtimeJobId || "等待 Runtime ID"}</b><span>{attempt.status}</span>{attempt.errorMessage && <em>{attempt.errorMessage}</em>}{attempt.metrics && <TrainingJsonBlock title="指标 JSON" value={attempt.metrics} />}</article>)}</section>{detail.outputLoraVersionId && <section className="detail-block"><h3>输出 LoRA 版本</h3><p>{detail.outputLoraVersionId}</p></section>}{detail.errorMessage && <section className="detail-block training-error-block"><h3>错误</h3><p>{detail.errorMessage}</p></section>}</div><footer><button onClick={onClose}>关闭</button></footer></section></div>;
}

/** 按数据集规模生成 P40 快速默认参数，避免大数据集继续线性放大训练时长。 */
function defaultTrainingParameters(assetCount: number): TrainingParameters {
  const safeAssetCount = Math.max(minimumTrainingImages, assetCount);
  const epochs = safeAssetCount >= 80 ? 1 : safeAssetCount >= 40 ? 2 : 4;
  const repeats = Math.max(1, Math.round(160 / safeAssetCount / epochs));
  return { rank: 16, alpha: 16, epochs, repeats, resolution: 768, learningRate: 0.0001, lrScheduler: "constant", warmupRatio: 0, gradientAccumulationSteps: 1, captionDropoutRate: 0, shuffleCaption: false, keepTokens: 1, seed: Math.floor(Math.random() * 2147483647), maxAttempts: 2, samplePrompt: "" };
}
function captionStageLabel(status: string): string { return { not_started: "尚未开始", queued: "等待自动打标", running: "正在逐图打标", awaiting_confirmation: "等待人工确认", confirmed: "Caption 已确认", failed: "自动打标失败，可重试", stale: "图片已变化，需要重做" }[status] || status; }
function captionStageShortLabel(stage: TrainingCaptionStageView | null): string { return stage ? captionStageLabel(stage.status) : "未打标"; }
function TrainingJsonBlock({ title, value }: { title: string; value: Record<string, unknown> }) { return <details className="json-block"><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>; }

/** 初次进入按服务端状态恢复到最远可执行页，并校验地址栏请求没有越过前置条件。 */
function initialTrainingStepIndex(dataset: TrainingDatasetView): number {
  const requested = trainingSteps.findIndex((step) => step.id === new URLSearchParams(window.location.search).get("trainingStep"));
  const highest = highestReachableStepIndex(dataset);
  return requested >= 0 ? Math.min(requested, highest) : highest;
}

/** 依据持久化图片快照、打标确认和任务数量计算当前最远可进入步骤。 */
function highestReachableStepIndex(dataset: TrainingDatasetView): number {
  if (dataset.assets.length < minimumTrainingImages) return 0;
  if (!["awaiting_confirmation", "confirmed"].includes(dataset.captionStage?.status || "")) return 1;
  if (dataset.captionStage?.status !== "confirmed") return 2;
  return dataset.trainingJobCount > 0 ? 4 : 3;
}

/** 判断指定步骤是否仍满足服务端前置状态；状态回退时页面会同步退回。 */
function isTrainingStepReachable(dataset: TrainingDatasetView, step: TrainingStepId): boolean {
  return trainingSteps.findIndex((item) => item.id === step) <= highestReachableStepIndex(dataset);
}

/** 步骤完成态只用于展示，真正前进仍会再次请求服务端进行校验。 */
function trainingStepCompleted(dataset: TrainingDatasetView, step: TrainingStepId): boolean {
  if (step === "images") return dataset.assets.length >= minimumTrainingImages;
  if (step === "caption") return ["awaiting_confirmation", "confirmed"].includes(dataset.captionStage?.status || "");
  if (step === "review") return dataset.captionStage?.status === "confirmed";
  return dataset.trainingJobCount > 0;
}

/** 返回当前步骤阻断原因；空值表示允许按顺序进入下一页。 */
function trainingStepIssue(dataset: TrainingDatasetView, step: TrainingStepId): string | null {
  const anyCaptionActive = [dataset.captionStage, ...dataset.assets.map((asset) => asset.captionStage)].some((stage) => ["queued", "running"].includes(stage?.status || ""));
  const allCaptioned = dataset.assets.length >= minimumTrainingImages && dataset.assets.every((asset) => Boolean(asset.caption?.trim()));
  if (step === "images" && dataset.assets.length < minimumTrainingImages) return `至少上传 ${minimumTrainingImages} 张图片后才能进入自动打标`;
  if (step === "caption" && anyCaptionActive) return "自动打标仍在处理，请完成后再进入标签核对";
  if (step === "caption" && (!["awaiting_confirmation", "confirmed"].includes(dataset.captionStage?.status || "") || !allCaptioned)) return "请先完成当前图片快照的自动打标，并确保每张图片都有标签";
  if (step === "review" && (dataset.captionStage?.status !== "confirmed" || !allCaptioned)) return "请逐图保存标签并确认当前图片快照后再进入训练设置";
  return null;
}

/** 将当前训练步骤写入地址栏，刷新页面后仍从已校验的服务端状态恢复。 */
function writeTrainingStep(step: TrainingStepId): void {
  const url = new URL(window.location.href);
  url.searchParams.set("trainingStep", step);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function isTrainingFinal(status: TrainingJobView["status"]): boolean { return ["succeeded", "failed", "cancelled"].includes(status); }
function trainingStatusLabel(status: TrainingJobView["status"]): string { return { queued: "排队中", reserving: "排队中", ready: "排队中", running: "训练中", evaluating: "保存结果", succeeded: "已完成", failed: "失败", cancelled: "已取消" }[status]; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "操作失败"; }
