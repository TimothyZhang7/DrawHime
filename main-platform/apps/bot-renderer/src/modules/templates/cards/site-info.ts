/** 本文件渲染 Bot `/info` 运维信息卡片，数据直接复用公开状态页真实统计结构。 */
import type { PublicServiceHealthView, PublicSiteRuntimeView, PublicStatusResponse } from '@aiimage/shared-contracts';
import { Icons } from '../icons.js';
import { renderCard, T, arrayValue, esc, textValue, timeText, type UserBadgeData } from '../shared-style-v2.js';

/** `/info` 卡片补充的实时 Bot 连接摘要。 */
type InfoBot = {
  selfId: string;
  nickname?: string;
  status?: string;
  avatarUrl?: string;
  uptimeMs?: number;
};

/** `/info` 卡片补充的最近错误摘要。 */
type InfoError = {
  prompt?: string;
  error: string;
  siteName?: string;
  createdAt?: string;
};

/** `/info` 卡片输入数据；status 来自 backend `/api/status?range=24h`。 */
export type Data = {
  status?: PublicStatusResponse;
  cmdPrefix?: string;
  botItems?: InfoBot[];
  recentErrors?: InfoError[];
  submitter?: UserBadgeData;
};

/** 渲染 `/info` 高密度状态页同款运维卡片。 */
export function render(d: Data): string {
  const status = normalizeStatus(d.status);
  const services = arrayValue<PublicServiceHealthView>(status.services);
  const sites = arrayValue<PublicSiteRuntimeView>(status.sites);
  const liveBots = arrayValue<InfoBot>(d.botItems);
  const errors = arrayValue<InfoError>(d.recentErrors).slice(0, 6);
  const onlineServices = services.filter((service) => service.ok).length;
  const activeTasks = status.tasks.queued + status.tasks.running + status.tasks.finalizing;
  const enabledSites = sites.filter((site) => site.isEnabled && !site.autoDisabledUntil).length;
  const abnormalSites = sites.filter((site) => !site.isEnabled || Boolean(site.autoDisabledUntil) || site.consecutiveFailures > 0 || (site.successRate != null && site.successRate < 80)).length;
  const avgServiceLatency = averageLatency(services);
  const avgSiteLatency = averageSiteLatency(sites);
  const cmdPrefix = textValue(d.cmdPrefix, '#');

  const body = `
    <div class="status-top">
      ${topMetric('服务在线', `${formatInt(onlineServices)}/${formatInt(services.length)}`, onlineServices === services.length ? '#059669' : '#f59e0b', '真实 health 探活')}
      ${topMetric('本期任务', formatInt(status.tasks.total), '#2563eb', rangeLabel(status.range))}
      ${topMetric('终态成功率', formatPercent(status.tasks.successRate), rateColor(status.tasks.successRate), 'success / failed')}
      ${topMetric('本期进行中', formatInt(activeTasks), activeTasks > 0 ? '#7c3aed' : '#64748b', '排队/运行/收尾')}
    </div>

    <div class="layout-main">
      <section class="panel-block task-block">
        <div class="panel-head"><span>任务状态分布</span><strong>${formatTimeRange(status.since, status.generatedAt)}</strong></div>
        <div class="task-grid">
          ${miniMetric('总数', status.tasks.total, '#111827')}
          ${miniMetric('成功', status.tasks.success, '#059669')}
          ${miniMetric('失败', status.tasks.failed, status.tasks.failed > 0 ? '#dc2626' : '#64748b')}
          ${miniMetric('排队', status.tasks.queued, '#2563eb')}
          ${miniMetric('运行', status.tasks.running, '#7c3aed')}
          ${miniMetric('收尾', status.tasks.finalizing, '#0891b2')}
        </div>
        <div class="section-subhead">平台概览</div>
        <div class="platform-grid">
          ${platformItem('注册用户', status.platform.users)}
          ${platformItem('已验证邮箱', status.platform.verifiedUsers)}
          ${platformItem('公开作品', status.platform.publicImages)}
          ${platformItem('启用站点', status.platform.enabledSites)}
        </div>
      </section>

      <section class="panel-block">
        <div class="panel-head"><span>来源与 Bot</span><strong>${formatInt(status.bots.online)}/${formatInt(status.bots.total)}</strong></div>
        <div class="source-list">
          ${status.sources.length ? status.sources.slice(0, 4).map(sourceRow).join('') : emptyLine('当前区间暂无来源数据')}
        </div>
        <div class="bot-summary">
          ${botStat('记录', status.bots.total, '#111827')}
          ${botStat('在线', status.bots.online, '#059669')}
          ${botStat('离线', status.bots.offline, '#64748b')}
          ${botStat('封禁', status.bots.banned, status.bots.banned > 0 ? '#dc2626' : '#64748b')}
        </div>
        <div class="live-bots">
          ${liveBots.length ? liveBots.slice(0, 4).map(botRow).join('') : emptyLine('暂无实时连接补充')}
        </div>
      </section>
    </div>

    <section class="panel-block service-block">
      <div class="panel-head"><span>服务节点</span><strong>平均 ${formatDuration(avgServiceLatency)}</strong></div>
      <div class="service-grid">
        ${services.length ? services.slice(0, 10).map(serviceNode).join('') : emptyLine('暂无服务探活数据')}
      </div>
    </section>

    <section class="panel-block site-block">
      <div class="panel-head">
        <span>绘图站点运行统计</span>
        <strong>${formatInt(enabledSites)}/${formatInt(sites.length)} 可用 · ${formatInt(abnormalSites)} 异常 · 平均 ${formatDuration(avgSiteLatency)}</strong>
      </div>
      <div class="site-grid">
        ${sites.length ? sites.slice(0, 9).map(siteCard).join('') : emptyLine('暂无绘图站点数据')}
      </div>
    </section>

    <section class="panel-block error-block">
      <div class="panel-head"><span>最近错误</span><strong>${formatInt(errors.length)}</strong></div>
      <div class="error-grid">
        ${errors.length ? errors.map(errorRow).join('') : emptyLine('暂无最近错误记录')}
      </div>
    </section>
  `;

  return renderCard({
    submitter: d.submitter,
    accent: '#111827',
    icon: Icons.siteStatus,
    title: '站点信息',
    layout: 'wide',
    extraCSS: `
      :root{--w:1040px;--cp:14px 16px 16px}
      .status-top{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:9px}
      .top-metric{position:relative;min-width:0;padding:10px 12px;border:0.5px solid #e2e8f0;border-radius:8px;background:#fff;overflow:hidden}
      .top-metric:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c)}
      .top-metric label,.mini label,.platform-item label,.bot-stat label{display:block;font-size:8px;font-weight:900;color:${T.soft};letter-spacing:.06em;white-space:nowrap}
      .top-metric strong{display:block;margin-top:4px;font-size:21px;line-height:1;font-weight:950;color:var(--c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .top-metric span{display:block;margin-top:5px;font-size:8.5px;font-weight:800;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .layout-main{display:grid;grid-template-columns:1.18fr .82fr;gap:8px;margin-bottom:8px}
      .panel-block{border:0.5px solid #e2e8f0;border-radius:8px;background:#fff;overflow:hidden;margin-bottom:8px}
      .panel-block:last-child{margin-bottom:0}
      .panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;height:30px;padding:0 10px;background:#f8fafc;border-bottom:0.5px solid #edf2f7}
      .panel-head span{font-size:10.5px;font-weight:950;color:${T.text};white-space:nowrap}
      .panel-head strong{font-size:8.5px;font-weight:900;color:${T.soft};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .task-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;padding:8px 8px 6px}
      .mini,.platform-item,.bot-stat{min-width:0;padding:7px 8px;border:0.5px solid #edf2f7;border-radius:7px;background:#fbfdff}
      .mini strong{display:block;margin-top:3px;font-size:14.5px;line-height:1;font-weight:950;color:var(--c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .section-subhead{padding:0 9px 5px;font-size:8.5px;font-weight:950;color:${T.soft};letter-spacing:.06em}
      .platform-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;padding:0 8px 8px}
      .platform-item strong,.bot-stat strong{display:block;margin-top:3px;font-size:13px;line-height:1;font-weight:950;color:var(--c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .source-list{display:grid;gap:5px;padding:8px 8px 6px}
      .source-row{display:grid;grid-template-columns:72px 1fr 74px;gap:7px;align-items:center;padding:6px 7px;border:0.5px solid #edf2f7;border-radius:7px;background:#fbfdff}
      .source-name{font-size:9.5px;font-weight:950;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bar{height:6px;border-radius:99px;background:#e5e7eb;overflow:hidden}
      .bar-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#10b981,#2563eb);width:var(--p)}
      .source-num{text-align:right;font-size:8.5px;font-weight:900;color:${T.muted};white-space:nowrap}
      .bot-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px;padding:0 8px 6px}
      .live-bots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:0 8px 8px}
      .bot-row{min-width:0;display:flex;align-items:center;gap:6px;padding:5px;border:0.5px solid #edf2f7;border-radius:7px;background:#fff}
      .bot-row img{width:24px;height:24px;border-radius:6px;object-fit:cover;background:#f1f5f9;flex-shrink:0}
      .bot-name{font-size:9.5px;font-weight:900;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bot-sub{margin-top:1px;font-size:7.5px;font-weight:800;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .service-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;padding:8px}
      .service-node{position:relative;min-width:0;padding:8px 8px 7px;border:0.5px solid #e2e8f0;border-radius:7px;background:#fbfdff;overflow:hidden}
      .service-node:before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--c)}
      .service-title{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px}
      .service-title b{font-size:9.5px;font-weight:950;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .service-dot{width:8px;height:8px;border-radius:999px;background:var(--c);flex-shrink:0}
      .service-meta{display:flex;justify-content:space-between;gap:6px;font-size:7.5px;font-weight:800;color:${T.muted};white-space:nowrap;overflow:hidden}
      .site-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;padding:8px}
      .site-card{min-width:0;border:0.5px solid #e2e8f0;border-radius:8px;background:#fff;overflow:hidden}
      .site-head{display:flex;align-items:center;justify-content:space-between;gap:7px;padding:7px 8px;border-bottom:0.5px solid #edf2f7;background:#fbfdff}
      .site-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:10px;font-weight:950;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .site-name i{width:8px;height:8px;border-radius:999px;background:var(--c);flex-shrink:0}
      .site-state{font-size:7.5px;font-weight:950;padding:2px 6px;border-radius:5px;background:var(--bg);color:var(--c);white-space:nowrap}
      .site-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border-bottom:0.5px solid #edf2f7}
      .site-metric{padding:6px 5px;text-align:center;border-right:0.5px solid #edf2f7}
      .site-metric:last-child{border-right:none}
      .site-metric label{display:block;font-size:7px;font-weight:900;color:${T.soft};white-space:nowrap}
      .site-metric strong{display:block;margin-top:2px;font-size:10.5px;line-height:1;font-weight:950;color:${T.text};font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .site-foot{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:6px 7px;font-size:7.5px;font-weight:850;color:${T.muted}}
      .site-foot span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
      .error-block{margin-bottom:0}
      .error-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:8px}
      .error-row{min-width:0;padding:6px 8px;border:0.5px solid #fee2e2;border-radius:7px;background:#fff7f7}
      .error-title{font-size:9px;font-weight:950;color:#991b1b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .error-sub{margin-top:2px;font-size:7.5px;font-weight:800;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .empty{grid-column:1/-1;padding:10px;text-align:center;color:${T.muted};font-size:10px;font-weight:850}
    `,
    body,
    footer: [
      `生成 ${timeText(status.generatedAt)}`,
      `${cmdPrefix}info error 查看最近错误`,
      `${cmdPrefix}统计 all 查看全站排行`,
      `${cmdPrefix}任务 all 查看最近任务`,
    ],
  });
}

