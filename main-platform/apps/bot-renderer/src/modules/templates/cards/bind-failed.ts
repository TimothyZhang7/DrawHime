import { Icons } from '../icons.js';
import { renderCard, T, esc } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 绑定失败通知卡片
 */

export type Data = { reason: string; cmdPrefix?: string };

export function render(d: Data): string {
  const pfx = d.cmdPrefix ?? '';
  return renderCard({ submitter: (d as any).submitter,
    accent: '#ef4444',
    icon: Icons.bindFailed,
    layout: 'compact',
    hero: {
      eyebrow: 'Account · Bind',
      title: '绑定失败',
      subtitle: '请检查验证码后重新尝试',
      rightContent: `<span class="badge red">失败</span>`,
    },
    body: `
      <div class="grid">
        <div class="meta wide"><div class="label">失败原因</div><div class="value" style="color:${T.red}">${esc(d.reason)}</div></div>
      </div>
      <div class="sbox amber"><div class="sbox-label" style="color:${T.amber}">下一步</div>请重新获取验证码后重试 ${esc(pfx)}绑定 &lt;新验证码&gt;</div>
      <div style="text-align:center;font-size:13px;color:${T.muted};margin-top:8px">如遇问题请联系管理员</div>`,
    footer: [],
    title: '绑定失败',
  });
}
