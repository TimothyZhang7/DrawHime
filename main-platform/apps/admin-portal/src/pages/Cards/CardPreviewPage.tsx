/** 命令管理 — 动态预览真实数据 */
import { useState, useEffect, useRef } from 'react';
import { Plus, Save, RotateCw, Image, FileText, Eye, X, Trash2, Search, ChevronDown, ChevronRight, Zap, Clock, Settings, Tag, Layout, Loader2 } from 'lucide-react';
import type { BotCommandConfig, PublicStatusResponse } from '@aiimage/shared-contracts';
import { api } from '../../api/client';
import Toast from '../../components/Toast';
import { Modal } from '../../components/Modal';

const RENDERER = (import.meta.env.VITE_RENDERER_URL ?? '').replace(/\/$/, '');
type RenderMode = 'image' | 'text';

interface Cmd {
  id: string; label: string; group: string; triggers: string[];
  enabled: boolean; cooldownSec: number; cardTypes: string[];
  renderModes?: Record<string, RenderMode>;
}

const CT: Record<string, string> = {
  ping: 'Ping', help: '帮助', 'balance-success': '余额', 'site-status': '站点', 'site-info': '信息',
  'draw-submitted': '提交', 'draw-submitted-i2i': '提交i2i', 'draw-result': '结果',
  'draw-cooldown': '冷却', 'draw-quota-exceeded': '次数', 'retry-notify': '重试',
  'error-retryable': '可重试', 'error-fatal': '致命', 'model-list': '模型',
  'model-switched': '切换', 'privacy-public': '公开', 'privacy-private': '私密',
  'bind-howto': '绑定指引', 'bind-success': '绑成', 'bind-failed': '绑败',
  'bot-list': 'Bot列表', 'bot-list-empty': 'Bot空', 'admin-balance': '调额',
};

const GROUPS = ['查询', '绘图', '设置', '账户', '管理'];
const GC: Record<string, string> = { '查询': 'blue', '绘图': 'fuchsia', '设置': 'purple', '账户': 'cyan', '管理': 'orange' };

const DEFAULTS: Cmd[] = [
  { id: 'ping', label: '在线检测', group: '查询', triggers: ['ping'], enabled: true, cooldownSec: 0, cardTypes: ['ping'] },
  { id: 'help', label: '命令帮助', group: '查询', triggers: ['帮助', 'help'], enabled: true, cooldownSec: 0, cardTypes: ['help'] },
  { id: 'balance', label: '余额用量', group: '查询', triggers: ['余额', '额度', '次数'], enabled: true, cooldownSec: 0, cardTypes: ['balance-success'] },
  { id: 'status', label: '站点健康', group: '查询', triggers: ['状态', 'status', 'stats'], enabled: true, cooldownSec: 0, cardTypes: ['site-status'] },
  { id: 'tasks', label: '生成记录', group: '查询', triggers: ['任务', 'tasks', '记录'], enabled: true, cooldownSec: 0, cardTypes: ['task-list'] },
  { id: 'info', label: '站点统计', group: '查询', triggers: ['info', '站点统计'], enabled: true, cooldownSec: 0, cardTypes: ['site-info'] },
  { id: 'draw', label: '绘图姬绘图', group: '绘图', triggers: ['绘图', '生成', 'draw', 'generate'], enabled: true, cooldownSec: 90, cardTypes: ['draw-submitted','draw-result','draw-cooldown','draw-quota-exceeded','retry-notify','error-retryable','error-fatal'] },
  { id: 'model', label: '模型切换', group: '设置', triggers: ['模型', 'models'], enabled: true, cooldownSec: 0, cardTypes: ['model-list','model-switched'] },
  { id: 'privacy', label: '隐私设置', group: '设置', triggers: ['隐私', 'privacy'], enabled: true, cooldownSec: 0, cardTypes: ['privacy-public','privacy-private'] },
  { id: 'bind', label: 'QQ绑定', group: '账户', triggers: ['绑定', 'bind'], enabled: true, cooldownSec: 0, cardTypes: ['bind-howto','bind-success','bind-failed'] },
  { id: 'botlist', label: 'Bot列表', group: '管理', triggers: ['bot', 'bots', 'list'], enabled: true, cooldownSec: 0, cardTypes: ['bot-list','bot-list-empty'] },
  { id: 'admin_balance', label: '管理员调额', group: '管理', triggers: ['额度 加', '额度 减', '余额 加', '余额 减'], enabled: true, cooldownSec: 0, cardTypes: ['admin-balance'] },
];

const S = 'text-[11px]';

