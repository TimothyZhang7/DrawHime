/**
 * 本文件实现本地生成的固定参数栏、质量预设、专业参数和持久任务预览。
 */
import type { DesktopEnvironmentReport, DesktopLocalJobCreateInput, DesktopLocalJobView, DesktopLocalLoraView, DesktopLocalModelView, DesktopSettings, DesktopWebsiteLoraInstallProgress, DesktopWebsiteLoraView } from "@drawhime/contracts";
import { CheckCircle2, ChevronDown, CircleHelp, Database, Gauge, Layers3, LoaderCircle, PictureInPicture2, Play, SlidersHorizontal, Sparkles, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createDesktopLocalJob } from "./desktop-api";
import { GenerationLoraDialog } from "./GenerationLoraDialog";

type PresetName = Exclude<DesktopLocalJobCreateInput["qualityPreset"], "custom">;

interface GenerationPageProps {
  models: DesktopLocalModelView[];
  loras: DesktopLocalLoraView[];
  websiteLoras: DesktopWebsiteLoraView[];
  websiteLoraProgress: Record<string, DesktopWebsiteLoraInstallProgress>;
  executionBackend: DesktopEnvironmentReport["executionBackend"];
  inferenceReady: boolean;
  coreRunning: boolean;
  defaultPrivacy: DesktopSettings["defaultPrivacy"];
  onCreated: (job: DesktopLocalJobView) => void;
  onInstallWebsiteLora: (id: string) => void;
  onOpenLoraLibrary: () => void;
  onTogglePreview: () => void;
  onError: (message: string) => void;
}

const PRESETS: Array<{ id: PresetName; title: string; detail: string; Icon: typeof Zap }> = [
  { id: "fast", title: "快速", detail: "适合构图测试、提示词迭代与 LoRA 强度试验。", Icon: Zap },
  { id: "quality", title: "质量", detail: "默认档，与当前 GPU 服务器平衡质量参数一致。", Icon: Sparkles },
  { id: "extreme", title: "极致", detail: "优先细节和材质，显存占用与生成时间最高。", Icon: Gauge },
];
const OUTPUT_SIZES = [512, 768, 1024, 1280, 1536] as const;
const ASPECT_RATIOS = [
  { id: "1:1", label: "1:1 · 正方形", width: 1, height: 1 },
  { id: "2:3", label: "2:3 · 竖幅", width: 2, height: 3 },
  { id: "3:2", label: "3:2 · 横幅", width: 3, height: 2 },
  { id: "3:4", label: "3:4 · 竖幅", width: 3, height: 4 },
  { id: "4:3", label: "4:3 · 横幅", width: 4, height: 3 },
  { id: "9:16", label: "9:16 · 手机竖屏", width: 9, height: 16 },
  { id: "16:9", label: "16:9 · 宽屏", width: 16, height: 9 },
] as const;
type AspectRatioId = typeof ASPECT_RATIOS[number]["id"];

