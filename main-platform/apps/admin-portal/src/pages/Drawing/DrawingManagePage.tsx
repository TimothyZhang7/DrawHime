/** 绘图任务管理 — 任务列表 + 详情弹窗 + 配置 (Tailwind) */
/** 本文件实现管理后台绘图任务列表、任务详情时间线、参考图预览和绘图运行配置管理页面。 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { RotateCw, Zap, Hash, AlertCircle, CheckCircle, XCircle, Loader, Settings, SlidersHorizontal, Video, Copy } from 'lucide-react';
import { api } from '../../api/client';
import { useAdminRuntimeConfig } from '../../app/runtime-config';
import Toast from '../../components/Toast';
import { ModelSettingsPanel, type ModelSettingRow } from './DrawingModelSettingsPanel';
import { ConfigForm } from '../../components/ConfigForm';

const DRAWING_CONFIG_FIELDS = [
  { name: 'siteRequestRetries', key: 'drawing_site_request_retries', type: 'number' as const, label: '同站重试', defaultValue: '1', min: 0, max: 5,
    desc: '同一站点网络/超时错误的重试次数。0=不重试，1=失败后再试1次。独立于换站次数。',
  },
  { name: 'retryScope', key: 'drawing_retry_scope', type: 'select' as const, label: '重试范围', defaultValue: 'all_enabled', options: [{ value: 'all_enabled', label: '全部站点' }, { value: 'single_site', label: '单站点' }],
    desc: '全部站点=换站重试；单站点=固定当前站点，不切换。',
  },
  { name: 'siteSelectionMode', key: 'drawing_site_selection_mode', type: 'select' as const, label: '站点选择', defaultValue: 'random', options: [{ value: 'random', label: '随机均衡' }, { value: 'weighted', label: '权重兼容' }],
    desc: '随机均衡=按权重随机并用短窗口拉平分配；权重兼容同样启用均衡，保留旧配置值。',
  },
  { name: 'requestTimeout', key: 'drawing_request_timeout_ms', type: 'number' as const, label: '超时兜底(秒)', defaultValue: '30000', min: 1, max: 9999999, step: 1,
    desc: '仅当站点超时未配置或非法时使用；正常请求以 API 站点中的超时秒数为准。',
    display: (v: string) => String(Math.round(Number(v) / 1000)),
    save: (v: string) => String(Number(v) * 1000),
  },
  { name: 'siteRequestDelay', key: 'drawing_site_request_delay_ms', type: 'number' as const, label: '同站重试间隔(ms)', defaultValue: '2000', min: 0, max: 30000, step: 100,
    desc: '同一站点请求级重试之间等待多久，避免过快重打上游。',
  },
  { name: 'dispatchBackoff', key: 'drawing_dispatch_backoff_ms', type: 'number' as const, label: '投递重试间隔(ms)', defaultValue: '500', min: 0, max: 10000, step: 100,
    desc: 'backend 投递 drawing-service 失败后的短退避时间。',
  },
  { name: 'autoDisableThreshold', key: 'drawing_auto_disable_threshold', type: 'number' as const, label: '自动禁用阈值(次)', defaultValue: '5', min: 0, max: 999,
    desc: '连续失败 N 次后自动禁用。设为 0 永久不禁用。',
  },
  { name: 'autoDisableMinutes', key: 'drawing_auto_disable_minutes', type: 'number' as const, label: '自动禁用冷却(分钟)', defaultValue: '60', min: 1, max: 1440,
    desc: '自动禁用后等待多久重新启用。',
  },
  { name: 'retryIgnoreErrors', key: 'drawing_retry_ignore_errors', type: 'toggle' as const, label: '忽略错误重试',
    desc: '开启后即使错误不可重试也继续换站尝试。',
  },
  { name: 'retryNotifyEnabled', key: 'drawing_retry_notify_enabled', type: 'toggle' as const, label: '重试通知卡片', defaultValue: 'true',
    desc: '开启后每次换站重试都会发送通知卡片。关闭后仅返回最终结果。',
  },
  { name: 'botSubmittedRefsEnabled', key: 'drawing_bot_submitted_refs_enabled', type: 'toggle' as const, label: '提交卡参考图', defaultValue: 'true',
    desc: '开启后 Bot 提交卡展示参考图；关闭后只显示数量，可提升图片菜单渲染速度。',
  },
  { name: 'botFailedRefsEnabled', key: 'drawing_bot_failed_refs_enabled', type: 'toggle' as const, label: '失败卡参考图', defaultValue: 'true',
    desc: '开启后 Bot 最终失败卡展示参考图；关闭后失败通知更快返回。',
  },
  { name: 'defaultSize', key: 'drawing_default_size', type: 'select' as const, label: '默认尺寸', defaultValue: 'auto', options: [{ value: 'auto', label: '自动' }, { value: '1024x1024', label: '1K (1024×1024)' }, { value: '1792x1024', label: '2K (1792×1024)' }, { value: '1024x1792', label: '2K (1024×1792)' }] },
  { name: 'defaultQuality', key: 'drawing_default_quality', type: 'select' as const, label: '默认质量', defaultValue: 'auto', options: [{ value: 'auto', label: '自动' }, { value: 'standard', label: '标准' }, { value: 'hd', label: '高清' }] },
  { name: 'defaultModeration', key: 'drawing_default_moderation', type: 'select' as const, label: '默认审核', defaultValue: 'auto', options: [{ value: 'auto', label: '自动' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }] },
  { name: 'cooldown', key: 'drawing_cooldown_seconds', type: 'number' as const, label: '冷却时间(秒)', defaultValue: '90', min: 0, max: 600 },
  { name: 'maxPrompt', key: 'drawing_max_prompt_length', type: 'number' as const, label: '最大提示词长度', defaultValue: '5000', min: 100, max: 50000 },
  { name: 'blockDuring', key: 'drawing_block_during_generation', type: 'toggle' as const, label: '生成中阻塞', defaultValue: 'true' },
  { name: 'multiEnabled', key: 'drawing_multi_enabled', type: 'toggle' as const, label: '一次多图', defaultValue: 'true',
    desc: '开启后 Web 和 QQ 可一次提交多张，后端按批次并发调度。',
  },
  { name: 'multiCountMax', key: 'drawing_multi_count_max', type: 'number' as const, label: '多图上限', defaultValue: '4', min: 1, max: 20,
    desc: '单次提交最多生成多少张。',
  },
  { name: 'multiConcurrency', key: 'drawing_multi_concurrency', type: 'number' as const, label: '多图并发', defaultValue: '2', min: 1, max: 20,
    desc: '同一批次同时释放到 Worker 的任务数，仍受站点并发限制。',
  },
  { name: 'multiStopFailures', key: 'drawing_multi_stop_after_consecutive_failures', type: 'number' as const, label: '连续失败停止', defaultValue: '2', min: 1, max: 20,
    desc: '同一批次连续失败达到该次数后停止未开始任务并退款。',
  },
  { name: 'freeBalanceDaily', key: 'free_balance_daily', type: 'number' as const, label: '每日免费余额总额(元)', defaultValue: '1.2', min: 0, max: 1000, step: 0.01 },
];

const MEDIA_BASE: string = import.meta.env.VITE_API_BASE ?? '';

interface TaskItem {
  id: string; clientRequestId: string; status: string; prompt: string;
  mode: string; batchId?: string | null; batchTotal?: number | null; batchCount?: number; model?: string; siteName?: string; error?: string;
  qqNumber?: string; userId?: number; source?: string; isPrivate?: boolean;
  batchIndex?: number | null;
  sourceImageUrls?: string[]; templateId?: string | null;
  attempts?: number; failedCount?: number;
  createdAt: string; startedAt?: string; finishedAt?: string;
  subTasks?: SubtaskItem[];
  imageUrl?: string; thumbnailUrl?: string; videoUrl?: string; mediaType?: 'image' | 'video';
  duration?: number; resolution?: string; aspectRatio?: string;
  /** 列表接口返回的聚合字段 */
  sitesUsed?: string[];
  /** 详情接口在批次场景下会返回整批真实任务。 */
  tasks?: TaskItem[];
  /** 详情接口返回的代表性任务 ID。 */
  taskId?: string;
  /** backend 合并任务表和调度快照后返回的完整规范化请求参数。 */
  requestParams?: TaskRequestParams;
}

