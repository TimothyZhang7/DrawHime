import { Icons } from '../icons.js';
import { renderCard, T, esc, fmt } from '../shared-style-v2.js';

export type Data = { qqNumber: string; paidBalance: string; freeBalance?: string; cmdPrefix?: string };

export function render(d: Data): string {
  const P = d.cmdPrefix ?? '';
  return renderCard({ submitter: (d as any).submitter,
    accent: '#14b8a6',
    icon: Icons.bindSuccess,
    layout: 'compact',
    hero: {
      eyebrow: 'Account · Bind',
      title: '绑定成功',
      subtitle: `QQ ${d.qqNumber}`,
      rightContent: `<span class="badge green">已绑定</span>`,
    },
    body: `
      <div class="grid">
        <div class="meta"><div class="label">QQ 号</div><div class="value">${esc(d.qqNumber)}</div></div>
        <div class="meta"><div class="label">付费余额</div><div class="value" style="color:${T.green}">¥${fmt(d.paidBalance)}</div></div>
        ${d.freeBalance ? `<div class="meta"><div class="label">免费余额</div><div class="value" style="color:${T.green}">¥${fmt(d.freeBalance)}</div></div>` : ''}
        <div class="meta"><div class="label">状态</div><div class="value" style="color:${T.green}">可正常使用</div></div>
      </div>
      <div style="text-align:center;font-size:13px;color:${T.muted};margin-top:8px">可使用 ${P}绘图 ${P}余额 ${P}模型 等命令</div>`,
    footer: [],
    title: '绑定成功',
  });
}
