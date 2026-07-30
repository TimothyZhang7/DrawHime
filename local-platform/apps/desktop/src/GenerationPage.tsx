/**
 * 本文件实现本地生成的固定参数栏、质量预设、专业参数和持久任务预览。
 */
import type { DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalLoraView, DesktopLocalModelView, DesktopSettings } from "@drawhime/contracts";
import { convertFileSrc } from "@tauri-apps/api/core";
import { CheckCircle2, ChevronDown, CircleHelp, Database, Gauge, Image, Layers3, LoaderCircle, Play, SlidersHorizontal, Sparkles, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { createDesktopLocalJob } from "./desktop-api";

type PresetName = Exclude<DesktopLocalJobCreateInput["qualityPreset"], "custom">;

interface GenerationPageProps {
  models: DesktopLocalModelView[];
  loras: DesktopLocalLoraView[];
  jobs: DesktopLocalJobView[];
  inferenceReady: boolean;
  defaultPrivacy: DesktopSettings["defaultPrivacy"];
  onCreated: (job: DesktopLocalJobView) => void;
  onError: (message: string) => void;
}

const PRESETS: Array<{ id: PresetName; title: string; summary: string; detail: string; Icon: typeof Zap }> = [
  { id: "fast", title: "快速", summary: "20 步 · 约 0.8 MP", detail: "适合构图测试、提示词迭代与 LoRA 强度试验。", Icon: Zap },
  { id: "quality", title: "质量", summary: "37 步 · 约 1.35 MP", detail: "默认档，与当前 GPU 服务器平衡质量参数一致。", Icon: Sparkles },
  { id: "extreme", title: "极致", summary: "45 步 · 约 2.07 MP", detail: "优先细节和材质，显存占用与生成时间最高。", Icon: Gauge },
];
const STANDARD_SIZES = ["1024x1024", "1024x1536", "1536x1024", "864x1536", "1536x864"];

/** 本地生成页在页面切换时保持表单实例，任务提交后立即交给 SQLite 队列。 */
export function GenerationPage({ models, loras, jobs, inferenceReady, defaultPrivacy, onCreated, onError }: GenerationPageProps) {
  const availableModels = useMemo(() => models.filter((model) => model.available), [models]);
  const availableLoras = useMemo(() => loras.filter((lora) => lora.available), [loras]);
  const latestJob = useMemo(() => jobs.reduce<DesktopLocalJobView | null>((latest, job) => !latest || job.createdAt > latest.createdAt ? job : latest, null), [jobs]);
  const [form, setForm] = useState<DesktopLocalJobCreateInput>(() => createInitialForm(defaultPrivacy));
  const [busy, setBusy] = useState(false);
  const selectedModel = availableModels.find((model) => model.id === form.modelId) || null;

  useEffect(() => {
    if (availableModels.some((model) => model.id === form.modelId)) return;
    const model = availableModels[0];
    setForm((current) => model ? applyPreset({ ...current, modelId: model.id }, "quality", model) : { ...current, modelId: "" });
  }, [availableModels, form.modelId]);
  useEffect(() => { setForm((current) => ({ ...current, loras: current.loras.filter((selection) => availableLoras.some((lora) => lora.id === selection.id)) })); }, [availableLoras]);
  useEffect(() => { setForm((current) => ({ ...current, privacy: defaultPrivacy })); }, [defaultPrivacy]);

  /** 预设同时刷新模型级采样器、CFG 和质量预算，后端仍会再次权威解析。 */
  const choosePreset = (preset: PresetName) => setForm((current) => applyPreset(current, preset, selectedModel));
  /** 手动修改专业参数后标记为自定义，保证用户值不会被后端预设覆盖。 */
  const changeProfessional = <Key extends keyof DesktopLocalJobCreateInput>(key: Key, value: DesktopLocalJobCreateInput[Key]) => setForm((current) => ({ ...current, qualityPreset: "custom", [key]: value }));
  /** 输出尺寸不改变质量档语义，Runtime 会按预算采样后恢复到精确输出尺寸。 */
  const chooseSize = (value: string) => { const [width, height] = value.split("x").map(Number); setForm((current) => ({ ...current, width, height })); };
  /** 切换模型时保留提示词和 LoRA，并为当前预设载入该模型的生产参数。 */
  const chooseModel = (modelId: string) => {
    const model = availableModels.find((item) => item.id === modelId) || null;
    setForm((current) => current.qualityPreset === "custom" ? { ...current, modelId } : applyPreset({ ...current, modelId }, current.qualityPreset, model));
  };
  /** LoRA 最多选择四个，新选择默认让模型与 CLIP 强度保持一致。 */
  const toggleLora = (id: string) => setForm((current) => {
    if (current.loras.some((item) => item.id === id)) return { ...current, loras: current.loras.filter((item) => item.id !== id) };
    if (current.loras.length >= 4) { onError("每个任务最多选择 4 个 LoRA"); return current; }
    return { ...current, loras: [...current.loras, { id, strength: 0.8, clipStrength: 0.8 }] };
  });
  /** 模型与文本编码器强度独立持久化，便于专业用户精确控制 LoRA 影响。 */
  const changeLoraStrength = (id: string, key: "strength" | "clipStrength", value: number) => setForm((current) => ({ ...current, loras: current.loras.map((item) => item.id === id ? { ...item, [key]: value } : item) }));
  /** 创建任务只等待本地事务完成，不等待提示词处理或 GPU 生成。 */
  const submit = async () => {
    if (!inferenceReady || !form.modelId || !form.prompt.trim() || busy) return;
    setBusy(true);
    try { onCreated(await createDesktopLocalJob({ ...form, prompt: form.prompt.trim(), negativePrompt: form.negativePrompt?.trim() || null })); }
    catch (error) { onError(error instanceof Error ? error.message : String(error || "创建本地任务失败")); }
    finally { setBusy(false); }
  };

  return <div className="desktop-page generate-layout">
    <section className="section-card generation-form">
      <header><div><span>LOCAL GENERATION</span><h2>本地生成</h2></div><small>{inferenceReady ? "参数随任务固化 · 后台串行执行" : "GPU、Runtime 或底模未就绪"}</small></header>
      <div className="generation-form-scroll">{availableModels.length === 0 ? <div className="resource-unconfigured"><Database /><div><strong>尚无可用底模</strong><span>请先前往模型仓库安装底模，或导入已有 safetensors。</span></div></div> : <>
        <section className="generation-presets" aria-label="生成质量预设">{PRESETS.map(({ id, title, summary, detail, Icon }) => <button key={id} type="button" className={form.qualityPreset === id ? "active" : ""} onClick={() => choosePreset(id)}><Icon /><span><strong>{title}</strong><small>{summary}</small></span><HelpTip text={detail} />{form.qualityPreset === id && <CheckCircle2 className="preset-selected" />}</button>)}</section>
        {form.qualityPreset === "custom" && <div className="generation-custom-notice"><SlidersHorizontal /><span><strong>自定义参数</strong><small>点击任一预设可恢复经过验证的整套参数。</small></span></div>}
        <div className="generation-grid">
          <ParameterField label="底模" help="决定基础画风、材质和推荐采样组合。切换模型会同步当前预设的模型级参数。"><select value={form.modelId} onChange={(event) => chooseModel(event.target.value)}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.family}</option>)}</select></ParameterField>
          <ParameterField label="输出尺寸" help="最终图片的精确尺寸；采样尺寸由质量预算独立计算，再使用所选算法缩放输出。"><select value={`${form.width}x${form.height}`} onChange={(event) => chooseSize(event.target.value)}>{!STANDARD_SIZES.includes(`${form.width}x${form.height}`) && <option value={`${form.width}x${form.height}`}>自定义 · {form.width} × {form.height}</option>}<option value="1024x1024">1:1 · 1024 × 1024</option><option value="1024x1536">2:3 · 1024 × 1536</option><option value="1536x1024">3:2 · 1536 × 1024</option><option value="864x1536">9:16 · 864 × 1536</option><option value="1536x864">16:9 · 1536 × 864</option></select></ParameterField>
          <ParameterField label="采样步数" help="扩散去噪迭代次数。更多步数通常增加细节，也会线性增加耗时。"><input type="number" min={1} max={80} value={form.steps} onChange={(event) => changeProfessional("steps", Number(event.target.value))} /></ParameterField>
          <ParameterField label="CFG 引导" help="提示词约束强度。过高可能产生高对比、烧色或结构僵硬；Anima 通常建议 4–5。"><input type="number" min={0.1} max={20} step={0.1} value={form.cfg} onChange={(event) => changeProfessional("cfg", Number(event.target.value))} /></ParameterField>
          <ParameterField label="采样器" help="决定每一步如何更新噪声。ER-SDE 偏稳定细腻，Euler A 偏活跃和多样。"><select value={form.samplerName} onChange={(event) => changeProfessional("samplerName", event.target.value as DesktopLocalJobCreateInput["samplerName"])}><option value="er_sde">ER-SDE</option><option value="euler">Euler</option><option value="euler_ancestral">Euler Ancestral</option></select></ParameterField>
          <ParameterField label="调度器" help="控制噪声在各采样步的分布。Simple 适合 ER-SDE，Normal 适合常规 Euler 系列。"><select value={form.schedulerName} onChange={(event) => changeProfessional("schedulerName", event.target.value as DesktopLocalJobCreateInput["schedulerName"])}><option value="simple">Simple</option><option value="normal">Normal</option></select></ParameterField>
          <ParameterField label="随机种子" help="相同模型、参数与种子便于复现构图；留空时每个任务自动生成新种子。"><input type="number" min={0} max={2147483647} placeholder="留空随机" value={form.seed ?? ""} onChange={(event) => setForm((current) => ({ ...current, seed: event.target.value ? Number(event.target.value) : null }))} /></ParameterField>
          <ParameterField label="图库权限" help="登录且开启自动上传时，任务完成后按此权限同步到网页图库。"><select value={form.privacy} onChange={(event) => setForm((current) => ({ ...current, privacy: event.target.value as DesktopLocalJobCreateInput["privacy"] }))}><option value="public">公开</option><option value="private">私有</option></select></ParameterField>
        </div>
        <details className="generation-advanced"><summary><span><SlidersHorizontal /><b>高级采样设置</b></span><ChevronDown /></summary><div className="generation-advanced-grid">
          <ParameterField label="输出宽度" help="64–2048 的 8 倍数。只改变成图尺寸，不自动改变质量预设。"><input type="number" min={64} max={2048} step={8} value={form.width} onChange={(event) => setForm((current) => ({ ...current, width: Number(event.target.value) }))} /></ParameterField>
          <ParameterField label="输出高度" help="64–2048 的 8 倍数。可与宽度组合任意画幅，极端比例会使用独立步数。"><input type="number" min={64} max={2048} step={8} value={form.height} onChange={(event) => setForm((current) => ({ ...current, height: Number(event.target.value) }))} /></ParameterField>
          <ParameterField label="采样最长边" help="限制潜空间采样的最长边。提高会增加细节和显存占用，实际尺寸还受像素预算限制。"><input type="number" min={512} max={2048} step={64} value={form.samplingMaxEdge} onChange={(event) => changeProfessional("samplingMaxEdge", Number(event.target.value))} /></ParameterField>
          <ParameterField label="采样像素预算" help="控制潜空间总像素量，是质量和速度的主要杠杆；1,350,000 与服务器质量档一致。"><input type="number" min={262144} max={4194304} step={65536} value={form.samplingPixelBudget} onChange={(event) => changeProfessional("samplingPixelBudget", Number(event.target.value))} /></ParameterField>
          <ParameterField label="极端画幅阈值" help="长边与短边比例达到该值时，改用极端画幅步数以平衡耗时。"><input type="number" min={1} max={4} step={0.1} value={form.aspectStepThreshold} onChange={(event) => changeProfessional("aspectStepThreshold", Number(event.target.value))} /></ParameterField>
          <ParameterField label="极端画幅步数" help="宽屏或竖屏达到阈值后使用的步数，不会超过普通采样步数。"><input type="number" min={1} max={80} value={form.aspectAdjustedSteps} onChange={(event) => changeProfessional("aspectAdjustedSteps", Number(event.target.value))} /></ParameterField>
          <ParameterField label="缩放算法" help="采样尺寸与输出尺寸不同时使用。Lanczos 细节保留最好，Bicubic 更柔和。"><select value={form.upscaleMethod} onChange={(event) => changeProfessional("upscaleMethod", event.target.value as DesktopLocalJobCreateInput["upscaleMethod"])}><option value="lanczos">Lanczos</option><option value="bicubic">Bicubic</option><option value="bilinear">Bilinear</option><option value="area">Area</option><option value="nearest-exact">Nearest Exact</option></select></ParameterField>
          <SwitchField label="模型质量前缀" help="自动补齐当前底模验证过的质量标签；已存在的标签不会重复。" checked={form.qualityPromptEnabled} onChange={(checked) => changeProfessional("qualityPromptEnabled", checked)} />
          <SwitchField label="默认负面词" help="仅在负面提示词留空时使用模型级默认内容，不覆盖你的手动输入。" checked={form.defaultNegativeEnabled} onChange={(checked) => changeProfessional("defaultNegativeEnabled", checked)} />
        </div></details>
        {availableLoras.length > 0 && <section className="generation-loras"><header><div><strong>叠加 LoRA</strong><span>最多 4 个，模型与 CLIP 权重独立</span></div><b>{form.loras.length}/4</b></header><div>{availableLoras.map((lora) => { const selection = form.loras.find((item) => item.id === lora.id); return <article key={lora.id} className={selection ? "selected" : ""}><button type="button" onClick={() => toggleLora(lora.id)}><i>{selection ? <CheckCircle2 /> : <Layers3 />}</i><span><strong>{lora.title}</strong><small>{loraTypeLabel(lora.type)} · {lora.triggerWords.join(", ") || "无触发词"}</small></span></button>{selection && <div className="generation-lora-strengths"><ParameterField label="模型强度" help="控制 LoRA 对画面结构和风格的影响。"><input type="number" min={-2} max={2} step={0.05} value={selection.strength} onChange={(event) => changeLoraStrength(lora.id, "strength", Number(event.target.value))} /></ParameterField><ParameterField label="CLIP 强度" help="控制触发词与文本条件的影响。"><input type="number" min={-2} max={2} step={0.05} value={selection.clipStrength} onChange={(event) => changeLoraStrength(lora.id, "clipStrength", Number(event.target.value))} /></ParameterField></div>}</article>; })}</div></section>}
        <label className="prompt-field"><span>提示词<HelpTip text="描述主体、画风、构图、光影和细节；开启质量前缀时只补齐缺失的模型标签。" /></span><textarea value={form.prompt} onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))} placeholder="支持 Anima 标签或自然语言" /></label>
        <label className="prompt-field negative"><span>负面提示词<HelpTip text="通过独立 negative conditioning 进入工作流，不会与正面提示词合并。" /></span><textarea value={form.negativePrompt || ""} onChange={(event) => setForm((current) => ({ ...current, negativePrompt: event.target.value || null }))} placeholder="可选；留空时可使用模型级默认负面词" /></label>
      </>}</div>
      {availableModels.length > 0 && <footer><div><strong>{presetLabel(form.qualityPreset)}</strong><span>{form.steps} 步 · CFG {form.cfg} · {form.samplerName} / {form.schedulerName}</span></div><button disabled={busy || !inferenceReady || !form.modelId || !form.prompt.trim()} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <Play />}{busy ? "正在创建任务" : inferenceReady ? "提交本地任务" : "等待环境就绪"}</button></footer>}
    </section>
    <GenerationPreview job={latestJob} />
  </div>;
}

