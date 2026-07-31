/**
 * 本文件实现独立本地模型用户端，包含主站会话交换、真实生成表单、刷新可恢复任务和产物预览。
 */
import type { InferenceJobView, InferenceLoraView, InferenceModelView, InferenceSamplingOverrides, LocalPlatformSessionView, LoraLibraryEntryView, ModelGenerationProfile, ModelLibraryEntryView } from "@drawhime/contracts";
import { Activity, Bot, BrainCircuit, Clock3, Cpu, Eye, Folder, ImageIcon, Images, Layers3, Layout, LoaderCircle, LogIn, LogOut, MoreHorizontal, Paintbrush, ScanSearch, Sparkles, Trash2, Trophy, User, Wallet, WalletCards, Wrench, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { TrainingPage } from "./TrainingPage";
import { LoraLibraryPage } from "./LoraLibraryPage";
import { ModelLibraryPage } from "./ModelLibraryPage";
import { DesktopAuthorizationPage } from "./DesktopAuthorizationPage";
import { formatQueueCompletion, formatQueueSummary } from "./queue-display";

const apiBase = import.meta.env.VITE_LOCAL_API_BASE || "/local-model-api";
// 任务固化的 LoRA 没有用户封面或封面已失效时，统一回退到仓库默认封面。
const defaultLoraCoverUrl = `${import.meta.env.BASE_URL}lora-default-cover.svg`;
const sessionStorageKey = "drawhime_local_session";
const generationSettingsKey = "drawhime_local_generation_settings";
const maximumSelectedLoras = 4;

/** 质量档只决定目录预设，不暗含任何底模名称或文件名判断。 */
type GenerationPresetName = "fast" | "quality" | "extreme";

/** 每个模型独立持久化当前质量档与高级覆盖值，切换模型不会串用不兼容参数。 */
interface PersistedSamplingSelection {
  preset: GenerationPresetName;
  customized: boolean;
  overrides: InferenceSamplingOverrides;
}

/** 生成页按 LoRA 资产类型分组，避免角色、画风和服装类资产混在同一选择列表。 */
const loraTypeLabels: Record<InferenceLoraView["type"], string> = {
  character: "角色",
  style: "画风",
  concept: "概念",
  clothing: "服装",
  pose: "姿势",
  other: "其他",
};

/** 不同资产类型的默认叠加强度，与服务端新任务默认值保持一致。 */
const loraTypeDefaultStrengths: Record<InferenceLoraView["type"], number> = {
  character: 1,
  style: 0.85,
  concept: 0.8,
  clothing: 0.85,
  pose: 0.7,
  other: 0.8,
};

/** 主站钱包只读摘要，余额权威数据始终保留在主站。 */
interface MainWalletSummary { freeBalance: string; paidBalance: string; totalBalance: string }

/** LoRA 仓库请求生成页选中版本时使用递增序号，重复选择同一版本也会触发表单同步。 */
interface LoraUseRequest { loraVersionId: string; sequence: number }

/** 模型仓库请求生成页选中底模时使用递增序号，确保重复选择也会同步表单。 */
interface ModelUseRequest { modelVersionId: string; sequence: number }

/** 本地平台页面内可切换的业务工作区。 */
type LocalTab = "create" | "jobs" | "models" | "loras" | "training";

/** 主站全站导航项，独立平台只负责跳转，不复制主站路由状态。 */
interface MainNavigationItem { href: string; label: string; Icon: LucideIcon }

const mainNavigation: MainNavigationItem[] = [
  { href: "/", label: "绘图", Icon: Paintbrush },
  // 与主站保持相同的顶栏顺序，本地模型紧随绘图入口。
  { href: "/local-model/", label: "本地模型", Icon: Cpu },
  { href: "/reverse", label: "反推", Icon: ScanSearch },
  { href: "/gallery", label: "图库", Icon: Images },
  { href: "/personal", label: "我的", Icon: Folder },
  { href: "/leaderboard", label: "排行", Icon: Trophy },
  { href: "/tools", label: "工具", Icon: Wrench },
];

const signedInNavigation: MainNavigationItem[] = [
  { href: "/templates", label: "模板", Icon: Layout },
  { href: "/recharge", label: "充值", Icon: Wallet },
  { href: "/bots", label: "Bot", Icon: Bot },
];

const mobilePrimaryNavigation: MainNavigationItem[] = [
  { href: "/", label: "绘图", Icon: Paintbrush },
  // 手机底栏与主站保持同一顺序，本地模型入口固定放在绘图右侧。
  { href: "/local-model/", label: "本地模型", Icon: Cpu },
  { href: "/reverse", label: "反推", Icon: ScanSearch },
  { href: "/gallery", label: "图库", Icon: Images },
  { href: "/personal/gallery", label: "我的", Icon: Folder },
];

const localTabs: Array<{ id: LocalTab; label: string; shortLabel: string; Icon: LucideIcon }> = [
  { id: "create", label: "本地绘图", shortLabel: "绘图", Icon: Sparkles },
  { id: "jobs", label: "任务记录", shortLabel: "任务", Icon: Clock3 },
  { id: "models", label: "模型仓库", shortLabel: "模型", Icon: Cpu },
  { id: "loras", label: "LoRA 仓库", shortLabel: "LoRA", Icon: Layers3 },
  { id: "training", label: "LoRA 训练", shortLabel: "训练", Icon: BrainCircuit },
];

/** 从地址栏恢复独立平台二级页面，只接受当前真实存在的功能键。 */
function readLocalTabFromLocation(): LocalTab {
  const value = new URLSearchParams(window.location.search).get("tab");
  return value === "jobs" || value === "models" || value === "loras" || value === "training" ? value : "create";
}

/** 统一渲染本地模型工作区入口，保证每个页面的结构、宽度与交互完全一致。 */
function LocalWorkspaceNavigation({ activeTab, onSelect }: { activeTab: LocalTab; onSelect: (tab: LocalTab) => void }) {
  return <nav className="local-section-nav local-workspace-nav" aria-label="本地模型功能导航">
    {localTabs.map(({ id, label, shortLabel, Icon }) => <button key={id} className={activeTab === id ? "active" : ""} onClick={() => onSelect(id)}><Icon size={15} /><span className="desktop-label">{label}</span><span className="mobile-label">{shortLabel}</span></button>)}
  </nav>;
}

/** 独立本地模型用户应用。 */
export function App() {
  const [session, setSession] = useState<LocalPlatformSessionView | null>(null);
  const [models, setModels] = useState<InferenceModelView[]>([]);
  const [loras, setLoras] = useState<InferenceLoraView[]>([]);
  const [jobs, setJobs] = useState<InferenceJobView[]>([]);
  const [libraryEntries, setLibraryEntries] = useState<LoraLibraryEntryView[]>([]);
  const [modelLibraryEntries, setModelLibraryEntries] = useState<ModelLibraryEntryView[]>([]);
  const [wallet, setWallet] = useState<MainWalletSummary | null>(null);
  const [selectedJob, setSelectedJob] = useState<InferenceJobView | null>(null);
  const [activeTab, setActiveTab] = useState<LocalTab>(readLocalTabFromLocation);
  const [mountedTabs, setMountedTabs] = useState<Set<LocalTab>>(() => new Set([readLocalTabFromLocation()]));
  const [loraUseRequest, setLoraUseRequest] = useState<LoraUseRequest | null>(null);
  const [modelUseRequest, setModelUseRequest] = useState<ModelUseRequest | null>(null);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    // 主站账号可能在当前标签页存活期间切换，重新确认身份前先清空上一会话的任务，避免短暂展示其他用户记录。
    setJobs([]);
    setSelectedJob(null);
    try {
      const localSession = await restoreLocalSession();
      setSession(localSession);
      if (!localSession) {
        setModels([]);
        setLoras([]);
        setJobs([]);
        setLibraryEntries([]);
        setModelLibraryEntries([]);
        setWallet(null);
        setError("请先在绘图姬主站登录，再打开本地模型页面");
        return;
      }
      const [modelPayload, loraPayload, jobPayload, libraryPayload, modelLibraryPayload] = await Promise.all([
        authenticatedJson<{ models: InferenceModelView[] }>("/v1/models", localSession.sessionToken),
        authenticatedJson<{ loras: InferenceLoraView[] }>("/v1/loras", localSession.sessionToken),
        authenticatedJson<{ jobs: InferenceJobView[] }>("/v1/inference/jobs?limit=50", localSession.sessionToken),
        authenticatedJson<{ entries: LoraLibraryEntryView[] }>("/v1/lora-library", localSession.sessionToken),
        authenticatedJson<{ entries: ModelLibraryEntryView[] }>("/v1/model-library", localSession.sessionToken),
      ]);
      setModels(modelPayload.models);
      setLoras(loraPayload.loras);
      setJobs(jobPayload.jobs);
      setLibraryEntries(libraryPayload.entries);
      setModelLibraryEntries(modelLibraryPayload.entries);
      setWallet(await loadMainWallet());
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "页面加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    // 浏览器前进后退必须恢复对应二级页面，主站旧入口跳转也能直接落到 LoRA 仓库。
    const restoreTab = () => {
      const tab = readLocalTabFromLocation();
      setMountedTabs((current) => new Set(current).add(tab));
      setActiveTab(tab);
    };
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, []);
  useEffect(() => {
    if (!session || !jobs.some((job) => !isFinal(job.status))) return;
    const timer = window.setInterval(() => void loadJobs(session.sessionToken).then(setJobs).catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [session, jobs]);

  const currentJob = jobs.find((job) => !isFinal(job.status)) ?? jobs[0];
  const desktopNavigation = session ? [...mainNavigation, ...signedInNavigation, { href: "/status", label: "状态", Icon: Activity }] : [...mainNavigation, { href: "/status", label: "状态", Icon: Activity }];
  const mobileMoreNavigation = session
    ? [...signedInNavigation, { href: "/leaderboard", label: "排行榜", Icon: Trophy }, { href: "/tools", label: "工具", Icon: Wrench }, { href: "/profile", label: "个人中心", Icon: User }, { href: "/status", label: "服务状态", Icon: Activity }]
    : [{ href: "/leaderboard", label: "排行榜", Icon: Trophy }, { href: "/status", label: "服务状态", Icon: Activity }];

  /** 同步仓库详情和生成页可选 LoRA，训练完成或仓库更新后无需刷新浏览器。 */
  const refreshLoraViews = useCallback(async () => {
    if (!session) return;
    const [libraryPayload, loraPayload] = await Promise.all([
      authenticatedJson<{ entries: LoraLibraryEntryView[] }>("/v1/lora-library", session.sessionToken),
      authenticatedJson<{ loras: InferenceLoraView[] }>("/v1/loras", session.sessionToken),
    ]);
    setLibraryEntries(libraryPayload.entries);
    setLoras(loraPayload.loras);
  }, [session]);

  /** 同步模型仓库和生成页可选底模，管理员编辑后无需刷新浏览器。 */
  const refreshModelViews = useCallback(async () => {
    if (!session) return;
    const [libraryPayload, modelPayload] = await Promise.all([
      authenticatedJson<{ entries: ModelLibraryEntryView[] }>("/v1/model-library", session.sessionToken),
      authenticatedJson<{ models: InferenceModelView[] }>("/v1/models", session.sessionToken),
    ]);
    setModelLibraryEntries(libraryPayload.entries);
    setModels(modelPayload.models);
  }, [session]);

  /** 切换本地工作区并收起手机端更多面板。 */
  const selectLocalTab = (tab: LocalTab) => {
    // 页面首次打开后保持挂载，仅通过 hidden 切换可见性，防止输入框、筛选和弹窗草稿丢失。
    setMountedTabs((current) => new Set(current).add(tab));
    setActiveTab(tab);
    setMobileMoreOpen(false);
    const url = new URL(window.location.href);
    // 点击顶层业务标签始终回到该标签根页面，避免旧 LoRA 详情参数污染后续导航。
    url.searchParams.delete("lora");
    url.searchParams.delete("model");
    if (tab === "create") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    // 训练任务完成后进入仓库时主动刷新，避免用户手动重载页面才看到新草稿。
    if (tab === "loras") void refreshLoraViews().catch(() => undefined);
    if (tab === "models") void refreshModelViews().catch(() => undefined);
  };
  /** 从仓库详情带入 LoRA 后回到绘图页，生成表单会从持久化设置恢复该版本。 */
  const useLora = (loraVersionId: string) => {
    const current = readGenerationSettings();
    const loraVersionIds = [...new Set([...current.loraVersionIds, loraVersionId])].slice(0, maximumSelectedLoras);
    // 从详情带入 LoRA 时同步清理已取消版本的旧权重，避免下一次提交包含未选择版本。
    localStorage.setItem(generationSettingsKey, JSON.stringify({ ...current, loraVersionIds, loraStrengths: selectLoraStrengths(current.loraStrengths, loraVersionIds) }));
    setLoraUseRequest({ loraVersionId, sequence: Date.now() });
    selectLocalTab("create");
  };
  /** 从模型仓库带入底模后回到绘图页，生成表单立即切换为当前有效工作流。 */
  const useModel = (modelVersionId: string) => {
    const current = readGenerationSettings();
    localStorage.setItem(generationSettingsKey, JSON.stringify({ ...current, modelId: modelVersionId }));
    setModelUseRequest({ modelVersionId, sequence: Date.now() });
    selectLocalTab("create");
  };
  /** 撤销独立会话，不影响主站登录状态。 */
  const logout = async () => {
    if (session) await authenticatedJson("/v1/auth/session", session.sessionToken, { method: "DELETE" }).catch(() => undefined);
    localStorage.removeItem(sessionStorageKey);
    setSession(null); setJobs([]); setModels([]); setLoras([]); setLibraryEntries([]); setModelLibraryEntries([]); setWallet(null);
  };

  /** 取消可取消任务并立即刷新持久化状态。 */
  const cancelJob = async (job: InferenceJobView) => {
    if (!session || !window.confirm("取消该任务并释放已预留余额？")) return;
    try {
      const updated = await authenticatedJson<InferenceJobView>(`/v1/inference/jobs/${job.id}/cancel`, session.sessionToken, { method: "POST", body: JSON.stringify({ reason: "用户在本地模型页面取消任务" }) });
      setJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelectedJob((current) => current?.id === updated.id ? updated : current);
      setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "任务取消失败"); }
  };

  /** 删除已结束的本地推理记录；已发布作品会由后端同步从主站图库移除。 */
  const deleteJob = async (job: InferenceJobView) => {
    if (!session || !window.confirm("删除该生成记录？已发布作品会同步从主站图库删除，但余额和计费审计会保留。")) return;
    try {
      await authenticatedJson(`/v1/inference/jobs/${job.id}`, session.sessionToken, { method: "DELETE" });
      setJobs((current) => current.filter((item) => item.id !== job.id));
      setSelectedJob((current) => current?.id === job.id ? null : current);
      setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "任务删除失败"); }
  };
  const desktopUserCode = new URLSearchParams(window.location.search).get("desktopCode")?.trim().toUpperCase() || "";
  if (desktopUserCode) return <DesktopAuthorizationPage apiBase={apiBase} userCode={desktopUserCode} session={session} loading={loading} />;
  return (
    <div className="local-app">
      <header className="site-header">
        <a className="brand" href="/" aria-label="绘图姬主页"><img src="/favicon-32x32.png" alt="" width={28} height={28} /><span><strong>绘图姬</strong><small>DrawHime</small></span></a>
        <nav className="global-nav" aria-label="绘图姬全站导航">
          {desktopNavigation.map(({ href, label, Icon }) => <a key={href} className={href === "/local-model/" ? "active" : ""} href={href}><Icon size={14} />{label}</a>)}
        </nav>
        <div className="header-actions">{session ? <LocalNavbarUserMenu session={session} logout={() => void logout()} /> : <a className="login-link" href="/login">登录</a>}</div>
      </header>

      <main className={activeTab === "create" ? "page-wrap create-page-wrap" : "page-wrap"}>
        {activeTab !== "create" && <LocalWorkspaceNavigation activeTab={activeTab} onSelect={selectLocalTab} />}

        {activeTab !== "create" && error && <div className="notice error">{error}</div>}
        {mountedTabs.has("create") && <div hidden={activeTab !== "create"}>
          <div className="create-layout">
            <div className="create-left-column">
              <LocalWorkspaceNavigation activeTab={activeTab} onSelect={selectLocalTab} />
              <div className="create-control-column">
                {error && <div className="notice error">{error}</div>}
                <GenerateForm session={session} wallet={wallet} models={models} loras={loras} loraUseRequest={loraUseRequest} modelUseRequest={modelUseRequest} disabled={loading} onCreated={async () => { setJobs(await loadJobs(session!.sessionToken)); }} />
              </div>
            </div>
            <CurrentTask job={currentJob} sessionToken={session?.sessionToken ?? ""} onDetail={setSelectedJob} onCancel={(job) => void cancelJob(job)} onDelete={(job) => void deleteJob(job)} />
          </div>
        </div>}
        {mountedTabs.has("jobs") && <div hidden={activeTab !== "jobs"}><JobHistory jobs={jobs} sessionToken={session?.sessionToken ?? ""} loading={loading} onDetail={setSelectedJob} onCancel={(job) => void cancelJob(job)} onDelete={(job) => void deleteJob(job)} /></div>}
        {mountedTabs.has("models") && <div hidden={activeTab !== "models"}><ModelLibraryPage session={session} entries={modelLibraryEntries} models={models} onChanged={refreshModelViews} onUseModel={useModel} /></div>}
        {mountedTabs.has("loras") && <div hidden={activeTab !== "loras"}><LoraLibraryPage session={session} entries={libraryEntries} modelFamilies={models.map((item) => item.family)} onChanged={refreshLoraViews} onUseLora={useLora} /></div>}
        {mountedTabs.has("training") && <div hidden={activeTab !== "training"}><TrainingPage token={session?.sessionToken ?? ""} models={models} /></div>}
      </main>

      {selectedJob && <TaskDetail job={selectedJob} sessionToken={session?.sessionToken ?? ""} onClose={() => setSelectedJob(null)} onCancel={() => void cancelJob(selectedJob)} onDelete={() => void deleteJob(selectedJob)} />}

      <nav className="mobile-nav" aria-label="绘图姬手机端导航" style={{ gridTemplateColumns: `repeat(${mobilePrimaryNavigation.length + 1}, minmax(0, 1fr))` }}>
        {mobilePrimaryNavigation.map(({ href, label, Icon }) => <a key={href} className={href === "/local-model/" ? "active" : ""} href={href}><Icon size={19} /><span>{label}</span></a>)}
        <button className={mobileMoreOpen ? "active" : ""} onClick={() => setMobileMoreOpen((value) => !value)} aria-expanded={mobileMoreOpen}>{mobileMoreOpen ? <X size={19} /> : <MoreHorizontal size={20} />}<span>更多</span></button>
      </nav>
      {mobileMoreOpen && <><button className="mobile-more-backdrop" aria-label="关闭更多导航" onClick={() => setMobileMoreOpen(false)} /><section className="mobile-more-sheet" role="dialog" aria-label="更多导航"><header><strong>{session?.identity.displayName || "绘图姬"}</strong><button onClick={() => setMobileMoreOpen(false)} aria-label="关闭"><X size={16} /></button></header><div className="mobile-more-group"><span>本地模型</span><div>{localTabs.map(({ id, label, Icon }) => <button key={id} className={activeTab === id ? "active" : ""} onClick={() => selectLocalTab(id)}><Icon size={16} />{label}</button>)}</div></div><div className="mobile-more-group"><span>更多功能</span><div>{mobileMoreNavigation.map(({ href, label, Icon }) => <a key={href} href={href}><Icon size={16} />{label}</a>)}</div></div>{!session && <a className="mobile-sheet-login" href="/login"><LogIn size={16} />登录绘图姬</a>}</section></>}
    </div>
  );
}

/** 本地平台复用主站桌面导航的头像菜单结构，链接仍回到主站权威页面。 */
function LocalNavbarUserMenu({ session, logout }: { session: LocalPlatformSessionView; logout: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("mousedown", closeOutside); window.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  const identity = session.identity;
  return <div className="navbar-user-menu" ref={rootRef}>
    <button type="button" className="navbar-user-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="navbar-user-avatar">{identity.avatarUrl ? <img src={identity.avatarUrl} alt="" /> : identity.displayName.slice(0, 1)}</span>
      <span className="navbar-user-trigger-body"><strong>{identity.displayName}</strong></span><span className={open ? "navbar-user-caret is-open" : "navbar-user-caret"}>▼</span>
    </button>
    {open && <div className="navbar-user-dropdown" role="menu">
      <a href="/profile" className="navbar-user-menu-item" role="menuitem"><User size={15} />个人中心</a>
      <a href="/personal/gallery" className="navbar-user-menu-item" role="menuitem"><Images size={15} />我的图片</a>
      <a href="/recharge" className="navbar-user-menu-item" role="menuitem"><Wallet size={15} />充值钱包</a>
      <a href="/bots" className="navbar-user-menu-item" role="menuitem"><Bot size={15} />Bot 管理</a>
      <div className="navbar-user-menu-separator" />
      <button type="button" className="navbar-user-menu-item is-danger" role="menuitem" onClick={logout}><LogOut size={15} />登出</button>
    </div>}
  </div>;
}

/** 真实生成参数表单。 */
function GenerateForm({ session, wallet, models, loras, loraUseRequest, modelUseRequest, disabled, onCreated }: { session: LocalPlatformSessionView | null; wallet: MainWalletSummary | null; models: InferenceModelView[]; loras: InferenceLoraView[]; loraUseRequest: LoraUseRequest | null; modelUseRequest: ModelUseRequest | null; disabled: boolean; onCreated: () => Promise<void> }) {
  const saved = useMemo(readGenerationSettings, []);
  const [modelId, setModelId] = useState(saved.modelId);
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [ratio, setRatio] = useState(saved.ratio);
  const [renderEdge, setRenderEdge] = useState(saved.renderEdge);
  const [seed, setSeed] = useState("");
  const [loraVersionIds, setLoraVersionIds] = useState(saved.loraVersionIds);
  const [loraStrengths, setLoraStrengths] = useState(saved.loraStrengths);
  const [promptEnhancement, setPromptEnhancement] = useState(saved.promptEnhancement);
  const [isPrivate, setPrivate] = useState(saved.isPrivate);
  const [publishToGallery, setPublishToGallery] = useState(saved.publishToGallery);
  const [samplingSelections, setSamplingSelections] = useState(saved.samplingSelections);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const model = models.find((item) => item.modelVersionId === modelId) ?? models[0];
  const modelProfile = useMemo(() => readModelGenerationProfile(model?.defaultParameters), [model]);
  const samplingSelection = model ? samplingSelections[model.modelVersionId] ?? createSamplingSelection(modelProfile, "quality") : null;
  const outputEdges = useMemo(() => createOutputEdges(modelProfile.maxEdge), [modelProfile.maxEdge]);
  const compatibleLoras = loras.filter((item) => item.modelFamily === model?.family && (!item.baseModelVersionId || item.baseModelVersionId === model?.modelVersionId));
  const promptEnhancementAvailable = model?.defaultParameters.promptEnhancementEnabled === true;
  useEffect(() => {
    // 平台训练 LoRA 绑定精确底模；外部上传 LoRA 仍按模型系列兼容。
    setLoraVersionIds((current) => {
      const next = current.filter((id) => compatibleLoras.some((item) => item.loraVersionId === id)).slice(0, maximumSelectedLoras);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [compatibleLoras]);
  useEffect(() => { if (!modelId && models[0]) setModelId(models[0].modelVersionId); }, [modelId, models]);
  useEffect(() => {
    if (!model) return;
    // 新模型第一次出现时从目录质量档建立状态；已有模型保留用户在该模型上的高级参数。
    setSamplingSelections((current) => current[model.modelVersionId] ? current : { ...current, [model.modelVersionId]: createSamplingSelection(modelProfile, "quality") });
    setRenderEdge((current) => nearestOutputEdge(current, createOutputEdges(modelProfile.maxEdge)));
  }, [model, modelProfile]);
  useEffect(() => {
    if (!modelUseRequest || !models.some((item) => item.modelVersionId === modelUseRequest.modelVersionId)) return;
    setModelId(modelUseRequest.modelVersionId);
  }, [modelUseRequest, models]);
  useEffect(() => {
    if (!loraUseRequest) return;
    setLoraVersionIds((current) => [...new Set([...current, loraUseRequest.loraVersionId])].slice(0, maximumSelectedLoras));
  }, [loraUseRequest]);
  useEffect(() => {
    // 持久化只保留当前已选 LoRA 的权重，自动修复旧版 localStorage 残留键。
    localStorage.setItem(generationSettingsKey, JSON.stringify({ modelId, ratio, renderEdge, loraVersionIds, loraStrengths: selectLoraStrengths(loraStrengths, loraVersionIds), promptEnhancement, isPrivate, publishToGallery, samplingSelections }));
  }, [modelId, ratio, renderEdge, loraVersionIds, loraStrengths, promptEnhancement, isPrivate, publishToGallery, samplingSelections]);
  const dimensions = useMemo(() => ratioDimensions(ratio, Number(renderEdge)), [ratio, renderEdge]);

  const submit = async () => {
    if (!session || !model) return setFormError("账号或模型尚未就绪");
    if (!prompt.trim()) return setFormError("请输入提示词");
    setSubmitting(true);
    setFormError("");
    try {
      await authenticatedJson("/v1/inference/jobs", session.sessionToken, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: `web:${crypto.randomUUID()}`,
          modelVersionId: model.modelVersionId,
          workflowVersionId: model.workflowVersionId,
          prompt: prompt.trim(),
          promptEnhancement: promptEnhancementAvailable && promptEnhancement,
          negativePrompt: negativePrompt.trim() || null,
          width: dimensions[0],
          height: dimensions[1],
          batchSize: 1,
          seed: seed.trim() ? Number(seed) : null,
          // 质量档和高级参数都在创建时固化，Worker 重试只复用同一份任务快照。
          samplingOverrides: samplingSelection?.overrides ?? createSamplingSelection(modelProfile, "quality").overrides,
          loraVersionIds,
          // API 只接收当前选择集合对应的权重，取消选择和切换模型后的旧状态不得进入请求。
          loraStrengths: selectLoraStrengths(loraStrengths, loraVersionIds),
          sourceArtifactIds: [],
          publishToGallery,
          isPrivate,
        }),
      });
      await onCreated();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : "任务提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card generate-card generation-form">
      <section className="generation-section generation-model-section">
        <label className="field"><span>基础模型</span><select value={model?.modelVersionId ?? ""} onChange={(event) => setModelId(event.target.value)} disabled={!models.length}>{models.map((item) => <option key={item.modelVersionId} value={item.modelVersionId}>{item.displayName}</option>)}</select></label>
        <div className="model-status-cards">
          <div className="model-runtime-summary"><strong><span>{model?.family || "等待模型"}</span>{model && <b>¥{model.priceCny} / 张</b>}</strong><div><span>文生图 · 最长边 {Number(model?.defaultParameters.maxEdge) || 1536}px · 单张任务</span></div></div>
          <a className="wallet-summary-card" href="/recharge"><span><WalletCards size={13} />账户余额</span><strong>¥{wallet?.totalBalance ?? "--"}</strong><small>充值与明细</small></a>
        </div>
      </section>
      <div className="prompt-parameter-row">
        <section className="generation-section prompt-section">
          <div className="section-heading"><div><span>提示词</span><small>可直接写中文或英文；开启增强时将生成 Anima 可用格式。</small></div><em>{prompt.length.toLocaleString()} / 100,000</em></div>
          <textarea className="prompt-editor" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述主体、动作、镜头、场景与画风。测试角色 LoRA 时请避免填写具体角色外观。" rows={8} maxLength={100000} />
        </section>
        <section className="generation-section parameter-section">
          <div className="section-heading"><div><span>输出参数</span><small>参数随任务固化保存。</small></div></div>
          <div className="generation-parameter-grid">
            <label className="field"><span>画幅比例</span><select value={ratio} onChange={(event) => setRatio(event.target.value)}>{["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="field"><span>质量预设</span><select value={samplingSelection?.preset ?? "quality"} onChange={(event) => {
              if (!model) return;
              const preset = event.target.value as GenerationPresetName;
              setSamplingSelections((current) => ({ ...current, [model.modelVersionId]: createSamplingSelection(modelProfile, preset) }));
            }}><option value="fast">快速</option><option value="quality">质量</option><option value="extreme">极致</option></select></label>
            <label className="field"><span>输出边长</span><select value={renderEdge} onChange={(event) => setRenderEdge(Number(event.target.value))}>{outputEdges.map((edge) => <option key={edge} value={edge}>{edge} px{edge === modelProfile.maxEdge ? " · 模型上限" : ""}</option>)}</select></label>
            <label className="field"><span>随机种子 <small>可选</small></span><input type="number" min="0" value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="留空随机" /></label>
          </div>
        </section>
      </div>
      <LoraPicker loras={compatibleLoras} selectedIds={loraVersionIds} strengths={loraStrengths} onChange={(ids) => { setLoraVersionIds(ids); setLoraStrengths((current) => selectLoraStrengths(current, ids)); }} onStrengthChange={(id, strength) => setLoraStrengths((current) => ({ ...current, [id]: strength }))} />
      <details className="generation-advanced">
        <summary><span>高级控制</span><small>{samplingSelection?.customized ? "已使用自定义采样参数" : "采样参数、负面提示词与发布范围"}</small></summary>
        <div className="advanced-content">
          <div className="sampling-control-panel">
            <header><div><strong>采样参数</strong><small>初始值来自当前底模目录，可按任务单独覆盖。</small></div>{samplingSelection?.customized && model && <button type="button" onClick={() => setSamplingSelections((current) => ({ ...current, [model.modelVersionId]: createSamplingSelection(modelProfile, samplingSelection.preset) }))}>恢复预设</button>}</header>
            <div className="sampling-control-grid">
              <SamplingNumber label="步数" value={samplingSelection?.overrides.steps ?? modelProfile.steps} min={1} max={80} step={1} onChange={(value) => updateSamplingSelection(model, modelProfile, samplingSelection, setSamplingSelections, "steps", value)} />
              <SamplingNumber label="CFG" value={samplingSelection?.overrides.cfg ?? modelProfile.cfg} min={0.1} max={20} step={0.1} onChange={(value) => updateSamplingSelection(model, modelProfile, samplingSelection, setSamplingSelections, "cfg", value)} />
              <label className="field"><span>采样器</span><select value={samplingSelection?.overrides.sampler ?? modelProfile.sampler} onChange={(event) => updateSamplingSelection(model, modelProfile, samplingSelection, setSamplingSelections, "sampler", event.target.value)}>{modelProfile.availableSamplers.map((value) => <option key={value} value={value}>{samplingOptionLabel(value)}</option>)}</select></label>
              <label className="field"><span>调度器</span><select value={samplingSelection?.overrides.scheduler ?? modelProfile.scheduler} onChange={(event) => updateSamplingSelection(model, modelProfile, samplingSelection, setSamplingSelections, "scheduler", event.target.value)}>{modelProfile.availableSchedulers.map((value) => <option key={value} value={value}>{samplingOptionLabel(value)}</option>)}</select></label>
              <SamplingNumber label="采样最长边" value={samplingSelection?.overrides.samplingMaxEdge ?? modelProfile.samplingMaxEdge} min={512} max={2048} step={64} onChange={(value) => updateSamplingSelection(model, modelProfile, samplingSelection, setSamplingSelections, "samplingMaxEdge", value)} />
              <SamplingNumber label="像素预算" value={samplingSelection?.overrides.samplingPixelBudget ?? modelProfile.samplingPixelBudget} min={262144} max={4194304} step={65536} onChange={(value) => updateSamplingSelection(model, modelProfile, samplingSelection, setSamplingSelections, "samplingPixelBudget", value)} />
              <SamplingNumber label="极端画幅阈值" value={samplingSelection?.overrides.aspectStepThreshold ?? modelProfile.aspectStepThreshold} min={1} max={4} step={0.1} onChange={(value) => updateSamplingSelection(model, modelProfile, samplingSelection, setSamplingSelections, "aspectStepThreshold", value)} />
              <SamplingNumber label="极端画幅步数" value={samplingSelection?.overrides.aspectAdjustedSteps ?? modelProfile.presets.quality.aspectAdjustedSteps} min={1} max={samplingSelection?.overrides.steps ?? modelProfile.steps} step={1} onChange={(value) => updateSamplingSelection(model, modelProfile, samplingSelection, setSamplingSelections, "aspectAdjustedSteps", value)} />
            </div>
          </div>
          <div className="generation-secondary-controls"><label className="field"><span>负面提示词 <small>可选</small></span><textarea value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="留空时使用模型默认结构避免词" rows={3} /></label>
          <div className="switch-grid">
            {promptEnhancementAvailable && <label className="switch-row"><span><strong>AI 提示增强</strong><small>每个任务只执行一次</small></span><button type="button" className={promptEnhancement ? "switch on" : "switch"} onClick={() => setPromptEnhancement((value) => !value)} aria-pressed={promptEnhancement}><i /></button></label>}
            <label className="switch-row"><span><strong>发布到主站图库</strong><small>同步原图、缩略图与最终提示词</small></span><button type="button" className={publishToGallery ? "switch on" : "switch"} onClick={() => setPublishToGallery((value) => !value)} aria-pressed={publishToGallery}><i /></button></label>
            <label className="switch-row"><span><strong>设为私密任务</strong><small>发布后仅自己可见</small></span><button type="button" className={isPrivate ? "switch on" : "switch"} onClick={() => setPrivate((value) => !value)} aria-pressed={isPrivate}><i /></button></label>
          </div></div>
        </div>
      </details>
      {formError && <div className="notice error compact">{formError}</div>}
      <button className="primary-button generation-submit" onClick={() => void submit()} disabled={disabled || submitting || !session || !model}>{submitting ? <><LoaderCircle size={17} className="spin" />正在创建任务</> : <><Sparkles size={17} />创建本地任务</>}</button>
      <div className="billing-note"><WalletCards size={16} /><span>提交时由主站按模型价格预留余额；失败或取消将按原钱包分账自动退回。</span></div>
    </section>
  );
}

/** 渲染受范围约束的高级数值项，避免各输入框采用不一致的步进和类型。 */
function SamplingNumber({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label className="field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next))); }} /></label>;
}

/** 按资产类型提供多选 LoRA，提交前始终限制为四个兼容版本。 */
function LoraPicker({ loras, selectedIds, strengths, onChange, onStrengthChange }: { loras: InferenceLoraView[]; selectedIds: string[]; strengths: Record<string, number>; onChange: (ids: string[]) => void; onStrengthChange: (id: string, strength: number) => void }) {
  const grouped = (Object.keys(loraTypeLabels) as InferenceLoraView["type"][]).map((type) => ({ type, items: loras.filter((item) => item.type === type) })).filter((group) => group.items.length > 0);
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) return onChange(selectedIds.filter((item) => item !== id));
    if (selectedIds.length >= maximumSelectedLoras) return;
    onChange([...selectedIds, id]);
  };
  return <section className="generation-section lora-picker">
    <div className="section-heading"><div><span>LoRA 叠加</span><small>最多 {maximumSelectedLoras} 个；角色默认 1.00，画风默认 0.85，可分别调整。</small></div><em>{selectedIds.length} / {maximumSelectedLoras}</em></div>
    {grouped.length === 0 ? <div className="lora-picker-empty">当前主模型暂无可用 LoRA</div> : <div className="lora-type-groups">{grouped.map((group) => <section key={group.type} className="lora-type-group"><header><strong>{loraTypeLabels[group.type]}</strong><small>{group.items.length} 个可用</small></header><div>{group.items.map((item) => {
      const selected = selectedIds.includes(item.loraVersionId);
      const strength = strengths[item.loraVersionId] ?? loraTypeDefaultStrengths[item.type];
      return <label key={item.loraVersionId} className={selected ? "selected" : ""}><input type="checkbox" checked={selected} disabled={!selected && selectedIds.length >= maximumSelectedLoras} onChange={() => toggle(item.loraVersionId)} /><span><strong>{item.title}</strong><small>{item.description || "未填写说明"}{item.privacy === "private" ? " · 私有" : ""}</small>{selected && <i className="lora-strength"><em>强度</em><input type="number" min="0" max="1.5" step="0.05" value={strength} onChange={(event) => onStrengthChange(item.loraVersionId, Math.min(1.5, Math.max(0, Number(event.target.value) || 0)))} /></i>}</span></label>;
    })}</div></section>)}</div>}
  </section>;
}

/** 右侧当前任务预览。 */
function CurrentTask({ job, sessionToken, onDetail, onCancel, onDelete }: { job?: InferenceJobView; sessionToken: string; onDetail: (job: InferenceJobView) => void; onCancel: (job: InferenceJobView) => void; onDelete: (job: InferenceJobView) => void }) {
  return <section className="card preview-card"><div className="card-head"><div><span>当前任务</span><h2>{job ? statusLabel(job.status) : "等待提交"}</h2></div>{job && <b>{Math.round(job.progress)}%</b>}</div>{job?.artifacts[0] ? <ArtifactImage artifact={job.artifacts[0]} token={sessionToken} /> : <div className="empty-preview">{job && !isFinal(job.status) ? <LoaderCircle size={36} className="spin" /> : <ImageIcon size={42} />}<strong>{job ? job.errorMessage || "任务正在处理" : "生成结果将在这里显示"}</strong><span>{job?.modelDisplayName || "最长边 1536px · 高质量 WebP"}</span></div>}{job && <><TaskMeta job={job} /><TaskActions job={job} onDetail={onDetail} onCancel={onCancel} onDelete={onDelete} /></>}</section>;
}

/** 持久化任务历史列表。 */
function JobHistory({ jobs, sessionToken, loading, onDetail, onCancel, onDelete }: { jobs: InferenceJobView[]; sessionToken: string; loading: boolean; onDetail: (job: InferenceJobView) => void; onCancel: (job: InferenceJobView) => void; onDelete: (job: InferenceJobView) => void }) {
  if (loading && !jobs.length) return <div className="loading-page"><LoaderCircle className="spin" />正在读取任务</div>;
  if (!jobs.length) return <div className="empty-history"><Clock3 size={36} /><h2>暂无本地任务</h2><p>创建任务后，刷新页面也会保留完整状态与结果。</p></div>;
  const runningCount = jobs.filter((job) => !isFinal(job.status)).length;
  const succeededCount = jobs.filter((job) => job.status === "succeeded").length;
  return <section className="job-history-page"><header className="job-history-header"><div><strong>任务记录</strong><span>方形封面居中裁切，提示词、模型与任务配置分层展示</span></div><dl><div><dt>全部</dt><dd>{jobs.length}</dd></div><div><dt>进行中</dt><dd>{runningCount}</dd></div><div><dt>已完成</dt><dd>{succeededCount}</dd></div></dl></header><div className="job-grid">{jobs.map((job) => <JobHistoryCard key={job.id} job={job} sessionToken={sessionToken} onDetail={onDetail} onCancel={onCancel} onDelete={onDelete} />)}</div></section>;
}

/** 使用方形居中裁切封面展示单个历史任务，并把提示词与技术信息分层。 */
function JobHistoryCard({ job, sessionToken, onDetail, onCancel, onDelete }: { job: InferenceJobView; sessionToken: string; onDetail: (job: InferenceJobView) => void; onCancel: (job: InferenceJobView) => void; onDelete: (job: InferenceJobView) => void }) {
  const artifact = job.artifacts[0];
  const width = artifact?.width ?? (Number(job.parameters.width) || null);
  const height = artifact?.height ?? (Number(job.parameters.height) || null);
  const dimensions = width && height ? `${width} × ${height}` : "尺寸待定";
  const createdAt = new Date(job.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return <article className="card job-card"><div className="job-card-cover">{artifact ? <ArtifactImage artifact={artifact} token={sessionToken} /> : <div className="job-placeholder">{!isFinal(job.status) ? <LoaderCircle className="spin" /> : <ImageIcon />}</div>}<div className="job-card-cover-top"><span className={`status ${job.status}`}>{statusLabel(job.status)}</span>{job.loras.length > 0 && <b>{job.loras.length} LoRA</b>}</div><span className="job-card-cover-size">{dimensions}</span></div><div className="job-card-copy"><time>{createdAt}</time><h3 title={job.requestedPrompt}>{job.requestedPrompt || "未填写提示词"}</h3><p title={job.modelDisplayName}>{job.modelDisplayName}</p>{job.queue && <p className="queue-card-summary">{formatQueueSummary(job.queue)}</p>}<div>{job.publication && <span>图库 · {publicationStatusLabel(job.publication.status)}</span>}{job.source === "bot" && <span>Bot</span>}</div>{job.errorMessage && isFinal(job.status) && <em title={job.errorMessage}>{job.errorMessage}</em>}</div><TaskActions job={job} onDetail={onDetail} onCancel={onCancel} onDelete={onDelete} /></article>;
}

/** 带独立会话读取私有产物并使用 Blob URL 展示。 */
function ArtifactImage({ artifact, token }: { artifact: InferenceJobView["artifacts"][number]; token: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let objectUrl = "";
    void fetch(`${apiBase}/v1/artifacts/${artifact.id}/content`, { headers: { authorization: `Bearer ${token}` } }).then(async (response) => {
      if (!response.ok) throw new Error("产物读取失败");
      objectUrl = URL.createObjectURL(await response.blob());
      setSource(objectUrl);
    }).catch(() => undefined);
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.id, token]);
  return <div className="artifact-wrap">{source ? <img src={source} alt="本地模型生成结果" /> : <LoaderCircle className="spin" />}</div>;
}

/** 任务公共元信息。 */
function TaskMeta({ job }: { job: InferenceJobView }) {
  return <div className="task-meta"><div><span className={`status ${job.status}`}>{statusLabel(job.status)}</span><time>{new Date(job.createdAt).toLocaleString("zh-CN")}</time></div><h3>{job.requestedPrompt}</h3><p>{job.modelDisplayName} · {String(job.parameters.width)}×{String(job.parameters.height)}</p>{job.queue && <p className="queue-summary">{formatQueueSummary(job.queue)}</p>}{job.publication && <p>主站图库：{publicationStatusLabel(job.publication.status)}</p>}{job.errorMessage && isFinal(job.status) && <em>{job.errorMessage}</em>}</div>;
}

/** 任务详情与取消操作，运行阶段由后端禁止取消。 */
function TaskActions({ job, onDetail, onCancel, onDelete }: { job: InferenceJobView; onDetail: (job: InferenceJobView) => void; onCancel: (job: InferenceJobView) => void; onDelete: (job: InferenceJobView) => void }) {
  const cancellable = ["queued", "reserving", "ready"].includes(job.status);
  return <div className="task-actions"><button onClick={() => onDetail(job)}><Eye size={14} />查看详情</button>{cancellable && <button className="danger" onClick={() => onCancel(job)}><X size={14} />取消任务</button>}{isFinal(job.status) && <button className="danger" onClick={() => onDelete(job)}><Trash2 size={14} />删除记录</button>}</div>;
}

/** 展示任务固化参数、执行阶段、尝试请求和计费终态。 */
function TaskDetail({ job, sessionToken, onClose, onCancel, onDelete }: { job: InferenceJobView; sessionToken: string; onClose: () => void; onCancel: () => void; onDelete: () => void }) {
  const [detail, setDetail] = useState(job);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const current = await authenticatedJson<InferenceJobView>(`/v1/inference/jobs/${job.id}`, sessionToken);
        if (active) setDetail(current);
      } catch { /* 详情轮询瞬时失败时保留上一次持久化状态。 */ }
    };
    void load();
    const timer = isFinal(detail.status) ? undefined : window.setInterval(() => void load(), 3000);
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, [detail.status, job.id, sessionToken]);
  const cancellable = ["queued", "reserving", "ready"].includes(detail.status);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="task-dialog" role="dialog" aria-modal="true" aria-label="任务详情"><header><div><span>任务详情</span><h2>{detail.id}</h2></div><button onClick={onClose} aria-label="关闭"><X /></button></header><div className="task-detail-body"><section className="task-detail-overview">{detail.artifacts[0] ? <ArtifactImage artifact={detail.artifacts[0]} token={sessionToken} /> : <div className="task-detail-artifact-empty"><ImageIcon /><span>{statusLabel(detail.status)}</span></div>}<div className="detail-summary"><div><span>状态</span><strong>{statusLabel(detail.status)} · {Math.round(detail.progress)}%</strong></div><div><span>模型</span><strong>{detail.modelDisplayName}</strong></div><div><span>计费</span><strong>{detail.billing ? `¥${detail.billing.amount} · ${detail.billing.status}` : "无"}</strong></div><div><span>创建</span><strong>{new Date(detail.createdAt).toLocaleString("zh-CN")}</strong></div>{detail.queue && <div className="queue-detail"><span>排队信息</span><strong>{formatQueueSummary(detail.queue)}</strong><small>{formatQueueCompletion(detail.queue)}</small></div>}</div></section>{detail.loras.length > 0 && <TaskLoraList loras={detail.loras} sessionToken={sessionToken} />}<div className="task-detail-prompts"><DetailBlock title="用户提示词" value={detail.requestedPrompt} /><DetailBlock title="最终提示词" value={detail.effectivePrompt || "-"} /><DetailBlock title="负面提示词" value={detail.negativePrompt || "-"} /></div>{detail.artifacts[0] && <DetailBlock title="生成产物" value={`${detail.artifacts[0].width ?? "-"}×${detail.artifacts[0].height ?? "-"} · ${formatArtifactBytes(detail.artifacts[0].byteSize)} · SHA-256 ${detail.artifacts[0].sha256}`} />}{detail.publication && <PublicationDetail publication={detail.publication} />}<JsonBlock title="完整参数 JSON" value={detail.parameters} /><section className="execution-list"><h3>执行阶段</h3>{detail.stages.length === 0 ? <p>暂无阶段记录</p> : detail.stages.map((stage) => <article key={stage.id}><b>#{stage.sequence} {stage.stageType}</b><span>{stage.status}</span>{stage.errorMessage && <em>{stage.errorMessage}</em>}</article>)}</section><section className="execution-list"><h3>上游尝试</h3>{detail.attempts.length === 0 ? <p>尚未调用 Runtime</p> : detail.attempts.map((attempt) => <article key={attempt.id}><b>第 {attempt.attemptNumber} 次 · {attempt.runtimeJobId || "等待 Runtime ID"}</b><span>{attempt.status}</span>{attempt.errorMessage && <em>{attempt.errorMessage}</em>}{attempt.requestJson && <JsonBlock title="请求 JSON" value={attempt.requestJson} />}{attempt.responseJson && <JsonBlock title="响应 JSON" value={attempt.responseJson} />}</article>)}</section></div><footer>{cancellable && <button className="dialog-danger" onClick={onCancel}>取消并释放余额</button>}{isFinal(detail.status) && <button className="dialog-danger" onClick={onDelete}>删除记录</button>}<button onClick={onClose}>关闭</button></footer></section></div>;
}

/** 展示任务实际使用的 LoRA 封面、类型与固化权重。 */
function TaskLoraList({ loras, sessionToken }: { loras: InferenceJobView["loras"]; sessionToken: string }) {
  return <section className="task-lora-section"><header><div><span>任务配置</span><h3>使用的 LoRA</h3></div><b>{loras.length}</b></header><div className="task-lora-grid">{loras.map((lora) => <article key={lora.loraVersionId}><TaskLoraCover lora={lora} sessionToken={sessionToken} /><div><span className={`lora-type-${lora.type}`}>{loraTypeLabels[lora.type]}</span><strong title={lora.title}>{lora.title}</strong><small>{lora.loraVersionId}</small></div><b>权重 {lora.strength.toFixed(2)}</b></article>)}</div></section>;
}

/** 通过任务归属鉴权读取 LoRA 封面，避免私有或已下架资产被公开访问。 */
function TaskLoraCover({ lora, sessionToken }: { lora: InferenceJobView["loras"][number]; sessionToken: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    setSource("");
    if (!lora.cover) return undefined;
    let objectUrl = "";
    void fetch(lora.cover.contentUrl, { headers: { authorization: `Bearer ${sessionToken}` }, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("LoRA 封面读取失败");
      objectUrl = URL.createObjectURL(await response.blob());
      setSource(objectUrl);
    }).catch(() => setSource(""));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [lora.cover, sessionToken]);
  return <div className="task-lora-cover">{source ? <img src={source} alt={`${lora.title} 封面`} onError={() => setSource("")} /> : <img src={defaultLoraCoverUrl} alt="LoRA 默认封面" />}</div>;
}

/** 展示主站图库同步终态，并在发布成功后提供正式图库入口。 */
function PublicationDetail({ publication }: { publication: NonNullable<InferenceJobView["publication"]> }) {
  return <section className="detail-block"><h3>主站图库</h3><p>{publicationStatusLabel(publication.status)}</p>{publication.mainGalleryItemId && <a href={`/image/${publication.mainGalleryItemId}`}>打开主站图库详情</a>}{publication.errorMessage && <p>{publication.errorMessage}</p>}</section>;
}

/** 展示任务文本字段。 */
function DetailBlock({ title, value }: { title: string; value: string }) { return <section className="detail-block"><h3>{title}</h3><p>{value}</p></section>; }

/** 展示可复制检查的 JSON。 */
function JsonBlock({ title, value }: { title: string; value: Record<string, unknown> }) { return <details className="json-block"><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>; }

/** 把产物字节数字符串格式化为便于核对的文件大小。 */
function formatArtifactBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return `${value} B`;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 主站图库发布状态中文外显。 */
function publicationStatusLabel(status: NonNullable<InferenceJobView["publication"]>["status"]): string {
  return { pending: "等待同步", publishing: "同步中", published: "已发布", failed: "同步失败" }[status];
}

/** 依据当前主站 token 重新交换独立会话，账号切换后不复用上一用户的本地会话。 */
async function restoreLocalSession(): Promise<LocalPlatformSessionView | null> {
  const existing = localStorage.getItem(sessionStorageKey);
  const mainToken = localStorage.getItem("token");
  if (!mainToken) {
    localStorage.removeItem(sessionStorageKey);
    if (existing) await revokeLocalSession(existing);
    return null;
  }
  const existingSession = existing ? await requestSession("/v1/auth/me", existing, "GET") : null;
  const exchanged = await requestSession("/v1/auth/session/exchange", mainToken, "POST");
  if (!exchanged) {
    localStorage.removeItem(sessionStorageKey);
    if (existing) await revokeLocalSession(existing);
    return null;
  }
  if (existing && existingSession && sameLocalIdentity(existingSession, exchanged)) {
    // 同一主站账号继续复用既有会话，避免刷新一个标签页导致其他标签页的任务轮询失效。
    await revokeLocalSession(exchanged.sessionToken);
    return existingSession;
  }
  localStorage.setItem(sessionStorageKey, exchanged.sessionToken);
  if (existing && existing !== exchanged.sessionToken) await revokeLocalSession(existing);
  return exchanged;
}

/** 比较独立会话的权威主站身份键，显示名和头像变化不应被误判为账号切换。 */
function sameLocalIdentity(left: LocalPlatformSessionView, right: LocalPlatformSessionView): boolean {
  return left.identity.issuer === right.identity.issuer && left.identity.subject === right.identity.subject;
}

/** 撤销已经被当前主站身份替换的独立会话，避免旧账号令牌继续读取任务。 */
async function revokeLocalSession(token: string): Promise<void> {
  await fetch(`${apiBase}/v1/auth/session`, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => undefined);
}

/** 调用独立会话端点。 */
async function requestSession(path: string, token: string, method: "GET" | "POST"): Promise<LocalPlatformSessionView | null> {
  try {
    const response = await fetch(`${apiBase}${path}`, { method, headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    const payload = await response.json() as { ok?: boolean; data?: LocalPlatformSessionView };
    return response.ok && payload.ok === true && payload.data ? payload.data : null;
  } catch { return null; }
}

/** 带独立会话调用统一 JSON 接口。 */
async function authenticatedJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers || {}) }, cache: "no-store" });
  const payload = await response.json() as { ok?: boolean; data?: T; message?: string };
  if (!response.ok || payload.ok !== true || payload.data === undefined) throw new Error(payload.message || `请求失败：HTTP ${response.status}`);
  return payload.data;
}

