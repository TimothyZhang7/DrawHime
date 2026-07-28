import { Icons } from '../icons.js';
import { renderCard, T, esc, walletBreakdownBlock, walletSummaryBlock, type WalletSourceView } from '../shared-style-v2.js';

export type Data = {
  freeBalance: string;
  paidBalance: string;
  qqNumber: string;
  totalBalance?: string;
  primaryWallet?: WalletSourceView;
  linkedWallet?: WalletSourceView;
  linkedUsername?: string;
  linkedUserId?: number;
};

export function render(d: Data): string {
  const free = Number(d.freeBalance || '0');
  const paid = Number(d.paidBalance || '0');
  const total = d.totalBalance ?? (free + paid).toFixed(2);
  const boundLabel = d.linkedWallet ? 'QQ + 已绑定 Web 可访问余额' : 'QQ 钱包可访问余额';
  const linkedText = d.linkedWallet
    ? `${d.linkedUsername || '已绑定 Web'}${d.linkedUserId ? ` · ID ${d.linkedUserId}` : ''}`
    : '未绑定 Web';

  return renderCard({ submitter: (d as any).submitter,
    accent: '#10b981',
    icon: Icons.balance,
    layout: 'compact',
    hero: {
      eyebrow: 'Account · Balance',
      title: '余额查询',
      subtitle: `QQ ${d.qqNumber}`,
    },
    body: `
      ${walletSummaryBlock({
        freeBalance: d.freeBalance,
        paidBalance: d.paidBalance,
        sourceLabel: boundLabel,
        note: d.linkedWallet ? '扣费顺序：先用 QQ 钱包免费余额，再用绑定 Web 钱包免费余额，之后再扣付费余额。' : '扣费顺序：先免费余额，再付费余额。',
      })}
      ${walletBreakdownBlock({
        primaryWallet: d.primaryWallet,
        linkedWallet: d.linkedWallet,
        linkedUsername: d.linkedUsername,
        qqNumber: d.qqNumber,
      })}
      <div class="grid">
        <div class="meta"><div class="label">QQ</div><div class="value" style="font-size:14px">${esc(d.qqNumber)}</div></div>
        <div class="meta"><div class="label">绑定</div><div class="value" style="font-size:14px">${esc(linkedText)}</div></div>
        <div class="meta"><div class="label">可访问合计</div><div class="value" style="font-size:14px;color:${T.green}">¥${esc(total)}</div></div>
      </div>`,
    footer: ['QQ 和 Web 是独立钱包，绑定后互通可用但不合并', '每日免费余额按身份钱包独立发放'],
    title: '余额查询',
  });
}
