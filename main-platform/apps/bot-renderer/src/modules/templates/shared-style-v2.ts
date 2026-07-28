/**
 * 统一卡片样式 — 低圆角 / 精确留白 / 现代配色 / 清晰层级
 */
export const T = {
  bg: '#f0f4f8', surface: '#ffffff', border: '#e4e7eb',
  text: '#0f172a', muted: '#6b7280', soft: '#9ca3af',
  primary: '#6366f1', primarySoft: '#eef2ff',
  green: '#10b981', greenSoft: '#ecfdf5', greenBorder: '#a7f3d0',
  amber: '#f59e0b', amberSoft: '#fffbeb', amberBorder: '#fcd34d',
  red: '#ef4444', redSoft: '#fef2f2', redBorder: '#fecaca',
  violet: '#8b5cf6',
  zinc: '#71717a',
};

/** 本地字体文件由部署脚本或生产环境放入 BOT_RENDERER_ASSET_DIR/fonts，卡片模板不再访问 Google Fonts。 */
const LOCAL_FONT_FILE = (process.env.BOT_RENDERER_FONT_FILE ?? 'NotoSansSC-Regular.otf').replace(/[^a-zA-Z0-9_.-]/g, '');
const LOCAL_FONT_FORMAT = LOCAL_FONT_FILE.toLowerCase().endsWith('.otf')
  ? 'opentype'
  : LOCAL_FONT_FILE.toLowerCase().endsWith('.ttf')
  ? 'truetype'
  : 'woff2';
const LOCAL_FONT_FACE = LOCAL_FONT_FILE
  ? `@font-face{font-family:"DrawHimeLocalSC";src:url("http://aiimage.local-assets/fonts/${LOCAL_FONT_FILE}") format("${LOCAL_FONT_FORMAT}");font-weight:400 900;font-style:normal;font-display:swap}`
  : '';

