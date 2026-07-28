import { Icons } from '../icons.js';
import { renderCard, T, esc, fmt, shortText, textValue, walletSummaryBlock, arrayValue } from '../shared-style-v2.js';
/**
 * 任务提交卡片 — 展示用户提交的完整参数和扣费后余额
 */

export type Data = {
  taskId?: string;
  prompt: string;
  mode?: string;
  model?: string;
  siteName?: string;
  charged?: boolean;
  chargedAmount?: string;
  paidBalance?: string;
  freeBalance?: string;
  imageCount?: number;
  sourceImageUrls?: string[];
  maxAttempts?: number;
  estimatedPrice?: string;
  size?: string;
  quality?: string;
  isPrivate?: boolean;
  binding?: { username: string; userId: number };
  qqNumber?: string;
};

export function render(d: Data): string {
  const isI2I = d.mode === 'image-to-image';
  const modeText = isI2I ? '图生图' : '文生图';
  // Bot 渲染入口允许后台探测和失败兜底复用，缺少 prompt 时仍应返回可用卡片。
  const prompt = textValue(d.prompt, '未提供提示词');
  const userText = d.binding
    ? `${esc(d.binding.username)}（QQ ${d.qqNumber || ''}）`
    : `QQ ${d.qqNumber || ''}`;
  const refs = arrayValue<string>(d.sourceImageUrls);
  const privacyText = d.isPrivate ? '私密' : '公开';
  const privacyColor = d.isPrivate ? T.muted : T.green;

  const refsHtml = refs.length > 0
    ? `<div class="refs submit-refs refs-count-${Math.min(refs.length, 4)}">${refs.map((url, i) => `<div class="ref-card"><div class="ref-index">${i + 1}</div><img src="${esc(url)}" alt="参考图${i + 1}" onerror="this.closest('.ref-card')?.remove()" /></div>`).join('')}</div>`
    : '';

  return renderCard({ submitter: (d as any).submitter,
    accent: '#8b5cf6',
    icon: Icons.drawSubmit,
    layout: 'wide',
    hero: {
      eyebrow: 'Draw · 任务提交',
      title: '绘图任务已提交',
      subtitle: `${modeText}${d.model ? ' · ' + d.model : ''}${d.maxAttempts ? ' · 最多' + d.maxAttempts + '次尝试' : ''}`,
      rightContent: d.charged
        ? `<span class="badge amber">-¥${fmt(d.chargedAmount)}</span>`
        : `<span class="badge green">免费</span>`,
    },
    // 提交卡片单独固定参考图框，避免通用卡片网格在截图时因为图片比例变化导致裁切。
    extraCSS: `
      .draw-submit-card .submit-refs{grid-template-columns:repeat(auto-fill,220px);justify-content:start;align-items:start}
      .draw-submit-card .submit-refs .ref-card{width:220px;min-height:188px}
      .draw-submit-card .submit-refs .ref-card img{width:208px;height:176px;object-fit:contain}
      .draw-submit-card .submit-refs.refs-count-1{grid-template-columns:320px}
      .draw-submit-card .submit-refs.refs-count-1 .ref-card{width:320px;min-height:272px}
      .draw-submit-card .submit-refs.refs-count-1 .ref-card img{width:308px;height:260px;object-fit:contain}
    `,
    body: `<div class="draw-submit-card">
      <div class="grid">
        <div class="meta wide"><div class="label">提示词</div><div class="value" style="font-size:13px">${esc(shortText(prompt, 120))}</div></div>
        <div class="meta"><div class="label">模式</div><div class="value">${esc(modeText)}${isI2I && d.imageCount ? ' · ' + d.imageCount + ' 张参考图' : ''}</div></div>
        <div class="meta"><div class="label">状态</div><div class="value" style="color:${privacyColor}">${privacyText}</div></div>
        <div class="meta"><div class="label">模型</div><div class="value">${esc(d.model || '')}</div></div>
        ${d.charged ? `<div class="meta"><div class="label">本次扣费</div><div class="value" style="color:${T.amber}">-¥${fmt(d.chargedAmount)}</div></div>` : `<div class="meta"><div class="label">本次费用</div><div class="value" style="color:${T.green}">免费</div></div>`}
        ${d.size ? `<div class="meta"><div class="label">尺寸</div><div class="value">${esc(d.size)}</div></div>` : ''}
        ${d.quality ? `<div class="meta"><div class="label">质量</div><div class="value">${esc(d.quality)}</div></div>` : ''}
        <div class="meta"><div class="label">用户</div><div class="value" style="font-size:12px">${userText}</div></div>
      </div>
      ${walletSummaryBlock({
        freeBalance: d.freeBalance,
        paidBalance: d.paidBalance,
        sourceLabel: d.binding ? 'QQ + 已绑定 Web 可访问余额' : 'QQ 钱包可访问余额',
        note: d.charged ? `提交后余额，已扣 ¥${fmt(d.chargedAmount)}` : '本次未扣费，余额未变化',
      })}
      ${refsHtml}
      </div>`,
    footer: d.maxAttempts ? [`任务将依次尝试最多 ${d.maxAttempts} 个站点直至成功`, `发送 #任务 查看进度`] : [`发送 #任务 查看进度`],
    title: '绘图任务提交',
  });
}
