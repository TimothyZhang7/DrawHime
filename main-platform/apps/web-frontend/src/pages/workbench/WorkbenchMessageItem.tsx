/** 本文件实现工作台 Agent 单条步骤渲染，包含附件、工具调用、绘图确认和任务链接。 */
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Bot, ChevronDown, ChevronRight, ExternalLink, ImageIcon, Loader2, RotateCcw, Search, Sparkles, User } from 'lucide-react';
import type {
  DrawingStatus,
  GenerationTaskView,
  WorkbenchDrawingDecision,
  WorkbenchDrawingProposalOptionView,
  WorkbenchMessageView,
  WorkbenchToolCallView,
  WorkbenchAttachmentView,
} from '@aiimage/shared-contracts';
import { ImageLightbox, type ImageLightboxItem } from '../../components/image/ImageLightbox';
import { config } from '../../lib/config';
import { resolveMediaUrl } from '../../lib/media';
import { WorkbenchDrawProposalCard } from './WorkbenchDrawProposalCard';

type WorkbenchMessageItemProps = {
  /** 当前消息。 */
  message: WorkbenchMessageView;
  /** 当前窗口内已轮询到的真实生成任务。 */
  generationTasks: GenerationTaskView[];
  /** 当前用户绘图剩余冷却秒数。 */
  cooldownRemaining: number;
  /** 当前正在确认的绘图建议按钮键。 */
  confirmingKey: string | null;
  /** 用户确认或拒绝绘图建议时触发。 */
  onDecision: (messageId: string, decision: WorkbenchDrawingDecision, optionId?: string) => void;
  /** 用户点击失败消息重试时触发，由页面复用上一条用户消息重新提交。 */
  onRetry: (messageId: string) => void;
  /** 当前是否正在重试该失败消息。 */
  retryingMessageId: string | null;
};

/** 渲染一条工作台步骤，待确认绘图建议会展示完整提示词和确认按钮。 */
export function WorkbenchMessageItem({ message, generationTasks, cooldownRemaining, confirmingKey, onDecision, onRetry, retryingMessageId }: WorkbenchMessageItemProps) {
  const relatedTasks = getRelatedTasks(message, generationTasks);
  const hasSubmittedDrawTool = message.toolCalls.some(tool => tool.type === 'image_generation' && isSubmittedDrawTool(tool));
  const submittedDrawState = resolveSubmittedDrawMessageState(message, generationTasks);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());
  const canRetry = message.role === 'assistant' && message.status === 'error';
  /** 切换已提交绘图摘要的完整详情，默认保持收起以降低消息流高度。 */
  const toggleSubmittedDrawDetail = (toolId: string) => {
    setExpandedToolIds(current => {
      const next = new Set(current);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  };

  return (
    <article className={`workbench-message is-${message.role} ${message.status ? `is-${message.status}` : ''}${submittedDrawState ? ` has-submitted-draw is-submitted-${submittedDrawState}` : ''}`}>
      <div className="workbench-message-avatar">{message.role === 'user' ? <User size={16} /> : <Bot size={16} />}</div>
      <div className="workbench-message-frame">
        <div className="workbench-message-bubble">
          {message.attachments.length > 0 && (
            <div className="workbench-message-attachments">
              {message.attachments.map(attachment => <WorkbenchMessageAttachmentImage key={attachment.id} attachment={attachment} />)}
            </div>
          )}
          {!hasSubmittedDrawTool && <WorkbenchMessageBody message={message} />}
          {message.toolCalls.length > 0 && (
            <div className="workbench-tool-calls">
              {message.toolCalls.map(tool => {
                const toolTasks = getRelatedTasksForTool(tool, generationTasks);
                if (tool.type === 'image_generation' && isSubmittedDrawTool(tool)) {
                  return (
                    <WorkbenchSubmittedDrawSummary
                      key={tool.id}
                      tool={tool}
                      tasks={toolTasks}
                      expanded={expandedToolIds.has(tool.id)}
                      messageId={message.id}
                      confirmingKey={confirmingKey}
                      cooldownRemaining={cooldownRemaining}
                      onToggle={() => toggleSubmittedDrawDetail(tool.id)}
                      onDecision={onDecision}
                    />
                  );
                }
                return tool.type === 'image_generation' && (tool.prompt || tool.decision) ? (
                  <WorkbenchDrawProposalCard
                    key={tool.id}
                    tool={tool}
                    messageId={message.id}
                    confirmingKey={confirmingKey}
                    cooldownRemaining={cooldownRemaining}
                    onDecision={onDecision}
                  />
                ) : (
                  <div key={tool.id} className={`workbench-tool-call is-${tool.status}`}>
                    {isGenerationLookupTool(tool.type) ? <Search size={13} /> : <Sparkles size={13} />}
                    <span>{tool.title}</span>
                    {tool.reason && <small>{tool.reason}</small>}
                  </div>
                );
              })}
            </div>
          )}
          {!hasSubmittedDrawTool && (
            relatedTasks.length > 0 ? <WorkbenchTaskStatusList tasks={relatedTasks} /> : (
              message.taskIds.length > 0 && (
                <div className="workbench-task-links">
                  {message.taskIds.map(id => <a key={id} href={`/personal/generations/${id}`}>{id.slice(0, 10)}</a>)}
                </div>
              )
            )
          )}
          {canRetry && (
            <button
              type="button"
              className="workbench-message-retry"
              disabled={retryingMessageId === message.id}
              onClick={() => onRetry(message.id)}
            >
              {retryingMessageId === message.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              重试
            </button>
          )}
        </div>
        <WorkbenchMessageMeta message={message} />
      </div>
    </article>
  );
}

/** 消息悬浮元信息：不占用气泡高度，悬浮时展示模型、耗时和消息时间。 */
function WorkbenchMessageMeta({ message }: { message: WorkbenchMessageView }) {
  const hasModel = message.role === 'assistant' && Boolean(message.model);
  const hasElapsed = message.role === 'assistant' && message.agentElapsedMs !== null;
  return (
    <div className="workbench-message-meta-line">
      <div className="workbench-message-meta-left">
        {hasModel && <span>{message.model}</span>}
        {hasElapsed && <span>耗时 {formatAgentElapsed(message.agentElapsedMs ?? 0)}</span>}
      </div>
      <time className="workbench-message-meta-time" dateTime={message.createdAt}>{formatMessageCreatedTime(message.createdAt)}</time>
    </div>
  );
}

/** 工作台普通正文：assistant 使用安全 Markdown 渲染，用户原始输入保持纯文本。 */
function WorkbenchMessageBody({ message }: { message: WorkbenchMessageView }) {
  if (message.role !== 'assistant') return <p>{message.content}</p>;
  return (
    <div className="workbench-message-markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          // 外链只允许新窗口打开，不把 AI 输出的链接变成当前页跳转。
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          // 禁止 Markdown 图片触发外部加载；工作台图片必须走受控附件或生成结果链路。
          img: ({ alt }) => <span className="workbench-markdown-image-disabled">{alt || '图片'}</span>,
        }}
      >
        {message.content}
      </ReactMarkdown>
    </div>
  );
}

