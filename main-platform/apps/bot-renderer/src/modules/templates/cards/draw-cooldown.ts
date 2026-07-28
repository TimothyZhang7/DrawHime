import { Icons } from '../icons.js';
import { renderCard, T, esc } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 冷却等待提示卡片
 */

export type Data = { remainingSec: number; cmdPrefix?: string };

export function render(d: Data): string {
  const P = d.cmdPrefix ?? '';
  const m = Math.floor(d.remainingSec / 60);
  const s = d.remainingSec % 60;
  return renderCard({ submitter: (d as any).submitter,
    accent: '#f59e0b',
    icon: Icons.cooldown,
    layout: 'compact',
    hero: {
      eyebrow: 'Cooldown · 冷却中',
      title: '请稍候',
      subtitle: '冷却保护保证绘图服务稳定运行',
      rightContent: `<div class="counter"><div class="counter-num">${m}<span style="font-size:14px">分</span> ${String(s).padStart(2, '0')}<span style="font-size:14px">秒</span></div><div class="counter-label">剩余时间</div></div>`,
    },
    body: `
      <div class="grid">
        <div class="meta wide"><div class="label">状态</div><div class="value" style="color:${T.amber}">冷却保护中，请耐心等待</div></div>
      </div>
      <div class="sbox amber"><div class="sbox-label" style="color:${T.amber}">提示</div>冷却结束后可继续使用 ${P}绘图 命令</div>`,
    footer: ['每个用户连续请求间需间隔特定秒数'],
    title: '冷却中',
  });
}
