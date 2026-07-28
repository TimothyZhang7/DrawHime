/** 本文件渲染 Bot 控制台卡片，展示在线连接、站点健康和任务摘要。 */
import { Icons } from '../icons.js';
import { renderCard, T, arrayValue, esc, textValue } from '../shared-style-v2.js';

/** Bot 控制台卡片数据。 */
export type Data = {
  bots: {
    selfId: string;
    nickname: string;
    status: string;
    qqNumber?: string;
    avatarUrl?: string;
    boundUsername?: string;
    uptimeMs?: number;
  }[];
  drawingOnline?: boolean;
  proxyConnected?: boolean;
  inProgressCount?: number;
  recentTaskCount?: number;
  successRate?: number;
  failedToday?: number;
  avgLatencyMs?: number;
  total?: number;
  enabledSiteCount?: number;
  siteCount?: number;
  siteFailureCount?: number;
  sites?: { name: string; isEnabled: boolean; consecutiveFailures: number; successRate?: number }[];
  cmdPrefix?: string;
};

type BotItem = Data['bots'][number];

/** 渲染 Bot 控制台卡片。 */
export function render(d: Data): string {
  const bots = arrayValue<BotItem>(d.bots);
  const sites = arrayValue<NonNullable<Data['sites']>[number]>(d.sites);
  const online = bots.filter((item) => item.status === 'online').length;
  const cmdPrefix = textValue(d.cmdPrefix, '#');
  const totalBot = d.total ?? bots.length;
  const summary = [
    { label: '在线 Bot', value: `${online}/${totalBot}`, color: '#2563eb', soft: '#eff6ff' },
    { label: '任务进行中', value: String(d.inProgressCount ?? 0), color: '#7c3aed', soft: '#f5f3ff' },
    { label: '今日任务', value: String(d.recentTaskCount ?? 0), color: '#059669', soft: '#ecfdf5' },
    { label: '今日失败', value: String(d.failedToday ?? 0), color: '#dc2626', soft: '#fef2f2' },
  ];

  const body = `
    <div class="bot-hero">
      <div class="bot-hero-main">
        <div class="bot-eyebrow">System Console · Bots</div>
        <div class="bot-title">Bot 连接与调度总览</div>
        <div class="bot-subtitle">同时展示在线连接、站点健康、当前任务和命令入口。</div>
      </div>
      <div class="bot-hero-side">
        <div class="bot-badge">
          <strong>${online}</strong>
          <span>在线</span>
        </div>
        <div class="bot-badge alt">
          <strong>${sites.filter((site) => site.isEnabled).length}</strong>
          <span>可用站点</span>
        </div>
      </div>
    </div>
    <div class="bot-summary">
      ${summary.map((item) => metricCard(item.label, item.value, item.color, item.soft)).join('')}
    </div>
    <div class="bot-panels">
      <section class="bot-panel">
        <div class="bot-panel-head">
          <span>站点状态</span>
          <strong>${d.enabledSiteCount ?? sites.filter((site) => site.isEnabled).length}/${d.siteCount ?? sites.length}</strong>
        </div>
        <div class="bot-site-list">
          ${sites.length > 0 ? sites.map(siteRow).join('') : emptyRow('暂无站点状态')}
        </div>
      </section>
      <section class="bot-panel">
        <div class="bot-panel-head">
          <span>在线 Bot</span>
          <strong>${online}</strong>
        </div>
        <div class="bot-bot-list">
          ${bots.length > 0 ? bots.map(botRow).join('') : emptyRow('暂无在线 Bot')}
        </div>
      </section>
    </div>
    <section class="bot-panel bot-panel-wide">
      <div class="bot-panel-head">
        <span>任务摘要</span>
        <strong>${d.inProgressCount ?? 0} 进行中</strong>
      </div>
      <div class="bot-task-grid">
        <div class="bot-task-item">
          <label>今日任务</label>
          <strong>${d.recentTaskCount ?? 0}</strong>
          <span>最近 1 天真实任务</span>
        </div>
        <div class="bot-task-item">
          <label>今日成功率</label>
          <strong>${formatRate(d.successRate)}</strong>
          <span>来自 backend 聚合统计</span>
        </div>
        <div class="bot-task-item">
          <label>今日失败</label>
          <strong>${d.failedToday ?? 0}</strong>
          <span>失败任务已按原路退款</span>
        </div>
        <div class="bot-task-item">
          <label>平均耗时</label>
          <strong>${formatDuration(d.avgLatencyMs)}</strong>
          <span>仅统计有真实耗时的任务</span>
        </div>
      </div>
    </section>
  `;

  return renderCard({
    submitter: (d as any).submitter,
    accent: '#0f172a',
    icon: Icons.botList,
    title: 'Bot 控制台',
    layout: 'wide',
    extraCSS: `
      :root{--w:980px;--cp:14px 16px 16px}
      .bot-hero{display:grid;grid-template-columns:minmax(0,1fr) 158px;gap:10px;align-items:stretch;margin-bottom:10px}
      .bot-hero-main{position:relative;overflow:hidden;padding:13px 15px;border:0.5px solid #dbe3ea;border-radius:8px;background:linear-gradient(135deg,#f8fafc,#ffffff)}
      .bot-hero-main:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:#0f172a}
      .bot-eyebrow{font-size:8.5px;font-weight:950;letter-spacing:.12em;text-transform:uppercase;color:${T.soft}}
      .bot-title{margin-top:4px;font-size:21px;line-height:1.05;font-weight:950;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bot-subtitle{margin-top:6px;font-size:10px;line-height:1.35;font-weight:800;color:${T.zinc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bot-hero-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
      .bot-badge{display:flex;flex-direction:column;justify-content:center;align-items:center;border:0.5px solid #d1fae5;border-radius:8px;background:#ecfdf5}
      .bot-badge.alt{border-color:#c7d2fe;background:#eef2ff}
      .bot-badge strong{font-size:25px;font-weight:950;line-height:1;color:#059669;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .bot-badge.alt strong{color:#4f46e5}
      .bot-badge span{margin-top:4px;font-size:9px;font-weight:900;color:${T.zinc};white-space:nowrap}
      .bot-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-bottom:9px}
      .bot-metric{min-width:0;padding:9px 10px;border-radius:8px;border:0.5px solid color-mix(in srgb,var(--metric-color) 25%,#ffffff);background:var(--metric-soft)}
      .bot-metric label{display:block;font-size:8.5px;font-weight:900;color:${T.zinc};letter-spacing:.05em}
      .bot-metric strong{display:block;margin-top:3px;font-size:18px;line-height:1;font-weight:950;color:var(--metric-color);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .bot-metric span{display:block;margin-top:4px;font-size:8.5px;font-weight:800;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bot-panels{display:grid;grid-template-columns:1.08fr .92fr;gap:8px}
      .bot-panel{border:0.5px solid #e5e7eb;border-radius:8px;background:#fff;overflow:hidden}
      .bot-panel-wide{margin-top:8px}
      .bot-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:#f8fafc;border-bottom:0.5px solid #eef0f2}
      .bot-panel-head span{font-size:11px;font-weight:950;color:${T.text}}
      .bot-panel-head strong{font-size:10px;font-weight:900;color:${T.soft};font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .bot-site-list,.bot-bot-list{display:grid;gap:0}
      .bot-row{display:grid;grid-template-columns:minmax(0,1fr) 104px;gap:8px;align-items:center;padding:8px 10px;border-bottom:0.5px solid #f0f2f5}
      .bot-row:last-child{border-bottom:none}
      .bot-row-main{min-width:0;display:flex;align-items:center;gap:8px}
      .bot-avatar{width:26px;height:26px;border-radius:7px;object-fit:cover;flex-shrink:0;background:#f3f4f6}
      .bot-dot{width:8px;height:8px;border-radius:999px;flex-shrink:0}
      .bot-name{min-width:0;font-size:11.5px;font-weight:900;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bot-sub{margin-top:1px;font-size:8.5px;font-weight:800;color:${T.zinc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bot-row-side{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
      .bot-row-side span{font-size:8.5px;font-weight:850;color:${T.muted};white-space:nowrap}
      .bot-row-side strong{font-size:10px;font-weight:950;color:${T.text};font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .bot-status{height:18px;padding:0 6px;border-radius:5px;display:inline-flex;align-items:center;font-size:8.5px;font-weight:950;white-space:nowrap}
      .bot-status.on{background:#ecfdf5;color:#059669}
      .bot-status.off{background:#f8fafc;color:#64748b}
      .bot-task-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:10px}
      .bot-task-item{min-width:0;padding:9px 10px;border-radius:8px;background:#f8fafc;border:0.5px solid #eef0f2}
      .bot-task-item label{display:block;font-size:8.5px;font-weight:900;color:${T.zinc};letter-spacing:.05em}
      .bot-task-item strong{display:block;margin-top:4px;font-size:18px;line-height:1;font-weight:950;color:${T.text};font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .bot-task-item span{display:block;margin-top:4px;font-size:8.5px;font-weight:800;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bot-empty{padding:12px;color:${T.muted};font-size:11px;font-weight:800;text-align:center}
    `,
    body,
    footer: [`${cmdPrefix}bot list 重新检查`, `${cmdPrefix}状态 查看绘图站点`, `${cmdPrefix}任务 查看最近任务`, `${cmdPrefix}统计 查看个人统计`],
  });
}