/** 生成 renderer 和后台预览共用的状态页示例数据。 */
export function sampleSiteInfoData(): Data {
  const now = '2026-06-17T10:10:00+08:00';
  return {
    cmdPrefix: '#',
    status: {
      range: '24h',
      since: '2026-06-16T10:10:00+08:00',
      generatedAt: now,
      services: [
        service('backend', '后端', true, 18, '3.0.0', 86400),
        service('drawing-service', '绘图调度', true, 26, '3.0.0', 85300),
        service('drawing-worker', '绘图 Worker', true, 31, '3.0.0', 84100),
        service('media-service', '媒体存储', true, 21, '3.0.0', 83000),
        service('bot-service', 'Bot 服务', true, 28, '3.0.0', 81200),
        service('bot-renderer', '卡片渲染', true, 35, '3.0.0', 80600),
        service('wsproxy-service', 'WS 代理', true, 23, '3.0.0', 79500),
        service('workflow-service', '工作流服务', true, 42, '3.0.0', 78000),
        service('ops-worker', '运维 Worker', true, 19, '3.0.0', 76500),
        service('notification-worker', '邮件通知', false, null, '3.0.0', 0, '探活超时'),
      ],
      tasks: { total: 286, queued: 4, running: 9, finalizing: 2, success: 238, failed: 33, terminalTotal: 271, successRate: 87.8 },
      sources: [
        { source: 'bot', total: 178, success: 151, failed: 19 },
        { source: 'web', total: 105, success: 85, failed: 13 },
        { source: 'workflow', total: 3, success: 2, failed: 1 },
      ],
      sites: [
        site(1, '科比', true, 12, 5, 0, null, null, 6120, 5418, 38200, 104, 92, 9, 2, 91.1, 36800),
        site(2, 'zxai', true, 10, 4, 1, null, null, 4310, 3581, 42100, 88, 70, 15, 5, 82.4, 44200),
        site(3, 'matr', true, 8, 3, 0, null, null, 3820, 3610, 29400, 71, 68, 2, 1, 97.1, 28600),
        site(4, 'local-comfy', true, 6, 2, 0, null, null, 260, 240, 52000, 18, 15, 2, 1, 88.2, 51000),
        site(5, 'backup-a', false, 3, 1, 5, null, '人工停用', 920, 710, 47000, 5, 0, 5, 0, 0, 0),
      ],
      bots: { total: 6, online: 4, offline: 1, banned: 1 },
      platform: { users: 1386, verifiedUsers: 940, publicImages: 21840, enabledSites: 4 },
    },
    botItems: [
      { selfId: '100000001', nickname: '绘图姬', status: 'online', avatarUrl: 'https://q.qlogo.cn/headimg_dl?dst_uin=100000001&spec=100', uptimeMs: 3_600_000 },
      { selfId: '100000002', nickname: '绘图姬-备用', status: 'online', avatarUrl: 'https://q.qlogo.cn/headimg_dl?dst_uin=100000002&spec=100', uptimeMs: 1_840_000 },
    ],
    recentErrors: [
      { error: '提示词审查未通过', prompt: '角色立绘，替换服装细节', siteName: '科比', createdAt: '2026-06-17T10:04:00+08:00' },
      { error: '上游请求超时', prompt: '高清头像修复', siteName: 'zxai', createdAt: '2026-06-17T09:52:00+08:00' },
      { error: '参考图审查未通过', prompt: '图生图风格迁移', siteName: '科比', createdAt: '2026-06-17T09:40:00+08:00' },
    ],
  };
}

