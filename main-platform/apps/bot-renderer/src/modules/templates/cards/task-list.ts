/** 本文件渲染 Bot 任务菜单卡片，展示 backend 返回的真实任务摘要和筛选入口。 */
import { Icons } from '../icons.js';
import { renderCard, T, arrayValue, esc, shortText, textValue, timeText } from '../shared-style-v2.js';

/** Bot 任务菜单卡片数据，字段只来自 backend 内部任务列表聚合。 */
export type Data = {
  tasks: {
    id: string;
    status: 'success' | 'failed' | 'running' | 'finalizing' | 'queued';
    prompt: string;
    mode: string;
    model?: string;
    siteName?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    latencyMs?: number;
    latencySec?: string;
    attemptCount?: number;
    failedAttemptCount?: number;
    retryCount?: number;
  imageCount?: number;
  charged?: boolean;
  chargedAmount?: string;
  refunded?: boolean;
  error?: string;
  }[];
  filter: string;
  total?: number;
  cmdPrefix: string;
};

type TaskItem = Data['tasks'][number];

type StatusTheme = {
  color: string;
  soft: string;
  label: string;
  short: string;
  icon: string;
};

const STATUS_ORDER: TaskItem['status'][] = ['running', 'finalizing', 'queued', 'success', 'failed'];

/** 渲染任务菜单卡片。 */
export function render(d: Data): string {
  const items = arrayValue<TaskItem>(d.tasks).slice(0, 8);
  const filter = normalizeFilter(d.filter);
  const cmdPrefix = textValue(d.cmdPrefix, '/');
  const summary = buildSummary(items);
  const title = filter === 'all' ? '任务菜单' : `任务菜单 · ${statusTheme(filter).label}`;
  const cardWidth = items.length >= 7 ? 820 : 780;

  const body = `
    <div class="task-top">
      <div class="task-top-main">
        <div class="task-eyebrow">Drawing Task Console</div>
        <div class="task-title-line">${esc(title)}</div>
        <div class="task-subline">${d.total != null ? `当前筛选共 ${Number(d.total)} 条` : '最近任务'} · 发送命令可按状态查看</div>
      </div>
      <div class="task-filter" style="--filter-color:${statusTheme(filter).color};--filter-soft:${statusTheme(filter).soft}">
        <span>${esc(filter === 'all' ? '全部' : statusTheme(filter).label)}</span>
        <strong>${items.length}</strong>
      </div>
    </div>
    <div class="task-stats">
      ${statusCounter('running', summary.active)}
      ${statusCounter('success', summary.success)}
      ${statusCounter('failed', summary.failed)}
      <div class="task-counter money">
        <span>费用</span>
        <strong>${esc(formatMoney(summary.chargedAmount))}</strong>
      </div>
    </div>
    ${items.length > 0 ? `<div class="task-flow">${items.map(taskRow).join('')}</div>` : emptyBlock(cmdPrefix)}
  `;

  return renderCard({
    submitter: (d as any).submitter,
    accent: '#0f172a',
    icon: Icons.botList,
    title,
    layout: 'compact',
    extraCSS: `
      :root{--w:${cardWidth}px;--cp:16px 18px 18px}
      .content{padding:var(--cp)}
      .task-top{display:grid;grid-template-columns:minmax(0,1fr) 108px;gap:10px;margin-bottom:10px}
      .task-top-main{position:relative;min-width:0;padding:12px 14px 12px 15px;border:0.5px solid #dbe3ea;border-radius:8px;background:linear-gradient(135deg,#f8fafc,#ffffff)}
      .task-top-main:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:#0f172a}
      .task-eyebrow{font-size:8.5px;font-weight:950;letter-spacing:.12em;text-transform:uppercase;color:${T.soft}}
      .task-title-line{margin-top:5px;font-size:21px;line-height:1.05;font-weight:950;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .task-subline{margin-top:6px;font-size:10px;line-height:1.35;font-weight:800;color:${T.zinc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .task-filter{display:flex;flex-direction:column;justify-content:center;align-items:center;border:0.5px solid color-mix(in srgb,var(--filter-color) 26%,#ffffff);border-radius:8px;background:var(--filter-soft)}
      .task-filter span{font-size:10px;font-weight:950;color:var(--filter-color)}
      .task-filter strong{margin-top:2px;font-size:30px;line-height:1;font-weight:950;color:var(--filter-color);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .task-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-bottom:9px}
      .task-counter{min-width:0;padding:8px 10px;border-radius:8px;border:0.5px solid color-mix(in srgb,var(--counter-color) 25%,#ffffff);background:var(--counter-soft)}
      .task-counter span{display:block;font-size:8.5px;font-weight:900;color:${T.zinc};letter-spacing:.05em}
      .task-counter strong{display:block;margin-top:3px;font-size:17px;line-height:1;font-weight:950;color:var(--counter-color);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .task-counter.money{--counter-color:#d97706;--counter-soft:#fffbeb}
      .task-flow{display:grid;gap:6px}
      .task-row{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr) 92px;gap:8px;align-items:center;padding:8px 9px;border:0.5px solid #e7ecf2;border-radius:8px;background:#fff;overflow:hidden}
      .task-row:before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:0 99px 99px 0;background:var(--task-color)}
      .task-icon{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;color:var(--task-color);background:var(--task-soft);box-shadow:inset 0 0 0 0.5px rgba(255,255,255,.8)}
      .task-icon svg{width:14px;height:14px}
      .task-main{min-width:0}
      .task-head{display:flex;align-items:center;gap:5px;min-width:0}
      .task-rank{flex:0 0 auto;font-size:9px;font-weight:950;color:${T.soft};font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .task-prompt{min-width:0;font-size:11.5px;line-height:1.25;font-weight:900;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .task-id{flex:0 0 auto;font-size:8.5px;font-weight:900;color:${T.soft};font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .task-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;min-width:0}
      .task-chip{height:16px;display:inline-flex;align-items:center;max-width:118px;padding:0 5px;border-radius:5px;background:#f8fafc;color:${T.zinc};font-size:8.5px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .task-chip.status{background:var(--task-soft);color:var(--task-color);font-weight:950}
      .task-error{margin-top:4px;font-size:9px;line-height:1.25;font-weight:800;color:${T.red};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .task-side{min-width:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
      .task-time{font-size:9px;font-weight:850;color:${T.muted};white-space:nowrap}
      .task-money{font-size:10.5px;line-height:1;font-weight:950;color:var(--money-color);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}
      .task-empty{padding:18px 16px;border:0.5px dashed #cbd5e1;border-radius:8px;background:#f8fafc;text-align:center}
      .task-empty-title{font-size:13px;font-weight:950;color:${T.text}}
      .task-empty-sub{margin-top:6px;font-size:10.5px;font-weight:800;color:${T.zinc}}
      .task-note{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
      .task-note span{height:17px;padding:2px 5px;border-radius:5px;background:#f1f5f9;color:${T.zinc};font-size:8px;font-weight:850;white-space:nowrap}
    `,
    body,
    footer: [
      `${cmdPrefix}任务 success 查看成功`,
      `${cmdPrefix}任务 failed 查看失败`,
      `${cmdPrefix}任务 running 查看进行中`,
      `${cmdPrefix}任务 all 查看全局最近`,
    ],
  });
}

