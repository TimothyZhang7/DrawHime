/** 右侧实时预览 — 自适应轮询 + 尝试点位 + 结果操作 */
import { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import { Loader2, Image, AlertTriangle, RotateCcw, Download, Plus, ChevronLeft, ChevronRight, Video } from 'lucide-react';
import { resolveMediaUrl, resolvePlayableVideoUrl } from '../../lib/media';
import { useToast } from '../../providers/ToastProvider';
import type { GenerationSubTaskView, GenerationTaskView } from '@aiimage/shared-contracts';
import { ImageLightbox, type ImageLightboxItem } from '../../components/image/ImageLightbox';
import { formatDrawingModelNameByMap, useDrawingModelDisplayMap } from '../../lib/drawingModelDisplay';

type TaskInfo = GenerationTaskView & { taskId?: string; imageUrl?: string; thumbnailUrl?: string; failureSummary?: string };

type BatchPreviewSlot = {
  index: number;
  task?: TaskInfo;
};

/** 活跃任务前台轮询间隔，保证进度足够及时且不把后端打满。 */
const ACTIVE_POLL_MS = 2500;

/** 活跃任务在页面隐藏时降频轮询，减少后台标签页造成的请求压力。 */
const HIDDEN_ACTIVE_POLL_MS = 10000;

/** 任务暂不可见或接口异常时的重试间隔，避免刷新风暴。 */
const RETRY_POLL_MS = 10000;

function getRecent(): string[] { try { return JSON.parse(localStorage.getItem('aiimage_recent_tasks') ?? '[]').slice(0, 10); } catch { return []; } }

/** 读取当前生成页正在预览的一组任务；多图批次必须保留同批任务边界，不能混入历史任务。 */
function getActivePreviewTaskIds(): string[] {
  try {
    const active = JSON.parse(localStorage.getItem('aiimage_active_preview_tasks') ?? '[]') as unknown;
    if (Array.isArray(active)) {
      const ids = active.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 20);
      if (ids.length > 0) return ids;
    }
  } catch { /* 历史本地缓存损坏时回退最近任务。 */ }
  return getRecent().slice(0, 1);
}

export function addRecentTask(id: string) {
  addRecentTasks([id]);
}

/** 批量写入最近任务；多图提交时保持返回顺序，让第 1 张作为默认预览。 */
export function addRecentTasks(ids: string[]) {
  const cleanIds = ids.filter((id, index) => id && ids.indexOf(id) === index);
  if (cleanIds.length === 0) return;
  const t = [...cleanIds, ...getRecent().filter((x: string) => !cleanIds.includes(x))].slice(0, 10);
  localStorage.setItem('aiimage_recent_tasks', JSON.stringify(t));
  // 当前预览只跟踪本次提交的一组任务，避免多图批次预览被更早的历史任务污染。
  localStorage.setItem('aiimage_active_preview_tasks', JSON.stringify(cleanIds));
  window.dispatchEvent(new CustomEvent('aiimage:task-added', { detail: { taskId: cleanIds[0], taskIds: cleanIds } }));
}

function statusText(s: string) {
  switch (s) {
    case 'success': return '已完成';
    case 'failed': return '失败';
    case 'running': return '生成中';
    case 'finalizing': return '收尾中';
    default: return '等待中';
  }
}

function statusTone(s: string) {
  if (s === 'success') return 'is-success';
  if (s === 'failed') return 'is-error';
  if (s === 'running' || s === 'finalizing') return 'is-active';
  return 'is-muted';
}

/** 前端只用真实配置渲染点位数量；历史任务缺字段时用已出现尝试数兜底。 */
function getMaxAttemptDots(task: TaskInfo, attempts: GenerationSubTaskView[]) {
  const configured = typeof task.maxAttempts === 'number' && Number.isFinite(task.maxAttempts)
    ? Math.trunc(task.maxAttempts)
    : 0;
  return Math.min(Math.max(configured || attempts.length || 1, 1), 10);
}

