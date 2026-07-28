import { Icons } from '../icons.js';
import { renderCard, T, esc } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 模型切换确认卡片
 */

export type Data = { modelName: string; cmdPrefix?: string };

export function render(d: Data): string {
  const P = d.cmdPrefix ?? '';
  return renderCard({ submitter: (d as any).submitter,
    accent: '#06b6d4',
    icon: Icons.modelSwitched,
    layout: 'compact',
    hero: {
      eyebrow: 'Model · Switched',
      title: '模型已切换',
      subtitle: '后续绘图将默认使用此模型',
      rightContent: `<span class="badge green">已更新</span>`,
    },
    body: `
      <div class="grid">
        <div class="meta wide"><div class="label">当前首选模型</div><div class="value" style="font-size:20px;font-weight:900;color:${T.primary}">${esc(d.modelName)}</div></div>
      </div>
      <div class="sbox green"><div class="sbox-label" style="color:${T.green}">确认</div>后续 ${P}绘图 命令将默认使用此模型</div>`,
    footer: [`可在 ${P}绘图 时临时指定其他模型`],
    title: '模型切换',
  });
}