/** 工作台消息附件图片：私有附件接口需要 JWT，不能直接交给 img 标签请求。 */
function WorkbenchMessageAttachmentImage({ attachment }: { attachment: WorkbenchAttachmentView }) {
  const [src, setSrc] = useState(() => isProtectedWorkbenchAttachmentUrl(attachment.url) ? '' : attachment.url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!isProtectedWorkbenchAttachmentUrl(attachment.url)) {
      setSrc(attachment.url);
      return;
    }

    const controller = new AbortController();
    let objectUrl = '';
    setSrc('');
    void fetch(resolveWorkbenchAttachmentFetchUrl(attachment.url), {
      headers: buildWorkbenchAttachmentHeaders(),
      signal: controller.signal,
    }).then(async response => {
      if (response.status === 401) {
        // 鉴权分支：附件图片和普通 API 一样触发登录态过期处理，避免 401 静默刷屏。
        localStorage.removeItem('token');
        window.dispatchEvent(new CustomEvent('aiimage:auth-expired'));
      }
      if (!response.ok) throw new Error(`附件读取失败：HTTP ${response.status}`);
      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setFailed(true);
    });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.url]);

  if (failed) {
    return (
      <div className="workbench-message-attachment-fallback">
        <ImageIcon size={16} />
        <span>图片加载失败</span>
      </div>
    );
  }

  return src ? <img src={src} alt={attachment.name} loading="lazy" decoding="async" /> : (
    <div className="workbench-message-attachment-fallback">
      <Loader2 size={16} className="animate-spin" />
      <span>加载图片</span>
    </div>
  );
}