/** 读取当前用户任务。 */
async function loadJobs(token: string): Promise<InferenceJobView[]> {
  return (await authenticatedJson<{ jobs: InferenceJobView[] }>("/v1/inference/jobs?limit=50", token)).jobs;
}

/** 使用主站现有登录令牌读取可访问总余额，不把余额复制到独立平台。 */
async function loadMainWallet(): Promise<MainWalletSummary | null> {
  const token = localStorage.getItem("token");
  if (!token) return null;
  try {
    const response = await fetch("/api/wallet/status", { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    const payload = await response.json() as { ok?: boolean; data?: MainWalletSummary };
    return response.ok && payload.ok === true && payload.data ? payload.data : null;
  } catch { return null; }
}

/** 恢复用户上次选择的模型、输出尺寸、多 LoRA 与发布开关，并兼容旧版单 LoRA 保存值。 */
function readGenerationSettings(): { modelId: string; ratio: string; renderEdge: number; loraVersionIds: string[]; loraStrengths: Record<string, number>; promptEnhancement: boolean; isPrivate: boolean; publishToGallery: boolean; samplingSelections: Record<string, PersistedSamplingSelection> } {
  try {
    const value = JSON.parse(localStorage.getItem(generationSettingsKey) || "{}") as Record<string, unknown>;
    const loraVersionIds = Array.isArray(value.loraVersionIds)
      ? [...new Set(value.loraVersionIds.filter((item): item is string => typeof item === "string" && item.length > 0))].slice(0, maximumSelectedLoras)
      : typeof value.loraVersionId === "string" && value.loraVersionId ? [value.loraVersionId] : [];
    const storedStrengths = value.loraStrengths && typeof value.loraStrengths === "object" && !Array.isArray(value.loraStrengths)
      ? Object.fromEntries(Object.entries(value.loraStrengths).flatMap(([id, strength]) => typeof strength === "number" && Number.isFinite(strength) && strength >= 0 && strength <= 1.5 ? [[id, strength]] : []))
      : {};
    return {
      modelId: typeof value.modelId === "string" ? value.modelId : "",
      ratio: typeof value.ratio === "string" ? value.ratio : "1:1",
      renderEdge: Number.isSafeInteger(Number(value.renderEdge)) && Number(value.renderEdge) >= 512 && Number(value.renderEdge) <= 2048 ? Number(value.renderEdge) : 1536,
      loraVersionIds,
      loraStrengths: selectLoraStrengths(storedStrengths, loraVersionIds),
      promptEnhancement: value.promptEnhancement !== false,
      isPrivate: value.isPrivate === true,
      publishToGallery: value.publishToGallery !== false,
      samplingSelections: readPersistedSamplingSelections(value.samplingSelections),
    };
  } catch { return { modelId: "", ratio: "1:1", renderEdge: 1536, loraVersionIds: [], loraStrengths: {}, promptEnhancement: true, isPrivate: false, publishToGallery: true, samplingSelections: {} }; }
}

/** 读取模型目录配置；缺失字段只使用通用数值回退，不按标题、版本或文件名推断模型能力。 */
function readModelGenerationProfile(value: unknown): ModelGenerationProfile {
  const source = readUnknownRecord(value);
  const generationPresets = readUnknownRecord(source.generationPresets);
  const defaultSteps = boundedInteger(source.steps, 1, 80, 20);
  const defaultAspectSteps = boundedInteger(source.aspectAdjustedSteps, 1, defaultSteps, defaultSteps);
  const defaultSamplingMaxEdge = boundedInteger(source.samplingMaxEdge, 512, 2048, 1024);
  const defaultPixelBudget = boundedInteger(source.samplingPixelBudget, 262144, 4194304, 1048576);
  const readPreset = (name: GenerationPresetName): ModelGenerationProfile["presets"][GenerationPresetName] => {
    const preset = readUnknownRecord(generationPresets[name]);
    const steps = boundedInteger(preset.steps, 1, 80, defaultSteps);
    return {
      steps,
      aspectAdjustedSteps: boundedInteger(preset.aspectAdjustedSteps, 1, steps, Math.min(defaultAspectSteps, steps)),
      samplingMaxEdge: boundedInteger(preset.samplingMaxEdge, 512, 2048, defaultSamplingMaxEdge),
      samplingPixelBudget: boundedInteger(preset.samplingPixelBudget, 262144, 4194304, defaultPixelBudget),
    };
  };
  const sampler = stringValue(source.sampler, "er_sde");
  const scheduler = stringValue(source.scheduler, "simple");
  return {
    steps: defaultSteps,
    cfg: boundedNumber(source.cfg, 0.1, 20, 1),
    sampler,
    scheduler,
    samplingMaxEdge: defaultSamplingMaxEdge,
    samplingPixelBudget: defaultPixelBudget,
    aspectStepThreshold: boundedNumber(source.aspectStepThreshold, 1, 4, 1.5),
    maxEdge: boundedInteger(source.maxEdge, 512, 2048, 1536),
    qualityPrefix: stringValue(source.qualityPrefix, ""),
    defaultNegativePrompt: stringValue(source.defaultNegativePrompt, ""),
    trainingSupported: source.trainingSupported !== false,
    availableSamplers: readStringOptions(source.availableSamplers, sampler),
    availableSchedulers: readStringOptions(source.availableSchedulers, scheduler),
    presets: { fast: readPreset("fast"), quality: readPreset("quality"), extreme: readPreset("extreme") },
  };
}

/** 从模型目录质量档构造一次完整任务覆盖值。 */
function createSamplingSelection(profile: ModelGenerationProfile, preset: GenerationPresetName): PersistedSamplingSelection {
  const selected = profile.presets[preset];
  return {
    preset,
    customized: false,
    overrides: {
      steps: selected.steps,
      cfg: profile.cfg,
      sampler: profile.sampler,
      scheduler: profile.scheduler,
      samplingMaxEdge: selected.samplingMaxEdge,
      samplingPixelBudget: selected.samplingPixelBudget,
      aspectStepThreshold: profile.aspectStepThreshold,
      aspectAdjustedSteps: Math.min(selected.steps, selected.aspectAdjustedSteps),
    },
  };
}

/** 更新当前模型的单个高级字段，并同步保持极端画幅步数不高于基础步数。 */
function updateSamplingSelection<Key extends keyof InferenceSamplingOverrides>(
  model: InferenceModelView | undefined,
  profile: ModelGenerationProfile,
  selection: PersistedSamplingSelection | null,
  update: Dispatch<SetStateAction<Record<string, PersistedSamplingSelection>>>,
  key: Key,
  value: InferenceSamplingOverrides[Key],
): void {
  if (!model) return;
  const current = selection ?? createSamplingSelection(profile, "quality");
  const overrides = { ...current.overrides, [key]: value };
  if (key === "steps") overrides.aspectAdjustedSteps = Math.min(overrides.aspectAdjustedSteps, Number(value));
  update((items) => ({ ...items, [model.modelVersionId]: { ...current, customized: true, overrides } }));
}

/** 只恢复结构完整的本机高级参数；最终仍由 API 按在线模型目录白名单校验。 */
function readPersistedSamplingSelections(value: unknown): Record<string, PersistedSamplingSelection> {
  const source = readUnknownRecord(value);
  return Object.fromEntries(Object.entries(source).flatMap(([modelId, item]) => {
    const row = readUnknownRecord(item);
    const preset = row.preset === "fast" || row.preset === "extreme" ? row.preset : "quality";
    const overrides = readUnknownRecord(row.overrides);
    const candidate: InferenceSamplingOverrides = {
      steps: boundedInteger(overrides.steps, 1, 80, 20),
      cfg: boundedNumber(overrides.cfg, 0.1, 20, 1),
      sampler: stringValue(overrides.sampler, "er_sde"),
      scheduler: stringValue(overrides.scheduler, "simple"),
      samplingMaxEdge: boundedInteger(overrides.samplingMaxEdge, 512, 2048, 1024),
      samplingPixelBudget: boundedInteger(overrides.samplingPixelBudget, 262144, 4194304, 1048576),
      aspectStepThreshold: boundedNumber(overrides.aspectStepThreshold, 1, 4, 1.5),
      aspectAdjustedSteps: boundedInteger(overrides.aspectAdjustedSteps, 1, 80, 20),
    };
    candidate.aspectAdjustedSteps = Math.min(candidate.steps, candidate.aspectAdjustedSteps);
    return modelId ? [[modelId, { preset, customized: row.customized === true, overrides: candidate } satisfies PersistedSamplingSelection]] : [];
  }));
}

/** 模型输出边长由目录上限生成，常用尺寸不足上限时自动补入精确上限。 */
function createOutputEdges(maxEdge: number): number[] {
  return [...new Set([768, 1024, 1280, 1536, 1792, 2048, maxEdge].filter((value) => value <= maxEdge))].sort((left, right) => left - right);
}

/** 把旧缓存中的任意边长收敛到当前模型真实可选值。 */
function nearestOutputEdge(value: number, options: number[]): number { return options.reduce((best, current) => Math.abs(current - value) < Math.abs(best - value) ? current : best, options[0] ?? 1024); }

/** 把运行时标识转换为紧凑可读文本，不维护模型专属映射。 */
function samplingOptionLabel(value: string): string { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

/** 将未知 JSON 读取为普通对象。 */
function readUnknownRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** 读取受限整数。 */
function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback; }
/** 读取受限数值。 */
function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback; }
/** 读取非空字符串。 */
function stringValue(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
/** 读取去重后的非空字符串选项，并确保推荐值始终可选。 */
function readStringOptions(value: unknown, fallback: string): string[] { return [...new Set([...(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []), fallback])]; }

/** 按当前 LoRA 版本 ID 集合筛选权重，版本标题变化不会影响任务绑定。 */
function selectLoraStrengths(strengths: Record<string, number>, selectedIds: string[]): Record<string, number> {
  const selected = new Set(selectedIds);
  return Object.fromEntries(Object.entries(strengths).filter(([id, strength]) => selected.has(id) && Number.isFinite(strength) && strength >= 0 && strength <= 1.5));
}

/** 常见画幅映射到用户选择的最长边，并按 Runtime 潜空间要求对齐到 8 像素。 */
function ratioDimensions(ratio: string, maximumEdge: number): [number, number] {
  const [horizontal, vertical] = ratio.split(":").map(Number);
  return horizontal >= vertical ? [maximumEdge, Math.round(maximumEdge * vertical / horizontal / 8) * 8] : [Math.round(maximumEdge * horizontal / vertical / 8) * 8, maximumEdge];
}

/** 判断任务是否已进入最终状态。 */
function isFinal(status: InferenceJobView["status"]): boolean { return status === "succeeded" || status === "failed" || status === "cancelled"; }

/** 用户可读状态名称。 */
function statusLabel(status: InferenceJobView["status"]): string {
  return { queued: "排队中", reserving: "排队中", ready: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" }[status];
}
