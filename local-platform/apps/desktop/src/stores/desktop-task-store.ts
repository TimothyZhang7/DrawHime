/**
 * 本文件隔离生成、打标、清洗与训练任务流，高频事件不会再驱动桌面根组件更新。
 */
import type { DesktopAiCleanJobView, DesktopCaptionJobView, DesktopLocalJobView, DesktopTrainingDatasetView, DesktopTrainingJobView } from "@drawhime/contracts";
import { startTransition, useSyncExternalStore } from "react";
import { cancelDesktopLocalJob, listDesktopAiCleanJobs, listDesktopCaptionJobs, listDesktopLocalJobs, listDesktopTrainingDatasets, listDesktopTrainingJobs, listenDesktopAiCleanJobUpdates, listenDesktopCaptionJobUpdates, listenDesktopLocalJobUpdates, listenDesktopTrainingJobUpdates } from "../desktop-api";

interface DesktopTaskState {
  datasets: DesktopTrainingDatasetView[];
  captionJobs: DesktopCaptionJobView[];
  aiCleanJobs: DesktopAiCleanJobView[];
  trainingJobs: DesktopTrainingJobView[];
  jobs: DesktopLocalJobView[];
  cancellingJobIds: Set<string>;
  hasActiveLocalJobs: boolean;
}

const listeners = new Set<() => void>();
let state: DesktopTaskState = { datasets: [], captionJobs: [], aiCleanJobs: [], trainingJobs: [], jobs: [], cancellingJobIds: new Set(), hasActiveLocalJobs: false };
let messageHandler: (message: string) => void = () => undefined;
let trainingSucceededHandler: () => void = () => undefined;
let taskFrame: number | null = null;
let datasetTimer: number | null = null;
let datasetRequest: Promise<void> | null = null;
let datasetRefreshPending = false;
const cancellingJobs = new Set<string>();
const announcedTrainingArtifacts = new Set<string>();
const pendingCaptionJobs: Record<string, DesktopCaptionJobView> = {};
const pendingAiCleanJobs: Record<string, DesktopAiCleanJobView> = {};
const pendingTrainingJobs: Record<string, DesktopTrainingJobView> = {};
const pendingLocalJobs: Record<string, DesktopLocalJobView> = {};

function updateState(patch: Partial<DesktopTaskState>): void {
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof DesktopTaskState>) {
    if (!Object.is(state[key], patch[key])) { changed = true; break; }
  }
  if (!changed) return;
  const nextJobs = patch.jobs || state.jobs;
  state = { ...state, ...patch, hasActiveLocalJobs: nextJobs.some((job) => job.status === "queued" || job.status === "running") };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 页面只订阅自己需要的任务切片，训练进度不会重绘图库或生成表单。 */
