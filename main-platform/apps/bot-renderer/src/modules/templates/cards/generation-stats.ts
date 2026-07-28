/** 本文件渲染 Bot `/统计` 任务统计卡片，数据全部来自 backend 真实聚合接口。 */
import { Icons } from '../icons.js';
import { renderCard, T, arrayValue, esc, textValue, timeText } from '../shared-style-v2.js';

/** Bot 统计排行行，用于全站前 10 展示。 */
type RankItem = {
  rank: number;
  qqNumber: string;
  avatarUrl: string;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  todayTotal: number;
  lastTaskAt?: string;
};

/** Bot 统计卡片数据结构。 */
export type Data = {
  scope: 'mine' | 'all';
  qqNumber?: string;
  generatedAt?: string;
  buckets: {
    key: 'total' | 'today' | '7d';
    label: string;
    total: number;
    success: number;
    failed: number;
    active: number;
    successRate: number;
    imageToImage: number;
    textToImage: number;
    attempts: number;
    failedAttempts: number;
    avgLatencyMs?: number;
    chargedAmount: string;
  }[];
  ranking?: RankItem[];
};

/** 渲染 Bot 任务统计卡片。 */
export function render(d: Data): string {
  const buckets = arrayValue<Data['buckets'][number]>(d.buckets);
  const total = buckets.find((item) => item.key === 'total') ?? emptyBucket('累计');
  const today = buckets.find((item) => item.key === 'today') ?? emptyBucket('今日');
  const week = buckets.find((item) => item.key === '7d') ?? emptyBucket('近 7 日');
  const rows = arrayValue<RankItem>(d.ranking).slice(0, 10);
  const allScope = d.scope === 'all';

  const body = `
    <div class="stats-hero">
      <div class="stats-total">
        <div class="stats-kicker">${allScope ? '全站任务' : `QQ ${esc(d.qqNumber || '')}`}</div>
        <div class="stats-number">${formatInt(total.total)}</div>
        <div class="stats-sub">成功 ${formatInt(total.success)} · 失败 ${formatInt(total.failed)} · 进行中 ${formatInt(total.active)}</div>
      </div>
      <div class="stats-ring">
        <div class="ring-num">${formatPercent(total.successRate)}</div>
        <div class="ring-label">成功率</div>
      </div>
    </div>
    <div class="bucket-grid">
      ${bucketCard(today, '#10b981')}
      ${bucketCard(week, '#6366f1')}
      ${bucketCard(total, '#f59e0b')}
    </div>
    ${allScope ? rankingBlock(rows) : detailBlock(total)}
  `;

  return renderCard({
    submitter: (d as any).submitter,
    accent: allScope ? '#2563eb' : '#10b981',
    icon: Icons.stats,
    title: allScope ? '全站生成统计' : '我的生成统计',
    layout: 'wide',
    extraCSS: `
      :root{--w:${allScope ? '900px' : '820px'};--cp:18px 22px 22px}
      .stats-hero{display:grid;grid-template-columns:minmax(0,1fr) 116px;gap:12px;align-items:stretch;margin-bottom:12px}
      .stats-total{padding:16px 18px;border:0.5px solid #e5e7eb;border-radius:8px;background:linear-gradient(135deg,#f8fafc,#ffffff)}
      .stats-kicker{font-size:10px;font-weight:900;color:${T.muted};letter-spacing:.08em;text-transform:uppercase}
      .stats-number{margin-top:6px;font-size:42px;line-height:.95;font-weight:950;color:${T.text};font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .stats-sub{margin-top:8px;font-size:11px;font-weight:800;color:${T.zinc}}
      .stats-ring{display:flex;flex-direction:column;align-items:center;justify-content:center;border:0.5px solid #bfdbfe;border-radius:8px;background:#eff6ff}
      .ring-num{font-size:25px;font-weight:950;color:#2563eb;line-height:1}
      .ring-label{margin-top:6px;font-size:10px;font-weight:900;color:${T.muted}}
      .bucket-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-bottom:12px}
      .bucket{position:relative;overflow:hidden;padding:12px;border:0.5px solid #e5e7eb;border-radius:8px;background:#fff}
      .bucket:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c)}
      .bucket-title{font-size:11px;font-weight:950;color:${T.text}}
      .bucket-main{display:flex;align-items:flex-end;gap:6px;margin-top:8px}
      .bucket-num{font-size:24px;font-weight:950;line-height:1;color:var(--c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .bucket-rate{font-size:10px;font-weight:900;color:${T.zinc};padding-bottom:2px}
      .bucket-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin-top:10px}
      .mini{height:24px;padding:5px 6px;border-radius:6px;background:#f8fafc;font-size:9.5px;font-weight:800;color:${T.zinc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
      .detail{padding:10px;border:0.5px solid #e5e7eb;border-radius:8px;background:#f8fafc}
      .detail-label{font-size:9px;font-weight:900;color:${T.soft};letter-spacing:.06em;text-transform:uppercase}
      .detail-value{margin-top:5px;font-size:15px;font-weight:950;color:${T.text};line-height:1.15}
      .rank-list{display:grid;gap:6px}
      .rank-row{display:grid;grid-template-columns:34px 38px minmax(0,1fr) 72px 58px;align-items:center;gap:8px;padding:7px 9px;border:0.5px solid #eef0f2;border-radius:8px;background:#fff}
      .rank-no{font-size:13px;font-weight:950;color:${T.primary};font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-align:center}
      .rank-avatar{width:34px;height:34px;border-radius:7px;object-fit:cover;background:#e5e7eb}
      .rank-main{min-width:0}
      .rank-qq{font-size:12px;font-weight:950;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .rank-meta{margin-top:2px;font-size:9.5px;font-weight:800;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .rank-count{text-align:right;font-size:14px;font-weight:950;color:${T.text};font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .rank-rate{text-align:right;font-size:10px;font-weight:900;color:${T.green}}
    `,
    body,
    footer: [
      `生成于 ${timeText(d.generatedAt)}`,
      allScope ? '排行按累计任务数排序，仅统计带 QQ 的任务' : '统计只读真实任务记录',
    ],
  });
}

