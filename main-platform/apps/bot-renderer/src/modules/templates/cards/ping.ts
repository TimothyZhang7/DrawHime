import { Icons } from '../icons.js';
import { renderCard, T, esc } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — Bot Ping 延迟展示卡片
 */

export type Data = {
  botName: string;
  uptime: string;
  pingMs: number;
  memory?: string;
  nodeVersion?: string;
};

export function render(d: Data): string {
  return renderCard({ submitter: (d as any).submitter,
    accent: '#3b82f6',
    icon: Icons.ping,
    layout: 'compact',
    hero: {
      eyebrow: 'System · Ping',
      title: d.botName,
      subtitle: `延迟 ${d.pingMs}ms · 运行 ${d.uptime}`,
      rightContent: `<div class="counter"><div class="counter-num">${d.pingMs}<span style="font-size:14px">ms</span></div><div class="counter-label">延迟</div></div>`,
    },
    body: `
      <div class="grid">
        <div class="meta"><div class="label">状态</div><div class="value" style="color:${T.green}">一切正常 · 在线</div></div>
        <div class="meta"><div class="label">内存</div><div class="value">${esc(d.memory || '-')}</div></div>
        <div class="meta"><div class="label">引擎</div><div class="value">Node ${esc(d.nodeVersion || '-')}</div></div>
        <div class="meta"><div class="label">运行时长</div><div class="value">${esc(d.uptime)}</div></div>
      </div>`,
    footer: [d.botName],
    title: 'Ping',
  });
}