/** 渲染单行真实任务摘要。 */
function taskRow(t: TaskItem, index: number): string {
  const theme = statusTheme(t.status);
  const duration = formatTaskDuration(t);
  const attemptText = formatAttempts(t);
  const isRefunded = t.status === 'failed' || t.refunded === true;
  const chargeText = isRefunded ? '未扣费' : (t.charged ? `¥${textValue(t.chargedAmount, '0')}` : '免费');
  const moneyColor = isRefunded ? '#059669' : t.charged ? '#d97706' : '#059669';
  const meta = [
    `<span class="task-chip status">${esc(theme.label)}</span>`,
    `<span class="task-chip">${esc(modeLabel(t.mode))}</span>`,
    t.imageCount != null && t.imageCount > 0 ? `<span class="task-chip">${t.imageCount}图</span>` : '',
    t.siteName ? `<span class="task-chip">${esc(t.siteName)}</span>` : '',
    t.model ? `<span class="task-chip">${esc(t.model)}</span>` : '',
    duration ? `<span class="task-chip">${esc(duration)}</span>` : '',
    attemptText ? `<span class="task-chip">${esc(attemptText)}</span>` : '',
  ].filter(Boolean).join('');

  return `<div class="task-row" style="--task-color:${theme.color};--task-soft:${theme.soft};--money-color:${moneyColor}">
    <div class="task-icon">${theme.icon}</div>
    <div class="task-main">
      <div class="task-head">
        <span class="task-rank">#${index + 1}</span>
        <span class="task-prompt">${esc(shortText(t.prompt, 64, '未提供提示词'))}</span>
        <span class="task-id">${esc(shortTaskId(t.id))}</span>
      </div>
      <div class="task-meta">${meta}</div>
      ${t.status === 'failed' && t.error ? `<div class="task-error">${esc(shortText(t.error, 58))}</div>` : ''}
      ${isRefunded ? `<div class="task-note"><span>失败已退款</span></div>` : ''}
    </div>
    <div class="task-side">
      <div class="task-time">${esc(formatShortDateTime(t.createdAt))}</div>
      <div class="task-money">${esc(chargeText)}</div>
    </div>
  </div>`;
}