/** 管理后台任务详情展示和复制的完整请求参数。 */
interface TaskRequestParams {
  taskId: string;
  clientRequestId: string;
  /** 按任务身份生成且不含明文用户标识的渠道亲和键。 */
  promptCacheKey: string;
  batchId: string | null;
  source: string;
  mode: string;
  prompt: string;
  templateId: number | null;
  sourceImageUrls: string[];
  sourceImageSizes: number[] | null;
  isPrivate: boolean;
  count: number;
  model: string | null;
  size: string;
  aspectRatio: string | null;
  quality: string;
  duration: number | null;
  resolution: string | null;
  storyboardDesign: boolean;
  maxAttempts: number;
  /** 最近一次可确定性还原的脱敏上游 HTTP 请求。 */
  upstreamRequest: {
    attemptNo: number;
    siteId: number;
    siteName: string;
    model: string;
    apiMode: string;
    method: 'POST';
    url: string;
    contentType: string;
    timeoutMs: number;
    body: Record<string, unknown>;
  } | null;
}

interface SubtaskItem {
  id?: string; sequence: number; kind: string; status: string;
  attemptNo?: number; siteName?: string; model?: string;
  latencyMs?: number; error?: string; rawError?: string;
  retryable?: boolean; nextAction?: string;
  startedAt?: string; finishedAt?: string; createdAt?: string;
}

/** 管理后台展示模型名时优先使用外显名，其次使用第一个输入别名。 */
function formatModelDisplayName(row?: ModelSettingRow | null): string {
  if (!row) return '';
  const label = row.label?.trim();
  if (label) return label;
  const alias = row.aliases?.find((item) => item.trim())?.trim();
  return alias || row.name;
}

/** 构建后台任务展示用的模型 ID 映射，避免列表和详情直接暴露真实上游模型名。 */
function buildModelDisplayMap(rows: ModelSettingRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const displayName = formatModelDisplayName(row);
    map.set(row.name, displayName);
    for (const requestName of row.requestModelNames ?? []) map.set(requestName, displayName);
  }
  return map;
}

/** 按主模型名或等价请求模型名读取外显名；空值返回空串。 */
function formatModelNameByMap(modelName: string | null | undefined, displayMap: Map<string, string>): string {
  const normalized = modelName?.trim();
  if (!normalized) return '';
  return displayMap.get(normalized) || normalized;
}

/** 格式化用斜杠拼接的模型列表，逐个替换成外显名。 */
function formatModelListByMap(value: string | null | undefined, displayMap: Map<string, string>): string {
  const normalized = value?.trim();
  if (!normalized) return '';
  return normalized.split(' / ').map((item) => formatModelNameByMap(item, displayMap)).join(' / ');
}

