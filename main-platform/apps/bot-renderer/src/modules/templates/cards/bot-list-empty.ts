/** 本文件渲染 Bot 控制台空态卡片，样式与 Bot 列表主卡保持一致。 */
import { Icons } from '../icons.js';
import { renderCard, T, esc } from '../shared-style-v2.js';

/** 空态卡片数据。 */
export type Data = { cmdPrefix?: string };

/** 渲染空态 Bot 卡片。 */
export function render(d: Data): string {
  const prefix = d.cmdPrefix ?? '';
  return renderCard({
    submitter: (d as any).submitter,
    accent: '#0f172a',
    icon: Icons.botListEmpty,
    layout: 'wide',
    title: 'Bot 控制台',
    hero: {
      eyebrow: 'System Console · Bots',
      title: '当前没有在线 Bot',
      subtitle: '连接状态、站点与任务统计会在有在线 Bot 时自动展示。',
    },
    body: `
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:10px">
        ${metric('在线连接', '0', '#2563eb', '#eff6ff')}
        ${metric('可用站点', '0', '#4f46e5', '#eef2ff')}
        ${metric('进行中任务', '0', '#7c3aed', '#f5f3ff')}
      </div>
      <div style="padding:18px 16px;border:0.5px dashed #cbd5e1;border-radius:8px;background:#f8fafc;text-align:center">
        <div style="font-size:13px;font-weight:950;color:${T.text}">暂无在线 Bot 连接</div>
        <div style="margin-top:6px;font-size:10.5px;font-weight:800;color:${T.muted}">请检查 OneBot、wsproxy 和 bot-service 的连接状态</div>
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;justify-content:center">
          <span style="height:17px;padding:2px 5px;border-radius:5px;background:#f1f5f9;color:${T.zinc};font-size:8px;font-weight:850">${esc(prefix)}bot list</span>
          <span style="height:17px;padding:2px 5px;border-radius:5px;background:#f1f5f9;color:${T.zinc};font-size:8px;font-weight:850">${esc(prefix)}状态</span>
          <span style="height:17px;padding:2px 5px;border-radius:5px;background:#f1f5f9;color:${T.zinc};font-size:8px;font-weight:850">${esc(prefix)}任务</span>
        </div>
      </div>
    `,
    footer: [`使用 ${prefix}bot list 重新检查`, `${prefix}状态 查看绘图站点`, `${prefix}任务 查看最近任务`],
  });
}

/** 空态数字块。 */
function metric(label: string, value: string, color: string, soft: string): string {
  return `<div style="padding:10px 12px;border:0.5px solid color-mix(in srgb,${color} 25%,#ffffff);border-radius:8px;background:${soft}">
    <div style="font-size:8.5px;font-weight:900;color:${T.zinc};letter-spacing:.05em">${esc(label)}</div>
    <div style="margin-top:4px;font-size:22px;line-height:1;font-weight:950;color:${color};font-family:ui-monospace,SFMono-Regular,Consolas,monospace">${esc(value)}</div>
  </div>`;
}