/** 过滤 Worker 抢占占位记录，避免内部 running/queued 节点影响用户看到的尝试进度。 */
function getVisibleAttempts(task?: TaskInfo | null) {
  const rawAttempts = (task?.subTasks ?? []).filter((item) => {
    if (item.kind !== 'upstream_attempt') return false;
    const covered = item.status === 'skipped' && (item.error?.includes('覆盖') || item.error?.includes('covered') || item.error?.includes('新尝试'));
    return !covered;
  });
  return collapseAttemptsByAttemptNo(rawAttempts);
}

/** 同一次 attemptNo 可能先有运行占位再有终态结果；点位必须展示该尝试最终状态。 */
function collapseAttemptsByAttemptNo(attempts: GenerationSubTaskView[]) {
  const grouped = new Map<number, GenerationSubTaskView>();
  attempts.forEach((attempt, index) => {
    const key = attempt.attemptNo ?? index + 1;
    const current = grouped.get(key);
    grouped.set(key, pickAttemptDotSource(current, attempt));
  });
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, attempt]) => attempt);
}

/** 同一尝试序号内，成功/失败结果优先于运行态；否则保留最新的运行态。 */
function pickAttemptDotSource(current: GenerationSubTaskView | undefined, next: GenerationSubTaskView) {
  if (!current) return next;
  if (isTerminalAttempt(next.status) && !isTerminalAttempt(current.status)) return next;
  if (isTerminalAttempt(next.status) && isTerminalAttempt(current.status)) return next;
  if (!isTerminalAttempt(next.status) && !isTerminalAttempt(current.status)) return next;
  return current;
}

/** 判断一次上游尝试是否已有最终结果。 */
function isTerminalAttempt(status: string) {
  return status === 'success' || status === 'failed';
}

/** 将一次尝试映射到预览点位颜色，未开始、进行中、失败、成功分别独立表达。 */
function getAttemptDotTone(attempt?: GenerationSubTaskView) {
  if (!attempt) return 'is-pending';
  if (attempt.status === 'success') return 'is-success';
  if (attempt.status === 'failed') return 'is-failed';
  if (attempt.status === 'running' || attempt.status === 'queued') return 'is-running';
  return 'is-pending';
}

/** 按真实任务时间计算耗时；运行中使用当前时间实时刷新，终态使用完成时间固定展示。 */
function getElapsedMs(task: TaskInfo, nowMs: number) {
  const startMs = parseTaskTime(task.startedAt) ?? parseTaskTime(task.createdAt);
  if (!startMs) return undefined;
  const active = task.status === 'running' || task.status === 'queued' || task.status === 'finalizing';
  const endMs = active ? nowMs : parseTaskTime(task.finishedAt) ?? parseTaskTime(task.updatedAt) ?? nowMs;
  return Math.max(0, endMs - startMs);
}