/** 统计卡片数字块。 */
function metricCard(label: string, value: string, color: string, soft: string): string {
  return `<div class="bot-metric" style="--metric-color:${color};--metric-soft:${soft}">
    <label>${esc(label)}</label>
    <strong>${esc(value)}</strong>
  </div>`;
}

/** Bot 条目。 */
function botRow(bot: BotItem): string {
  const online = bot.status === 'online';
  const statusClass = online ? 'on' : 'off';
  const avatar = bot.avatarUrl
    ? `<img class="bot-avatar" src="${esc(bot.avatarUrl)}" alt="avatar" />`
    : `<span class="bot-dot" style="background:${online ? '#10b981' : '#94a3b8'}"></span>`;
  return `<div class="bot-row">
    <div class="bot-row-main">
      ${avatar}
      <div style="min-width:0">
        <div class="bot-name">${esc(bot.nickname || bot.selfId)}</div>
        <div class="bot-sub">${bot.boundUsername ? esc(bot.boundUsername) : esc(bot.qqNumber || bot.selfId)}</div>
      </div>
    </div>
    <div class="bot-row-side">
      <span class="bot-status ${statusClass}">${online ? '在线' : '离线'}</span>
      <strong>${esc(bot.selfId)}</strong>
      ${bot.uptimeMs != null ? `<span>${formatDuration(bot.uptimeMs)}</span>` : ''}
    </div>
  </div>`;
}