/** 本地生成页在页面切换时保持表单实例，任务提交后立即交给 SQLite 队列。 */
export function GenerationPage({ models, loras, websiteLoras, websiteLoraProgress, executionBackend, inferenceReady, coreRunning, defaultPrivacy, onCreated, onInstallWebsiteLora, onOpenLoraLibrary, onTogglePreview, onError }: GenerationPageProps) {
  const directMl = executionBackend.id === "amd_directml";
  const backendMaxEdge = executionBackend.limits.maxValidatedEdge;
  const availableModels = useMemo(() => models.filter((model) => model.available && (!directMl || model.workflowKind === "anima")), [directMl, models]);
  const availableLoras = useMemo(() => loras.filter((lora) => lora.available), [loras]);
  const [form, setForm] = useState<DesktopLocalJobCreateInput>(() => createInitialForm(defaultPrivacy, backendMaxEdge));
  const [busy, setBusy] = useState(false);
  const [loraDialogOpen, setLoraDialogOpen] = useState(false);
  const selectedModel = availableModels.find((model) => model.id === form.modelId) || null;
  const compatibleLoras = useMemo(() => availableLoras.filter((lora) => !lora.baseModelSha256 || lora.baseModelSha256 === selectedModel?.modelSha256), [availableLoras, selectedModel?.modelSha256]);
  const samplerOptions = useMemo(() => modelOptions(selectedModel?.generationProfile?.availableSamplers, form.samplerName), [form.samplerName, selectedModel?.generationProfile?.availableSamplers]);
  const schedulerOptions = useMemo(() => modelOptions(selectedModel?.generationProfile?.availableSchedulers, form.schedulerName), [form.schedulerName, selectedModel?.generationProfile?.availableSchedulers]);
  const outputSize = Math.max(form.width, form.height);
  const aspectRatio = aspectRatioFromDimensions(form.width, form.height);
  const outputSizes = OUTPUT_SIZES.filter((size) => size <= backendMaxEdge);

  useEffect(() => {
    if (availableModels.some((model) => model.id === form.modelId)) return;
    const model = availableModels[0];
    setForm((current) => model ? constrainFormToBackend(applyPreset({ ...current, modelId: model.id }, "quality", model), executionBackend) : { ...current, modelId: "" });
  }, [availableModels, executionBackend, form.modelId]);
  useEffect(() => { setForm((current) => ({ ...current, loras: current.loras.filter((selection) => compatibleLoras.some((lora) => lora.id === selection.id)) })); }, [compatibleLoras]);
  useEffect(() => { setForm((current) => ({ ...current, privacy: defaultPrivacy })); }, [defaultPrivacy]);
  useEffect(() => { setForm((current) => constrainFormToBackend(current, executionBackend)); }, [executionBackend]);

  /** 预设同时刷新模型级采样器、CFG 和质量预算，后端仍会再次权威解析。 */
  const choosePreset = (preset: PresetName) => setForm((current) => constrainFormToBackend(applyPreset(current, preset, selectedModel), executionBackend));
  /** 手动修改专业参数后标记为自定义，保证用户值不会被后端预设覆盖。 */
  const changeProfessional = <Key extends keyof DesktopLocalJobCreateInput>(key: Key, value: DesktopLocalJobCreateInput[Key]) => setForm((current) => constrainFormToBackend({ ...current, qualityPreset: "custom", [key]: value }, executionBackend));
  /** 输出边长和比例独立选择，并按当前后端已验证上限收敛。 */
  const chooseOutput = (size: number, ratio: AspectRatioId) => setForm((current) => ({ ...current, ...dimensionsFor(size, ratio, backendMaxEdge) }));
  /** 切换模型时保留提示词和 LoRA，并为当前预设载入该模型的生产参数。 */
  const chooseModel = (modelId: string) => {
    const model = availableModels.find((item) => item.id === modelId) || null;
    setForm((current) => constrainFormToBackend(current.qualityPreset === "custom" ? { ...current, modelId } : applyPreset({ ...current, modelId }, current.qualityPreset, model), executionBackend));
  };
  /** 打开选择器时才读取主站 LoRA 目录，普通启动和页面切换不下载仓库媒体。 */
  const openLoraDialog = () => { onOpenLoraLibrary(); setLoraDialogOpen(true); };
  /** LoRA 数量由用户和本机资源决定，新选择默认让模型与 CLIP 强度保持一致。 */
  const toggleLora = (id: string) => setForm((current) => {
    if (current.loras.some((item) => item.id === id)) return { ...current, loras: current.loras.filter((item) => item.id !== id) };
    if (current.loras.length >= executionBackend.limits.maxValidatedLoras) return current;
    return { ...current, loras: [...current.loras, { id, strength: 0.8, clipStrength: 0.8 }] };
  });
  /** 模型与文本编码器强度独立持久化，便于专业用户精确控制 LoRA 影响。 */
  const changeLoraStrength = (id: string, key: "strength" | "clipStrength", value: number) => setForm((current) => ({ ...current, loras: current.loras.map((item) => item.id === id ? { ...item, [key]: value } : item) }));
  /** 创建任务只等待本地事务完成，不等待提示词处理或 GPU 生成。 */
  const submit = async () => {
    if (!inferenceReady || !coreRunning || !form.modelId || !form.prompt.trim() || busy) return;
    setBusy(true);
    try { onCreated(await createDesktopLocalJob({ ...form, prompt: form.prompt.trim(), negativePrompt: form.negativePrompt?.trim() || null })); }
    catch (error) { onError(error instanceof Error ? error.message : String(error || "创建本地任务失败")); }
    finally { setBusy(false); }
  };
  // 禁用原因按用户下一步可执行动作排序，按钮悬浮时直接说明如何恢复。
  const submitDisabledReason = busy ? "任务正在创建，请勿重复提交" : !coreRunning ? "请先在启动页启动本地核心" : !inferenceReady ? "GPU、Runtime 或必需底模尚未就绪" : !form.modelId ? "请先选择可用底模" : !form.prompt.trim() ? "请输入提示词" : null;

  return <div className="desktop-page generate-layout">
    <section className="generation-form generation-form-flat">
      <header><div><span>LOCAL GENERATION</span><h2>本地生成</h2></div><div className="generation-heading-actions"><small>{!inferenceReady ? "GPU、Runtime 或底模未就绪" : !coreRunning ? "请先在启动页面启动本地核心" : `${executionBackend.label} · 参数随任务固化`}</small><button type="button" onClick={onTogglePreview}><PictureInPicture2 />预览窗口</button></div></header>
      <div className="generation-form-scroll">{availableModels.length === 0 ? <div className="resource-unconfigured"><Database /><div><strong>尚无可用底模</strong><span>请先前往模型仓库安装底模，或导入已有 safetensors。</span></div></div> : <>
        <section className="generation-presets" aria-label="生成质量预设">{PRESETS.map(({ id, title, detail, Icon }) => <button key={id} type="button" className={form.qualityPreset === id ? "active" : ""} onClick={() => choosePreset(id)}><Icon /><span><strong>{title}</strong><small>{presetSummary(id, selectedModel)}</small></span><HelpTip text={detail} />{form.qualityPreset === id && <CheckCircle2 className="preset-selected" />}</button>)}</section>
        {form.qualityPreset === "custom" && <div className="generation-custom-notice"><SlidersHorizontal /><span><strong>自定义参数</strong><small>点击任一预设可恢复经过验证的整套参数。</small></span></div>}
        {/* 宽屏将提示词与参数并排，窄窗口仍按操作顺序回落为单列。 */}
        <div className="generation-workspace">
          <div className="generation-prompt-column">
            <label className="prompt-field"><span>提示词<HelpTip text="描述主体、画风、构图、光影和细节；开启质量前缀时只补齐缺失的模型标签。" /></span><textarea value={form.prompt} onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))} placeholder="支持 Anima 标签或自然语言" /></label>
            <label className="prompt-field negative"><span>负面提示词<HelpTip text="通过独立 negative conditioning 进入工作流，不会与正面提示词合并。" /></span><textarea value={form.negativePrompt || ""} onChange={(event) => setForm((current) => ({ ...current, negativePrompt: event.target.value || null }))} placeholder="可选；留空时可使用模型级默认负面词" /></label>
          </div>
          <div className="generation-controls-column">
            <div className="generation-grid">
              <ParameterField label="底模" help="决定基础画风、材质和推荐采样组合。切换模型会同步当前预设的模型级参数。"><select value={form.modelId} onChange={(event) => chooseModel(event.target.value)}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.displayName} · {model.family}</option>)}</select></ParameterField>
              <ParameterField label="输出尺寸" help={`当前 ${executionBackend.label} 已验证的最长边为 ${backendMaxEdge}px，实际宽高由画幅比例自动计算。`}><select value={outputSize} onChange={(event) => chooseOutput(Number(event.target.value), aspectRatio)}>{outputSizes.map((size) => <option key={size} value={size}>{size === backendMaxEdge ? `${size}px（当前后端上限）` : `${size}px`}</option>)}</select></ParameterField>
              <ParameterField label="画幅比例" help="独立选择横竖构图；默认 1:1，最终宽高会按所选尺寸和比例自动对齐到 8 像素。"><select value={aspectRatio} onChange={(event) => chooseOutput(outputSize, event.target.value as AspectRatioId)}>{ASPECT_RATIOS.map((ratio) => <option key={ratio.id} value={ratio.id}>{ratio.label}</option>)}</select></ParameterField>
              <ParameterField label="采样步数" help="扩散去噪迭代次数。更多步数通常增加细节，也会线性增加耗时。"><input type="number" min={1} max={80} value={form.steps} onChange={(event) => changeProfessional("steps", Number(event.target.value))} /></ParameterField>
              <ParameterField label="CFG 引导" help="提示词约束强度。过高可能产生高对比、烧色或结构僵硬；Anima 通常建议 4–5。"><input type="number" min={0.1} max={20} step={0.1} value={form.cfg} onChange={(event) => changeProfessional("cfg", Number(event.target.value))} /></ParameterField>
              <ParameterField label="采样器" help="决定每一步如何更新噪声；可选项由当前底模在线目录下发。"><select value={form.samplerName} onChange={(event) => changeProfessional("samplerName", event.target.value as DesktopLocalJobCreateInput["samplerName"])}>{samplerOptions.map((value) => <option key={value} value={value}>{samplingOptionLabel(value)}</option>)}</select></ParameterField>
              <ParameterField label="调度器" help="控制噪声在各采样步的分布；可选项由当前底模在线目录下发。"><select value={form.schedulerName} onChange={(event) => changeProfessional("schedulerName", event.target.value as DesktopLocalJobCreateInput["schedulerName"])}>{schedulerOptions.map((value) => <option key={value} value={value}>{samplingOptionLabel(value)}</option>)}</select></ParameterField>
              <ParameterField label="随机种子" help="相同模型、参数与种子便于复现构图；留空时每个任务自动生成新种子。"><input type="number" min={0} max={2147483647} placeholder="留空随机" value={form.seed ?? ""} onChange={(event) => setForm((current) => ({ ...current, seed: event.target.value ? Number(event.target.value) : null }))} /></ParameterField>
              <ParameterField label="图库权限" help="登录且开启自动上传时，任务完成后按此权限同步到网页图库。"><select value={form.privacy} onChange={(event) => setForm((current) => ({ ...current, privacy: event.target.value as DesktopLocalJobCreateInput["privacy"] }))}><option value="public">公开</option><option value="private">私有</option></select></ParameterField>
            </div>
            <details className="generation-advanced"><summary><span><SlidersHorizontal /><b>高级采样设置</b></span><ChevronDown /></summary><div className="generation-advanced-grid">
              <ParameterField label="采样最长边" help="限制潜空间采样的最长边。提高会增加细节和显存占用，实际尺寸还受像素预算限制。"><input type="number" min={512} max={backendMaxEdge} step={64} value={form.samplingMaxEdge} onChange={(event) => changeProfessional("samplingMaxEdge", Number(event.target.value))} /></ParameterField>
              <ParameterField label="采样像素预算" help="控制潜空间总像素量，是质量和速度的主要杠杆；1,350,000 与服务器质量档一致。"><input type="number" min={262144} max={4194304} step={65536} value={form.samplingPixelBudget} onChange={(event) => changeProfessional("samplingPixelBudget", Number(event.target.value))} /></ParameterField>
              <ParameterField label="极端画幅阈值" help="长边与短边比例达到该值时，改用极端画幅步数以平衡耗时。"><input type="number" min={1} max={4} step={0.1} value={form.aspectStepThreshold} onChange={(event) => changeProfessional("aspectStepThreshold", Number(event.target.value))} /></ParameterField>
              <ParameterField label="极端画幅步数" help="宽屏或竖屏达到阈值后使用的步数，不会超过普通采样步数。"><input type="number" min={1} max={80} value={form.aspectAdjustedSteps} onChange={(event) => changeProfessional("aspectAdjustedSteps", Number(event.target.value))} /></ParameterField>
              <ParameterField label="缩放算法" help="采样尺寸与输出尺寸不同时使用。Lanczos 细节保留最好，Bicubic 更柔和。"><select value={form.upscaleMethod} onChange={(event) => changeProfessional("upscaleMethod", event.target.value as DesktopLocalJobCreateInput["upscaleMethod"])}><option value="lanczos">Lanczos</option><option value="bicubic">Bicubic</option><option value="bilinear">Bilinear</option><option value="area">Area</option><option value="nearest-exact">Nearest Exact</option></select></ParameterField>
              <SwitchField label="模型质量前缀" help="自动补齐当前底模验证过的质量标签；已存在的标签不会重复。" checked={form.qualityPromptEnabled} onChange={(checked) => changeProfessional("qualityPromptEnabled", checked)} />
              <SwitchField label="默认负面词" help="仅在负面提示词留空时使用模型级默认内容，不覆盖你的手动输入。" checked={form.defaultNegativeEnabled} onChange={(checked) => changeProfessional("defaultNegativeEnabled", checked)} />
            </div></details>
            <section className="generation-lora-summary"><header><div><strong>使用的 LoRA</strong><span>{directMl ? "AMD DirectML 当前验证最多 1 个 LoRA" : "外部 LoRA 按仓库兼容范围使用"}</span></div><button type="button" onClick={openLoraDialog}><Layers3 />选择 LoRA</button></header>{form.loras.length ? <div>{form.loras.map((selection) => { const lora = compatibleLoras.find((item) => item.id === selection.id); return <button key={selection.id} type="button" onClick={openLoraDialog}><strong>{lora?.title || "LoRA"}</strong><span>模型 {selection.strength.toFixed(2)} · CLIP {selection.clipStrength.toFixed(2)}</span></button>; })}</div> : <p>当前未选择 LoRA</p>}</section>
          </div>
        </div>
      </>}</div>
      {availableModels.length > 0 && <footer><div><strong>{presetLabel(form.qualityPreset)}</strong><span>{form.steps} 步 · CFG {form.cfg} · {form.samplerName} / {form.schedulerName}</span></div><button disabled={Boolean(submitDisabledReason)} title={submitDisabledReason || "创建持久化任务并进入本地队列"} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" /> : <Play />}{busy ? "正在创建任务" : !coreRunning ? "请先启动本地核心" : !inferenceReady ? "等待环境就绪" : "提交本地任务"}</button></footer>}
    </section>
    {loraDialogOpen && <GenerationLoraDialog localLoras={compatibleLoras} websiteLoras={websiteLoras} selected={form.loras} selectionLimit={executionBackend.limits.maxValidatedLoras} progress={websiteLoraProgress} onToggle={toggleLora} onStrength={changeLoraStrength} onInstall={onInstallWebsiteLora} onClose={() => setLoraDialogOpen(false)} />}
  </div>;
}

