import { Icons } from '../icons.js';
import { renderCard, T, esc } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 隐私设为公开卡片
 */

export type Data = { cmdPrefix?: string };

export function render(d: Data): string {
  const P = d.cmdPrefix ?? '';
  return renderCard({ submitter: (d as any).submitter,
    accent: '#64748b',
    icon: Icons.privacyPublic,
    layout: 'compact',
    hero: {
      eyebrow: 'Privacy · Public',
      title: '图片隐私 · 公开',
      subtitle: '设置已更新',
      rightContent: `<span class="badge green">公开</span>`,
    },
    body: `
      <div class="grid">
        <div class="meta wide"><div class="label">隐私设置</div><div class="value" style="color:${T.green}">公开可见</div></div>
      </div>
      <div class="sbox green"><div class="sbox-label" style="color:${T.green}">说明</div>后续生成的图片将公开可见，会出现在图库中</div>
      <div style="text-align:center;font-size:13px;color:${T.muted};margin-top:8px">使用 ${P}隐私 切换设置</div>`,
    footer: [`${P}隐私 public · 公开所有图片`],
    title: '设为公开',
  });
}