export const BASE_CSS = `
${LOCAL_FONT_FACE}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;margin:0;padding:0;background:#eef1f5}
body{font-family:"DrawHimeLocalSC","Noto Sans CJK SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;color:${T.text};padding:16px 0;-webkit-font-smoothing:antialiased}
.card{width:var(--w);max-width:100%;margin:0 auto}
.panel{background:${T.surface};border:0.5px solid ${T.border};border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04);overflow:hidden}

/* ─── CARD HEADER ─── */
.card-header{display:flex;align-items:center;gap:12px;padding:12px 20px;background:#fafbfc;border-bottom:0.5px solid ${T.border};min-height:54px}
.card-header-avatar{width:38px;height:38px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:800;background:linear-gradient(135deg,${T.primary},#818cf8);box-shadow:0 2px 10px rgba(99,102,241,.18)}
.card-header-avatar svg{width:20px;height:20px;color:#fff}
.card-header-info{flex:1;min-width:0}
.card-header-title{font-size:14px;font-weight:700;color:${T.text};line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-header-sub{font-size:10.5px;color:${T.muted};margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.divider{height:1px;background:${T.border};margin:0}

/* ─── CONTENT ─── */
.content{padding:var(--cp,22px 26px 30px)}
.grid{display:grid;grid-template-columns:repeat(var(--cols),1fr);gap:10px;margin-bottom:var(--gm)}
.meta{padding:12px 14px;min-height:var(--mh);border-radius:8px;background:#f8fafb;border:0.5px solid #eef0f2}
.meta.wide{grid-column:1/-1}
.meta.double{grid-column:span 2}
.label{font-size:9px;font-weight:700;color:${T.soft};margin-bottom:4px;text-transform:uppercase;letter-spacing:.07em}
.value{font-size:14px;font-weight:700;color:${T.text};line-height:1.3;word-break:break-word}

/* ─── STAT ROW ─── */
.stat-row{display:flex;flex-wrap:wrap;gap:20px;padding:4px 0 10px}
.stat-item{display:flex;flex-direction:column;gap:2px}
.stat-num{font-size:19px;font-weight:800;color:${T.text};line-height:1.1}
.stat-lbl{font-size:10px;font-weight:600;color:${T.soft};text-transform:uppercase;letter-spacing:.05em}

/* ─── PROMPT ─── */
.prompt-box{margin:8px 0;padding:10px 14px;border-radius:8px;background:#f8fafb;border:0.5px solid #eef0f2;font-size:13px;color:${T.text};line-height:1.65;white-space:pre-wrap;word-break:break-word}

/* ─── FOOTER ─── */
.footer{padding:9px 20px;color:${T.zinc};background:#fafbfc;border-top:0.5px solid ${T.border};font-size:9.5px;line-height:1.5}
.footer-row{display:flex;flex-wrap:wrap;gap:2px 14px}
.footer-dot{display:inline-block;width:3px;height:3px;border-radius:99px;background:${T.soft};margin-right:5px;vertical-align:middle;opacity:.4}

/* ─── COUNTER ─── */
.counter{padding:12px 16px;text-align:center;min-width:72px;flex-shrink:0;border-radius:8px;background:#ffffff;border:0.5px solid #eef0f2;box-shadow:0 1px 3px rgba(0,0,0,.03)}
.counter-num{font-size:26px;font-weight:900;color:${T.primary};line-height:1}
.counter-label{font-size:10px;color:${T.muted};font-weight:600;margin-top:3px}

/* ─── BADGE ─── */
.badge{display:inline-flex;align-items:center;gap:3px;height:22px;padding:0 9px;border-radius:6px;font-size:10.5px;font-weight:700;background:${T.primarySoft};color:${T.primary};white-space:nowrap}
.badge.green{background:${T.greenSoft};color:#065f46}
.badge.amber{background:${T.amberSoft};color:#92400e}
.badge.red{background:${T.redSoft};color:#991b1b}

/* ─── STATUS BOX ─── */
.sbox{padding:10px 14px;margin:8px 0;border-radius:8px;font-size:12px;line-height:1.5}
.sbox.green{background:${T.greenSoft};color:#065f46;border-left:3px solid ${T.green}}
.sbox.amber{background:${T.amberSoft};color:#92400e;border-left:3px solid ${T.amber}}
.sbox.red{background:${T.redSoft};color:#991b1b;border-left:3px solid ${T.red}}
.sbox-label{font-size:10px;font-weight:700;margin-bottom:2px;text-transform:uppercase}

/* ─── INFO ROW ─── */
.irow{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;font-size:12px;border-bottom:0.5px solid #f0f2f5}
.irow:last-child{border-bottom:none}
.ilabel{color:${T.muted};font-size:11px;font-weight:500;flex-shrink:0;margin-right:10px}
.ivalue{font-weight:600;color:${T.text};text-align:right;font-size:11.5px}

/* ─── PROGRESS ─── */
.pg{margin:6px 0}.pg-bar{height:5px;background:#e5e7eb;border-radius:3px;overflow:hidden}
.pg-f{height:100%;border-radius:3px;background:linear-gradient(90deg,${T.primary},${T.violet});transition:width .5s ease}
.pg-l{display:flex;justify-content:space-between;margin-top:3px;font-size:10px;color:${T.soft};font-weight:600}

/* ─── REFS GRID ─── */
.refs{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:8px;align-items:start}
.refs:has(.ref-card:only-child){grid-template-columns:minmax(0,1fr)}
.ref-card{position:relative;border:0.5px solid #eef0f2;border-radius:8px;background:#ffffff;padding:5px;overflow:hidden}
.ref-index{position:absolute;left:6px;top:6px;width:20px;height:20px;border-radius:6px;background:${T.primary};color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;box-shadow:0 2px 6px rgba(99,102,241,.25);z-index:1}
.ref-card img{width:100%;height:180px;object-fit:contain;border-radius:6px;background:${T.bg};display:block}
.refs:has(.ref-card:only-child) .ref-card img{height:260px}
.ref-placeholder{width:100%;min-height:140px;border-radius:6px;background:#f3f4f6;color:${T.muted};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600}
.ref-url{margin-top:3px;color:${T.muted};font-size:9px;line-height:1.3;word-break:break-all;max-height:26px;overflow:hidden}

/* ─── USER BADGE (header) ─── */
.user-badge{display:flex;align-items:center;border-radius:8px;background:#ffffff;border:0.5px solid #eef0f2;flex-shrink:0;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.03)}
.user-badge-avatar{width:42px;height:42px;border-radius:0;flex-shrink:0;background:#e0e7ff}
.user-badge-info{flex:1;display:flex;flex-direction:column;justify-content:center;padding:4px 8px;min-width:0}
.user-badge-qq{font-size:14px;line-height:1.2;font-weight:800;color:#111827}
.user-badge-name{margin-top:1px;font-size:10.5px;font-weight:700;color:${T.primary}}
.user-badge-web{margin-top:1px;font-size:9.5px;font-weight:600;color:${T.zinc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ─── SUBMITTER BLOCK (body) ─── */
.submitter{border:0.5px solid #eef0f2;border-radius:8px;background:#ffffff;padding:10px 14px;min-width:0}
.submitter-avatar{width:36px;height:36px;border-radius:7px;object-fit:cover;float:right;margin-left:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.submitter-label{font-size:9px;font-weight:700;color:${T.muted};margin-bottom:2px;text-transform:uppercase;letter-spacing:.05em}
.submitter-qq{font-size:14px;line-height:1.2;font-weight:800;color:${T.text}}
.submitter-name{margin-top:1px;font-size:10.5px;font-weight:700;color:${T.primary}}
.submitter-bound{margin-top:1px;font-size:10px;font-weight:600;color:${T.zinc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ─── PROFILE ─── */
.profile{display:flex;align-items:center;gap:8px;padding:7px 10px;border:0.5px solid #eef0f2;border-radius:8px;background:#ffffff}
.avatar{width:32px;height:32px;border-radius:7px;object-fit:cover;flex-shrink:0;background:#f3f4f6;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.profile-info{min-width:0}
.profile-name{font-size:12.5px;font-weight:700;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.profile-meta{font-size:9.5px;color:${T.muted};margin-top:1px}

/* ─── MODEL PILLS ─── */
.pills{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.pill{padding:5px 12px;border-radius:8px;font-size:11px;font-weight:600;background:#f8fafb;color:${T.text};border:0.5px solid #eef0f2;transition:all .15s}
.pill.on{background:${T.primary};color:#fff;border-color:${T.primary};font-weight:700;box-shadow:0 2px 8px rgba(99,102,241,.18)}

/* ─── WALLET SUMMARY ─── */
.wallet-summary{display:grid;grid-template-columns:minmax(190px,.95fr) minmax(0,1.05fr);gap:10px;margin:10px 0 12px}
.wallet-total{padding:14px 16px;border-radius:8px;background:${T.primarySoft};border:0.5px solid #c7d2fe}
.wallet-total-label{font-size:9px;font-weight:800;color:${T.muted};text-transform:uppercase;letter-spacing:.07em}
.wallet-total-num{margin-top:6px;font-size:28px;font-weight:900;line-height:1;color:${T.primary};word-break:break-word}
.wallet-total-source{margin-top:6px;font-size:10.5px;font-weight:700;color:${T.zinc};line-height:1.4}
.wallet-parts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.wallet-part{min-width:0;padding:12px;border-radius:8px;background:#f8fafb;border:0.5px solid #eef0f2}
.wallet-part.free{background:${T.greenSoft};border-color:${T.greenBorder}}
.wallet-part.paid{background:${T.amberSoft};border-color:${T.amberBorder}}
.wallet-part-label{font-size:9px;font-weight:800;color:${T.muted};text-transform:uppercase;letter-spacing:.06em}
.wallet-part-num{margin-top:5px;font-size:18px;font-weight:900;line-height:1.1;word-break:break-word}
.wallet-part.free .wallet-part-num{color:${T.green}}
.wallet-part.paid .wallet-part-num{color:${T.amber}}
.wallet-note{grid-column:1/-1;margin-top:2px;font-size:10px;line-height:1.45;color:${T.zinc}}
.wallet-breakdown{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:10px 0 12px}
.wallet-source{min-width:0;padding:12px 14px;border-radius:8px;background:#ffffff;border:0.5px solid #eef0f2}
.wallet-source.qq{border-color:#bfdbfe;background:#eff6ff}
.wallet-source.user{border-color:#ddd6fe;background:#f5f3ff}
.wallet-source-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}
.wallet-source-title{font-size:12px;font-weight:900;color:${T.text};line-height:1.2}
.wallet-source-key{font-size:9.5px;font-weight:700;color:${T.zinc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wallet-source-main{font-size:21px;font-weight:900;line-height:1;color:${T.primary};word-break:break-word}
.wallet-source-rows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:10px}
.wallet-source-mini{padding:7px 8px;border-radius:7px;background:rgba(255,255,255,.72);border:0.5px solid rgba(226,232,240,.9)}
.wallet-source-mini-label{font-size:8.5px;font-weight:800;color:${T.muted};letter-spacing:.04em}
.wallet-source-mini-num{margin-top:3px;font-size:12.5px;font-weight:900;line-height:1.1}
.wallet-empty{grid-column:1/-1;padding:10px 12px;border-radius:8px;background:#f8fafb;border:0.5px dashed #d8dee6;color:${T.zinc};font-size:11px;font-weight:700;line-height:1.45}
`;