export function useDesktopTaskSelector<Value>(selector: (snapshot: DesktopTaskState) => Value): Value {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

function mergeRealtimeItems<Item extends { id: string; createdAt: string }>(current: Item[], pending: Record<string, Item>): Item[] {
  const items = Object.values(pending);
  if (!items.length) return current;
  const ids = new Set(items.map((item) => item.id));
  return [...items, ...current.filter((item) => !ids.has(item.id))].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function flushTaskEvents(): void {
  const captions = { ...pendingCaptionJobs };
  const cleanJobs = { ...pendingAiCleanJobs };
  const trainings = { ...pendingTrainingJobs };
  const localJobs = { ...pendingLocalJobs };
  for (const key of Object.keys(pendingCaptionJobs)) delete pendingCaptionJobs[key];
  for (const key of Object.keys(pendingAiCleanJobs)) delete pendingAiCleanJobs[key];
  for (const key of Object.keys(pendingTrainingJobs)) delete pendingTrainingJobs[key];
  for (const key of Object.keys(pendingLocalJobs)) delete pendingLocalJobs[key];
  taskFrame = null;
  const patch: Partial<DesktopTaskState> = {};
  if (Object.keys(captions).length) patch.captionJobs = mergeRealtimeItems(state.captionJobs, captions);
  if (Object.keys(cleanJobs).length) patch.aiCleanJobs = mergeRealtimeItems(state.aiCleanJobs, cleanJobs);
  if (Object.keys(trainings).length) patch.trainingJobs = mergeRealtimeItems(state.trainingJobs, trainings);
  if (Object.keys(localJobs).length) patch.jobs = mergeRealtimeItems(state.jobs, localJobs);
  updateState(patch);
}

function scheduleTaskFlush(): void {
  if (taskFrame === null) taskFrame = window.requestAnimationFrame(flushTaskEvents);
}

/** 数据集重读使用单飞和脏标记，连续逐图事件只产生一次后端查询。 */
export function refreshDesktopTrainingDatasets(): Promise<void> {
  if (datasetRequest) {
    datasetRefreshPending = true;
    return datasetRequest;
  }
  const request = listDesktopTrainingDatasets().then((datasets) => startTransition(() => updateState({ datasets }))).finally(() => {
    if (datasetRequest === request) datasetRequest = null;
    if (datasetRefreshPending) {
      datasetRefreshPending = false;
      void refreshDesktopTrainingDatasets().catch(report);
    }
  });
  datasetRequest = request;
  return request;
}

function scheduleDatasetRefresh(immediate: boolean): void {
  if (datasetTimer !== null) window.clearTimeout(datasetTimer);
  datasetTimer = window.setTimeout(() => {
    datasetTimer = null;
    void refreshDesktopTrainingDatasets().catch(report);
  }, immediate ? 60 : 350);
}

function report(error: unknown): void {
  messageHandler(error instanceof Error ? error.message : String(error || "任务状态更新失败"));
}

function notifyTrainingArtifact(job: DesktopTrainingJobView): void {
  if (job.status !== "succeeded" || !job.outputLoraId || announcedTrainingArtifacts.has(job.id)) return;
  announcedTrainingArtifacts.add(job.id);
  trainingSucceededHandler();
}

/** 页面写回训练集时按 ID 原位更新并置顶，不重新读取其他任务集合。 */
export function desktopTrainingDatasetUpdated(dataset: DesktopTrainingDatasetView): void {
  updateState({ datasets: [dataset, ...state.datasets.filter((item) => item.id !== dataset.id)] });
}

/** 删除训练集只改变训练集切片，历史训练任务继续保留。 */
export function desktopTrainingDatasetDeleted(datasetId: string): void {
  updateState({ datasets: state.datasets.filter((item) => item.id !== datasetId) });
}

/** 页面命令返回的打标任务立即并入事件事实源。 */
export function desktopCaptionJobUpdated(job: DesktopCaptionJobView): void {
  delete pendingCaptionJobs[job.id];
  updateState({ captionJobs: mergeRealtimeItems(state.captionJobs, { [job.id]: job }) });
}

/** 页面命令返回的 AI 清洗任务只更新清洗任务切片。 */
export function desktopAiCleanJobUpdated(job: DesktopAiCleanJobView): void {
  delete pendingAiCleanJobs[job.id];
  updateState({ aiCleanJobs: mergeRealtimeItems(state.aiCleanJobs, { [job.id]: job }) });
}

/** 训练任务更新按 ID 合并，成功产物只触发一次 LoRA 后台刷新。 */
export function desktopTrainingJobUpdated(job: DesktopTrainingJobView): void {
  delete pendingTrainingJobs[job.id];
  updateState({ trainingJobs: mergeRealtimeItems(state.trainingJobs, { [job.id]: job }) });
  notifyTrainingArtifact(job);
}

/** 新生成任务进入持久队列后只更新本地任务域。 */
export function desktopLocalJobCreated(job: DesktopLocalJobView): void {
  delete pendingLocalJobs[job.id];
  updateState({ jobs: mergeRealtimeItems(state.jobs, { [job.id]: job }) });
  messageHandler("本地任务已进入持久队列");
}

/** 取消操作对单任务加锁，其他任务卡片和页面操作不受影响。 */
export async function cancelDesktopTask(id: string): Promise<void> {
  if (cancellingJobs.has(id)) return;
  cancellingJobs.add(id);
  updateState({ cancellingJobIds: new Set([...state.cancellingJobIds, id]) });
  try {
    const job = await cancelDesktopLocalJob(id);
    delete pendingLocalJobs[id];
    updateState({ jobs: state.jobs.map((item) => item.id === id ? job : item) });
    messageHandler("已提交取消请求");
  } catch (error) {
    report(error);
  } finally {
    cancellingJobs.delete(id);
    const next = new Set(state.cancellingJobIds);
    next.delete(id);
    updateState({ cancellingJobIds: next });
  }
}

/** 启动持久任务事件服务；所有事件监听在同一生命周期内统一清理。 */
export function startDesktopTaskStore(onMessage: (message: string) => void, onTrainingSucceeded: () => void): () => void {
  messageHandler = onMessage;
  trainingSucceededHandler = onTrainingSucceeded;
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  void Promise.all([listDesktopTrainingDatasets(), listDesktopCaptionJobs(), listDesktopAiCleanJobs(), listDesktopTrainingJobs(), listDesktopLocalJobs()]).then(([datasets, captionJobs, aiCleanJobs, trainingJobs, jobs]) => {
    if (!disposed) startTransition(() => updateState({ datasets, captionJobs, aiCleanJobs, trainingJobs, jobs }));
  }).catch(report);
  const register = (promise: Promise<() => void>) => void promise.then((dispose) => disposed ? dispose() : unlisteners.push(dispose)).catch(report);
  register(listenDesktopCaptionJobUpdates((job) => {
    pendingCaptionJobs[job.id] = job;
    scheduleTaskFlush();
    scheduleDatasetRefresh(["succeeded", "failed", "cancelled"].includes(job.status));
  }));
  register(listenDesktopAiCleanJobUpdates((job) => {
    pendingAiCleanJobs[job.id] = job;
    scheduleTaskFlush();
    scheduleDatasetRefresh(["succeeded", "failed", "cancelled"].includes(job.status));
  }));
  register(listenDesktopTrainingJobUpdates((job) => {
    pendingTrainingJobs[job.id] = job;
    scheduleTaskFlush();
    notifyTrainingArtifact(job);
  }));
  register(listenDesktopLocalJobUpdates((job) => {
    pendingLocalJobs[job.id] = job;
    scheduleTaskFlush();
  }));
  return () => {
    disposed = true;
    unlisteners.forEach((dispose) => dispose());
    if (taskFrame !== null) window.cancelAnimationFrame(taskFrame);
    if (datasetTimer !== null) window.clearTimeout(datasetTimer);
    taskFrame = null;
    datasetTimer = null;
    messageHandler = () => undefined;
    trainingSucceededHandler = () => undefined;
  };
}
