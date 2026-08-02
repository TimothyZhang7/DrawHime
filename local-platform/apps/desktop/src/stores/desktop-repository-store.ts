/**
 * 本文件集中管理本机与主站模型仓库状态，避免下载进度和后台同步触发桌面根组件重绘。
 */
import type {
  DesktopAccountView,
  DesktopLocalLoraView,
  DesktopLocalModelView,
  DesktopManagedFileRemovalView,
  DesktopWebsiteLoraInstallProgress,
  DesktopWebsiteLoraView,
  DesktopWebsiteModelInstallProgress,
  DesktopWebsiteModelView,
} from "@drawhime/contracts";
import { startTransition, useSyncExternalStore } from "react";
import {
  installDesktopWebsiteLora,
  installDesktopWebsiteModel,
  listDesktopLocalLoras,
  listDesktopLocalModels,
  listenDesktopWebsiteLoraProgress,
  listenDesktopWebsiteModelProgress,
  loadDesktopWebsiteLoras,
  loadDesktopWebsiteModels,
} from "../desktop-api";

interface DesktopRepositoryState {
  models: DesktopLocalModelView[];
  loras: DesktopLocalLoraView[];
  websiteModels: DesktopWebsiteModelView[];
  websiteLoras: DesktopWebsiteLoraView[];
  websiteModelProgress: Record<string, DesktopWebsiteModelInstallProgress>;
  websiteLoraProgress: Record<string, DesktopWebsiteLoraInstallProgress>;
  modelsRefreshing: boolean;
  lorasRefreshing: boolean;
}

type MessageHandler = (message: string) => void;

const listeners = new Set<() => void>();
let state: DesktopRepositoryState = {
  models: [],
  loras: [],
  websiteModels: [],
  websiteLoras: [],
  websiteModelProgress: {},
  websiteLoraProgress: {},
  modelsRefreshing: false,
  lorasRefreshing: false,
};
let messageHandler: MessageHandler = () => undefined;
let accountStatus: DesktopAccountView["status"] = "signed_out";
let catalogEpoch = 0;
let storeLifecycleEpoch = 0;
let websiteModelsLoaded = false;
let websiteLorasLoaded = false;
let websiteModelsRequest: Promise<void> | null = null;
let websiteLorasRequest: Promise<void> | null = null;
let websiteModelsRefreshPending = false;
let websiteLorasRefreshPending = false;
let localModelsRequest: Promise<void> | null = null;
let localLorasRequest: Promise<void> | null = null;
const modelInstalls = new Set<string>();
const loraInstalls = new Set<string>();
const pendingModelProgress: Record<string, DesktopWebsiteModelInstallProgress> = {};
const pendingLoraProgress: Record<string, DesktopWebsiteLoraInstallProgress> = {};
let progressFrame: number | null = null;