// ── 卡片布局系统 ──
export type LayoutPreset = 'default' | 'compact' | 'wide';
const LAYOUT: Record<LayoutPreset, string> = {
  compact: '--w:720px;--cp:20px 24px 26px;--cols:2;--gm:10px;--mh:46px',
  default: '--w:820px;--cp:24px 28px 32px;--cols:3;--gm:12px;--mh:50px',
  wide:    '--w:900px;--cp:28px 32px 34px;--cols:3;--gm:14px;--mh:54px',
};

export type HeroCfg = { eyebrow?: string; title: string; subtitle?: string; rightContent?: string };
export type CardLayout = { layout?: LayoutPreset; hero?: HeroCfg; body: string; footer?: string[]; title?: string; extraCSS?: string; submitter?: UserBadgeData; icon?: string; accent?: string };

export function renderCard(cfg: CardLayout): string {
  const t = (cfg.title || cfg.hero?.title || 'Bot').replace(/[&]/g, '&amp;').replace(/</g, '&lt;');
  const layoutVars = LAYOUT[cfg.layout || 'default'];
  const accent = cfg.accent || T.primary;

  const sub = cfg.submitter;
  const iconSvg = cfg.icon || '';
  const hdrTitle = t.length > 28 ? t.slice(0,26)+'…' : t;
  const hdrSub = cfg.hero?.eyebrow || cfg.hero?.subtitle || '';
  const badgeHtml = sub?.qqNumber ? userBadge(sub) : '';

  const avatarContent = iconSvg
    ? iconSvg.replace('<svg','<svg width="20" height="20"')
    : (cfg.title || 'B').charAt(0).toUpperCase();

  const headerHtml = `<header class="card-header">
    <div class="card-header-avatar" style="background:linear-gradient(135deg,${accent},${adjustColor(accent,20)})">${avatarContent}</div>
    <div class="card-header-info">
      <div class="card-header-title">${esc(hdrTitle)}</div>
      ${hdrSub ? `<div class="card-header-sub">${esc(hdrSub)}</div>` : ''}
    </div>
    ${badgeHtml}
  </header>`;

  const footerHtml = cfg.footer?.length
    ? `<footer class="footer"><div class="footer-row">${cfg.footer.map(x=>`<span><span class="footer-dot"></span>${esc(x)}</span>`).join('')}</div></footer>` : '';

  const extra = cfg.extraCSS ? `<style>${cfg.extraCSS}</style>` : '';
  const css = `:root{${layoutVars}}${BASE_CSS}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${t}</title><style>${css}</style>${extra}</head><body><div class="card"><section class="panel">${headerHtml}<main class="content">${cfg.body}</main>${footerHtml}</section></div></body></html>`;
}