/** 将缺失状态归一为空结构，保证 renderer 降级时不会崩溃。 */
function normalizeStatus(status: Data['status']): PublicStatusResponse {
  if (status) return status;
  return {
    range: '24h',
    since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    generatedAt: new Date().toISOString(),
    services: [],
    tasks: { total: 0, queued: 0, running: 0, finalizing: 0, success: 0, failed: 0, terminalTotal: 0, successRate: null },
    sources: [],
    sites: [],
    bots: { total: 0, online: 0, offline: 0, banned: 0 },
    platform: { users: 0, verifiedUsers: 0, publicImages: 0, enabledSites: 0 },
  };
}

/** 示例服务节点。 */
function service(name: string, label: string, ok: boolean, latencyMs: number | null, version: string, uptimeSec: number, error: string | null = null): PublicServiceHealthView {
  return { name, label, ok, statusCode: ok ? 200 : null, version, uptimeSec, latencyMs, error };
}

/** 示例绘图站点节点。 */
function site(
  id: number,
  name: string,
  isEnabled: boolean,
  weight: number,
  maxConcurrency: number,
  consecutiveFailures: number,
  autoDisabledUntil: string | null,
  autoDisabledReason: string | null,
  lifetimeCalls: number,
  lifetimeSuccess: number,
  lifetimeAvgLatencyMs: number,
  attempts: number,
  success: number,
  failed: number,
  active: number,
  successRate: number | null,
  avgLatencyMs: number | null,
): PublicSiteRuntimeView {
  return { id, name, isEnabled, weight, maxConcurrency, consecutiveFailures, autoDisabledUntil, autoDisabledReason, lifetimeCalls, lifetimeSuccess, lifetimeAvgLatencyMs, attempts, success, failed, active, successRate, avgLatencyMs };
}

