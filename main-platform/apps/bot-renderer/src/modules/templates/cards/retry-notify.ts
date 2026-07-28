import { Icons } from '../icons.js';
import { renderCard, T, esc, promptBox, arrayValue, shortText, textValue } from '../shared-style-v2.js';

export type Data = {
  prompt?: string;
  type: string;
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  siteName: string;
  nextSiteName?: string;
  model: string;
  error: string;
  imageCount?: number;
  refImageUrls?: string[];
  previousAttempts?: {
    attempt: number;
    siteName: string;
    model?: string;
    status: string;
    latencyMs?: number;
    error?: string;
  }[];
};

export function render(d: Data): string {
  const isX = d.type === 'cross_site' || (d.nextSiteName && d.nextSiteName !== d.siteName);
  const maxAttempts = Math.max(1, Number.isFinite(Number(d.maxAttempts)) ? Number(d.maxAttempts) : 1);
  const nextAttempt = Math.max(1, Number.isFinite(Number(d.nextAttempt)) ? Number(d.nextAttempt) : 1);
  const siteName = textValue(d.siteName, 'auto');
  const model = textValue(d.model);
  const prevs = arrayValue<NonNullable<Data['previousAttempts']>[number]>(d.previousAttempts).slice(-(maxAttempts - 1)); // 最多 maxAttempts-1 条
  const refs = arrayValue<string>(d.refImageUrls).slice(0, 3);

  let cumulativeMs = 0;
  const prevRows = prevs.length > 0 ? prevs.map(a => {
    cumulativeMs += (a.latencyMs || 0);
    const dur = a.latencyMs ? a.latencyMs >= 1000 ? (a.latencyMs/1000).toFixed(1)+'s' : a.latencyMs+'ms' : '-';
    const cum = cumulativeMs >= 60000 ? (cumulativeMs/60000).toFixed(1)+'m' : (cumulativeMs/1000).toFixed(1)+'s';
    return `
    <div class="attempt-block" style="padding:5px 0;border-bottom:0.5px solid ${T.border}">
      <div style="display:flex;align-items:center;gap:6px;font-size:11px">
        <span style="width:7px;height:7px;border-radius:99px;background:${T.red};flex-shrink:0"></span>
        <span style="font-weight:700;color:${T.text}">#${a.attempt} ${esc(a.siteName)}${a.model?' · '+esc(a.model):''}</span>
        <span style="color:${T.muted};margin-left:auto;flex-shrink:0;font-size:10px">${dur} · 累计 ${cum}</span>
      </div>
      ${a.error ? `<div style="margin-top:2px;margin-left:13px;font-size:10.5px;color:${T.red};line-height:1.4;word-break:break-word">${esc(shortText(a.error, 200))}</div>` : ''}
    </div>`;
  }).join('') : '';

  const refsHTML = refs.length > 0 ? `
  <div class="refs">${refs.map((u, i) => `
    <div class="ref-card">
      <div class="ref-index">${i + 1}</div>
      <img src="${esc(u)}" alt="参考图${i + 1}" onerror="this.closest('.ref-card')?.remove()" />
    </div>`).join('')}</div>` : '';

  return renderCard({ submitter: (d as any).submitter,
    accent: '#f59e0b',
    icon: Icons.retry,
    layout: 'default',
    hero: {
      eyebrow: 'Retry · ' + (isX ? '换站重试' : '同站重试'),
      title: `第 ${nextAttempt}/${maxAttempts} 次尝试`,
      subtitle: `${esc(siteName)} → ${esc(d.nextSiteName || siteName)}${model ? ' · ' + model : ''}`,
      rightContent: `<div class="counter"><div class="counter-num">${nextAttempt}/${maxAttempts}</div><div class="counter-label">尝试</div></div>`,
    },
    body: `
      ${d.prompt ? promptBox(d.prompt, 100) : ''}
      ${refsHTML}
      ${prevRows ? `<div style="margin-top:8px;font-size:10px;font-weight:700;color:${T.muted};text-transform:uppercase;letter-spacing:.05em">此前尝试</div>${prevRows}` : ''}`,
    footer: [`系统自动重试中 · 最多 ${maxAttempts} 次`, `${nextAttempt}/${maxAttempts}`],
    title: '重试通知',
  });
}
