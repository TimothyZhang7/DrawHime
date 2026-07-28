import { Icons } from '../icons.js';
import { renderCard, T, esc, promptBox, walletSummaryBlock, arrayValue, textValue, timeText } from '../shared-style-v2.js';

export type Data = {
  prompt: string;
  error: string;
  mode?: string;
  model?: string;
  siteName?: string;
  imageCount?: number;
  refImageUrls?: string[];
  totalLatencySec?: string;
  balance?: { paidBalance: string; freeBalance: string } | string;
  submittedAt?: string;
  allAttempts?: {
    attempt: number;
    siteName: string;
    model?: string;
    status: string;
    latencyMs?: number;
    error?: string;
  }[];
};

export function render(d: Data): string {
  const attempts = arrayValue<NonNullable<Data['allAttempts']>[number]>(d.allAttempts);
  const ml = d.mode === 'image-to-image' ? `图生图${d.imageCount ? ' · ' + d.imageCount + '张' : ''}` : '文生图';
  const refs = arrayValue<string>(d.refImageUrls).slice(0, 3);
  const isI2I = d.mode === 'image-to-image';
  const balObj = typeof d.balance === 'object' && d.balance ? d.balance as { paidBalance: string; freeBalance: string } : null;
  const balStr = typeof d.balance === 'string' ? d.balance : '';
  const model = textValue(d.model);
  const siteName = textValue(d.siteName);

  // 累计耗时（每次尝试的开始到该尝试结束的总耗时）
  let cumulativeMs = 0;
  const attemptRows = attempts.length > 0 ? attempts.map(a => {
    cumulativeMs += (a.latencyMs || 0);
    const dur = a.latencyMs ? a.latencyMs >= 1000 ? (a.latencyMs/1000).toFixed(1)+'s' : a.latencyMs+'ms' : '-';
    const cum = cumulativeMs >= 60000 ? (cumulativeMs/60000).toFixed(1)+'m' : (cumulativeMs/1000).toFixed(1)+'s';
    return `
    <div class="attempt-block" style="padding:6px 0;border-bottom:0.5px solid ${T.border}">
      <div style="display:flex;align-items:center;gap:6px;font-size:11px">
        <span style="width:7px;height:7px;border-radius:99px;background:${a.status==='success'?T.green:T.red};flex-shrink:0"></span>
        <span style="font-weight:700;color:${T.text}">#${a.attempt} ${esc(a.siteName)}${a.model?' · '+esc(a.model):''}</span>
        <span style="color:${T.muted};margin-left:auto;flex-shrink:0;font-size:10px">该次 ${dur} · 累计 ${cum}</span>
      </div>
      ${a.error ? `<div style="margin-top:3px;margin-left:13px;font-size:11px;color:${T.red};line-height:1.5;word-break:break-word">${esc(a.error)}</div>` : ''}
    </div>`;
  }).join('') : '';

  const refsHTML = isI2I && refs.length > 0 ? `
  <div class="refs">${refs.map((u, i) => `
    <div class="ref-card">
      <div class="ref-index">${i + 1}</div>
      <img src="${esc(u)}" alt="参考图${i + 1}" onerror="this.closest('.ref-card')?.remove()" />
    </div>`).join('')}</div>` : '';

  return renderCard({ submitter: (d as any).submitter,
    accent: '#ef4444',
    icon: Icons.errorFatal,
    layout: 'default',
    hero: {
      eyebrow: 'Error · Fatal',
      title: `绘图失败 · ${attempts.length}次尝试`,
      subtitle: [model, siteName, d.totalLatencySec ? d.totalLatencySec+'s' : ''].filter(Boolean).join(' · '),
      rightContent: `<span class="badge red">全部失败</span>`,
    },
    body: `
      ${promptBox(d.prompt, 120)}
      ${refsHTML}
      ${balObj ? walletSummaryBlock({
        freeBalance: balObj.freeBalance,
        paidBalance: balObj.paidBalance,
        sourceLabel: '失败后当前可访问余额',
        note: '如任务已扣费，失败退款会按实际扣费来源原路退回。',
      }) : ''}
      <div class="grid">
        ${ml ? `<div class="meta"><div class="label">模式</div><div class="value">${esc(ml)}</div></div>` : ''}
        ${(!balObj && balStr) ? `<div class="meta"><div class="label">余额</div><div class="value">¥${esc(balStr)}</div></div>` : ''}
        ${d.submittedAt ? `<div class="meta"><div class="label">提交时间</div><div class="value">${timeText(d.submittedAt)}</div></div>` : ''}
      </div>
      ${attemptRows ? `<div style="margin-top:10px">${attemptRows}</div>` : ''}`,
    footer: [`共尝试 ${attempts.length} 次，全部失败`, '请修改提示词后重新提交'],
    title: '最终失败',
  });
}
