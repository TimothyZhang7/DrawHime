/** 本文件负责个人中心生成任务子任务时间线展示，并屏蔽后端重试编排的内部占位噪声。 */

/** 任务详情时间线单项，字段来自 backend 的 GenerationSubTaskView。 */
export type SubTaskTimelineItem = {
  id?: string;
  sequence: number;
  kind: string;
  status: string;
  attemptNo?: number;
  siteName?: string;
  model?: string;
  latencyMs?: number;
  error?: string;
  retryable?: boolean;
  nextAction?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
};

type SubTaskTimelineProps = {
  /** 主任务状态，用于历史脏数据中 running 子任务的展示兜底。 */
  taskStatus: string;
  /** 后端返回的原始子任务列表。 */
  subTasks?: SubTaskTimelineItem[];
  /** 展示层模型名格式化函数；真实模型 ID 仍保留在后端任务数据中。 */
  formatModelName?: (model?: string) => string;
};

const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  failed: '失败',
  running: '生成中',
  finalizing: '收尾中',
  queued: '等待中',
  skipped: '已跳过',
};

const KIND_LABELS: Record<string, string> = {
  request_received: '接收请求',
  prompt_assist: 'AI 提示增强',
  dispatch: '分发任务',
  same_site_retry: '同站重试',
  site_switch: '切换站点',
  upstream_attempt: '上游调用',
  image_saved: '图片保存',
  video_saved: '视频保存',
  result_ready: '结果就绪',
  result_delivered: '结果投递',
  finalize: '完成收尾',
};

/** 判断是否为真实上游尝试，过滤 claim 占位被覆盖后留下的内部记录。 */
export function isRealUpstreamAttempt(item: SubTaskTimelineItem): boolean {
  return item.kind === 'upstream_attempt' && !isCoveredUpstreamPlaceholder(item);
}

/** 返回适合用户展示的时间线项，隐藏被覆盖占位和纯收尾清理节点。 */
export function getVisibleSubTasks(subTasks?: SubTaskTimelineItem[]): SubTaskTimelineItem[] {
  return (subTasks ?? []).filter((item) => !isCoveredUpstreamPlaceholder(item) && !isTerminalCleanupNoise(item));
}

/** 生成任务子任务时间线组件；只展示用户能理解的真实处理步骤。 */
export function SubTaskTimeline({ taskStatus, subTasks, formatModelName }: SubTaskTimelineProps) {
  const visibleItems = getVisibleSubTasks(subTasks);
  if (visibleItems.length === 0) return null;

  return (
    <section className="personal-task-section">
      <h4>子任务时间线 ({visibleItems.length})</h4>
      <div className="personal-subtask-list">
        {visibleItems.map((item) => {
          const displayStatus = getDisplayStatus(item, taskStatus, subTasks ?? []);
          return (
            <div key={item.id ?? `${item.sequence}-${item.kind}`} className={`personal-subtask ${statusClass(displayStatus)}`}>
              <div className="personal-subtask-head">
                <span className="personal-subtask-seq">#{item.sequence}</span>
                <span className="personal-subtask-kind">{labelOf(KIND_LABELS, item.kind)}</span>
                <span className={`personal-status ${statusClass(displayStatus)}`}>{labelOf(STATUS_LABELS, displayStatus)}</span>
                {item.attemptNo != null && <span>第{item.attemptNo}次</span>}
                {item.siteName && <span>{item.siteName}</span>}
                {shouldShowModel(item) && <span>{formatModelName?.(item.model) || item.model}</span>}
                {item.latencyMs != null && <span>{formatDuration(item.latencyMs)}</span>}
                {item.retryable !== undefined && <span>可重试:{item.retryable ? '是' : '否'}</span>}
                <span className="personal-subtask-time">{formatDateTime(item.startedAt || item.createdAt)}</span>
              </div>
              {item.error && <div className="personal-subtask-error">{item.error}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function labelOf(map: Record<string, string>, value?: string) {
  return value ? map[value] ?? value : '-';
}

function statusClass(status: string) {
  if (status === 'success') return 'is-success';
  if (status === 'failed') return 'is-error';
  if (status === 'running' || status === 'finalizing') return 'is-active';
  return 'is-muted';
}

function formatDateTime(value?: string) {
  if (!value) return '-';
  return value.slice(0, 19).replace('T', ' ');
}

function formatDuration(ms?: number) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function isRetryTransition(item: SubTaskTimelineItem): boolean {
  return item.kind === 'site_switch' || item.kind === 'same_site_retry';
}

/** 只有真正会调用上游或描述重试流转的节点才展示模型，避免旧 image_saved 脏字段显示成模型名。 */
function shouldShowModel(item: SubTaskTimelineItem): boolean {
  return Boolean(item.model) && (item.kind === 'upstream_attempt' || isRetryTransition(item));
}

function isCoveredUpstreamPlaceholder(item: SubTaskTimelineItem): boolean {
  return item.kind === 'upstream_attempt'
    && item.status === 'skipped'
    && !item.siteName
    && !item.latencyMs
    && Boolean(item.error?.includes('覆盖'));
}

function isTerminalCleanupNoise(item: SubTaskTimelineItem): boolean {
  return isRetryTransition(item)
    && item.status === 'skipped'
    && item.attemptNo === undefined
    && !item.siteName
    && !item.model
    && !item.latencyMs
    && Boolean(item.error?.includes('重试已终止'));
}

function getDisplayStatus(item: SubTaskTimelineItem, taskStatus: string, allItems: SubTaskTimelineItem[]): string {
  if (isRetryTransition(item) && item.status === 'running' && (taskStatus === 'success' || taskStatus === 'failed')) {
    const hasFollowingAttempt = item.attemptNo != null && allItems.some((next) => (
      next.kind === 'upstream_attempt'
      && next.attemptNo === item.attemptNo
      && next.sequence > item.sequence
      && !isCoveredUpstreamPlaceholder(next)
    ));
    return hasFollowingAttempt ? 'success' : 'skipped';
  }
  return item.status;
}