/** 构造空统计桶，保证接口异常降级时卡片仍能渲染。 */
function emptyBucket(label: string): Data['buckets'][number] {
  return { key: 'total', label, total: 0, success: 0, failed: 0, active: 0, successRate: 0, imageToImage: 0, textToImage: 0, attempts: 0, failedAttempts: 0, chargedAmount: '0.00' };
}

/** 渲染时间窗口统计小卡。 */
function bucketCard(bucket: Data['buckets'][number], color: string): string {
  return `<div class="bucket" style="--c:${color}">
    <div class="bucket-title">${esc(bucket.label)}</div>
    <div class="bucket-main"><div class="bucket-num">${formatInt(bucket.total)}</div><div class="bucket-rate">${formatPercent(bucket.successRate)}</div></div>
    <div class="bucket-meta">
      <div class="mini">成功 ${formatInt(bucket.success)}</div>
      <div class="mini">失败 ${formatInt(bucket.failed)}</div>
      <div class="mini">图生图 ${formatInt(bucket.imageToImage)}</div>
      <div class="mini">尝试 ${formatInt(bucket.attempts)}</div>
    </div>
  </div>`;
}

/** 渲染个人统计细节。 */
function detailBlock(bucket: Data['buckets'][number]): string {
  return `<div class="detail-grid">
    ${detail('文生图', formatInt(bucket.textToImage))}
    ${detail('图生图', formatInt(bucket.imageToImage))}
    ${detail('失败尝试', formatInt(bucket.failedAttempts))}
    ${detail('平均耗时', formatDuration(bucket.avgLatencyMs))}
    ${detail('总尝试', formatInt(bucket.attempts))}
    ${detail('进行中', formatInt(bucket.active))}
    ${detail('扣费合计', `¥${esc(bucket.chargedAmount)}`)}
    ${detail('成功率', formatPercent(bucket.successRate))}
  </div>`;
}

/** 渲染排行榜。 */
function rankingBlock(rows: RankItem[]): string {
  if (rows.length === 0) return `<div style="text-align:center;padding:18px;border:0.5px dashed #d8dee6;border-radius:8px;color:${T.muted};font-size:12px;font-weight:800">暂无排行数据</div>`;
  return `<div class="rank-list">${rows.map((row) => `<div class="rank-row">
    <div class="rank-no">#${row.rank}</div>
    <img class="rank-avatar" src="${esc(row.avatarUrl)}" onerror="this.style.visibility='hidden'">
    <div class="rank-main">
      <div class="rank-qq">QQ ${esc(row.qqNumber)}</div>
      <div class="rank-meta">今日 ${formatInt(row.todayTotal)} · 成功 ${formatInt(row.success)} · 最近 ${timeText(row.lastTaskAt, 5, 16)}</div>
    </div>
    <div class="rank-count">${formatInt(row.total)}</div>
    <div class="rank-rate">${formatPercent(row.successRate)}</div>
  </div>`).join('')}</div>`;
}

function detail(label: string, value: string): string {
  return `<div class="detail"><div class="detail-label">${esc(label)}</div><div class="detail-value">${value}</div></div>`;
}

function formatInt(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)).toLocaleString('zh-CN') : '0';
}

function formatPercent(value: unknown): string {
  const n = Number(value ?? 0);
  return `${Number.isFinite(n) ? n.toFixed(1) : '0.0'}%`;
}

function formatDuration(ms: unknown): string {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}