/** 顶部四指标块。 */
function topMetric(label: string, value: string, color: string, note: string): string {
  return `<div class="top-metric" style="--c:${color}"><label>${esc(label)}</label><strong>${esc(value)}</strong><span>${esc(note)}</span></div>`;
}

/** 任务状态小指标。 */
function miniMetric(label: string, value: number, color: string): string {
  return `<div class="mini" style="--c:${color}"><label>${esc(label)}</label><strong>${formatInt(value)}</strong></div>`;
}

/** 平台概览指标。 */
function platformItem(label: string, value: number): string {
  return `<div class="platform-item" style="--c:#111827"><label>${esc(label)}</label><strong>${formatInt(value)}</strong></div>`;
}

/** Bot 汇总指标。 */
function botStat(label: string, value: number, color: string): string {
  return `<div class="bot-stat" style="--c:${color}"><label>${esc(label)}</label><strong>${formatInt(value)}</strong></div>`;
}

/** 来源行展示任务分布和成功占比。 */
function sourceRow(source: PublicStatusResponse['sources'][number]): string {
  const terminal = source.success + source.failed;
  const pct = terminal > 0 ? Math.max(0, Math.min(100, (source.success / terminal) * 100)) : 0;
  return `<div class="source-row">
    <div class="source-name">${esc(sourceLabel(source.source))}</div>
    <div class="bar"><div class="bar-fill" style="--p:${pct.toFixed(1)}%"></div></div>
    <div class="source-num">${formatInt(source.total)} / ${formatInt(source.failed)}败</div>
  </div>`;
}

