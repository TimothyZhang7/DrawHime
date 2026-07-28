import { Icons } from '../icons.js';
import { renderCard, T, esc, walletSummaryBlock } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 余额不足提示卡片
 */

export type Data = { freeBalance?: string; paidBalance?: string; cmdPrefix?: string };

export function render(d: Data): string {
  const fb = d.freeBalance ?? '0';
  const pb = d.paidBalance ?? '0';
  const total = (Number(fb) + Number(pb)).toFixed(2);
  return renderCard({ submitter: (d as any).submitter,
    accent: '#ef4444',
    icon: Icons.quota,
    layout: 'compact',
    hero: {
      eyebrow: 'Quota · 余额',
      title: '余额不足',
      subtitle: '当前可用余额不足以支付本次生成',
      rightContent: `<div class="counter" style="border-color:${T.redBorder}"><div class="counter-num" style="color:${T.red}">¥${esc(total)}</div><div class="counter-label">可用余额</div></div>`,
    },
    body: `
      ${walletSummaryBlock({
        freeBalance: fb,
        paidBalance: pb,
        sourceLabel: 'QQ 当前可访问余额',
        note: '当前总额不足以支付本次生成。',
      })}
      <div class="sbox amber"><div class="sbox-label" style="color:${T.amber}">提示</div>每日免费余额按身份钱包发放 · 发送 ${esc(d.cmdPrefix ?? '')}余额 查看详情 · 可在网页端购买或兑换付费余额</div>`,
    footer: [],
    title: '余额不足',
  });
}
