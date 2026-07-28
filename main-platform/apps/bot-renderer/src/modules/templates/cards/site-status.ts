import { Icons } from '../icons.js';
import { renderCard, T, esc, arrayValue, textValue, timeText } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 站点健康状态卡片
 * 对齐 V2 status card: 站点列表 + 范围统计 + 并发 + 平均延迟
 */
export type Data = {
  sites: { name: string; model?: string; isEnabled: boolean; consecutiveFailures: number; successRate?: number; inProgressCount?: number; avgLatencyMs?: number; disabledUntil?: string; }[];
  rangeLabel?: string; generatedAt?: string; inProgressTotal?: number; recentTotal?: number;
  failThreshold?: number; warnThreshold?: number;
};
export function render(d: Data): string {
  // 站点状态允许 backend 短暂返回空列表，Bot 侧仍应得到清晰的空态卡片。
  const sites = arrayValue<Data['sites'][number]>(d.sites);
  const total = sites.length;
  const enabledCount = sites.filter(s => s.isEnabled).length;
  const failThreshold = d.failThreshold ?? 3;
  const warnThreshold = d.warnThreshold ?? 95;
  const rows = sites.map(s => {
    const dot = !s.isEnabled ? T.muted : s.consecutiveFailures >= failThreshold ? T.red : (s.successRate ?? 100) >= warnThreshold ? T.green : T.amber;
    const stat = s.isEnabled
      ? (s.consecutiveFailures > 0 ? `${s.consecutiveFailures}连败` : s.successRate != null ? `${s.successRate.toFixed(0)}%` : '正常')
      : (s.disabledUntil ? `停用至 ${timeText(s.disabledUntil, 11, 16)}` : '已停用');
    return `<div class="irow">
      <span style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        <span style="width:8px;height:8px;border-radius:50%;background:${dot};flex-shrink:0"></span>
        <span class="ilabel" style="flex:1">${esc(s.name)}${s.model?` · ${esc(s.model)}`:''}</span>
        ${s.inProgressCount!=null?`<span style="font-size:10px;color:${T.primary};font-weight:600">${s.inProgressCount}进行中</span>`:''}
        ${s.avgLatencyMs!=null?`<span style="font-size:10px;color:${T.muted}">${s.avgLatencyMs.toFixed(0)}ms</span>`:''}
      </span>
      <span class="ivalue" style="color:${dot};flex-shrink:0">${stat}</span>
    </div>`;
  }).join('');

  const subtitleParts = [`${textValue(d.rangeLabel, '实时')}监控`, `启用 ${enabledCount}/${total} 站点`];
  if (d.inProgressTotal != null) subtitleParts.push(`${d.inProgressTotal}进行中`);
  if (d.recentTotal != null) subtitleParts.push(`${d.recentTotal}近1h任务`);

  return renderCard({ submitter: (d as any).submitter,
    accent: '#3b82f6',
    icon: Icons.siteStatus,
    layout: 'default',
    hero: {
      eyebrow: 'System · Status',
      title: '站点状态',
      subtitle: subtitleParts.join(' · '),
    },
    body: `
      <div style="margin-bottom:10px">${rows || `<div style="text-align:center;padding:16px;color:${T.muted};font-size:12px">暂无站点状态</div>`}</div>
      ${d.generatedAt?`<div style="text-align:center;font-size:10px;color:${T.muted};margin-top:6px">生成于 ${timeText(d.generatedAt)}</div>`:''}`,
    footer: [`绿色≥${warnThreshold}% · 黄色<${warnThreshold}% · 红色≥${failThreshold}连败 · 灰色停用`],
    title: '站点状态',
  });
}