/** 已确认的绘图建议不再默认展开完整 Prompt，只展示摘要、横向结果图和可展开详情。 */
function WorkbenchSubmittedDrawSummary({
  tool,
  tasks,
  expanded,
  messageId,
  confirmingKey,
  cooldownRemaining,
  onToggle,
  onDecision,
}: {
  /** 已提交或提交失败的绘图工具。 */
  tool: WorkbenchToolCallView;
  /** 该工具关联的真实生成任务。 */
  tasks: GenerationTaskView[];
  /** 是否展开完整方案详情。 */
  expanded: boolean;
  /** 当前 assistant 消息 ID。 */
  messageId: string;
  /** 当前正在确认的按钮键。 */
  confirmingKey: string | null;
  /** 当前用户绘图剩余冷却秒数。 */
  cooldownRemaining: number;
  /** 用户点击展开或收起时触发。 */
  onToggle: () => void;
  /** 展开后复用原确认卡的处理回调。 */
  onDecision: (messageId: string, decision: WorkbenchDrawingDecision, optionId?: string) => void;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const images = buildTaskLightboxImages(tasks);
  const title = getSubmittedDrawTitle(tool);
  const status = summarizeTaskStatus(tool, tasks);
  const canExpandDetail = tool.decision !== 'rejected';

  /** 打开摘要缩略图灯箱，避免用户必须展开详情才能查看生成图。 */
  const openImage = (index: number) => {
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  return (
    <div className={`workbench-submitted-draw is-${tool.status}${images.length > 0 ? ' has-final-images' : ''}`}>
      <div className="workbench-submitted-draw-main">
        <div className="workbench-submitted-draw-title">
          <Sparkles size={14} />
          <span>{title}</span>
        </div>
        <div className="workbench-submitted-draw-meta">
          <strong className={`is-${status.kind}`}>{status.label}</strong>
          <span>{tool.mode === 'image-to-image' ? '图生图' : '文生图'}</span>
          {tool.sourceImageUrls && tool.sourceImageUrls.length > 0 && <span>参考图 {tool.sourceImageUrls.length}</span>}
          {tool.model && <span>{tool.model}</span>}
          {typeof tool.count === 'number' && <span>{tool.count} 张</span>}
          {tool.isPrivate === true && <span>私密</span>}
        </div>
      </div>
      <div className={`workbench-submitted-draw-strip ${images.length === 1 ? 'is-single' : 'is-multi'}`} aria-label="生成图片预览">
        {images.length > 0 ? images.map((image, index) => (
          <button
            key={image.taskId}
            type="button"
            className="workbench-submitted-draw-thumb"
            onClick={() => openImage(index)}
            aria-label={`打开${image.title}`}
            title="点击打开大图预览"
          >
            <img src={image.src} alt={image.alt} loading="lazy" decoding="async" />
          </button>
        )) : (
          <div className="workbench-submitted-draw-empty">
            {status.kind === 'running' ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
            <span>{status.placeholder}</span>
          </div>
        )}
      </div>
      {canExpandDetail && (
        <button type="button" className="workbench-submitted-draw-toggle" onClick={onToggle}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? '收起详情' : '展开详情'}
        </button>
      )}
      {canExpandDetail && expanded && (
        <div className="workbench-submitted-draw-detail">
          <WorkbenchDrawProposalCard
            tool={tool}
            messageId={messageId}
            confirmingKey={confirmingKey}
            cooldownRemaining={cooldownRemaining}
            onDecision={onDecision}
          />
        </div>
      )}
      <ImageLightbox
        open={lightboxOpen}
        images={images}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}

/** 判断工具是否为任务查询工具；字符串比较隔离在这里，避免 JSX 分支收窄误判。 */
function isGenerationLookupTool(type: string) {
  return type === 'generation_lookup';
}

/** 判断绘图工具是否已经被用户处理；允许或拒绝后都不能继续默认展示完整方案内容。 */
function isSubmittedDrawTool(tool: WorkbenchToolCallView) {
  return tool.decision === 'approved' || tool.decision === 'rejected' || tool.status === 'success';
}

/** 收集消息关联任务，批次外显 ID 会匹配到同批次下的真实单图任务。 */
function getRelatedTasks(message: WorkbenchMessageView, tasks: GenerationTaskView[]) {
  const ids = new Set([
    ...message.taskIds,
    ...message.toolCalls.flatMap(tool => tool.taskIds),
  ].filter(Boolean));
  if (ids.size === 0) return [];
  return tasks.filter(task => ids.has(task.id) || Boolean(task.batchId && ids.has(task.batchId)));
}

/** 按单个工具收集任务，避免同一条消息多工具时缩略图串联。 */
function getRelatedTasksForTool(tool: WorkbenchToolCallView, tasks: GenerationTaskView[]) {
  const ids = new Set(tool.taskIds.filter(Boolean));
  if (ids.size === 0) return [];
  return tasks.filter(task => ids.has(task.id) || Boolean(task.batchId && ids.has(task.batchId)));
}

/** 已提交绘图消息直接使用消息气泡承载状态样式，避免气泡内再嵌套一层卡片。 */
function resolveSubmittedDrawMessageState(message: WorkbenchMessageView, tasks: GenerationTaskView[]) {
  const tool = message.toolCalls.find(item => item.type === 'image_generation' && isSubmittedDrawTool(item));
  if (!tool) return null;
  return summarizeTaskStatus(tool, getRelatedTasksForTool(tool, tasks)).kind;
}

/** 摘要卡标题优先取用户实际选择的方案标题。 */
function getSubmittedDrawTitle(tool: WorkbenchToolCallView) {
  const selected = findSelectedOption(tool);
  if (selected?.title) return selected.title;
  if (tool.title) return tool.title;
  if (tool.status === 'error') return '绘图提交失败';
  return '已提交绘图任务';
}

/** 查找用户最终确认的绘图方案，用于摘要标题和展开详情一致。 */
function findSelectedOption(tool: WorkbenchToolCallView): WorkbenchDrawingProposalOptionView | null {
  const options = Array.isArray(tool.options) ? tool.options : [];
  if (tool.selectedOptionId) return options.find(item => item.id === tool.selectedOptionId) ?? null;
  return options.length === 1 ? options[0] ?? null : null;
}

/** 汇总工具关联任务状态，给收起态摘要提供稳定短文本。 */
function summarizeTaskStatus(tool: WorkbenchToolCallView, tasks: GenerationTaskView[]) {
  if (tool.decision === 'rejected') {
    // 拒绝态不会创建真实任务，只显示终态摘要，不能泄露被拒绝方案的完整 Prompt。
    return { kind: 'rejected', label: '已拒绝', placeholder: '已拒绝，不创建任务' };
  }
  if (tool.status === 'error') {
    return { kind: 'failed', label: '提交失败', placeholder: tool.error || '提交失败' };
  }
  if (tasks.length === 0) {
    return { kind: 'running', label: '已提交', placeholder: '等待任务状态' };
  }
  const successCount = tasks.filter(task => task.status === 'success').length;
  const failedCount = tasks.filter(task => task.status === 'failed').length;
  const runningCount = tasks.filter(task => task.status === 'queued' || task.status === 'running' || task.status === 'finalizing' || task.status === 'deferred').length;
  if (runningCount > 0) return { kind: 'running', label: `生成中 ${successCount}/${tasks.length}`, placeholder: '图片生成中' };
  if (failedCount > 0 && successCount === 0) return { kind: 'failed', label: '失败', placeholder: tasks[0]?.failureSummary || tasks[0]?.error || '生成失败' };
  if (failedCount > 0) return { kind: 'failed', label: `部分完成 ${successCount}/${tasks.length}`, placeholder: '部分任务失败' };
  return { kind: 'success', label: `已完成 ${successCount}/${tasks.length}`, placeholder: '暂无预览图' };
}

/** 工作台内任务状态列表：展示真实状态、结果图和详情入口。 */
function WorkbenchTaskStatusList({ tasks }: { tasks: GenerationTaskView[] }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const lightboxImages = buildTaskLightboxImages(tasks);

  /** 打开当前任务图片的灯箱；只使用已成功任务的真实图片地址。 */
  const openTaskLightbox = (taskId: string) => {
    const index = lightboxImages.findIndex(item => item.taskId === taskId);
    if (index < 0) return;
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  return (
    <div className="workbench-task-status-list">
      {tasks.map((task, index) => {
        const previewUrl = task.thumbnailUrl || task.imageUrl;
        const detailId = task.batchId && (task.batchTotal ?? 1) > 1 ? task.batchId : task.id;
        return (
          <div key={task.id} className={`workbench-task-status-card is-${task.status}`}>
            <div className="workbench-task-status-preview">
              {task.status === 'success' && previewUrl ? (
                <button
                  type="button"
                  className="workbench-task-status-preview-button"
                  onClick={() => openTaskLightbox(task.id)}
                  aria-label="打开生成图片预览"
                  title="点击打开大图预览"
                >
                  <img src={resolveMediaUrl(previewUrl)} alt={task.prompt || '生成结果'} loading="lazy" decoding="async" />
                </button>
              ) : task.status === 'failed' ? (
                <AlertTriangle size={20} />
              ) : task.status === 'queued' || task.status === 'running' || task.status === 'finalizing' ? (
                <Loader2 size={20} className="animate-spin" />
              ) : (
                <ImageIcon size={20} />
              )}
            </div>
            <div className="workbench-task-status-main">
              <div className="workbench-task-status-head">
                <span>{formatTaskTitle(task, index)}</span>
                <strong className={`is-${task.status}`}>{statusLabel(task.status)}</strong>
              </div>
              <div className="workbench-task-status-meta">
                <span>{task.id.slice(0, 18)}</span>
                {task.mode && <span>{task.mode === 'image-to-image' ? '图生图' : '文生图'}</span>}
                {task.finishedAt && <span>{formatTaskTime(task.finishedAt)}</span>}
              </div>
              {task.status === 'failed' && <p>{task.failureSummary || task.error || '生成失败'}</p>}
              <div className="workbench-task-status-actions">
                <a href={`/personal/generations/${detailId}`}>
                  <ExternalLink size={12} />
                  详情
                </a>
                {task.status === 'success' && task.imageUrl && (
                  <a href={resolveMediaUrl(task.imageUrl)} target="_blank" rel="noreferrer">
                    <ImageIcon size={12} />
                    原图
                  </a>
                )}
              </div>
            </div>
          </div>
        );
      })}
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

/** 任务卡标题，批次任务展示序号。 */
function formatTaskTitle(task: GenerationTaskView, index: number) {
  if (task.batchTotal && task.batchTotal > 1) return `生成图 ${task.batchIndex ?? index + 1}/${task.batchTotal}`;
  return '生成图片';
}

/** 任务状态中文文案。 */
function statusLabel(status: DrawingStatus) {
  const map: Record<DrawingStatus, string> = {
    deferred: '等待释放',
    queued: '排队中',
    running: '运行中',
    finalizing: '收尾中',
    success: '已完成',
    failed: '失败',
  };
  return map[status] ?? status;
}

/** 任务时间短格式。 */
function formatTaskTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** 格式化 Agent Run 耗时，按 0.1 秒精度展示。 */
function formatAgentElapsed(value: number) {
  if (!Number.isFinite(value) || value < 0) return '-';
  return `${(Math.round(value / 100) / 10).toFixed(1)}s`;
}

/** 格式化消息创建时间；当天只显示时分，历史消息带月日，避免右侧过宽。 */
function formatMessageCreatedTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const day = date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  return `${day} ${time}`;
}

/** 工作台灯箱图片条目，额外保留任务 ID 以便从缩略图定位到正确图片。 */
type WorkbenchTaskLightboxItem = ImageLightboxItem & { taskId: string };

/** 构建当前消息下所有已完成生成图的灯箱列表。 */
function buildTaskLightboxImages(tasks: GenerationTaskView[]): WorkbenchTaskLightboxItem[] {
  const images: WorkbenchTaskLightboxItem[] = [];
  tasks.forEach((task, index) => {
    const imageUrl = task.imageUrl || task.thumbnailUrl;
    if (task.status !== 'success' || !imageUrl) return;
    images.push({
      taskId: task.id,
      src: resolveMediaUrl(imageUrl),
      title: formatTaskTitle(task, index),
      downloadName: buildDownloadFilename(task.id, imageUrl),
      alt: task.prompt || '生成图片',
    });
  });
  return images;
}

/** 生成灯箱下载文件名，保留原图扩展名并避免使用用户提示词作为文件名。 */
function buildDownloadFilename(taskId: string, imageUrl: string) {
  const cleanId = taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36) || 'image';
  const extension = imageUrl.split('?')[0]?.split('.').pop()?.toLowerCase();
  const safeExtension = extension && /^[a-z0-9]{2,5}$/.test(extension) ? extension : 'png';
  return `aiimage-${cleanId}.${safeExtension}`;
}

/** 判断是否为工作台私有附件地址；该地址必须带鉴权读取后转成 blob 预览。 */
function isProtectedWorkbenchAttachmentUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname.startsWith('/api/workbench/attachments/');
  } catch {
    return url.startsWith('/api/workbench/attachments/');
  }
}

/** 解析工作台附件请求地址，兼容后端返回相对路径和完整 API 地址。 */
function resolveWorkbenchAttachmentFetchUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  return `${config.apiBase}${url.startsWith('/') ? url : `/${url}`}`;
}

/** 构造工作台附件读取鉴权头；图片读取仍走真实用户 JWT，不开放公开绕过接口。 */
function buildWorkbenchAttachmentHeaders(): HeadersInit {
  const token = localStorage.getItem('token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}