/** 只替换发生变化的仓库切片，订阅其他切片的页面不会被连带唤醒。 */
function updateState(patch: Partial<DesktopRepositoryState>): void {
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof DesktopRepositoryState>) {
    if (!Object.is(state[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 页面按切片订阅仓库；下载进度不会让未使用该进度的页面重绘。 */
export function useDesktopRepositorySelector<Value>(selector: (snapshot: DesktopRepositoryState) => Value): Value {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

function canReadWebsiteCatalog(): boolean {
  return accountStatus === "connected" || accountStatus === "offline";
}

function report(error: unknown): void {
  messageHandler(error instanceof Error ? error.message : String(error || "仓库操作失败"));
}

function formatBytes(value: number): string {
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function upsertModel(model: DesktopLocalModelView, announce: boolean): void {
  updateState({ models: [model, ...state.models.filter((item) => item.id !== model.id)] });
  if (announce) messageHandler(`模型“${model.displayName}”已完成校验并导入`);
}

function upsertLora(lora: DesktopLocalLoraView, announce: boolean): void {
  updateState({ loras: [lora, ...state.loras.filter((item) => item.id !== lora.id)] });
  if (announce) messageHandler(`LoRA“${lora.title}”已完成校验并导入`);
}

/** 本机模型刷新使用单飞请求，模型操作不会读取或替换 LoRA 列表。 */
export function refreshDesktopLocalModels(): Promise<void> {
  if (localModelsRequest) return localModelsRequest;
  const request = listDesktopLocalModels().then((items) => startTransition(() => updateState({ models: items }))).finally(() => {
    if (localModelsRequest === request) localModelsRequest = null;
  });
  localModelsRequest = request;
  return request;
}

/** 本机 LoRA 刷新使用独立单飞请求，训练产物登记不会触发模型仓库扫描。 */
export function refreshDesktopLocalLoras(): Promise<void> {
  if (localLorasRequest) return localLorasRequest;
  const request = listDesktopLocalLoras().then((items) => startTransition(() => updateState({ loras: items }))).finally(() => {
    if (localLorasRequest === request) localLorasRequest = null;
  });
  localLorasRequest = request;
  return request;
}

/** 主站底模目录按需后台加载，账号切换后的旧响应不会覆盖新账号状态。 */
export function ensureDesktopWebsiteModels(forceRefresh = false): Promise<void> {
  if (!canReadWebsiteCatalog() || (!forceRefresh && websiteModelsLoaded)) return Promise.resolve();
  if (websiteModelsRequest) {
    if (forceRefresh) websiteModelsRefreshPending = true;
    return websiteModelsRequest;
  }
  const epoch = catalogEpoch;
  const request = loadDesktopWebsiteModels(forceRefresh).then((items) => {
    if (epoch !== catalogEpoch) return;
    websiteModelsLoaded = true;
    startTransition(() => updateState({ websiteModels: items }));
  }).catch(report).finally(() => {
    if (websiteModelsRequest === request) websiteModelsRequest = null;
    if (websiteModelsRefreshPending && canReadWebsiteCatalog()) {
      websiteModelsRefreshPending = false;
      void ensureDesktopWebsiteModels(true);
    }
  });
  websiteModelsRequest = request;
  return request;
}

/** 主站 LoRA 目录独立按需后台加载，不与底模目录共用刷新门禁。 */
export function ensureDesktopWebsiteLoras(forceRefresh = false): Promise<void> {
  if (!canReadWebsiteCatalog() || (!forceRefresh && websiteLorasLoaded)) return Promise.resolve();
  if (websiteLorasRequest) {
    if (forceRefresh) websiteLorasRefreshPending = true;
    return websiteLorasRequest;
  }
  const epoch = catalogEpoch;
  const request = loadDesktopWebsiteLoras(forceRefresh).then((items) => {
    if (epoch !== catalogEpoch) return;
    websiteLorasLoaded = true;
    startTransition(() => updateState({ websiteLoras: items }));
  }).catch(report).finally(() => {
    if (websiteLorasRequest === request) websiteLorasRequest = null;
    if (websiteLorasRefreshPending && canReadWebsiteCatalog()) {
      websiteLorasRefreshPending = false;
      void ensureDesktopWebsiteLoras(true);
    }
  });
  websiteLorasRequest = request;
  return request;
}

/** 模型页刷新只刷新模型域，远端失败时仍保留本机结果与上次可信目录。 */
export async function refreshDesktopModels(): Promise<void> {
  if (state.modelsRefreshing) return;
  updateState({ modelsRefreshing: true });
  try {
    await refreshDesktopLocalModels();
    if (canReadWebsiteCatalog()) await ensureDesktopWebsiteModels(true);
    messageHandler("模型仓库已刷新");
  } catch (error) {
    report(error);
  } finally {
    updateState({ modelsRefreshing: false });
  }
}

/** LoRA 页刷新只刷新 LoRA 域，不再连带扫描全部底模与签名资源。 */
export async function refreshDesktopLoras(): Promise<void> {
  if (state.lorasRefreshing) return;
  updateState({ lorasRefreshing: true });
  try {
    await refreshDesktopLocalLoras();
    if (canReadWebsiteCatalog()) await ensureDesktopWebsiteLoras(true);
    messageHandler("LoRA 仓库已刷新");
  } catch (error) {
    report(error);
  } finally {
    updateState({ lorasRefreshing: false });
  }
}

/** 手工导入模型仅更新模型切片。 */
export function desktopModelImported(model: DesktopLocalModelView): void {
  upsertModel(model, true);
}

/** 手工导入 LoRA 仅更新 LoRA 切片。 */
export function desktopLoraImported(lora: DesktopLocalLoraView): void {
  upsertLora(lora, true);
}

/** 删除受管文件后只重读对应类型，历史任务快照不受影响。 */
export async function desktopManagedFileDeleted(result: DesktopManagedFileRemovalView): Promise<void> {
  try {
    if (result.kind === "model") await refreshDesktopLocalModels();
    else await refreshDesktopLocalLoras();
    const retained = result.retainedSharedFiles ? `，保留 ${result.retainedSharedFiles} 个共享组件` : "";
    messageHandler(result.removed ? `已删除 ${result.fileName}，释放 ${formatBytes(result.freedBytes)}${retained}` : `${result.fileName} 已不在本机`);
  } catch (error) {
    report(error);
  }
}

/** 网站 LoRA 安装完成即更新本机条目，主站安装状态随后异步收敛。 */
export async function installDesktopRepositoryLora(id: string): Promise<void> {
  if (loraInstalls.has(id)) return;
  loraInstalls.add(id);
  const totalBytes = state.websiteLoras.find((item) => item.id === id)?.byteSize || state.websiteLoraProgress[id]?.totalBytes || 1;
  updateState({ websiteLoraProgress: { ...state.websiteLoraProgress, [id]: { loraId: id, status: "downloading", downloadedBytes: state.websiteLoraProgress[id]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, error: null } } });
  try {
    upsertLora(await installDesktopWebsiteLora(id), true);
    void ensureDesktopWebsiteLoras(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "LoRA 下载失败");
    delete pendingLoraProgress[id];
    updateState({ websiteLoraProgress: { ...state.websiteLoraProgress, [id]: { loraId: id, status: "failed", downloadedBytes: state.websiteLoraProgress[id]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, error: message } } });
    messageHandler(message);
  } finally {
    loraInstalls.delete(id);
  }
}

/** 网站底模安装与 LoRA 安装完全分域，完成后不等待远端目录刷新。 */
export async function installDesktopRepositoryModel(id: string): Promise<void> {
  if (modelInstalls.has(id)) return;
  modelInstalls.add(id);
  const totalBytes = state.websiteModels.find((item) => item.id === id)?.download?.byteSize || state.websiteModelProgress[id]?.totalBytes || 1;
  updateState({ websiteModelProgress: { ...state.websiteModelProgress, [id]: { modelId: id, status: "downloading", downloadedBytes: state.websiteModelProgress[id]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, error: null } } });
  try {
    upsertModel(await installDesktopWebsiteModel(id), true);
    void ensureDesktopWebsiteModels(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "模型下载失败");
    delete pendingModelProgress[id];
    updateState({ websiteModelProgress: { ...state.websiteModelProgress, [id]: { modelId: id, status: "failed", downloadedBytes: state.websiteModelProgress[id]?.downloadedBytes || 0, totalBytes, bytesPerSecond: 0, error: message } } });
    messageHandler(message);
  } finally {
    modelInstalls.delete(id);
  }
}

/** 账号状态只使远端目录缓存失效，本机仓库始终可用。 */
export function setDesktopRepositoryAccountStatus(status: DesktopAccountView["status"]): void {
  if (accountStatus === status) return;
  accountStatus = status;
  catalogEpoch += 1;
  websiteModelsLoaded = false;
  websiteLorasLoaded = false;
  websiteModelsRequest = null;
  websiteLorasRequest = null;
  websiteModelsRefreshPending = false;
  websiteLorasRefreshPending = false;
  if (!canReadWebsiteCatalog()) updateState({ websiteModels: [], websiteLoras: [] });
}

function flushWebsiteProgress(): void {
  const modelPatch = { ...pendingModelProgress };
  const loraPatch = { ...pendingLoraProgress };
  for (const key of Object.keys(pendingModelProgress)) delete pendingModelProgress[key];
  for (const key of Object.keys(pendingLoraProgress)) delete pendingLoraProgress[key];
  progressFrame = null;
  const patch: Partial<DesktopRepositoryState> = {};
  if (Object.keys(modelPatch).length) patch.websiteModelProgress = { ...state.websiteModelProgress, ...modelPatch };
  if (Object.keys(loraPatch).length) patch.websiteLoraProgress = { ...state.websiteLoraProgress, ...loraPatch };
  updateState(patch);
}

/** 启动仓库后台服务；高频下载进度按帧合并并仅通知仓库订阅者。 */
export function startDesktopRepositoryStore(onMessage: MessageHandler): () => void {
  messageHandler = onMessage;
  const epoch = ++storeLifecycleEpoch;
  let disposed = false;
  let unlistenModel: (() => void) | undefined;
  let unlistenLora: (() => void) | undefined;
  void Promise.all([refreshDesktopLocalModels(), refreshDesktopLocalLoras()]).catch(report);
  const schedule = () => {
    if (progressFrame === null) progressFrame = window.requestAnimationFrame(flushWebsiteProgress);
  };
  void listenDesktopWebsiteModelProgress((progress) => { pendingModelProgress[progress.modelId] = progress; schedule(); }).then((dispose) => {
    if (disposed || epoch !== storeLifecycleEpoch) dispose(); else unlistenModel = dispose;
  }).catch(report);
  void listenDesktopWebsiteLoraProgress((progress) => { pendingLoraProgress[progress.loraId] = progress; schedule(); }).then((dispose) => {
    if (disposed || epoch !== storeLifecycleEpoch) dispose(); else unlistenLora = dispose;
  }).catch(report);
  return () => {
    disposed = true;
    unlistenModel?.();
    unlistenLora?.();
    if (progressFrame !== null) window.cancelAnimationFrame(progressFrame);
    progressFrame = null;
    if (epoch === storeLifecycleEpoch) messageHandler = () => undefined;
  };
}