function adjustColor(hex: string, amount: number): string {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0xff) + amount));
  return `#${((r<<16)|(g<<8)|b).toString(16).padStart(6,'0')}`;
}

export function esc(s: unknown): string {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** 将模板输入收敛为字符串；Bot 卡片来自多个服务，缺字段时必须降级渲染而不是抛错。 */
export function textValue(value: unknown, fallback = ''): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.trim() ? text : fallback;
}

/** 安全截断展示文本；用于替代模板中直接调用 slice/length 的高风险逻辑。 */
export function shortText(value: unknown, max: number, fallback = ''): string {
  const text = textValue(value, fallback);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 将未知输入收敛为数组，避免后台配置或探测请求缺字段时卡片渲染失败。 */
export function arrayValue<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

/** 截取 ISO 时间中的时分秒；输入异常时返回占位符。 */
export function timeText(value: unknown, start = 11, end = 19): string {
  const text = textValue(value);
  return text.length >= end ? text.slice(start, end) : '-';
}

/** 格式化金额为两位小数 */
export function fmt(v: unknown): string {
  const n = Number(v ?? 0);
  return (isNaN(n) ? 0 : n).toFixed(2);
}

// ── 组件 ──
export function metaCard(l: string, v: string, o?:{wide?:boolean;double?:boolean;color?:string}): string {
  const cls=['meta',o?.wide?'wide':'',o?.double?'double':''].filter(Boolean).join(' ');
  return `<div class="${cls}"><div class="label">${esc(l)}</div><div class="value"${o?.color?` style="color:${o.color}"`:''}>${esc(v)}</div></div>`;
}
export function metaGrid(items: Array<{label:string;value:string;wide?:boolean;double?:boolean;color?:string}>): string {
  return `<div class="grid">${items.map(i=>metaCard(i.label,i.value,{wide:i.wide,double:i.double,color:i.color})).join('')}</div>`;
}
export function infoRow(l:string, v:string, c?:string): string {
  return `<div class="irow"><span class="ilabel">${esc(l)}</span><span class="ivalue"${c?` style="color:${c}"`:''}>${esc(v)}</span></div>`;
}
export function infoRows(items: Array<{label:string;value:string;color?:string}>, bg?:boolean): string {
  return `<div${bg?` style="background:#f8fafb;border-radius:8px"`:''}>${items.map(i=>infoRow(i.label,i.value,i.color)).join('')}</div>`;
}
export function statusBox(msg:string, type:'green'|'amber'|'red', label?:string): string {
  return `<div class="sbox ${type}">${label?`<div class="sbox-label">${esc(label)}</div>`:''}${esc(msg)}</div>`;
}
export function counter(num:number|string, label:string): string {
  return `<div class="counter"><div class="counter-num">${String(num)}</div><div class="counter-label">${esc(label)}</div></div>`;
}
export function badge(text:string, color?:'green'|'amber'|'red'): string {
  return `<span class="badge${color?' '+color:''}">${esc(text)}</span>`;
}
/** 安全渲染提示词块，生产 Bot 数据可能缺少展示字段，缺字段时不能让整张卡片渲染失败。 */
export function promptBox(text: unknown, max?:number): string {
  const value = textValue(text, '未提供提示词');
  const t = max && value.length > max ? esc(value.slice(0,max))+'…' : esc(value);
  return `<div class="prompt-box">${t}</div>`;
}
/** 渲染提交人信息，头像 URL 只作为展示字段处理，缺失时保持卡片主体可渲染。 */
export function submitterBlock(d:{qqNumber?:string;nickname?:string;binding?:string;avatarUrl?:string}): string {
  const avatarUrl = typeof d.avatarUrl === 'string' ? d.avatarUrl : '';
  return `<div class="submitter">${avatarUrl?`<img class="submitter-avatar" src="${avatarUrl.replace(/"/g,'&quot;')}" onerror="this.remove()">`:''}<div class="submitter-label">提交人</div><div class="submitter-qq">QQ ${esc(d.qqNumber||'')}</div><div class="submitter-name">${esc(d.nickname||d.qqNumber||'')}</div>${d.binding?`<div class="submitter-bound">${esc(d.binding)}</div>`:''}</div>`;
}