/** 为每种卡片类型从后端拉取真实预览数据 */
async function fetchPreviewData(type: string, qq: string): Promise<Record<string, unknown>> {
  switch (type) {
    case 'ping':
      return { botName: 'DrawHime-Bot', uptime: '-', pingMs: 42, memory: '-', nodeVersion: '-' };
    case 'balance-success': {
      const r = await api<any>(`/admin/balance/${qq}`);
      if (r.ok && r.data) return { freeBalance: r.data.freeBalance ?? '0.00', paidBalance: r.data.paidBalance ?? '0', qqNumber: qq };
      return { freeBalance: '0.00', paidBalance: '0', qqNumber: qq };
    }
    case 'draw-submitted':
    case 'draw-submitted-i2i': {
      const [balR, modelsR] = await Promise.all([api<any>(`/admin/balance/${qq}`), api<any>('/admin/drawing/model-settings')]);
      const bal = balR.ok ? balR.data : null;
      // 提交卡预览使用默认模型的独立价格，不再读取历史全局单价。
      const model = modelsR.data?.models?.find((item: any) => item.name === modelsR.data?.defaultModel) ?? modelsR.data?.models?.[0];
      const price = Number(model?.price ?? 0.05).toFixed(2);
      return { taskId: `preview_${Date.now()}`, prompt: '一只可爱的猫，窗台，柔和晨光，电影感', mode: 'text-to-image', model: model?.name ?? 'gpt-image-2', charged: (bal?.paidBalance||'0') !== '0', chargedAmount: price, paidBalance: bal?.paidBalance ?? '0', freeBalance: bal?.freeBalance ?? '0.00', qqNumber: qq, binding: { username: 'admin', userId: 1 }, isPrivate: false, maxAttempts: 3, siteName: 'Auto', estimatedPrice: Number(price), imageCount: 0 };
    }
    case 'draw-result': {
      const tasksR = await api<any>(`/admin/generations?qqNumber=${qq}&status=success&pageSize=1`);
      const t = tasksR.ok && tasksR.data?.items?.[0];
      if (t) return { prompt: t.prompt?.slice(0, 200) ?? '-', mode: t.mode ?? 'text-to-image', model: t.model ?? 'gpt-image-2', siteName: t.sitesUsed?.[0] ?? '-', latencySec: t.startedAt && t.finishedAt ? Math.round((new Date(t.finishedAt).getTime() - new Date(t.startedAt).getTime()) / 1000) : 0, retryCount: (t.attempts ?? 1) - 1, chargedAmount: t.chargedAmount ?? '0.00', balanceAfter: '5.00', taskId: t.id, imageCount: 0 };
      return { prompt: '无最近成功任务', mode: 'text-to-image', model: 'gpt-image-2', siteName: '-', latencySec: 0, retryCount: 0, chargedAmount: '0', balanceAfter: '0', taskId: 'preview_none', imageCount: 0 };
    }
    case 'draw-cooldown':
      return { remainingSec: 45 };
    case 'draw-quota-exceeded': {
      const cfgR = await api<Record<string,string>>('/admin/config');
      return {};
    }
    case 'model-list': {
      const r = await api<any>('/admin/sites');
      const models = r.ok && r.data ? [...new Set((r.data as any[]).flatMap((s: any) => (s.modelOptions || []).map((m: any) => m.name)).filter(Boolean))] as string[] : [];
      return { models: models.length > 0 ? models : ['gpt-image-2'], currentModel: models[0] ?? 'gpt-image-2' };
    }
    case 'model-switched':
      return { modelName: 'gpt-image-2' };
    case 'privacy-public':
    case 'privacy-private':
      return {};
    case 'bind-howto':
      return {};
    case 'bind-success':
      return { qqNumber: qq, paidBalance: '5.00' };
    case 'bind-failed':
      return { reason: '验证码已过期（预览示例）' };
    case 'bot-list': {
      const r = await api<any>('/admin/bot/accounts');
      const bots = r.ok && r.data ? (r.data as any[]).map((b: any) => ({ selfId: b.selfId || b.qqNumber || '?', nickname: '', status: b.status || 'offline' })) : [];
      return { bots: bots.length > 0 ? bots : [{ selfId: qq, nickname: 'Bot', status: 'online' }] };
    }
    case 'bot-list-empty':
      return {};
    case 'admin-balance':
      return { qqNumber: qq, amount: '+5.00', balanceAfter: '15.50' };
    case 'retry-notify':
      return { prompt: '一只可爱的猫', type: 'same_site', attempt: 1, nextAttempt: 2, maxAttempts: 3, siteName: 'auto', model: 'gpt-image-2', error: '请求超时 (timeout 30s)', imageCount: 0 };
    case 'error-retryable':
      return { prompt: '一只可爱的猫', error: '上游 API 503 暂时不可用', balance: '5.00' };
    case 'error-fatal':
      return { prompt: '一只可爱的猫', error: '所有站点不可用', balance: '5.00', mode: 'text-to-image', model: 'gpt-image-2', siteName: 'auto' };
    case 'site-status': {
      const r = await api<any>('/admin/sites');
      const sites = r.ok && r.data ? (r.data as any[]).map((s: any) => ({ name: s.name, isEnabled: s.isEnabled, consecutiveFailures: s.consecutiveFailures ?? 0 })) : [];
      return { sites: sites.length > 0 ? sites : [{ name: '无站点', isEnabled: false, consecutiveFailures: 0 }] };
    }
    case 'site-info': {
      const statusR = await api<PublicStatusResponse>('/api/status?range=24h');
      const status = statusR.ok && statusR.data ? statusR.data : buildSiteInfoPreviewStatus();
      return {
        cmdPrefix: '#',
        status,
        botItems: [{ selfId: qq, nickname: 'Bot', status: 'online', avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${qq}&spec=100`, uptimeMs: 0 }],
        recentErrors: [{ error: '预览示例：暂无最近错误', prompt: '管理后台预览', siteName: 'preview', createdAt: new Date().toISOString() }],
      };
    }
    case 'help': {
      const [cfgR, cmdR] = await Promise.all([api<Record<string,string>>('/admin/config'), api<any[]>('/admin/command-configs')]);
      const pfx = cfgR.data?.['bot_cmd_prefix'] || '#';
      const configs = cmdR.ok && Array.isArray(cmdR.data) ? normalizeHelpPreviewConfigs(cmdR.data, pfx) : [];
      const fallback = buildHelpPreviewConfigs(pfx);
      const commandConfigs = configs.length > 0 ? configs : fallback;
      const commands = commandConfigs.flatMap((item) => [item.command, ...(item.aliases ?? [])]).filter((item): item is string => typeof item === 'string');
      return { cmdPrefix: pfx, commands, commandConfigs };
    }
    default:
      return {};
  }
}

export function CardPreviewPage() {
  const [pfx, setPfx] = useState('#');
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const [ready, setReady] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pv, setPv] = useState<string | null>(null);
  const [pvLoading, setPvLoading] = useState(false);
  const [pvData, setPvData] = useState<string | null>(null);
  const [chg, setChg] = useState(0);
  const [msg, setMsg] = useState<{ t: 'success' | 'error'; m: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [add, setAdd] = useState({ id: '', label: '', group: '查询' });
  const [del, setDel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const [nt, setNt] = useState('');
  const [adminQQ, setAdminQQ] = useState('');
  const [adminUser, setAdminUser] = useState<{ username: string; id: number } | null>(null);

  // 初始化：拉配置 + 获取管理员 QQ
  useEffect(() => {
    Promise.all([
      api<Record<string,string>>('/admin/config'),
      api<any[]>('/admin/command-configs'),
      api<any>('/auth/me'),
      api<any[]>('/admin/bot/qq-bindings'),
    ]).then(([cR, rR, meR, bindR]) => {
      const p = (cR.ok && cR.data?.['bot_cmd_prefix']) || '#';
      setPfx(p);
      if (rR.ok && Array.isArray(rR.data)) {
        // 后端保存的是 command + aliases；管理端编辑态统一转换为不含前缀的 triggers，避免别名保存后刷新丢失。
        setCmds(mergeCommandConfigs(rR.data, p));
      } else setCmds(DEFAULTS);
      // 获取管理员 QQ 号和用户信息
      if (meR.ok && meR.data) {
        const u = meR.data as any;
        if (u.qqNumber) setAdminQQ(String(u.qqNumber));
        if (u.username) setAdminUser({ username: u.username, id: u.id ?? 0 });
      }
      if (!adminQQ && bindR.ok && Array.isArray(bindR.data) && bindR.data.length > 0) {
        setAdminQQ(String(bindR.data[0].qqNumber));
      }
      setReady(true);
    });
  }, []);

  const c = cmds.find(x => x.id === sel);
  const up = (id: string, p: Partial<Cmd>) => { setChg(x=>x+1); setCmds(pr => pr.map(x => x.id===id ? {...x,...p} : x)); };
  const at = (id: string) => { const t = stripCommandPrefix(nt.trim(), pfx); if (!t) return; setChg(x=>x+1); setCmds(pr => pr.map(x => x.id===id&&!x.triggers.includes(t) ? {...x,triggers:[...x.triggers,t]} : x)); setNt(''); };
  const rt = (id: string, t: string) => { setChg(x=>x+1); setCmds(pr => pr.map(x => x.id===id ? {...x,triggers:x.triggers.filter(y=>y!==t)} : x)); };
  const mk = () => { const id=add.id.trim(); if(!id||!add.label.trim()){setMsg({t:'error',m:'填写完整'});return;} if(cmds.some(x=>x.id===id)){setMsg({t:'error',m:'ID重复'});return;} setCmds(pr=>[...pr,{id,label:add.label.trim(),group:add.group,triggers:[id],enabled:true,cooldownSec:0,cardTypes:[]}]); setSel(id); setAddOpen(false); setAdd({id:'',label:'',group:'查询'}); setChg(x=>x+1); };
  const rm = (id: string) => { setCmds(pr=>pr.filter(x=>x.id!==id)); if(sel===id) setSel(null); setDel(null); setChg(x=>x+1); };
  // 保存命令 ID，bot-service 可直接按稳定 ID 识别命令类型，避免修改触发词后返回格式失效。
  const sv = async () => { setSaving(true); const list: BotCommandConfig[]=cmds.map(x=>({id:x.id,command:ensureCommandPrefix(x.triggers[0] ?? x.id,pfx),aliases:x.triggers.slice(1).map(t=>ensureCommandPrefix(t,pfx)),enabled:x.enabled,cooldownSec:x.cooldownSec,cardTypes:x.cardTypes,renderModes:x.renderModes,group:x.group,label:x.label})); const r=await api<BotCommandConfig[]>('/admin/command-configs',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(list)}); if (r.ok && Array.isArray(r.data)) { setCmds(mergeCommandConfigs(r.data, pfx)); setChg(0); } setMsg({t:r.ok?'success':'error',m:r.ok?'已保存':(r.message??'失败')}); setSaving(false); };

  // 动态预览：拉真实数据 → 注入 submitter → POST 渲染器 → 显示 PNG
  const openPreview = async (type: string) => {
    setPv(type);
    setPvLoading(true);
    setPvData(null);
    try {
      const data = await fetchPreviewData(type, adminQQ || '100000001');
      // 注入管理员 submitter 信息
      data.submitter = {
        qqNumber: adminQQ || '100000001',
        nickname: 'Yukino',
        avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${adminQQ || '100000001'}&spec=100`,
        binding: { username: 'Admin', userId: 1 },
      };
      const res = await fetch(`${RENDERER}/render/preview/${type}?png=1&w=860`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const blob = await res.blob();
        setPvData(URL.createObjectURL(blob));
      }
    } catch { /* ignore */ }
    setPvLoading(false);
  };
  const closePreview = () => {
    if (pvData) URL.revokeObjectURL(pvData);
    setPv(null); setPvData(null); setPvLoading(false);
  };

  if (!ready) return <div className="flex items-center justify-center py-20"><RotateCw size={22} className="animate-spin text-indigo-500" /></div>;

  const ft = q.trim() ? cmds.filter(x => x.label.includes(q)||x.id.includes(q)||x.triggers.some(t=>t.includes(q))) : cmds;
  const grp: Record<string, Cmd[]> = {}; for (const x of ft) { if(!grp[x.group]) grp[x.group]=[]; grp[x.group].push(x); }
  const on = cmds.filter(x=>x.enabled).length;
  const tt = cmds.reduce((s,x)=>s+x.triggers.length,0);

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 'calc(100vh - 150px)' }}>
      {msg && <Toast message={msg.m} type={msg.t} onClose={() => setMsg(null)} />}

      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <h2 className="text-lg font-extrabold text-gray-800 tracking-tight">命令管理</h2>
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-100 text-gray-500 text-xs font-mono font-bold">{pfx}</span>
          <div className="flex items-center gap-1 text-xs text-gray-400">
            <span className="font-semibold text-gray-600">{cmds.length}</span> 命令
            <span className="w-1 h-1 rounded-full bg-gray-300 mx-1" />
            <span className="font-semibold text-green-600">{on}</span> 启用
            <span className="w-1 h-1 rounded-full bg-gray-300 mx-1" />
            <span className="font-semibold text-gray-600">{tt}</span> 触发器
          </div>
          {adminQQ && <span className="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">预览QQ: {adminQQ}</span>}
          {chg > 0 && <span className="bg-amber-50 text-amber-700 border border-amber-200 text-[10px] px-2 py-0.5 rounded-full font-semibold animate-pulse">{chg} 处修改未保存</span>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setAddOpen(true)} className="btn btn-sm btn-outline"><Plus size={14} />新建</button>
          <button onClick={sv} disabled={saving || chg===0} className="btn btn-sm"><Save size={14} />保存</button>
        </div>
      </header>

      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input className="w-full h-9 pl-9 pr-8 text-xs rounded-xl border border-gray-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none bg-white transition-shadow" placeholder="搜索命令..." value={q} onChange={e => setQ(e.target.value)} />
        {q && <button onClick={() => setQ('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"><X size={13} /></button>}
      </div>

      {/* Body */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Sidebar */}
        <nav className="w-[288px] flex-shrink-0 border border-gray-200 rounded-2xl bg-white flex flex-col min-h-0 shadow-sm overflow-hidden">
          <div className="flex-1 overflow-y-auto" style={{scrollbarWidth:'thin'}}>
            {Object.keys(grp).length === 0 ? (
              <div className="p-10 text-center text-xs text-gray-400">无匹配结果</div>
            ) : Object.entries(grp).map(([gn, items]) => (
              <div key={gn}>
                <button onClick={() => setFold(p=>({...p,[gn]:!p[gn]}))}
                  className="w-full flex items-center gap-2 px-3.5 py-2 text-xs font-bold text-gray-400 hover:text-gray-600 sticky top-0 bg-white/95 backdrop-blur-sm border-b border-gray-50/50"
                >
                  {fold[gn] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span className={`w-2 h-2 rounded-full bg-${GC[gn]||'gray'}-500`} />
                  <span className="flex-1 text-left">{gn}</span>
                  <span className="tabular-nums font-normal text-[10px]">{items.length}</span>
                </button>
                {!fold[gn] && items.map(x => (
                  <button key={x.id} onClick={() => setSel(x.id)}
                    className={`w-full text-left pl-9 pr-3 py-2.5 ${S} transition-all flex items-center gap-2.5 border-l-[3px] ${
                      sel===x.id ? 'border-indigo-500 bg-indigo-50/70 text-indigo-700 font-semibold' :
                      'border-transparent hover:bg-gray-50 text-gray-600'}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${x.enabled?'bg-green-400':'bg-gray-300'}`} />
                    <span className="truncate flex-1">{x.label}</span>
                    {x.cooldownSec>0 && <span className="text-[10px] text-amber-500 flex-shrink-0"><Clock size={9} className="inline -mt-0.5" /> {x.cooldownSec}s</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>

        {/* Editor */}
        <main className="flex-1 min-w-0 border border-gray-200 rounded-2xl bg-white shadow-sm overflow-y-auto" style={{scrollbarWidth:'thin'}}>
          {c ? (
            <div>
              {/* Hero */}
              <div className="px-6 py-5 border-b border-gray-100">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-lg font-extrabold text-gray-800 truncate">{c.label}</h3>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-${GC[c.group]||'gray'}-50 text-${GC[c.group]||'gray'}-600`}>{c.group}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className={`${S} bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono`}>{c.id}</code>
                      <span className={`${S} text-gray-400`}>{c.triggers.length} 触发 · {c.cardTypes.length} 卡片{!c.enabled && ' · 已禁用'}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-xs font-bold ${c.enabled?'text-green-600':'text-red-400'}`}>{c.enabled?'启用':'禁用'}</span>
                    <button onClick={() => up(c.id,{enabled:!c.enabled})}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer border-0 p-0 ${c.enabled?'bg-indigo-500':'bg-gray-300'}`}
                      role="switch" aria-checked={c.enabled}
                    ><span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${c.enabled?'translate-x-[18px]':'translate-x-[3px]'}`} /></button>
                  </div>
                </div>
              </div>

              {/* Sections */}
              <div className="px-6 py-5 space-y-6">
                <section>
                  <div className="flex items-center gap-2 mb-3"><Settings size={14} className="text-gray-400" /><h4 className="text-sm font-bold text-gray-600">基本设置</h4></div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className={`block ${S} font-semibold text-gray-400 mb-1.5`}>名称</label><input className="w-full h-9 px-3 text-sm rounded-xl border border-gray-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none bg-gray-50 focus:bg-white transition-all" value={c.label} onChange={e=>up(c.id,{label:e.target.value})} /></div>
                    <div><label className={`block ${S} font-semibold text-gray-400 mb-1.5`}>分组</label><select className="w-full h-9 px-3 text-sm rounded-xl border border-gray-200 focus:border-indigo-400 outline-none bg-gray-50 focus:bg-white transition-all" value={c.group} onChange={e=>up(c.id,{group:e.target.value})}>{GROUPS.map(g=><option key={g} value={g}>{g}</option>)}</select></div>
                    <div><label className={`block ${S} font-semibold text-gray-400 mb-1.5`}>冷却(秒)</label><input type="number" min={0} max={600} className="w-full h-9 px-3 text-sm rounded-xl border border-gray-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none bg-gray-50 focus:bg-white transition-all" value={c.cooldownSec} onChange={e=>up(c.id,{cooldownSec:Number(e.target.value)||0})} /></div>
                  </div>
                </section>

                {/* Triggers */}
                <section>
                  <div className="flex items-center justify-between mb-3"><div className="flex items-center gap-2"><Tag size={14} className="text-gray-400" /><h4 className="text-sm font-bold text-gray-600">触发器</h4></div><span className={`${S} text-gray-400`}>{c.triggers.length} 个</span></div>
                  <div className="flex flex-wrap gap-1.5 mb-3">{c.triggers.map((t,i)=>(<span key={t} className={`inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-lg text-xs font-mono font-medium transition-all ${i===0?'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 shadow-sm':'bg-gray-50 text-gray-500 ring-1 ring-gray-200 hover:ring-gray-300'}`}>{i===0&&<span className="text-[9px] font-extrabold text-indigo-400 bg-indigo-100 px-1 rounded tracking-wider">主</span>}{pfx}{t}{c.triggers.length>1&&<button onClick={()=>rt(c.id,t)} className="p-0.5 rounded-full hover:bg-red-100 hover:text-red-500 text-gray-300 transition-colors"><X size={10} /></button>}</span>))}</div>
                  <div className="flex items-center gap-2"><span className={`${S} text-gray-400 flex-shrink-0 font-mono`}>{pfx}</span><input className="flex-1 h-8 px-3 text-xs rounded-lg border border-dashed border-gray-300 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none font-mono placeholder:text-gray-300 bg-transparent transition-all" placeholder="新触发词，回车添加..." value={nt} onChange={e=>setNt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter') at(c.id);}} /><button onClick={()=>at(c.id)} className="text-xs text-indigo-500 hover:text-indigo-700 font-semibold px-2 py-0.5 flex-shrink-0">添加</button></div>
                </section>

                {/* Cards */}
                <section>
                  <div className="flex items-center justify-between mb-3"><div className="flex items-center gap-2"><Layout size={14} className="text-gray-400" /><h4 className="text-sm font-bold text-gray-600">卡片渲染</h4></div><span className={`${S} text-gray-400`}>{c.cardTypes.length} 种</span></div>
                  {c.cardTypes.length === 0 ? (
                    <div className="text-center py-10 bg-gray-50/50 rounded-2xl border border-dashed border-gray-200"><Zap size={24} className="mx-auto text-gray-300 mb-2" /><p className={`${S} text-gray-400`}>纯文本命令，无卡片渲染</p></div>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                      {c.cardTypes.map(ct => {
                        const mode: RenderMode = c.renderModes?.[ct] || 'image';
                        return (
                          <div key={ct} className="flex items-center justify-between px-4 py-3 bg-gray-50/70 hover:bg-gray-100/70 rounded-2xl transition-colors group border border-transparent hover:border-gray-200">
                            <div className="flex items-center gap-3 min-w-0">
                              <button onClick={() => openPreview(ct)} className="flex items-center gap-1.5 text-indigo-500 hover:text-indigo-700 transition-colors min-w-0" title="预览（真实数据）">
                                <Eye size={13} className="flex-shrink-0" />
                                <span className={`${S} font-semibold truncate`}>{CT[ct]||ct}</span>
                              </button>
                              <code className="text-[10px] text-gray-400 font-mono hidden xl:inline truncate">{ct}</code>
                            </div>
                            <div className="flex items-center flex-shrink-0">
                              <div className="inline-flex rounded-xl overflow-hidden ring-1 ring-gray-200 shadow-sm">
                                {(['image','text'] as const).map(m => {
                                  const a = mode===m;
                                  return (
                                    <button key={m} type="button" onClick={()=>up(c.id,{renderModes:{...(c.renderModes||{}),[ct]:m}})}
                                      className={`flex items-center gap-1 px-2.5 py-1.5 ${S} font-semibold transition-all border-0 cursor-pointer ${a?'bg-indigo-500 text-white':'bg-white text-gray-400 hover:bg-gray-50 hover:text-gray-500'}`}>
                                      {m==='image'?<Image size={11}/>:<FileText size={11}/>}{m==='image'?'图片':'文字'}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Danger */}
                <section className="pt-4 border-t border-gray-100">
                  <div className="flex items-center justify-between">
                    <div><h4 className="text-sm font-bold text-gray-400">删除命令</h4><p className={`${S} text-gray-400 mt-0.5`}>永久移除，不可恢复</p></div>
                    <button onClick={()=>setDel(c.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl text-red-500 hover:bg-red-50 hover:text-red-600 transition-colors"><Trash2 size={13} />删除</button>
                  </div>
                </section>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 py-20 gap-3">
              <Zap size={32} className="text-gray-300" />
              <div className="text-center"><p className="text-sm">选择左侧命令开始编辑</p><p className={`${S} mt-1 text-gray-300`}>或点击"新建"创建自定义命令</p></div>
            </div>
          )}
        </main>
      </div>

      {/* Preview Modal — 动态真实数据 */}
      <Modal open={!!pv} title={`卡片预览: ${pv}`} onClose={closePreview} wide>
        {pvLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-indigo-500" />
            <span className="ml-2 text-sm text-gray-400">拉取真实数据...</span>
          </div>
        ) : pvData ? (
          <img src={pvData} className="w-full rounded" alt={pv || ''} />
        ) : (
          <div className="text-center py-16 text-sm text-gray-400">预览失败</div>
        )}
      </Modal>

      {/* Modals */}
      <Modal open={addOpen} title="新建命令" onClose={()=>setAddOpen(false)}>
        <div className="space-y-3">
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">ID</label><input className="w-full h-9 px-3 text-sm rounded-xl border border-gray-200 focus:border-indigo-400 outline-none font-mono" placeholder="draw" value={add.id} onChange={e=>setAdd(p=>({...p,id:e.target.value}))} /><p className="text-[10px] text-gray-400 mt-1">英文+下划线</p></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">名称</label><input className="w-full h-9 px-3 text-sm rounded-xl border border-gray-200 focus:border-indigo-400 outline-none" placeholder="绘图姬绘图" value={add.label} onChange={e=>setAdd(p=>({...p,label:e.target.value}))} /></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1">分组</label><select className="w-full h-9 px-3 text-sm rounded-xl border border-gray-200 focus:border-indigo-400 outline-none bg-white" value={add.group} onChange={e=>setAdd(p=>({...p,group:e.target.value}))}>{GROUPS.map(g=><option key={g} value={g}>{g}</option>)}</select></div>
          <div className="flex justify-end gap-2 pt-2"><button className="btn btn-sm btn-outline" onClick={()=>setAddOpen(false)}>取消</button><button className="btn btn-sm" onClick={mk}>创建</button></div>
        </div>
      </Modal>

      <Modal open={!!del} title="删除" onClose={()=>setDel(null)}>
        <p className="text-sm text-gray-500 mb-4">确定删除？不可撤销。</p>
        <div className="flex justify-end gap-2"><button className="btn btn-sm btn-outline" onClick={()=>setDel(null)}>取消</button><button className="btn btn-sm btn-danger" onClick={()=>del&&rm(del)}>删除</button></div>
      </Modal>
    </div>
  );
}

/** 将后端命令配置合并到编辑态命令模型，完整保留别名触发词。 */
function mergeCommandConfigs(configs: BotCommandConfig[], prefix: string): Cmd[] {
  const used = new Set<string>();
  const merged: Cmd[] = [];
  // 后端返回的配置是保存后的权威列表；这里仅补展示字段，不能把缺失的默认命令重新插回。
  for (const remote of configs) {
    const triggers = readTriggers(remote, prefix, []);
    const base = findDefaultConfig(remote, triggers);
    const id = String(remote.id ?? base?.id ?? '').trim();
    if (!id || used.has(id)) continue;
    used.add(id);
    merged.push({
      id,
      label: typeof remote.label === 'string' && remote.label.trim() ? remote.label : base?.label ?? id,
      group: typeof remote.group === 'string' && GROUPS.includes(remote.group) ? remote.group : base?.group ?? '查询',
      triggers: triggers.length > 0 ? triggers : base?.triggers ?? [id],
      enabled: remote.enabled !== false,
      cooldownSec: Number.isFinite(remote.cooldownSec) ? Number(remote.cooldownSec) : base?.cooldownSec ?? 0,
      cardTypes: Array.isArray(remote.cardTypes) ? remote.cardTypes : base?.cardTypes ?? [],
      renderModes: remote.renderModes,
    });
  }
  return merged;
}

/** 根据稳定 ID 或触发词查找内置命令默认展示信息；只补字段，不决定列表成员。 */
function findDefaultConfig(config: BotCommandConfig, triggers: string[]): Cmd | undefined {
  const id = String(config.id ?? '').trim();
  return DEFAULTS.find((item) => item.id === id)
    ?? DEFAULTS.find((item) => triggers.some((trigger) => item.triggers.includes(trigger)));
}

/** 提取主触发词和别名，统一移除当前前缀。 */
function readTriggers(config: BotCommandConfig, prefix: string, fallback: string[]): string[] {
  const triggers = [config.command, ...(config.aliases ?? [])]
    .filter((item): item is string => typeof item === 'string')
    .map((item) => stripCommandPrefix(item.trim(), prefix))
    .filter((item) => item.length > 0);
  return triggers.length > 0 ? [...new Set(triggers)] : fallback;
}

/** 去除命令前缀；兼容旧配置中非标准前缀。 */
function stripCommandPrefix(value: string, prefix: string): string {
  if (!value) return '';
  if (prefix && value.startsWith(prefix)) return value.slice(prefix.length).trim();
  return value.replace(/^[^a-zA-Z0-9一-鿿\\s]+/, '').trim();
}

/** 归一化 `/help` 后台预览命令配置，确保别名按命令块传给 renderer。 */
function normalizeHelpPreviewConfigs(configs: BotCommandConfig[], prefix: string): BotCommandConfig[] {
  return configs
    .filter((item) => item.enabled !== false && typeof item.command === 'string' && item.command.trim())
    .map((item) => ({
      ...item,
      command: ensureCommandPrefix(item.command, prefix),
      aliases: (item.aliases ?? []).map((alias) => ensureCommandPrefix(alias, prefix)),
    }));
}

/** 命令预览兜底配置；只在真实命令配置接口不可用时用于后台卡片预览。 */
function buildHelpPreviewConfigs(prefix: string): BotCommandConfig[] {
  return [
    { id: 'draw', command: `${prefix}绘图`, aliases: [`${prefix}生成`, `${prefix}draw`, `${prefix}generate`], enabled: true, label: '绘图' },
    { id: 'retry', command: `${prefix}重试`, aliases: [`${prefix}retry`], enabled: true, label: '重试' },
    { id: 'model', command: `${prefix}模型`, aliases: [`${prefix}models`], enabled: true, label: '模型' },
    { id: 'tasks', command: `${prefix}任务`, aliases: [`${prefix}记录`, `${prefix}tasks`], enabled: true, label: '任务' },
    { id: 'generation_stats', command: `${prefix}统计`, aliases: [], enabled: true, label: '统计' },
    { id: 'status', command: `${prefix}状态`, aliases: [`${prefix}status`, `${prefix}stats`], enabled: true, label: '状态' },
    { id: 'info', command: `${prefix}info`, aliases: [`${prefix}站点统计`], enabled: true, label: '站点统计' },
    { id: 'balance', command: `${prefix}余额`, aliases: [`${prefix}额度`, `${prefix}次数`], enabled: true, label: '余额' },
    { id: 'recharge', command: `${prefix}充值`, aliases: [`${prefix}兑换`, `${prefix}redeem`], enabled: true, label: '充值' },
    { id: 'bind', command: `${prefix}绑定`, aliases: [`${prefix}bind`], enabled: true, label: '绑定' },
    { id: 'privacy', command: `${prefix}隐私`, aliases: [`${prefix}privacy`], enabled: true, label: '隐私' },
    { id: 'help', command: `${prefix}帮助`, aliases: [`${prefix}help`], enabled: true, label: '帮助' },
    { id: 'ping', command: `${prefix}ping`, aliases: [], enabled: true, label: '连通' },
    { id: 'botlist', command: `${prefix}bot`, aliases: [`${prefix}bots`, `${prefix}list`], enabled: true, label: 'Bot 列表' },
  ];
}

/** 确保后台预览命令带有当前配置前缀。 */
function ensureCommandPrefix(value: string, prefix: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith(prefix) ? trimmed : `${prefix}${stripCommandPrefix(trimmed, prefix)}`;
}

/** 构造 `/info` 预览兜底数据；仅在真实状态接口不可用时用于后台渲染预览。 */
function buildSiteInfoPreviewStatus(): PublicStatusResponse {
  return {
    range: '24h',
    since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    generatedAt: new Date().toISOString(),
    services: [
      previewService('backend', '后端', true, 18),
      previewService('drawing-service', '绘图调度', true, 26),
      previewService('drawing-worker', '绘图 Worker', true, 31),
      previewService('media-service', '媒体存储', true, 21),
      previewService('bot-service', 'Bot 服务', true, 28),
      previewService('bot-renderer', '卡片渲染', true, 35),
      previewService('wsproxy-service', 'WS 代理', true, 23),
      previewService('ops-worker', '运维 Worker', true, 19),
      previewService('notification-worker', '邮件通知', false, null, '探活超时'),
    ],
    tasks: { total: 286, queued: 4, running: 9, finalizing: 2, success: 238, failed: 33, terminalTotal: 271, successRate: 87.8 },
    sources: [
      { source: 'bot', total: 178, success: 151, failed: 19 },
      { source: 'web', total: 105, success: 85, failed: 13 },
    ],
    sites: [
      previewSite(1, '科比', true, 12, 5, 0, 104, 92, 9, 2, 91.1, 36800),
      previewSite(2, 'zxai', true, 10, 4, 1, 88, 70, 15, 5, 82.4, 44200),
      previewSite(3, 'matr', true, 8, 3, 0, 71, 68, 2, 1, 97.1, 28600),
      previewSite(4, 'local-comfy', true, 6, 2, 0, 18, 15, 2, 1, 88.2, 51000),
      previewSite(5, 'backup-a', false, 3, 1, 5, 5, 0, 5, 0, 0, null),
    ],
    bots: { total: 6, online: 4, offline: 1, banned: 1 },
    platform: { users: 1386, verifiedUsers: 940, publicImages: 21840, enabledSites: 4 },
  };
}

/** 构造后台预览服务节点，真实接口不可用时保持卡片结构完整。 */
function previewService(name: string, label: string, ok: boolean, latencyMs: number | null, error: string | null = null): PublicStatusResponse['services'][number] {
  return { name, label, ok, statusCode: ok ? 200 : null, version: '3.0.0', uptimeSec: ok ? 86400 : 0, latencyMs, error };
}

/** 构造后台预览站点节点，字段与公开状态页契约保持一致。 */
function previewSite(
  id: number,
  name: string,
  isEnabled: boolean,
  weight: number,
  maxConcurrency: number,
  consecutiveFailures: number,
  attempts: number,
  success: number,
  failed: number,
  active: number,
  successRate: number | null,
  avgLatencyMs: number | null,
): PublicStatusResponse['sites'][number] {
  return {
    id,
    name,
    isEnabled,
    weight,
    maxConcurrency,
    consecutiveFailures,
    autoDisabledUntil: null,
    autoDisabledReason: isEnabled ? null : '预览停用',
    lifetimeCalls: attempts * 40,
    lifetimeSuccess: success * 40,
    lifetimeAvgLatencyMs: avgLatencyMs ?? 0,
    attempts,
    success,
    failed,
    active,
    successRate,
    avgLatencyMs,
  };
}