/** 解析后端统一返回的 ISO 时间，失败时返回 undefined 避免展示错误耗时。 */
function parseTaskTime(value?: string) {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 将毫秒格式化为紧凑中文耗时，预览区域只保留必要信息。 */
function formatElapsed(ms?: number) {
  if (ms === undefined) return '耗时 -';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `耗时 ${seconds}s`;
  return `耗时 ${minutes}m ${seconds}s`;
}

/** 失败预览只展示简短原因，避免把每个站点的排障报错堆进预览窗口。 */
function getFailureSummary(task: TaskInfo) {
  return task.failureSummary?.trim() || task.error?.trim() || '生成失败，请调整提示词或参考图后重试';
}

type TaskPanelProps = {
  embedded?: boolean;
  /** 成功生成图片后，把当前结果加入生成页参考图列表。 */
  onAddReference?: (image: { url: string; filename?: string; name?: string }) => boolean | Promise<boolean> | void;
};

export function TaskPanel({ embedded, onAddReference }: TaskPanelProps) {
  const { show } = useToast();
  const modelDisplayMap = useDrawingModelDisplayMap();
  const [taskIds, setTaskIds] = useState<string[]>(getActivePreviewTaskIds);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [addingReference, setAddingReference] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const prevStatus = useRef<string>('');
  /** 记录已经自动切换过的成功图，避免每次轮询都打断用户手动切换。 */
  const readyImageTaskIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handler = (event: Event) => {
      const taskIdsFromEvent = (event as CustomEvent<{ taskIds?: string[] }>).detail?.taskIds;
      const nextIds = Array.isArray(taskIdsFromEvent) && taskIdsFromEvent.length > 0 ? taskIdsFromEvent : getActivePreviewTaskIds();
      readyImageTaskIdsRef.current = new Set();
      setSelectedIndex(0);
      setTasks([]);
      setTaskIds(nextIds);
    };
    window.addEventListener('aiimage:task-added', handler);
    return () => window.removeEventListener('aiimage:task-added', handler);
  }, []);

  useEffect(() => {
    if (taskIds.length === 0 || !localStorage.getItem('token')) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const currentTaskIds = taskIds.slice(0, 20);
    prevStatus.current = '';

    /** 安排下一次预览轮询，串行执行避免同一任务请求堆积。 */
    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      timer = setTimeout(poll, delayMs);
    };

    const poll = async () => {
      const d = await api<{ tasks: TaskInfo[] }>(`/api/generations/tasks?ids=${encodeURIComponent(currentTaskIds.join(','))}`);
      if (cancelled) return;
      if (d.ok && d.data?.tasks?.length) {
        const taskMap = new Map(d.data.tasks.map(item => [item.id, item]));
        const orderedTasks = currentTaskIds.map(id => taskMap.get(id)).filter((item): item is TaskInfo => Boolean(item));
        const visibleTasks = orderedTasks.length > 0
          ? orderedTasks
          : currentTaskIds.length === 1 && d.data.tasks.some((item) => item.batchId === currentTaskIds[0])
            ? d.data.tasks
            : d.data.tasks;
        if (visibleTasks.length === 0) {
          scheduleNext(RETRY_POLL_MS);
          return;
        }
        setTasks(visibleTasks);
        setTaskIds(visibleTasks.map((item) => item.id));
        setSelectedIndex(index => Math.min(Math.max(index, 0), visibleTasks.length - 1));
        const newlyReady = visibleTasks
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.status === 'success' && Boolean(item.imageUrl || item.thumbnailUrl || item.videoUrl) && !readyImageTaskIdsRef.current.has(item.id));
        if (newlyReady.length > 0) {
          newlyReady.forEach(({ item }) => readyImageTaskIdsRef.current.add(item.id));
          // 多图生成时按返回顺序自动切到最新出图的任务，只显示一张图。
          setSelectedIndex(newlyReady[newlyReady.length - 1]!.index);
        }
        const selectedTask = visibleTasks[Math.min(selectedIndex, visibleTasks.length - 1)] ?? visibleTasks[0];
        if (selectedTask) {
          if (prevStatus.current && prevStatus.current !== selectedTask.status) {
            prevStatus.current = selectedTask.status;
          }
          if (!prevStatus.current) prevStatus.current = selectedTask.status;
        }
        const active = visibleTasks.some(item => item.status === 'running' || item.status === 'queued' || item.status === 'finalizing');
        // 同批任务全部终态后停止常驻轮询，避免多个打开页面持续压测后端。
        if (!active) return;
        scheduleNext(document.visibilityState === 'hidden' ? HIDDEN_ACTIVE_POLL_MS : ACTIVE_POLL_MS);
        return;
      }
      // 接口异常或任务暂不可见时放慢重试，防止刷新风暴。
      scheduleNext(RETRY_POLL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskIds, selectedIndex]);

  const task = tasks[selectedIndex] ?? tasks[0] ?? null;
  const hasMultipleTasks = tasks.length > 1;

  /** 切换当前预览任务；只改变前端可见图，不改变任务状态或后端数据。 */
  const switchPreviewTask = (offset: number) => {
    if (tasks.length <= 1) return;
    setSelectedIndex(index => (index + offset + tasks.length) % tasks.length);
  };

  useEffect(() => {
    const active = task?.status === 'queued' || task?.status === 'running' || task?.status === 'finalizing';
    if (!active) {
      setNowMs(Date.now());
      return;
    }
    // 运行中耗时秒级刷新；轮询仍按原间隔走，避免为了计时增加后端压力。
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [task?.status, task?.id]);

  if (!task) return (
    <div className="task-panel-card card task-preview-card task-preview-empty" style={{ width: 'clamp(280px, 35vw, 420px)', aspectRatio: '1' }}>
      <div className="task-preview-empty-inner">
        <Image size={30} />
        <span>提交后在此预览</span>
        <small>任务进度和结果会自动刷新</small>
      </div>
    </div>
  );

  const isDone = task.status === 'success' || task.status === 'failed';
  const imgSrc = task.imageUrl || task.thumbnailUrl;
  const videoSrc = task.videoUrl;
  const glassBgSrc = task.thumbnailUrl || task.imageUrl;
  const downloadSrc = task.videoUrl || task.imageUrl || task.thumbnailUrl;
  const attempts = getVisibleAttempts(task);
  const lastAttempt = attempts[attempts.length - 1];
  const maxAttemptDots = getMaxAttemptDots(task, attempts);
  const elapsedText = formatElapsed(getElapsedMs(task, nowMs));
  const displayTaskId = task.batchId && (task.batchTotal ?? 1) > 1 ? task.batchId : task.taskId ?? task.id ?? '';
  /** 操作仍必须落到真实单图任务上，批次外显 ID 只用于展示和记录。 */
  const actionTaskId = task.taskId ?? task.id ?? '';
  const visibleTaskId = getVisibleTaskId(task);
  const canRetry = Boolean(actionTaskId) && isDone;
  const canDownload = task.status === 'success' && Boolean(downloadSrc);
  const canAddReference = task.status === 'success' && Boolean(imgSrc) && !videoSrc && Boolean(onAddReference);
  const batchTotal = Math.max(
    taskIds.length,
    tasks.length,
    ...tasks.map(item => Number.isFinite(item.batchTotal ?? 0) ? Number(item.batchTotal) : 0),
  );
  // 多图批次必须展示每一张图的真实槽位，避免用户误以为只提交了一张。
  const batchSlots = hasMultipleTasks ? buildBatchPreviewSlots(tasks, batchTotal) : [];
  const batchDoneCount = hasMultipleTasks ? tasks.filter(item => item.status === 'success' || item.status === 'failed').length : 0;
  const batchSuccessCount = hasMultipleTasks ? tasks.filter(item => item.status === 'success' && Boolean(item.imageUrl || item.thumbnailUrl)).length : 0;
  const batchFailedCount = hasMultipleTasks ? tasks.filter(item => item.status === 'failed').length : 0;
  const lightboxEntries = tasks
    .map((item) => {
      const imageUrl = item.imageUrl || item.thumbnailUrl;
      if (item.status !== 'success' || !imageUrl) return null;
      return { task: item, imageUrl };
    })
    .filter((item): item is { task: TaskInfo; imageUrl: string } => Boolean(item));
  const selectedLightboxIndex = Math.max(0, lightboxEntries.findIndex(item => item.task.id === task.id));
  const lightboxImages: ImageLightboxItem[] = lightboxEntries.map(({ task: item, imageUrl }) => ({
    src: resolveMediaUrl(imageUrl),
    title: hasMultipleTasks ? `生成图 ${getTaskBatchPosition(item, 1)}/${batchTotal}` : '生成图片',
    downloadName: buildDownloadFilename(item.taskId ?? item.id, imageUrl),
    alt: item.prompt || '生成图片',
  }));

  /** Web 复投只把历史任务作为参数来源，新任务仍由后端重新扣费和调度。 */
  const retryTask = async () => {
    if (!actionTaskId || retrying) return;
    setRetrying(true);
    const d = await api<{ task: { id: string; status: string }; sourceTaskId: string }>('/api/generate/retry', {
      method: 'POST',
      body: JSON.stringify({ taskId: actionTaskId }),
    });
    if (d.ok && d.data?.task?.id) {
      show('重试任务已提交', 'success');
      addRecentTask(d.data.task.id);
      setTasks([d.data.task as TaskInfo]);
      setSelectedIndex(0);
    } else {
      show(d.message ?? '重试提交失败', 'error');
    }
    setRetrying(false);
  };

  /** 下载当前任务生成媒体；优先走 fetch 保存 blob，失败时回退到新窗口打开真实地址。 */
  const downloadImage = async () => {
    if (!downloadSrc || downloading) return;
    const url = resolveMediaUrl(downloadSrc);
    const filename = buildDownloadFilename(actionTaskId || displayTaskId, downloadSrc);
    setDownloading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`媒体下载失败：${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      triggerDownload(objectUrl, filename);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
      show('已打开生成结果，请在浏览器中保存', 'info');
    } finally {
      setDownloading(false);
    }
  };

  /** 将已生成图片回填到左侧参考图，不重新扣费、不重新创建任务。 */
  const addToReference = async () => {
    if (!downloadSrc || !onAddReference || addingReference) return;
    setAddingReference(true);
    try {
      await onAddReference({
        url: downloadSrc,
        filename: extractMediaFilename(downloadSrc),
        name: buildDownloadFilename(actionTaskId || displayTaskId, downloadSrc),
      });
    } finally {
      setAddingReference(false);
    }
  };

  return (
    <div
      className={`task-panel-card card task-preview-card ${hasMultipleTasks ? 'is-batch' : ''} ${statusTone(task.status)}`}
      style={{
        width: hasMultipleTasks ? 'clamp(320px, 42vw, 520px)' : 'clamp(280px, 35vw, 420px)',
        aspectRatio: hasMultipleTasks || videoSrc ? undefined : '1',
        padding: 0,
      }}
    >
      <div className="task-preview-header">
        <div className="task-preview-dots" aria-hidden="true">
          {Array.from({ length: maxAttemptDots }, (_, index) => (
            <span key={index} className={getAttemptDotTone(attempts[index])} />
          ))}
        </div>
        <div className={`task-preview-title ${hasMultipleTasks ? 'has-switcher' : ''}`}>
          {hasMultipleTasks && (
            <button type="button" className="task-preview-switch-button" onClick={() => switchPreviewTask(-1)} aria-label="上一张生成预览" title="上一张">
              <ChevronLeft size={14} />
            </button>
          )}
          <span>{visibleTaskId.slice(0, 22) || '任务预览'}</span>
          {hasMultipleTasks && <em>{selectedIndex + 1}/{tasks.length}</em>}
          {hasMultipleTasks && (
            <button type="button" className="task-preview-switch-button" onClick={() => switchPreviewTask(1)} aria-label="下一张生成预览" title="下一张">
              <ChevronRight size={14} />
            </button>
          )}
        </div>
        <span className={`task-preview-status ${statusTone(task.status)}`}>{statusText(task.status)}</span>
      </div>

      {hasMultipleTasks && (
        <div className="task-preview-batch-summary" aria-label="多图生成批次进度">
          <span>本批次 {batchTotal} 张</span>
          <strong>{batchDoneCount}/{batchTotal} 完成</strong>
          <em>{batchSuccessCount} 成功 · {batchFailedCount} 失败</em>
        </div>
      )}

      <div className="task-preview-body">
        {task.status === 'success' && videoSrc ? (
          <div className="task-preview-video-wrap">
            <video className="task-preview-video" src={resolvePlayableVideoUrl(videoSrc)} controls playsInline preload="metadata">
              当前浏览器不支持视频播放。
            </video>
            <div className="task-preview-video-meta">
              <Video size={14} />
              <span>{task.resolution ?? '视频'}{task.duration ? ` · ${task.duration} 秒` : ''}{task.aspectRatio ? ` · ${task.aspectRatio}` : ''}</span>
            </div>
          </div>
        ) : task.status === 'success' && imgSrc ? (
          <button
            type="button"
            onClick={() => { setLightboxIndex(selectedLightboxIndex); setLightboxOpen(true); }}
            className="task-preview-image-button"
            aria-label="打开预览图片"
            title="点击打开大图预览"
          >
            <img className="task-preview-glass-bg" src={resolveMediaUrl(glassBgSrc)} alt="" aria-hidden="true" loading="eager" decoding="async" fetchPriority="high" />
            <div className="task-preview-glass-layer" aria-hidden="true" />
            <img className="task-preview-image" src={resolveMediaUrl(imgSrc)} alt={task.prompt} loading="eager" decoding="async" fetchPriority="high" />
          </button>
        ) : (task.status === 'running' || task.status === 'finalizing') ? (
          <div className="task-preview-progress">
            <div className="task-preview-progress-ring">
              <Loader2 size={28} className="animate-spin" />
            </div>
            <div className="task-preview-progress-copy">
              <div>正在生成…</div>
              <p>
                <span>{elapsedText}</span>
                {lastAttempt?.model && <span> · {formatDrawingModelNameByMap(lastAttempt.model, modelDisplayMap)}</span>}
              </p>
            </div>
            <div className="task-preview-progress-rail" aria-hidden="true">
              <span />
            </div>
            <div className="task-preview-attempt-counter">
              第 {Math.min(attempts.length || 1, maxAttemptDots)} / {maxAttemptDots} 次尝试
            </div>
          </div>
        ) : task.status === 'failed' ? (
          <div className="task-preview-failed">
            <AlertTriangle size={30} />
            <div>生成失败</div>
            <p>{getFailureSummary(task)}</p>
            <span className="task-preview-elapsed">{elapsedText}</span>
            <div className="task-preview-attempt-counter">
              已尝试 {Math.min(attempts.length, maxAttemptDots)} / {maxAttemptDots} 次
            </div>
          </div>
        ) : (
          <div className="task-preview-empty-inner">
            <Image size={28} />
            <span>等待中…</span>
          </div>
        )}
      </div>

      {hasMultipleTasks && (
        <div className="task-preview-batch-strip" aria-label="多图生成预览列表">
          {batchSlots.map((slot) => {
            const slotTask = slot.task;
            const slotImage = slotTask?.thumbnailUrl || slotTask?.imageUrl;
            const isSelected = Boolean(slotTask && slotTask.id === task.id);
            return (
              <button
                key={slot.task?.id ?? `slot-${slot.index}`}
                type="button"
                className={`task-preview-batch-thumb ${isSelected ? 'is-selected' : ''} ${getBatchSlotTone(slotTask)}`}
                onClick={() => {
                  if (!slotTask) return;
                  const nextIndex = tasks.findIndex(item => item.id === slotTask.id);
                  if (nextIndex >= 0) setSelectedIndex(nextIndex);
                }}
                disabled={!slotTask}
                aria-label={`查看第 ${slot.index} 张生成预览`}
                title={`第 ${slot.index} 张 · ${slotTask ? statusText(slotTask.status) : '等待释放'}`}
              >
                {slotImage ? (
                  <img src={resolveMediaUrl(slotImage)} alt="" loading="lazy" decoding="async" />
                ) : slotTask?.status === 'failed' ? (
                  <AlertTriangle size={16} />
                ) : slotTask?.status === 'running' || slotTask?.status === 'finalizing' ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Image size={16} />
                )}
                <span>{slot.index}</span>
              </button>
            );
          })}
        </div>
      )}

      {(canAddReference || canRetry || canDownload) && (
        <div className="task-preview-action-row">
          {canAddReference && (
            <button
              type="button"
              className="task-preview-action-button is-reference"
              onClick={addToReference}
              disabled={addingReference}
              aria-label="添加到参考图"
              title="添加到参考图"
            >
              {addingReference ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              <span>{addingReference ? '添加中' : '加参考'}</span>
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              className="task-preview-action-button is-retry"
              onClick={retryTask}
              disabled={retrying}
              aria-label="重试此任务"
              title="重试此任务"
            >
              {retrying ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
              <span>{retrying ? '提交中' : '重试'}</span>
            </button>
          )}
          {canDownload && (
            <button
              type="button"
              className="task-preview-action-button is-download"
              onClick={downloadImage}
              disabled={downloading}
              aria-label="下载生成结果"
              title="下载生成结果"
            >
              {downloading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
              <span>{downloading ? '下载中' : '下载'}</span>
            </button>
          )}
        </div>
      )}

      <div className="task-preview-footer">
        <span>{MODE_LABEL(task.status)}</span>
        <strong>{task.prompt?.slice(0, 42) || '未提供提示词'}</strong>
      </div>

      <ImageLightbox
        open={lightboxOpen}
        images={lightboxImages}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}

/** 构造多图批次预览槽位：优先使用 batchIndex，缺失时按接口返回顺序兜底。 */
function buildBatchPreviewSlots(tasks: TaskInfo[], total: number): BatchPreviewSlot[] {
  const length = Math.max(1, total, tasks.length);
  const slots: BatchPreviewSlot[] = Array.from({ length }, (_, index) => ({ index: index + 1 }));
  tasks.forEach((task, index) => {
    const position = Math.min(length, getTaskBatchPosition(task, index + 1));
    slots[position - 1] = { index: position, task };
  });
  return slots;
}

/** 读取任务在批次中的位置；历史任务没有 batchIndex 时保持可读的顺序编号。 */
function getTaskBatchPosition(task: TaskInfo, fallback: number) {
  const value = typeof task.batchIndex === 'number' && Number.isFinite(task.batchIndex) ? Math.trunc(task.batchIndex) : fallback;
  return Math.max(1, value);
}

/** 多图缩略图槽位色调用于快速区分成功、失败、进行中和等待释放。 */
function getBatchSlotTone(task?: TaskInfo) {
  if (!task) return 'is-muted';
  if (task.status === 'success') return 'is-success';
  if (task.status === 'failed') return 'is-error';
  if (task.status === 'running' || task.status === 'finalizing') return 'is-active';
  return 'is-muted';
}

/** 外显任务 ID 统一使用批次 ID；内部重试、下载和轮询仍使用真实单图任务 ID。 */
function getVisibleTaskId(task: TaskInfo) {
  return task.batchId && (task.batchTotal ?? 1) > 1 ? task.batchId : task.taskId ?? task.id ?? '';
}

/** 从任务和图片地址推导稳定文件名，避免下载文件变成无意义的接口路径。 */
function buildDownloadFilename(taskId: string, imageUrl: string) {
  const cleanTaskId = (taskId || 'generated').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const path = imageUrl.split('?')[0] ?? '';
  const extMatch = path.match(/\.(png|jpe?g|webp|gif|mp4)$/i);
  return `${cleanTaskId}${extMatch?.[0] ?? '.png'}`;
}

/** 触发浏览器下载；调用方负责传入 blob URL 或同源图片 URL。 */
function triggerDownload(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 从图片地址中提取后端媒体短文件名；失败时让调用方仅使用 URL 兜底。 */
function extractMediaFilename(url: string) {
  const clean = String(url).split('?')[0] ?? '';
  const match = clean.match(/\/images\/([^/?#]+)$/);
  if (match?.[1]) return decodeURIComponent(match[1]);
  const last = clean.split('/').filter(Boolean).pop() ?? '';
  return /\.(png|jpe?g|webp|gif)$/i.test(last) ? decodeURIComponent(last) : undefined;
}

function MODE_LABEL(status: string) {
  if (status === 'success') return '结果已就绪';
  if (status === 'failed') return '需要重试或调整提示词';
  if (status === 'finalizing') return '正在保存结果';
  if (status === 'running') return '上游处理中';
  return '等待调度';
}
