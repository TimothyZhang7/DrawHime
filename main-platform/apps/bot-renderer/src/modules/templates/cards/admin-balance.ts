import { Icons } from '../icons.js';
import { renderCard, T, esc, fmt } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 管理员额度调整卡片
 */

export type Data = { qqNumber: string; amount: string; balanceAfter: string };

export function render(d: Data): string {
  const isPos = d.amount.startsWith('+');
  const amtColor = isPos ? T.green : T.red;
  return renderCard({ submitter: (d as any).submitter,
    accent: '#f97316',
    icon: Icons.adminBalance,
    layout: 'default',
    hero: {
      eyebrow: 'Admin · Balance',
      title: '额度调整',
      subtitle: `管理员操作 · QQ ${d.qqNumber}`,
      rightContent: `<span class="badge" style="background:${T.amberSoft};color:${T.amber}">管理</span>`,
    },
    body: `
      <div class="grid">
        <div class="meta"><div class="label">目标 QQ</div><div class="value">${esc(d.qqNumber)}</div></div>
        <div class="meta"><div class="label">调整金额</div><div class="value" style="color:${amtColor};font-weight:900">${esc(d.amount)}</div></div>
        <div class="meta"><div class="label">调整后余额</div><div class="value" style="color:${T.green};font-weight:900">¥${fmt(d.balanceAfter)}</div></div>
        <div class="meta"><div class="label">操作类型</div><div class="value" style="color:${amtColor}">${isPos ? '增加额度' : '扣减额度'}</div></div>
      </div>`,
    footer: ['管理员操作 · 已记录日志'],
    title: '额度调整',
  });
}