/** 渲染顶部状态计数。 */
function statusCounter(status: TaskItem['status'], value: number): string {
  const theme = statusTheme(status);
  const label = status === 'running' ? '进行中' : theme.label;
  return `<div class="task-counter" style="--counter-color:${theme.color};--counter-soft:${theme.soft}">
    <span>${esc(label)}</span>
    <strong>${value}</strong>
  </div>`;
}

/** 渲染空态，不伪造任何任务数据。 */
function emptyBlock(cmdPrefix: string): string {
  return `<div class="task-empty">
    <div class="task-empty-title">暂无匹配任务</div>
    <div class="task-empty-sub">使用 ${esc(cmdPrefix)}绘图 提示词 创建新任务，或切换其他筛选。</div>
  </div>`;
}

/** 汇总当前卡片内任务，用于顶部小统计。 */
function buildSummary(items: TaskItem[]) {
  const active = items.filter((item) => item.status === 'running' || item.status === 'finalizing' || item.status === 'queued').length;
  const success = items.filter((item) => item.status === 'success').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const chargedAmount = items.reduce((sum, item) => {
    if (item.status === 'failed') return sum;
    const amount = Number(item.chargedAmount ?? '0');
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
  return { active, success, failed, chargedAmount };
}

/** 获取任务状态视觉配置。 */
function statusTheme(status: string): StatusTheme {
  if (status === 'success') return { color: '#059669', soft: '#ecfdf5', label: '成功', short: '成', icon: Icons.drawResult };
  if (status === 'failed') return { color: '#dc2626', soft: '#fef2f2', label: '失败', short: '败', icon: Icons.errorFatal };
  if (status === 'running') return { color: '#2563eb', soft: '#eff6ff', label: '生成中', short: '跑', icon: Icons.retry };
  if (status === 'finalizing') return { color: '#7c3aed', soft: '#f5f3ff', label: '收尾中', short: '收', icon: Icons.drawSubmit };
  if (status === 'queued') return { color: '#d97706', soft: '#fffbeb', label: '排队中', short: '排', icon: Icons.cooldown };
  return { color: '#475569', soft: '#f8fafc', label: '全部', short: '全', icon: Icons.botList };
}

/** 过滤参数只允许已知状态或 all，避免渲染异常标题。 */
function normalizeFilter(value: unknown): TaskItem['status'] | 'all' {
  const text = textValue(value, 'all');
  return STATUS_ORDER.includes(text as TaskItem['status']) ? text as TaskItem['status'] : 'all';
}

/** 绘图模式中文化。 */
function modeLabel(mode: string): string {
  return mode === 'image-to-image' ? '图生图' : '文生图';
}

/** 日期时间短格式：优先展示 MM-DD HH:mm。 */
function formatShortDateTime(value: unknown): string {
  const text = textValue(value);
  if (!text) return '--:--';
  const normalized = text.replace('T', ' ');
  const md = normalized.slice(5, 10);
  const hm = normalized.slice(11, 16);
  return md && hm ? `${md} ${hm}` : timeText(text, 11, 16);
}

/** 耗时只展示真实字段：latencyMs、latencySec 或 startedAt/finishedAt。 */
function formatTaskDuration(t: TaskItem): string {
  if (typeof t.latencyMs === 'number' && Number.isFinite(t.latencyMs)) return formatMs(t.latencyMs);
  if (t.latencySec) return `${textValue(t.latencySec).replace(/s$/i, '')}s`;
  const start = Date.parse(textValue(t.startedAt));
  const end = Date.parse(textValue(t.finishedAt));
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return formatMs(end - start);
  return '';
}

/** 尝试信息使用 backend 聚合的真实次数。 */
function formatAttempts(t: TaskItem): string {
  if (typeof t.attemptCount === 'number' && t.attemptCount > 0) {
    return t.failedAttemptCount && t.failedAttemptCount > 0
      ? `${t.attemptCount}次/${t.failedAttemptCount}败`
      : `${t.attemptCount}试`;
  }
  if (typeof t.retryCount === 'number' && t.retryCount > 0) return `重试${t.retryCount}次`;
  return '';
}

/** 金额展示保留两位小数。 */
function formatMoney(value: number): string {
  return value > 0 ? `¥${value.toFixed(2)}` : '¥0.00';
}

/** 截取短任务 ID，供 QQ 卡片快速定位。 */
function shortTaskId(id: string): string {
  const text = textValue(id);
  return text.length > 12 ? text.slice(-12) : text;
}

/** 毫秒转短耗时。 */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