/** 管理后台任务详情响应；批次场景会返回整批真实任务。 */
interface TaskDetailPayload extends TaskItem {
  tasks?: TaskItem[];
  images?: Array<{ id: string; batchIndex?: number | null; batchTotal?: number | null; imageUrl?: string | null; thumbnailUrl?: string | null; videoUrl?: string | null; mediaType?: 'image' | 'video' | null; status?: string }>;
}

/** 任务详情批次摘要。 */
function buildBatchSummary(tasks: TaskItem[]) {
  return {
    total: tasks.length,
    successCount: tasks.filter((item) => item.status === 'success').length,
    failedCount: tasks.filter((item) => item.status === 'failed').length,
    activeCount: tasks.filter((item) => item.status === 'queued' || item.status === 'running' || item.status === 'finalizing').length,
  };
}

/** 任务详情选项卡按批次序号排序，未提供序号时按创建时间兜底。 */
function sortDetailTasks(tasks: TaskItem[]) {
  return [...tasks].sort((left, right) => {
    const leftIndex = left.batchIndex ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = right.batchIndex ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

/** 任务详情默认选中最新成功图，否则取第一项。 */
function pickDetailTaskId(tasks: TaskItem[]) {
  return [...tasks].reverse().find((item) => item.status === 'success' && (item.imageUrl || item.thumbnailUrl || item.videoUrl))?.id ?? tasks[0]?.id ?? '';
}

function formatTime(iso?: string) { return iso ? iso.slice(11, 19) : '-'; }
function formatDate(iso?: string) { return iso ? iso.slice(0, 10) + ' ' + iso.slice(11, 19) : '-'; }
function fmtMs(ms?: number) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
function statusColor(s: string) {
  return s === 'success' ? 'bg-green-100 text-green-700' : s === 'failed' ? 'bg-red-100 text-red-600'
    : (s === 'running' || s === 'finalizing') ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-500';
}
function statusIcon(s: string) {
  return s === 'success' ? CheckCircle : s === 'failed' ? XCircle : (s === 'running' || s === 'finalizing') ? Loader : AlertCircle;
}
/** 判断字符串是否像图片文件名 */
function looksLikeImage(s?: string): boolean {
  if (!s) return false;
  return /\.(png|jpg|jpeg|gif|webp|bmp)(\?|$)/i.test(s);
}

/** 将后端返回的图片地址统一规范化为浏览器可访问地址，短文件名自动补 /images/ 前缀。 */
function toImageUrl(url: string): string {
  if (url.startsWith('http') || url.startsWith('data:')) return url;
  const normalized = url.startsWith('/') ? url : `/images/${url}`;
  return `${MEDIA_BASE}${normalized}`;
}

/** 管理后台视频追加稳定播放标识，绕过升级前已经缓存的无 Range 响应。 */
function toVideoUrl(url: string): string {
  const resolved = toImageUrl(url);
  return `${resolved}${resolved.includes('?') ? '&' : '?'}media=video-v2`;
}

/* ── 中文化映射 ── */
const KIND_LABELS: Record<string, string> = {
  request_received: '接收请求',
  prompt_assist: 'AI 提示增强',
  dispatch: '分发任务',
  upstream_attempt: '上游调用',
  same_site_retry: '同站重试',
  site_switch: '切换站点',
  image_saved: '图片保存',
  video_saved: '视频保存',
  result_ready: '结果就绪',
  result_delivered: '结果投递',
  finalize: '完成收尾',
};
const STATUS_LABELS: Record<string, string> = {
  success: '成功', failed: '失败', running: '运行中', finalizing: '收尾中', queued: '等待中', skipped: '已跳过',
};
const SOURCE_LABELS: Record<string, string> = {
  bot: 'Bot', web: '网页', api: 'API',
};
const MODE_LABELS: Record<string, string> = {
  'text-to-image': '文生图', 'image-to-image': '图生图', 'text-to-video': '文生视频', 'image-to-video': '参考图视频',
};
function cnKind(k?: string) { return (k && KIND_LABELS[k]) || k || '-'; }
function cnStatus(s?: string) { return (s && STATUS_LABELS[s]) || s || '-'; }
function cnSource(s?: string) { return (s && SOURCE_LABELS[s]) || s || '-'; }
function cnMode(m?: string) { return (m && MODE_LABELS[m]) || m || '-'; }

/** 判断上游尝试是否是 Worker 抢占任务时留下的占位记录。 */
function isPlaceholderAttempt(task: SubtaskItem, allSubtasks: SubtaskItem[]): boolean {
  if (task.kind !== 'upstream_attempt') return false;
  if (Boolean(task.error?.includes('覆盖')) && !task.siteName && !task.latencyMs) return true;
  if (task.status !== 'queued' && task.status !== 'running') return false;
  return allSubtasks.some((other) => (
    other.kind === 'upstream_attempt'
    && other.sequence > task.sequence
    && other.attemptNo === task.attemptNo
    && (other.status === 'success' || other.status === 'failed')
  ));
}

/** 后台统计只计算真实上游结果，避免把抢占占位记录算成一次额外尝试。 */
function getVisibleAttempts(subtasks: SubtaskItem[]): SubtaskItem[] {
  return subtasks.filter((task) => task.kind === 'upstream_attempt' && !isPlaceholderAttempt(task, subtasks));
}

/** 判断是否是切站/同站重试流转节点，用于终态任务展示兜底。 */
function isRetryTransition(task: SubtaskItem): boolean {
  return task.kind === 'site_switch' || task.kind === 'same_site_retry';
}

/** 判断是否是 worker 收尾追加的清理噪声节点，后台时间线默认隐藏。 */
function isTerminalCleanupNoise(task: SubtaskItem): boolean {
  return isRetryTransition(task)
    && task.status === 'skipped'
    && task.attemptNo === undefined
    && !task.siteName
    && !task.model
    && !task.latencyMs
    && Boolean(task.error?.includes('重试已终止'));
}

/** 后台详情只展示真实业务节点，避免占位和清理上报干扰排障判断。 */
function getVisibleSubtasks(subtasks: SubtaskItem[]): SubtaskItem[] {
  return subtasks.filter((task) => !isPlaceholderAttempt(task, subtasks) && !isTerminalCleanupNoise(task));
}

/** 历史任务若残留 running 切站节点，按后续真实尝试和主任务终态转换成可理解状态。 */
function getDisplaySubtaskStatus(task: SubtaskItem, taskStatus: string, allSubtasks: SubtaskItem[]): string {
  if (isRetryTransition(task) && task.status === 'running' && (taskStatus === 'success' || taskStatus === 'failed')) {
    const hasFollowingAttempt = task.attemptNo != null && allSubtasks.some((other) => (
      other.kind === 'upstream_attempt'
      && other.attemptNo === task.attemptNo
      && other.sequence > task.sequence
      && !isPlaceholderAttempt(other, allSubtasks)
    ));
    return hasFollowingAttempt ? 'success' : 'skipped';
  }
  return task.status;
}

/** 管理后台会话失效时给出明确提示，避免后台列表和详情继续反复空转。 */
function AuthExpiredBanner() {
  return (
    <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      管理后台登录已失效，请重新登录后再查看任务记录。
    </div>
  );
}

/** 任务状态标签，给列表和详情使用统一口径。 */
function TaskStatePill({ status }: { status: string }) {
  const StateIcon = statusIcon(status);
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${statusColor(status)}`}>
      <StateIcon size={12} />
      {cnStatus(status)}
    </span>
  );
}

export function DrawingManagePage() {
  const { pollIntervalSec } = useAdminRuntimeConfig();
  const [subTab, setSubTab] = useState<'tasks' | 'config' | 'models'>('tasks');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailTask, setDetailTask] = useState<TaskItem | null>(null);
  const [detailBatch, setDetailBatch] = useState<TaskDetailPayload | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [toast, setToast] = useState<{message:string;type:'success'|'error'}|null>(null);
  const [modelDisplayMap, setModelDisplayMap] = useState<Map<string, string>>(() => new Map());

  const loadModelDisplayMap = useCallback(async () => {
    const res = await api<{ models: ModelSettingRow[] }>('/admin/drawing/model-settings');
    if (res.ok && Array.isArray(res.data?.models)) {
      setModelDisplayMap(buildModelDisplayMap(res.data.models));
    }
  }, []);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setListError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: '15' });
    if (statusFilter) params.set('status', statusFilter);
    const res = await api<{items:TaskItem[];total:number}>(`/admin/generations?${params}`);
    if (res.ok) {
      setTasks(res.data?.items ?? []);
      setTotal(res.data?.total ?? 0);
    } else {
      setListError(res.message ?? '任务列表加载失败');
      setToast({message:res.message??'加载失败',type:'error'});
    }
    setLoading(false);
  }, [page, statusFilter]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);
  useEffect(() => { void loadModelDisplayMap(); }, [loadModelDisplayMap]);
  /* 任务列表轮询使用后台系统设置的间隔，避免系统配置只写入不影响页面。 */
  useEffect(() => { const t = setInterval(fetchTasks, pollIntervalSec * 1000); return () => clearInterval(t); }, [fetchTasks, pollIntervalSec]);

  const openDetail = async (task: TaskItem) => {
    setDetailTask(task);
    setDetailBatch(null);
    setDetailError(null);
    setDetailLoading(true);
    const res = await api<TaskDetailPayload>(`/admin/generations/${task.id}`);
    if (res.ok && res.data) {
      const detailTasks = sortDetailTasks(res.data.tasks ?? []);
      const selectedTask = detailTasks.find((item) => item.id === res.data?.taskId)
        ?? detailTasks.find((item) => item.id === pickDetailTaskId(detailTasks))
        ?? detailTasks[0]
        ?? task;
      setDetailBatch({ ...res.data, tasks: detailTasks });
      setDetailTask(selectedTask ?? task);
    } else {
      setDetailError(res.message ?? '任务详情加载失败');
    }
    setDetailLoading(false);
  };

  /** 复制当前任务的完整请求 JSON，便于管理员原样复现参数。 */
  const copyRequestParams = async (params: TaskRequestParams) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(params, null, 2));
      setToast({ message: '完整请求参数 JSON 已复制', type: 'success' });
    } catch {
      setToast({ message: '请求参数复制失败', type: 'error' });
    }
  };

  /* ── 从子任务中提取信息作为顶层回退 ── */
  const subtasks = detailTask?.subTasks ?? [];
  const visibleAttempts = useMemo(() => getVisibleAttempts(subtasks), [subtasks]);
  const visibleSubtasks = useMemo(() => getVisibleSubtasks(subtasks), [subtasks]);

  /** 收集所有 upstream_attempt 涉及的去重模型列表 */
  const derivedModels = useMemo(() => {
    const names = [...new Set(
      visibleAttempts.map(s => s.model).filter(Boolean)
    )];
    if (detailTask?.model && !names.includes(detailTask.model)) {
      names.unshift(detailTask.model);
    }
    return names;
  }, [detailTask?.model, visibleAttempts]);
  const derivedModel = formatModelListByMap(derivedModels.join(' / '), modelDisplayMap) || null;

  /** 收集所有 upstream_attempt 涉及的去重站点列表 */
  const derivedSites = useMemo(() => {
    const names = [...new Set(
      visibleAttempts.map(s => s.siteName).filter(Boolean)
    )];
    if (detailTask?.siteName && !names.includes(detailTask.siteName)) {
      names.unshift(detailTask.siteName);
    }
    return names;
  }, [detailTask?.siteName, visibleAttempts]);
  const derivedSite = derivedSites.join(' / ') || null;

  /** 收集所有可能的结果图片 URL */
  const resultImageUrls = useMemo(() => {
    const urls: string[] = [];
    // 顶层 imageUrl
    if (detailTask?.imageUrl) urls.push(detailTask.imageUrl);
    if (detailTask?.thumbnailUrl) urls.push(detailTask.thumbnailUrl);
    // 从 finalize 子任务的 nextAction 提取图片 URL（可能是完整 URL 或相对路径）
    for (const s of subtasks) {
      if (s.kind === 'finalize' && s.nextAction && looksLikeImage(s.nextAction)) {
        if (!urls.includes(s.nextAction)) {
          urls.push(s.nextAction);
        }
      }
    }
    return urls;
  }, [detailTask, subtasks]);

  const detailTasks = useMemo(() => sortDetailTasks(detailBatch?.tasks ?? []), [detailBatch]);
  const batchSummary = useMemo(() => buildBatchSummary(detailTasks), [detailTasks]);
  /** 后台详情中的最终图列表，独立于当前选中任务，确保能看到整批结果。 */
  const detailImages = useMemo(() => {
    const images = detailBatch?.images ?? [];
    return [...images].sort((left, right) => {
      const leftIndex = left.batchIndex ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = right.batchIndex ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return String(left.id).localeCompare(String(right.id));
    });
  }, [detailBatch]);
  const selectedDetailTaskId = detailTask?.id ?? '';
  const selectedDetailTask = detailTasks.find((item) => item.id === selectedDetailTaskId) ?? detailTask;

  const attempts = visibleAttempts;
  const failedAttempts = visibleAttempts.filter(s => s.status === 'failed').length;
  const elapsed = selectedDetailTask?.startedAt && selectedDetailTask?.finishedAt
    ? Math.round((new Date(selectedDetailTask.finishedAt).getTime() - new Date(selectedDetailTask.startedAt).getTime()) / 1000)
    : null;

  const totalPages = Math.max(1, Math.ceil(total / 15));
  const statusOptions = [
    ['', '全部'],
    ['running', '运行中'],
    ['finalizing', '收尾中'],
    ['failed', '失败'],
    ['success', '成功'],
  ] as const;

  return (
    <div className="max-w-[1500px]">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Zap size={20} style={{ color: 'var(--color-primary)' }} />
            <h2 className="text-xl font-bold tracking-tight">绘图任务</h2>
            <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-text-2">共 {total} 个任务</span>
          </div>
          <p className="text-xs text-text-2 mt-1">查看任务状态、上游尝试、结果图片和失败原因。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <button onClick={() => setSubTab('tasks')} className={`px-3 py-1.5 text-xs font-semibold transition-colors ${subTab === 'tasks' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>任务列表</button>
            <button onClick={() => setSubTab('config')} className={`px-3 py-1.5 text-xs font-semibold transition-colors ${subTab === 'config' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}><Settings size={12} className="inline mr-1" />绘图配置</button>
            <button onClick={() => setSubTab('models')} className={`px-3 py-1.5 text-xs font-semibold transition-colors ${subTab === 'models' ? 'bg-indigo-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}><SlidersHorizontal size={12} className="inline mr-1" />模型设置</button>
          </div>
          {subTab === 'tasks' && <button onClick={fetchTasks} className="btn btn-sm btn-outline"><RotateCw size={14} className={loading ? 'animate-spin' : ''} />刷新</button>}
        </div>
      </div>
      {subTab === 'config' && <div className="card mb-4"><ConfigForm fields={DRAWING_CONFIG_FIELDS} sectionKey="drawing" /></div>}
      {subTab === 'models' && <ModelSettingsPanel onSaved={() => { setToast({ message: '模型设置已保存', type: 'success' }); void loadModelDisplayMap(); }} />}
      <div className={subTab !== 'tasks' ? 'hidden' : ''}>
        {/* 状态筛选 */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-2 shadow-sm">
        {statusOptions.map(([k,label])=>(
          <button key={k} onClick={()=>{setStatusFilter(k);setPage(1);}} className={`btn btn-sm ${statusFilter===k?'bg-primary text-white':'btn-outline'}`}>{label}</button>
        ))}
        <span className="ml-auto text-xs text-text-2">{loading ? '刷新中...' : `第 ${page} / ${totalPages} 页`}</span>
      </div>

      {listError && tasks.length === 0 && (
        <div className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
          {listError}
        </div>
      )}
      {listError && /登录|权限/i.test(listError) && <div className="mb-4"><AuthExpiredBanner /></div>}

      {/* 任务表格 */}
      <div className="card overflow-hidden border border-gray-200 bg-white p-0 shadow-sm">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-gray-100 bg-gray-50 text-xs text-text-2"><th className="p-3 text-left font-medium">任务</th><th className="p-3 text-left font-medium">结果</th><th className="p-3 text-left font-medium">提示词</th><th className="p-3 text-left font-medium">状态</th><th className="p-3 text-left font-medium">来源</th><th className="p-3 text-left font-medium">站点 / 模型</th><th className="p-3 text-left font-medium">尝试</th><th className="p-3 text-left font-medium">耗时</th><th className="p-3 text-left font-medium">创建时间</th></tr></thead>
          <tbody>{tasks.map(t=>{
            const rowAttempts = getVisibleAttempts(t.subTasks ?? []);
            const aCount = t.attempts ?? rowAttempts.length;
            const tElapsed = t.startedAt && t.finishedAt ? Math.round((new Date(t.finishedAt).getTime()-new Date(t.startedAt).getTime())/1000) : null;
            const Icon = statusIcon(t.status);
            // 列表接口返回 sitesUsed 聚合字段，优先使用；回退到 subTasks 提取
            const sites = t.sitesUsed ?? [...new Set(
              rowAttempts.map(s=>s.siteName).filter(Boolean) ?? []
            )];
            const tableSite = t.siteName || (sites.length > 0 ? sites.join(' / ') : '-');
            return <tr key={t.id} className="cursor-pointer border-b border-gray-100 hover:bg-gray-50" onClick={()=>openDetail(t)}>
              <td className="p-3 align-top">
                <div className="font-mono text-xs font-semibold text-gray-800">{(t.batchId && (t.batchTotal ?? 1) > 1 ? t.batchId : t.id).slice(-16)}</div>
                <div className="mt-1 text-[11px] text-text-2">{t.clientRequestId?.slice(-12) || '-'}</div>
                {t.batchId && (t.batchTotal ?? 1) > 1 && <div className="mt-1 text-[10px] text-text-2">批次 / {t.batchCount ?? t.batchTotal ?? 1}</div>}
              </td>
              <td className="p-3 align-top">
                {t.videoUrl ? (
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-600"><Video size={18} /></div>
                ) : t.thumbnailUrl || t.imageUrl ? (
                  <img src={toImageUrl(t.thumbnailUrl || t.imageUrl || '')} alt="" className="h-12 w-12 rounded-lg border border-gray-200 object-cover bg-gray-50" onError={e=>{(e.target as HTMLImageElement).style.display='none'}} />
                ) : <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-[10px] text-text-2">无图</div>}
              </td>
              <td className="max-w-sm p-3 align-top text-xs">
                <div className="line-clamp-2 leading-5 text-gray-700">{t.prompt?.slice(0,90)||'-'}</div>
              </td>
              <td className="p-3 align-top"><span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${statusColor(t.status)}`}><Icon size={12}/>{cnStatus(t.status)}</span></td>
              <td className="p-3 align-top text-xs">
                <div className="font-medium text-gray-700">{cnSource(t.source)}</div>
                <div className="mt-1 text-text-2">{cnMode(t.mode)}</div>
              </td>
              <td className="p-3 align-top text-xs">
                <div className="font-medium text-gray-700">{tableSite}</div>
                <div className="mt-1 text-text-2">{formatModelNameByMap(t.model, modelDisplayMap) || '-'}</div>
              </td>
              <td className="p-3 align-top text-xs tabular-nums">{aCount}</td>
              <td className="p-3 align-top text-xs tabular-nums">{tElapsed!=null?fmtMs(tElapsed*1000):'-'}</td>
              <td className="p-3 align-top text-xs text-text-2">{formatDate(t.createdAt)}</td>
            </tr>;
          })}</tbody>
        </table>
        </div>
      </div>

      {/* 分页 */}
      {totalPages > 1 && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button className="btn btn-sm btn-outline" disabled={page <= 1} onClick={()=>setPage(p=>p-1)}>上一页</button>
        <span className="text-xs text-text-2">{page} / {totalPages}</span>
        <button className="btn btn-sm btn-outline" disabled={page >= totalPages} onClick={()=>setPage(p=>p+1)}>下一页</button>
      </div>}

      {/* 详情弹窗 */}
      {detailTask && (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-6" style={{background:'rgba(15,23,42,.48)'}} onClick={()=>{ setDetailTask(null); setDetailBatch(null); }}>
          <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl" onClick={e=>e.stopPropagation()}>
            <div className="z-10 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
              <div>
                <h3 className="font-bold text-lg flex items-center gap-2">
                  任务详情
                  <TaskStatePill status={selectedDetailTask?.status ?? detailTask.status} />
                </h3>
                <p className="text-xs text-text-2 font-mono mt-0.5">{selectedDetailTask?.batchId && (selectedDetailTask.batchTotal ?? 1) > 1 ? selectedDetailTask.batchId : selectedDetailTask?.id ?? detailTask.id}</p>
              </div>
              <button onClick={()=>{ setDetailTask(null); setDetailBatch(null); }} className="btn btn-sm btn-outline">关闭</button>
            </div>
            <div className="space-y-5 overflow-y-auto p-5" style={{scrollbarWidth:'thin'}}>
              {detailLoading && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                  任务详情加载中...
                </div>
              )}
              {detailError && /登录|权限/i.test(detailError) && <AuthExpiredBanner />}
              {detailError && !/登录|权限/i.test(detailError) && (
                <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {detailError}
                </div>
              )}
              {detailTasks.length > 1 && (
                <div className="flex flex-wrap gap-2 rounded-xl border border-gray-200 bg-gray-50 p-2">
                  {detailTasks.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setDetailTask(item)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${selectedDetailTaskId === item.id ? 'border-indigo-500 bg-indigo-500 text-white shadow-sm' : 'border-gray-200 bg-white text-gray-600 hover:border-indigo-300 hover:text-indigo-600'}`}
                    >
                      n={item.batchIndex ?? 1} · {cnStatus(item.status)}
                    </button>
                  ))}
                </div>
              )}
              {detailImages.length > 1 && (
                <div className="rounded-xl border border-gray-200 bg-white p-3">
                  <div className="mb-2 flex items-center justify-between text-xs text-text-2">
                    <span className="font-semibold text-text">批次最终图</span>
                    <span>{detailImages.length} 张</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {detailImages.map((image) => (
                      <button
                        key={image.id}
                        type="button"
                        onClick={() => {
                          const next = detailTasks.find((item) => item.id === image.id);
                          if (next) setDetailTask(next);
                        }}
                        className={`overflow-hidden rounded-lg border text-left transition-colors ${selectedDetailTaskId === image.id ? 'border-indigo-500 ring-2 ring-indigo-100' : 'border-gray-200 hover:border-indigo-300'}`}
                      >
                        {image.videoUrl ? (
                          <div className="flex h-24 items-center justify-center bg-indigo-50 text-indigo-600"><Video size={22} /></div>
                        ) : image.thumbnailUrl || image.imageUrl ? (
                          <img
                            src={toImageUrl(image.thumbnailUrl || image.imageUrl || '')}
                            alt=""
                            className="h-24 w-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <div className="flex h-24 items-center justify-center bg-gray-50 text-[10px] text-text-2">无图</div>
                        )}
                        <div className="px-2 py-1 text-[11px] text-text-2">
                          n={image.batchIndex ?? 1} · {image.status ?? '-'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(320px,420px)_1fr]">
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                  <div className="text-xs font-bold uppercase text-text-2 mb-2">生成结果</div>
                  {selectedDetailTask?.videoUrl ? (
                    <video src={toVideoUrl(selectedDetailTask.videoUrl)} controls playsInline preload="metadata" className="w-full max-h-[520px] rounded-lg bg-slate-950 object-contain" />
                  ) : resultImageUrls.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {resultImageUrls.map((url,i)=>(
                        <a key={i} href={toImageUrl(url)} target="_blank" rel="noopener noreferrer" className={i === 0 ? 'col-span-2' : ''}>
                          <img
                            src={toImageUrl(url)}
                            alt={`result${i+1}`}
                            className={`${i === 0 ? 'w-full max-h-[360px]' : 'w-full h-32'} rounded-lg border border-gray-200 bg-white object-contain transition-shadow hover:ring-2 hover:ring-primary/50`}
                            onError={e=>{(e.target as HTMLImageElement).style.display='none'}}
                          />
                        </a>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-64 items-center justify-center rounded-lg border border-gray-200 bg-white text-sm text-text-2">
                      {detailTask.status === 'success' ? '未找到生成结果' : '暂无生成结果'}
                    </div>
                  )}
                  {batchSummary.total > 1 && (
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-2">
                      <span className="rounded-md border border-gray-200 bg-white px-2 py-1">共 {batchSummary.total} 张</span>
                      <span className="rounded-md border border-gray-200 bg-white px-2 py-1">成功 {batchSummary.successCount}</span>
                      <span className="rounded-md border border-gray-200 bg-white px-2 py-1">失败 {batchSummary.failedCount}</span>
                      <span className="rounded-md border border-gray-200 bg-white px-2 py-1">进行中 {batchSummary.activeCount}</span>
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
                    {[
                      {l:'来源',v:cnSource(selectedDetailTask?.source ?? detailTask.source)||'-'},
                      {l:'模式',v:cnMode(selectedDetailTask?.mode ?? detailTask.mode)||'-'},
                      {l:'隐私',v:(selectedDetailTask?.isPrivate ?? detailTask.isPrivate)?'私密':'公开'},
                      {l:'QQ',v:selectedDetailTask?.qqNumber||detailTask.qqNumber||'-'},
                      {l:'用户ID',v:String(selectedDetailTask?.userId ?? detailTask.userId ?? '-')},
                      {l:'模板',v:selectedDetailTask?.templateId||detailTask.templateId||'-'},
                      {l:'模型',v:derivedModel||formatModelNameByMap(selectedDetailTask?.model ?? detailTask.model, modelDisplayMap)||'-'},
                      {l:'站点',v:derivedSite||selectedDetailTask?.siteName||detailTask.siteName||'-'},
                      {l:'批次',v:selectedDetailTask?.batchId && (selectedDetailTask.batchTotal ?? 1) > 1 ? `${selectedDetailTask.batchId} / ${selectedDetailTask.batchTotal}` : (detailTask.batchId && (detailTask.batchTotal ?? 1) > 1 ? `${detailTask.batchId} / ${detailTask.batchTotal}` : '-')},
                      ...(selectedDetailTask?.videoUrl ? [{l:'视频规格',v:`${selectedDetailTask.resolution ?? '-'} · ${selectedDetailTask.duration ?? '-'} 秒 · ${selectedDetailTask.aspectRatio ?? '-'}`}] : []),
                      {l:'总耗时',v:elapsed!=null?fmtMs(elapsed*1000):'-'},
                      {l:'尝试次数',v:String(selectedDetailTask?.attempts ?? detailTask.attempts ?? attempts.length)},
                      {l:'失败次数',v:String(selectedDetailTask?.failedCount ?? detailTask.failedCount ?? failedAttempts)},
                      {l:'参考图',v:String(selectedDetailTask?.sourceImageUrls?.length ?? detailTask.sourceImageUrls?.length ?? 0)},
                      {l:'创建',v:formatDate(selectedDetailTask?.createdAt ?? detailTask.createdAt)},
                      {l:'开始',v:formatDate(selectedDetailTask?.startedAt ?? detailTask.startedAt)},
                      {l:'完成',v:formatDate(selectedDetailTask?.finishedAt ?? detailTask.finishedAt)},
                    ].map(r=>(
                      <div key={r.l} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                        <div className="text-text-2 text-[10px] mb-1">{r.l}</div>
                        <div className="font-medium break-all">{r.v}</div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h4 className="text-xs font-bold uppercase text-text-2 mb-2">提示词</h4>
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm whitespace-pre-wrap break-words">{selectedDetailTask?.prompt||detailTask.prompt||'-'}</div>
                  </div>
                  {(selectedDetailTask?.requestParams ?? detailTask.requestParams) && (() => {
                    const requestParams = (selectedDetailTask?.requestParams ?? detailTask.requestParams)!;
                    return (
                      <div>
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <h4 className="text-xs font-bold uppercase text-text-2">完整请求参数 JSON</h4>
                          <button type="button" className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 hover:border-indigo-300 hover:text-indigo-600" onClick={() => void copyRequestParams(requestParams)}>
                            <Copy size={12} />复制 JSON
                          </button>
                        </div>
                        <pre className="max-h-96 overflow-auto rounded-lg border border-slate-700 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100 whitespace-pre-wrap break-words">{JSON.stringify(requestParams, null, 2)}</pre>
                      </div>
                    );
                  })()}
                  {(selectedDetailTask?.error || detailTask.error) && (
                    <div>
                      <h4 className="text-xs font-bold uppercase text-text-2 mb-2">错误</h4>
                      <div className="max-h-40 overflow-y-auto rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 whitespace-pre-wrap break-words">{(selectedDetailTask?.error ?? detailTask.error ?? '').slice(0, 1000)}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* 子任务时间线 */}
              {visibleSubtasks.length > 0 && <div>
                <h4 className="text-xs font-bold uppercase text-text-2 mb-2">子任务时间线 ({visibleSubtasks.length})</h4>
                <div className="grid gap-2">{visibleSubtasks.map((s,i)=>{
                  const isImageFile = looksLikeImage(s.nextAction);
                  const displayStatus = getDisplaySubtaskStatus(s, selectedDetailTask?.status ?? detailTask.status, subtasks);
                  return (
                  <div key={i} className={`px-3 py-2 rounded-lg text-xs border ${displayStatus==='failed'?'bg-red-50 border-red-100':displayStatus==='success'?'bg-green-50 border-green-100':(displayStatus==='running'||displayStatus==='finalizing')?'bg-blue-50 border-blue-100':'bg-gray-50 border-gray-100'}`}>
                    {/* 第一行：关键指标 */}
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="font-mono w-6 text-text-2 flex-shrink-0">#{s.sequence}</span>
                      <span className="w-[5rem] flex-shrink-0 font-medium">{cnKind(s.kind)}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${statusColor(displayStatus)}`}>{cnStatus(displayStatus)}</span>
                      {s.attemptNo != null && <span className="text-text-2 flex-shrink-0">第{s.attemptNo}次</span>}
                      {s.siteName && <span className="text-text-2 font-medium flex-shrink-0">{s.siteName}</span>}
                      {s.model && <span className="text-text-2 flex-shrink-0 text-[10px] bg-white/60 px-1 rounded">{formatModelNameByMap(s.model, modelDisplayMap)}</span>}
                      {s.latencyMs != null && <span className="text-text-2 flex-shrink-0 tabular-nums">{fmtMs(s.latencyMs)}</span>}
                      {s.nextAction && !isImageFile && s.nextAction !== s.kind && s.nextAction !== 'switch_site' && <span className="text-text-2 flex-shrink-0">→ {s.nextAction === 'stop' ? '停止' : s.nextAction}</span>}
                      {s.nextAction && isImageFile && (
                        <span className="text-primary text-[10px] flex-shrink-0 font-mono truncate max-w-[180px]" title={s.nextAction}>
                          📎 {s.nextAction}
                        </span>
                      )}
                      {s.retryable !== undefined && <span className="text-text-2 flex-shrink-0">可重试:{s.retryable?'是':'否'}</span>}
                      <span className="text-text-2 ml-auto flex-shrink-0">{formatTime(s.startedAt||s.createdAt)}</span>
                    </div>
                    {/* 第二行：错误详情（完整展示） */}
                    {s.error && (
                      <div className="mt-2 ml-6 pl-2 border-l-2 border-red-300 text-red-700 text-[11px] leading-relaxed break-words">
                        {s.error}
                      </div>
                    )}
                  </div>
                )})}</div>
              </div>}
              {/* 参考图 — 默认折叠，点击展开后懒加载 */}
              {detailTask.sourceImageUrls && detailTask.sourceImageUrls.length > 0 && (<RefImages urls={detailTask.sourceImageUrls} />)}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

/** 参考图组件：默认折叠，点击展开后懒加载图片 */
function RefImages({ urls }: { urls: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(!open)}
        className="text-xs font-bold uppercase text-text-2 mb-2 flex items-center gap-1.5 hover:text-text transition-colors"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        {open ? '▾' : '▸'} 参考图 ({urls.length} 张)
      </button>
      {open && (
        <div className="flex flex-wrap gap-2 mt-2">
          {urls.map((url, i) => {
            const displayUrl = toImageUrl(url);
            return (
              <a key={i} href={displayUrl} target="_blank" rel="noopener noreferrer">
                <img src={displayUrl} alt={`ref${i + 1}`} loading="lazy"
                  className="w-24 h-24 object-cover rounded-lg border hover:ring-2 hover:ring-primary/50 transition-shadow"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