/** 服务健康小格。 */
function serviceNode(service: PublicServiceHealthView): string {
  const color = service.ok ? '#059669' : '#dc2626';
  return `<div class="service-node" style="--c:${color}">
    <div class="service-title"><b>${esc(service.label || service.name)}</b><span class="service-dot"></span></div>
    <div class="service-meta"><span>${service.ok ? formatUptime(service.uptimeSec) : shorten(service.error, 14, '离线')}</span><span>${formatDuration(service.latencyMs)}</span></div>
    <div class="service-meta" style="margin-top:2px"><span>${esc(shorten(service.version, 14, '无版本'))}</span><span>${service.statusCode ?? '-'}</span></div>
  </div>`;
}

/** 实时 Bot 连接行。 */
function botRow(bot: InfoBot): string {
  const qq = textValue(bot.selfId, '0');
  const avatar = bot.avatarUrl || `https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=100`;
  return `<div class="bot-row">
    <img src="${esc(avatar)}" onerror="this.style.display='none'">
    <div style="min-width:0">
      <div class="bot-name">${esc(bot.nickname || qq)}</div>
      <div class="bot-sub">${esc(qq)} · ${formatDuration(bot.uptimeMs)}</div>
    </div>
  </div>`;
}

/** 绘图站点统计卡。 */
function siteCard(site: PublicSiteRuntimeView): string {
  const state = siteState(site);
  const lifetimeRate = site.lifetimeCalls > 0 ? (site.lifetimeSuccess / site.lifetimeCalls) * 100 : null;
  return `<div class="site-card">
    <div class="site-head">
      <div class="site-name"><i style="--c:${state.color}"></i><span>${esc(site.name)}</span></div>
      <span class="site-state" style="--c:${state.color};--bg:${state.bg}">${esc(state.text)}</span>
    </div>
    <div class="site-metrics">
      ${siteMetric('尝试', formatInt(site.attempts))}
      ${siteMetric('成功率', formatPercent(site.successRate), rateColor(site.successRate))}
      ${siteMetric('耗时', formatDuration(site.avgLatencyMs))}
    </div>
    <div class="site-metrics">
      ${siteMetric('成功/失败', `${formatInt(site.success)}/${formatInt(site.failed)}`, site.failed > 0 ? '#f59e0b' : '#059669')}
      ${siteMetric('运行中', formatInt(site.active), site.active > 0 ? '#7c3aed' : '#64748b')}
      ${siteMetric('连败', formatInt(site.consecutiveFailures), site.consecutiveFailures > 0 ? '#dc2626' : '#64748b')}
    </div>
    <div class="site-foot">
      <span>权重 ${formatInt(site.weight)}</span>
      <span>并发 ${formatInt(site.maxConcurrency)}</span>
      <span>累计 ${formatPercent(lifetimeRate)}</span>
    </div>
  </div>`;
}