/** 站点条目。 */
function siteRow(site: { name: string; isEnabled: boolean; consecutiveFailures: number; successRate?: number }): string {
  const online = site.isEnabled && site.consecutiveFailures < 3;
  return `<div class="bot-row">
    <div class="bot-row-main">
      <span class="bot-dot" style="background:${online ? '#10b981' : '#dc2626'}"></span>
      <div style="min-width:0">
        <div class="bot-name">${esc(site.name)}</div>
        <div class="bot-sub">${site.consecutiveFailures > 0 ? `${site.consecutiveFailures} 连败` : '状态稳定'}</div>
      </div>
    </div>
    <div class="bot-row-side">
      <span class="bot-status ${online ? 'on' : 'off'}">${online ? '可用' : '异常'}</span>
      <strong>${formatRate(site.successRate)}</strong>
      ${site.consecutiveFailures > 0 ? `<span>失败累积 ${site.consecutiveFailures}</span>` : ''}
    </div>
  </div>`;
}

/** 空态条目。 */
function emptyRow(text: string): string {
  return `<div class="bot-empty">${esc(text)}</div>`;
}

/** 成功率显示。 */
function formatRate(value?: number): string {
  return value == null || !Number.isFinite(value) ? '--' : `${value.toFixed(1)}%`;
}

/** 时长显示。 */
function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
