import { Icons } from '../icons.js';
import { renderCard, T, esc, fmt, promptBox } from '../shared-style-v2.js';

export type Data = { prompt: string; error: string; balance?: string; maxAttempts?: number };

export function render(d: Data): string {
  return renderCard({ submitter: (d as any).submitter,
    accent: '#f59e0b',
    icon: Icons.errorRetryable,
    layout: 'default',
    hero: {
      eyebrow: 'Retry · 自动恢复',
      title: '重试中',
      subtitle: '系统自动切换站点和模型进行重试',
      rightContent: `<span class="badge" style="background:${T.amberSoft};color:${T.amber}">自动重试</span>`,
    },
    body: `
      ${promptBox(d.prompt, 100)}
      <div class="sbox red"><div class="sbox-label" style="color:${T.red}">错误信息</div>${esc(d.error)}</div>
      <div class="sbox amber"><div class="sbox-label" style="color:${T.amber}">自动处理</div>系统会自动切换站点和模型进行重试，请耐心等待</div>
      ${d.balance ? `
      <div class="grid"><div class="meta wide"><div class="label">当前余额</div><div class="value">¥${fmt(d.balance)}</div></div></div>` : ''}`,
    footer: d.maxAttempts ? [`最多尝试 ${d.maxAttempts} 个站点`] : [],
    title: '可重试错误',
  });
}