/** 站点指标单元。 */
function siteMetric(label: string, value: string, color?: string): string {
  return `<div class="site-metric"><label>${esc(label)}</label><strong${color ? ` style="color:${color}"` : ''}>${esc(value)}</strong></div>`;
}

/** 最近错误行。 */
function errorRow(error: InfoError): string {
  const title = [error.siteName, shorten(error.error, 34, '未知错误')].filter(Boolean).join(' · ');
  const sub = [shorten(error.prompt, 42, '未记录提示词'), timeText(error.createdAt, 5, 16)].filter((item) => item && item !== '-').join(' · ');
  return `<div class="error-row"><div class="error-title">${esc(title)}</div><div class="error-sub">${esc(sub)}</div></div>`;
}

/** 空态行。 */
function emptyLine(text: string): string {
  return `<div class="empty">${esc(text)}</div>`;
}

/** 来源中文标签。 */
function sourceLabel(source: string): string {
  const map: Record<string, string> = { web: '网页', bot: 'QQ Bot', api: 'API', workflow: '工作流' };
  return map[source] ?? source;
}

/** 状态区间中文标签。 */
function rangeLabel(range: PublicStatusResponse['range']): string {
  if (range === '1h') return '近 1 小时';
  if (range === '7d') return '近 7 天';
  return '近 24 小时';
}

/** 站点运行状态推断，完全基于状态页真实字段。 */
function siteState(site: PublicSiteRuntimeView): { text: string; color: string; bg: string } {
  if (!site.isEnabled) return { text: '停用', color: '#64748b', bg: '#f1f5f9' };
  if (site.autoDisabledUntil) return { text: '自动禁用', color: '#f59e0b', bg: '#fffbeb' };
  if (site.consecutiveFailures >= 3 || (site.successRate != null && site.successRate < 80)) return { text: '异常', color: '#dc2626', bg: '#fef2f2' };
  if (site.active > 0) return { text: '运行中', color: '#7c3aed', bg: '#f5f3ff' };
  if (site.successRate == null) return { text: '待观察', color: '#64748b', bg: '#f1f5f9' };
  return { text: site.successRate >= 95 ? '健康' : '波动', color: site.successRate >= 95 ? '#059669' : '#f59e0b', bg: site.successRate >= 95 ? '#ecfdf5' : '#fffbeb' };
}

/** 百分比颜色分级。 */
function rateColor(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '#64748b';
  if (value >= 95) return '#059669';
  if (value >= 80) return '#f59e0b';
  return '#dc2626';
}

/** 统计服务平均探活延迟。 */
function averageLatency(services: PublicServiceHealthView[]): number | null {
  const values = services.map((service) => service.latencyMs).filter((value): value is number => typeof value === 'number' && value >= 0);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

/** 统计绘图站点平均耗时。 */
function averageSiteLatency(sites: PublicSiteRuntimeView[]): number | null {
  const values = sites.map((site) => site.avgLatencyMs).filter((value): value is number => typeof value === 'number' && value > 0);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

/** 格式化整数。 */
function formatInt(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)).toLocaleString('zh-CN') : '0';
}

/** 格式化百分比。 */
function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '-' : `${value.toFixed(1)}%`;
}

/** 格式化耗时。 */
function formatDuration(ms: unknown): string {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

/** 格式化服务运行时间。 */
function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '-';
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

/** 状态页时间范围短文本。 */
function formatTimeRange(since: string, generatedAt: string): string {
  const left = timeText(since, 5, 16);
  const right = timeText(generatedAt, 5, 16);
  return `${left} - ${right}`;
}

/** 安全截断展示文本。 */
function shorten(value: unknown, max: number, fallback = ''): string {
  const text = textValue(value, fallback);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
