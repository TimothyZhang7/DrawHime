import { Icons } from '../icons.js';
import { renderCard, T, esc, fmt, promptBox, submitterBlock, walletSummaryBlock, type CardLayout, arrayValue, shortText, textValue, timeText } from '../shared-style-v2.js';
/**
 * 绘图结果卡片 — 只提供内容，布局由 renderCard 统一处理
 */
export type Data = {
  prompt: string; mode: string; model: string; siteName: string;
  imageUrl?: string; latencySec: number; retryCount: number;
  chargedAmount: string; balanceAfter: string; balance?: { paidBalance: string; freeBalance: string };
  imageCount?: number; refImageUrls?: string[];
  submittedAt?: string; taskId?: string; clientRequestId?: string; detailUrl?: string;
  cmdPrefix?: string;
  pricePerGen?: string; chargedSource?: string;
  submitterProfile?: { avatarUrl?: string; userNickname?: string; nickname?: string; userId?: number; selfId?: number; binding?: { username: string } };
  attempts?: { attempt: number; siteName: string; model?: string; status: string; latencyMs?: number; error?: string }[];
};

export function render(d: Data): string {
  const isI2I = d.mode === 'image-to-image';
  const el = Number.isFinite(Number(d.latencySec)) ? Number(d.latencySec) : 0;
  const model = textValue(d.model, 'auto');
  const siteName = textValue(d.siteName, 'auto');
  const freeRemain = d.balance?.freeBalance ?? null;
  const balanceTotal = d.balance ? fmt(Number(d.balance.freeBalance || 0) + Number(d.balance.paidBalance || 0)) : fmt(d.balanceAfter);
  const atts = arrayValue<NonNullable<Data['attempts']>[number]>(d.attempts);

  // ── Hero ──
  const h: CardLayout['hero'] = {
    eyebrow: `${isI2I ? 'Img2Img' : 'Draw'} · Complete`,
    title: '绘图完成',
    subtitle: `${model} · ${siteName}`,
    rightContent: `<span class="badge green">${d.retryCount > 0 ? `重试${d.retryCount}次成功` : '一次成功'}</span>`,
  };

  // ── Body ──
  const profileHtml = d.submitterProfile ? submitterBlock({
    qqNumber: String(d.submitterProfile.userId || d.submitterProfile.selfId || ''),
    nickname: d.submitterProfile.userNickname || d.submitterProfile.nickname,
    binding: d.submitterProfile.binding?.username,
    avatarUrl: d.submitterProfile.avatarUrl,
  }) : '';

  const refs = arrayValue<string>(d.refImageUrls).slice(0, 3);
  const refsHTML = isI2I && refs.length > 0 ? `
  <div class="refs">${refs.map((u,i)=>`
    <div class="ref-card"><div class="ref-index">${i+1}</div>
    <img src="${esc(u)}" alt="Ref${i+1}" onerror="this.closest('.ref-card')?.remove()" />
    </div>`).join('')}</div>` : '';

  const attemptRows = atts.length > 0 ? atts.map(a => `
    <div class="irow">
      <span style="display:flex;align-items:center;gap:6px">
        <span style="width:7px;height:7px;border-radius:50%;background:${a.status==='success'?T.green:T.red};flex-shrink:0"></span>
        <span class="ilabel">#${a.attempt} ${esc(a.siteName)}${a.model?' · '+esc(a.model):''}</span>
      </span>
      <span class="ivalue" style="font-size:11px">${a.latencyMs?(a.latencyMs/1000).toFixed(1)+'s':''}${a.error?' · '+esc(shortText(a.error,40)):''}</span>
    </div>`).join('') : '';

  const body = `
    ${profileHtml ? `<div style="margin-bottom:12px">${profileHtml}</div>` : ''}
    ${promptBox(d.prompt, 120)}
    ${refsHTML}
    ${d.imageUrl ? `<div style="text-align:center;margin:10px 0;background:${T.primarySoft};border-radius:10px;padding:6px;border:1px solid ${T.border}"><img src="${esc(d.imageUrl)}" alt="" style="max-width:100%;max-height:300px;border-radius:7px;object-fit:contain" /></div>` : ''}
    <div class="stat-row">
      <div class="stat-item"><span class="stat-num" style="color:${T.primary}">${el>=60?(el/60).toFixed(1)+'m':el.toFixed(1)+'s'}</span><span class="stat-lbl">耗时</span></div>
      <div class="stat-item"><span class="stat-num">${d.retryCount}</span><span class="stat-lbl">重试</span></div>
      <div class="stat-item"><span class="stat-num" style="color:${d.chargedSource==='free'?T.green:T.amber}">${d.chargedSource==='free'?'免费':'¥'+fmt(d.chargedAmount)}</span><span class="stat-lbl">费用</span></div>
      <div class="stat-item"><span class="stat-num" style="color:${T.green}">¥${balanceTotal}</span><span class="stat-lbl">可用余额${freeRemain!=null?' · 免'+freeRemain:''}</span></div>
    </div>
    ${d.balance ? walletSummaryBlock({
      freeBalance: d.balance.freeBalance,
      paidBalance: d.balance.paidBalance,
      sourceLabel: 'QQ 当前可访问余额',
      note: `本次费用：${d.chargedSource==='free' ? '免费额度' : '¥' + fmt(d.chargedAmount)}`,
    }) : ''}
    <div class="grid">
      <div class="meta"><div class="label">模型 / 站点</div><div class="value" style="font-size:14px">${esc(model)} · ${esc(siteName)}</div></div>
      <div class="meta"><div class="label">模式</div><div class="value" style="font-size:14px">${isI2I?`图生图${d.imageCount?' · '+d.imageCount+'张':''}`:'文生图'}</div></div>
      ${d.submittedAt?`<div class="meta"><div class="label">提交时间</div><div class="value" style="font-size:14px">${timeText(d.submittedAt)}</div></div>`:''}
      ${d.clientRequestId?`<div class="meta double"><div class="label">任务 ID</div><div class="value" style="font-size:12px;color:${T.muted}">#${esc(shortText(d.clientRequestId,20))}</div></div>`:''}
    </div>
    ${attemptRows?`<div style="margin-top:8px;padding:10px 14px;border:1px solid ${T.border};border-radius:8px;background:${T.bg}"><div class="label" style="margin-bottom:6px">重试记录</div>${attemptRows}</div>`:''}
  `;

  // ── Footer ──
  const footer = [siteName, `${d.cmdPrefix ?? ''}绘图 继续创作`];

  return renderCard({ submitter: (d as any).submitter,
    accent: '#10b981',
    icon: Icons.drawResult, hero: h, body, footer, title: '绘图结果' });
}