/** 参数字段保持稳定标题列，并把长说明收纳到可访问悬浮提示中。 */
function ParameterField({ label, help, children }: { label: string; help: string; children: ReactNode }) { return <label className="generation-parameter"><span>{label}<HelpTip text={help} /></span>{children}</label>; }

/** 在线目录是可选采样参数的唯一事实源；无目录的手工模型只保留当前安全值。 */
function modelOptions(values: string[] | undefined, current: string): string[] {
  return [...new Set([...(values || []).filter(Boolean), current].filter(Boolean))];
}

/** 将目录机器值转换为稳定外显，不反向推断模型能力。 */
function samplingOptionLabel(value: string): string {
  return ({ er_sde: "ER-SDE", euler: "Euler", euler_ancestral: "Euler Ancestral", simple: "Simple", normal: "Normal", beta: "Beta" } as Record<string, string>)[value] || value;
}

/** 帮助内容通过根级浮层渲染，避免被滚动容器、图片或相邻帮助图标裁切遮挡。 */
function HelpTip({ text }: { text: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const show = () => {
    const bounds = anchor.current?.getBoundingClientRect();
    if (!bounds) return;
    const above = window.innerHeight - bounds.bottom < 110 && bounds.top > 110;
    setPosition({ left: Math.min(Math.max(bounds.left + bounds.width / 2, 145), window.innerWidth - 145), top: above ? bounds.top - 8 : bounds.bottom + 8, above });
  };
  useEffect(() => {
    if (!position) return undefined;
    const hide = () => setPosition(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => { window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); };
  }, [position]);
  return <><span ref={anchor} className="parameter-help" tabIndex={0} aria-label={text} onMouseEnter={show} onMouseLeave={() => setPosition(null)} onFocus={show} onBlur={() => setPosition(null)}><CircleHelp /></span>{position && createPortal(<span className={`parameter-tooltip ${position.above ? "is-above" : ""}`} role="tooltip" style={{ left: position.left, top: position.top }}>{text}</span>, document.body)}</>;
}

/** 高级布尔参数使用可点击整行的稳定开关。 */
function SwitchField({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="generation-switch"><span><strong>{label}</strong><HelpTip text={help} /></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>; }

/** 创建默认质量档表单，首个任务无需专业调参即可获得服务器级参数。 */
function createInitialForm(privacy: DesktopSettings["defaultPrivacy"], maxEdge: number): DesktopLocalJobCreateInput {
  const edge = Math.min(1024, maxEdge);
  return { modelId: "", prompt: "", negativePrompt: null, width: edge, height: edge, qualityPreset: "quality", steps: 37, cfg: 4, samplerName: "er_sde", schedulerName: "simple", samplingMaxEdge: Math.min(1536, maxEdge), samplingPixelBudget: Math.min(1_350_000, maxEdge ** 2), aspectStepThreshold: 1.5, aspectAdjustedSteps: 34, upscaleMethod: "lanczos", qualityPromptEnabled: true, defaultNegativeEnabled: true, seed: null, loras: [], privacy };
}

/** 按最长边和比例生成 8 像素对齐的真实输出尺寸。 */
function dimensionsFor(size: number, ratioId: AspectRatioId, maxEdge = 1536): Pick<DesktopLocalJobCreateInput, "width" | "height"> {
  const ratio = ASPECT_RATIOS.find((item) => item.id === ratioId) || ASPECT_RATIOS[0];
  const longest = Math.min(maxEdge, Math.max(512, size));
  const align = (value: number) => Math.max(64, Math.round(value / 8) * 8);
  return ratio.width >= ratio.height ? { width: longest, height: align(longest * ratio.height / ratio.width) } : { width: align(longest * ratio.width / ratio.height), height: longest };
}

/** 页面状态随自动后端能力收敛，后端仍在任务创建时执行同一安全门禁。 */
function constrainFormToBackend(form: DesktopLocalJobCreateInput, backend: DesktopEnvironmentReport["executionBackend"]): DesktopLocalJobCreateInput {
  const maxEdge = backend.limits.maxValidatedEdge;
  const ratio = aspectRatioFromDimensions(form.width, form.height);
  const constrainedDimensions = Math.max(form.width, form.height) > maxEdge ? dimensionsFor(maxEdge, ratio, maxEdge) : { width: form.width, height: form.height };
  return { ...form, ...constrainedDimensions, samplingMaxEdge: Math.min(form.samplingMaxEdge, maxEdge), samplingPixelBudget: Math.min(form.samplingPixelBudget, maxEdge ** 2), loras: form.loras.slice(0, backend.limits.maxValidatedLoras) };
}

/** 从当前宽高恢复最接近的受支持比例，保证页面切换后选择状态不丢失。 */
function aspectRatioFromDimensions(width: number, height: number): AspectRatioId {
  const value = width / height;
  return ASPECT_RATIOS.reduce((best, candidate) => Math.abs(candidate.width / candidate.height - value) < Math.abs(best.width / best.height - value) ? candidate : best, ASPECT_RATIOS[0]).id;
}

/** 把预设转换成可见参数；模型级 CFG 与采样器和生产目录保持一致。 */
function applyPreset(form: DesktopLocalJobCreateInput, preset: PresetName, model: DesktopLocalModelView | null): DesktopLocalJobCreateInput {
  const profile = modelProfile(model);
  const values = profile.presets[preset];
  return { ...form, qualityPreset: preset, ...values, cfg: profile.cfg, samplerName: profile.samplerName, schedulerName: profile.schedulerName, aspectStepThreshold: profile.aspectStepThreshold, upscaleMethod: "lanczos", qualityPromptEnabled: true, defaultNegativeEnabled: true };
}

/** 在线目录是模型参数唯一事实源；手工导入模型没有目录时才使用保守回退。 */
function modelProfile(model: DesktopLocalModelView | null): { cfg: number; samplerName: DesktopLocalJobCreateInput["samplerName"]; schedulerName: DesktopLocalJobCreateInput["schedulerName"]; aspectStepThreshold: number; presets: Record<PresetName, Pick<DesktopLocalJobCreateInput, "steps" | "aspectAdjustedSteps" | "samplingMaxEdge" | "samplingPixelBudget">> } {
  const profile = model?.generationProfile;
  if (profile) {
    // 在线目录通过共享契约限制可选值，这里再次收窄后再写入本地任务参数。
    const samplerName = ["er_sde", "euler", "euler_ancestral"].includes(profile.sampler) ? profile.sampler as DesktopLocalJobCreateInput["samplerName"] : "er_sde";
    const schedulerName = ["simple", "normal", "beta"].includes(profile.scheduler) ? profile.scheduler as DesktopLocalJobCreateInput["schedulerName"] : "simple";
    return {
      cfg: profile.cfg,
      samplerName,
      schedulerName,
      aspectStepThreshold: profile.aspectStepThreshold,
      presets: { fast: profile.presets.fast, quality: profile.presets.quality, extreme: profile.presets.extreme },
    };
  }
  const checkpoint = model?.workflowKind === "checkpoint";
  return {
    cfg: checkpoint ? 5 : 4,
    samplerName: checkpoint ? "euler" : "er_sde",
    schedulerName: checkpoint ? "normal" : "simple",
    aspectStepThreshold: 1.5,
    presets: {
      fast: { steps: 20, aspectAdjustedSteps: 18, samplingMaxEdge: 1280, samplingPixelBudget: 786_432 },
      quality: { steps: 37, aspectAdjustedSteps: 34, samplingMaxEdge: 1536, samplingPixelBudget: 1_350_000 },
      extreme: { steps: 45, aspectAdjustedSteps: 42, samplingMaxEdge: 1792, samplingPixelBudget: 2_073_600 },
    },
  };
}

/** 质量卡片随当前底模展示真实步数和像素预算。 */
function presetSummary(preset: PresetName, model: DesktopLocalModelView | null): string {
  const values = applyPreset(createInitialForm("public", 1536), preset, model);
  return `${values.steps} 步 · 约 ${(values.samplingPixelBudget / 1_000_000).toFixed(2)} MP`;
}

/** 质量档外显名称用于提交区确认当前行为。 */
function presetLabel(preset: DesktopLocalJobCreateInput["qualityPreset"]): string { return { fast: "快速预设", quality: "质量预设", extreme: "极致预设", custom: "自定义参数" }[preset]; }