export interface UserBadgeData { qqNumber?: string; nickname?: string; avatarUrl?: string; binding?: { username: string; userId: number } | string; }
export function userBadge(d: UserBadgeData): string {
  const qq = d.qqNumber || '';
  const av = d.avatarUrl || `https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=100`;
  const rawAv = av.replace(/"/g,'&quot;');
  const bt = !d.binding ? '' : typeof d.binding === 'string' ? d.binding
    : [d.binding.username || '', d.binding.userId ? `ID:${d.binding.userId}` : ''].filter(Boolean).join(' · ').trim();
  const nm = d.nickname || '';
  return `<div class="user-badge">
    <img class="user-badge-avatar" src="${rawAv}" onerror="this.style.display='none'">
    <div class="user-badge-info">
      <div class="user-badge-qq">QQ ${esc(qq)}</div>
      <div class="user-badge-name">${esc(nm.length>14?nm.slice(0,12)+'…':nm)}</div>
      ${bt ? `<div class="user-badge-web">${esc(bt.length>20?bt.slice(0,18)+'…':bt)}</div>` : ''}
    </div></div>`;
}
export function refGrid(urls:string[], _rendered?:string[]): string {
  if(!urls.length)return '';
  return `<div class="refs">${urls.map((u,i)=>`<div class="ref-card"><div class="ref-index">${i+1}</div><img src="${esc(u)}" alt="Ref${i+1}" onerror="this.closest('.ref-card')?.remove()"></div>`).join('')}</div>`;
}
export function progressBar(pct:number, left?:string, right?:string): string {
  return `<div class="pg"><div class="pg-bar"><div class="pg-f" style="width:${Math.min(100,Math.max(0,pct))}%"></div></div>${left||right?`<div class="pg-l"><span>${left||''}</span><span>${right||''}</span></div>`:''}</div>`;
}
export function pills(items:Array<{label:string;active?:boolean}>): string {
  return `<div class="pills">${items.map(i=>`<span class="pill${i.active?' on':''}">${esc(i.label)}</span>`).join('')}</div>`;
}

/** 钱包余额摘要块：QQ 图片卡片统一以“可用总额”为主，免费/付费作为扣费来源拆分。 */
export function walletSummaryBlock(d: { freeBalance?: string; paidBalance?: string; sourceLabel?: string; note?: string }): string {
  const free = fmt(d.freeBalance);
  const paid = fmt(d.paidBalance);
  const total = fmt(Number(free) + Number(paid));
  return `<div class="wallet-summary">
    <div class="wallet-total">
      <div class="wallet-total-label">可用总余额</div>
      <div class="wallet-total-num">¥${total}</div>
      <div class="wallet-total-source">${esc(d.sourceLabel || 'QQ 可访问余额')}</div>
    </div>
    <div class="wallet-parts">
      <div class="wallet-part free"><div class="wallet-part-label">免费余额</div><div class="wallet-part-num">¥${free}</div></div>
      <div class="wallet-part paid"><div class="wallet-part-label">付费余额</div><div class="wallet-part-num">¥${paid}</div></div>
      <div class="wallet-note">${esc(d.note || '扣费顺序：先免费余额，再付费余额。')}</div>
    </div>
  </div>`;
}

/** 单个身份钱包的渲染输入；用于 Bot 余额卡展示 QQ/Web 分钱包来源。 */
export type WalletSourceView = {
  ownerType?: 'qq' | 'user' | string;
  ownerKey?: string;
  freeBalance?: string;
  paidBalance?: string;
};

/** 钱包来源拆分块：绑定后展示 QQ 钱包和 Web 钱包互通但不合并的真实结构。 */
export function walletBreakdownBlock(d: { primaryWallet?: WalletSourceView; linkedWallet?: WalletSourceView; linkedUsername?: string; qqNumber?: string }): string {
  const items = [d.primaryWallet, d.linkedWallet].filter((wallet): wallet is WalletSourceView => Boolean(wallet));
  if (items.length === 0) {
    return `<div class="wallet-breakdown"><div class="wallet-empty">暂无钱包明细，已按 QQ 当前可访问余额展示合计。</div></div>`;
  }
  const cards = items.map((wallet) => walletSourceCard(wallet, d)).join('');
  const empty = items.length === 1
    ? `<div class="wallet-empty">未绑定 Web 账号：当前仅使用 QQ 钱包。绑定后可同时使用 Web 钱包余额，但两个钱包不会合并。</div>`
    : '';
  return `<div class="wallet-breakdown">${cards}${empty}</div>`;
}

/** 渲染单个身份钱包卡片，金额仍按免费/付费拆分展示。 */
function walletSourceCard(wallet: WalletSourceView, ctx: { linkedUsername?: string; qqNumber?: string }): string {
  const free = fmt(wallet.freeBalance);
  const paid = fmt(wallet.paidBalance);
  const total = fmt(Number(free) + Number(paid));
  const isQq = wallet.ownerType === 'qq';
  const title = isQq ? 'QQ 钱包' : 'Web 钱包';
  const key = isQq ? `QQ ${wallet.ownerKey || ctx.qqNumber || ''}` : [ctx.linkedUsername || '已绑定网页账号', wallet.ownerKey ? `ID ${wallet.ownerKey}` : ''].filter(Boolean).join(' · ');
  return `<div class="wallet-source ${isQq ? 'qq' : 'user'}">
    <div class="wallet-source-head">
      <div class="wallet-source-title">${esc(title)}</div>
      <div class="wallet-source-key">${esc(key)}</div>
    </div>
    <div class="wallet-source-main">¥${total}</div>
    <div class="wallet-source-rows">
      <div class="wallet-source-mini"><div class="wallet-source-mini-label">免费</div><div class="wallet-source-mini-num" style="color:${T.green}">¥${free}</div></div>
      <div class="wallet-source-mini"><div class="wallet-source-mini-label">付费</div><div class="wallet-source-mini-num" style="color:${T.amber}">¥${paid}</div></div>
    </div>
  </div>`;
}