/** 参数字段保持稳定标题列，并把长说明收纳到可访问悬浮提示中。 */
function ParameterField({ label, help, children }: { label: string; help: string; children: ReactNode }) { return <label className="generation-parameter"><span>{label}<HelpTip text={help} /></span>{children}</label>; }

/** 帮助图标既支持鼠标悬浮，也可通过键盘聚焦查看说明。 */
function HelpTip({ text }: { text: string }) { return <span className="parameter-help" tabIndex={0} aria-label={text} data-tooltip={text}><CircleHelp /></span>; }

/** 高级布尔参数使用可点击整行的稳定开关。 */
function SwitchField({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="generation-switch"><span><strong>{label}</strong><HelpTip text={help} /></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>; }

/** 右侧预览只读取 SQLite 持久任务状态，刷新页面后仍能恢复最后任务。 */
function GenerationPreview({ job }: { job: DesktopLocalJobView | null }) {
  return <aside className="section-card generation-preview"><header><div><span>LAST TASK</span><h2>最近任务</h2></div>{job && <b className={`is-${job.status}`}>{jobStatusLabel(job.status)}</b>}</header><div className="generation-preview-stage">{job?.artifact ? <img src={convertFileSrc(job.artifact.path)} alt={job.prompt.slice(0, 80)} /> : <div className="generation-preview-empty"><Image /><strong>{job ? jobStatusLabel(job.status) : "尚未提交任务"}</strong><span>{job ? job.error || `本地任务进度 ${job.progress}%` : "提交任务后，此处会持续展示状态与最终图片。"}</span></div>}{job && !job.artifact && <i><em style={{ width: `${job.progress}%` }} /></i>}</div>{job && <footer><div><span>模型</span><strong>{job.modelDisplayName}</strong></div><div><span>输出</span><strong>{job.parameters.width} × {job.parameters.height}</strong></div><div><span>LoRA</span><strong>{job.loras.length} 个</strong></div><div><span>Seed</span><strong>{job.parameters.seed}</strong></div></footer>}</aside>;
}

/** 创建默认质量档表单，首个任务无需专业调参即可获得服务器级参数。 */
function createInitialForm(privacy: DesktopSettings["defaultPrivacy"]): DesktopLocalJobCreateInput {
  return { modelId: "", prompt: "", negativePrompt: null, width: 1024, height: 1024, qualityPreset: "quality", steps: 37, cfg: 4, samplerName: "er_sde", schedulerName: "simple", samplingMaxEdge: 1536, samplingPixelBudget: 1_350_000, aspectStepThreshold: 1.5, aspectAdjustedSteps: 34, upscaleMethod: "lanczos", qualityPromptEnabled: true, defaultNegativeEnabled: true, seed: null, loras: [], privacy };
}

/** 把预设转换成可见参数；模型级 CFG 与采样器和生产目录保持一致。 */
function applyPreset(form: DesktopLocalJobCreateInput, preset: PresetName, model: DesktopLocalModelView | null): DesktopLocalJobCreateInput {
  const profile = modelProfile(model);
  const values = preset === "fast" ? { steps: 20, aspectAdjustedSteps: 18, samplingMaxEdge: 1280, samplingPixelBudget: 786_432 } : preset === "extreme" ? { steps: 45, aspectAdjustedSteps: 42, samplingMaxEdge: 1792, samplingPixelBudget: 2_073_600 } : { steps: 37, aspectAdjustedSteps: 34, samplingMaxEdge: 1536, samplingPixelBudget: 1_350_000 };
  return { ...form, qualityPreset: preset, ...values, cfg: profile.cfg, samplerName: profile.samplerName, schedulerName: profile.schedulerName, aspectStepThreshold: 1.5, upscaleMethod: "lanczos", qualityPromptEnabled: true, defaultNegativeEnabled: true };
}

/** 识别正式底模文件名并返回与生产 GPU 一致的模型级采样组合。 */
function modelProfile(model: DesktopLocalModelView | null): Pick<DesktopLocalJobCreateInput, "cfg" | "samplerName" | "schedulerName"> {
  const fileName = model?.modelFileName.toLowerCase() || "";
  if (model?.workflowKind !== "anima") return { cfg: 5, samplerName: "euler", schedulerName: "normal" };
  if (fileName.includes("realskin") || fileName.includes("3dharem")) return { cfg: 4, samplerName: "euler_ancestral", schedulerName: "normal" };
  if (fileName.includes("waianima")) return { cfg: 4.5, samplerName: "euler_ancestral", schedulerName: "normal" };
  return { cfg: 4, samplerName: "er_sde", schedulerName: "simple" };
}

/** 质量档外显名称用于提交区确认当前行为。 */
function presetLabel(preset: DesktopLocalJobCreateInput["qualityPreset"]): string { return { fast: "快速预设", quality: "质量预设", extreme: "极致预设", custom: "自定义参数" }[preset]; }
/** LoRA 类型使用统一中文外显。 */
function loraTypeLabel(type: string): string { return { style: "画风", character: "角色", concept: "概念", clothing: "服装", pose: "姿势", other: "其他" }[type] || type; }
/** 本地任务状态使用稳定中文外显。 */
function jobStatusLabel(status: DesktopLocalJobView["status"]): string { return { queued: "排队中", running: "生成中", succeeded: "生成完成", failed: "生成失败", cancelled: "已取消" }[status]; }
