import { Icons } from '../icons.js';
import { renderCard, T, esc } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 隐私设为私密卡片
 */

export type Data = { cmdPrefix?: string };

export function render(d: Data): string {
  const P = d.cmdPrefix ?? '';
  return renderCard({ submitter: (d as any).submitter,
    accent: '#64748b',
    icon: Icons.privacyPrivate,
    layout: 'compact',
    hero: {
      eyebrow: 'Privacy · Private',
      title: '图片隐私 · 私密',
      subtitle: '设置已更新',
      rightContent: `<span class="badge" style="background:${T.muted}">私密</span>`,
    },
    body: `
      <div class="grid">
        <div class="meta wide"><div class="label">隐私设置</div><div class="value" style="color:${T.muted}">仅自己可见</div></div>
      </div>
      <div class="sbox" style="background:${T.bg};color:${T.text};border-color:${T.border}"><div class="sbox-label" style="color:${T.muted}">说明</div>后续生成的图片仅自己可见，不会出现在图库</div>
      <div style="text-align:center;font-size:13px;color:${T.muted};margin-top:8px">使用 ${P}隐私 切换设置</div>`,
    footer: [`${P}隐私 private · 仅自己可见`],
    title: '设为私密',
  });
}
