/** Bot 管理 — 展示全部 Bot 实时状态 + 在线/离线时长（时:分:秒），参考 V2 后台布局 */
import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Plus, Circle, Wifi, WifiOff, Clock, RefreshCw, Unlink, Zap, AlertTriangle, Search, Activity, Shield } from 'lucide-react';
import { api } from '../../lib/api';
import { config } from '../../lib/config';

type BotInfo = {
  id: number; selfId: string; qqNumber: string; nickname: string;
  status: 'online' | 'offline'; lastSeenAt: string | null; connectedAt: string | null;
  uptimeSec: number; messageCount?: number; banned?: boolean;
};

/** 格式化秒数为 HH:MM:SS */
function fmtDuration(totalSec: number): string {
  if (totalSec < 0) totalSec = 0;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 确认对话框 — 用于解绑等不可逆操作 */
function ConfirmModal({ open, title, message, onConfirm, onCancel, confirmLabel, danger }: {
  open: boolean; title: string; message: string; onConfirm: () => void; onCancel: () => void; confirmLabel?: string; danger?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={onCancel}>
      <div className="card p-6 mx-4 animate-fade-in" style={{ maxWidth: 400, width: '100%', borderRadius: 12 }} onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-4 mb-5">
          <div className="flex-shrink-0 flex items-center justify-center rounded-full" style={{ width: 40, height: 40, background: danger ? '#fef2f2' : '#fffbeb' }}>
            <AlertTriangle size={20} style={{ color: danger ? '#dc2626' : '#d97706' }} />
          </div>
          <div>
            <div className="text-base font-semibold mb-1">{title}</div>
            <div className="text-sm text-text-2 leading-relaxed">{message}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2.5">
          <button onClick={onCancel} className="btn btn-ghost btn-sm px-4">取消</button>
          <button onClick={onConfirm} className="btn btn-sm px-5" style={{ background: danger ? '#dc2626' : 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 6 }}>
            {confirmLabel || '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 计算相对时间文本 */
function timeAgo(iso: string | null): string {
  if (!iso) return '从未连接';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

/** 时长显示组件 — 每秒更新 */
function DurationDisplay({ status, connectedAt, uptimeSec, lastSeenAt }: {
  status: string; connectedAt: string | null; uptimeSec: number; lastSeenAt: string | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  if (status === 'online') {
    // uptimeSec 是 wsproxy 返回的基准值，加上从获取到现在的时间差
    const elapsed = uptimeSec > 0 ? uptimeSec : 0;
    return (
      <span className="flex items-center gap-1 text-[11px]" style={{ color: '#16a34a' }}>
        <Zap size={10} />
        <span className="font-mono">{fmtDuration(elapsed)}</span>
      </span>
    );
  }

  if (lastSeenAt) {
    const offlineSec = Math.floor((now - new Date(lastSeenAt).getTime()) / 1000);
    if (offlineSec < 0) return <span className="text-[11px] text-text-2">—</span>;
    return (
      <span className="flex items-center gap-1 text-[11px] text-text-2 font-mono">
        <Clock size={10} />
        <span>{fmtDuration(offlineSec)}</span>
      </span>
    );
  }

  return <span className="text-[11px] text-text-2">从未连接</span>;
}

export function BotsPage() {
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [mySelfIds, setMySelfIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unbinding, setUnbinding] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<BotInfo | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline' | 'banned'>('all');
  const refreshTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchBots = async () => {
    try {
      const [allRes, myRes] = await Promise.all([
        api<{ items: BotInfo[] }>('/wsproxy/public-bots'),
        api<{ items: { selfId: string }[] }>('/wsproxy/my-bots').catch(() => ({ ok: false, data: undefined } as const)),
      ]);
      if (allRes.ok && allRes.data) {
        setBots(allRes.data.items ?? []);
        setError(null);
      } else {
        setError('加载失败');
      }
      // 记录当前用户的 Bot selfId，用于显示「我的」标签
      if (myRes.ok && myRes.data) {
        setMySelfIds(new Set((myRes.data.items ?? []).map(b => b.selfId)));
      }
    } catch { setError('网络不可达'); }
    setLoading(false);
  };

  useEffect(() => {
    fetchBots();
    refreshTimer.current = setInterval(fetchBots, config.botRefreshInterval);
    return () => clearInterval(refreshTimer.current);
  }, []);

  const doUnbind = async () => {
    if (!confirmTarget) return;
    const selfId = confirmTarget.selfId;
    setConfirmTarget(null);
    setUnbinding(selfId);
    try {
      // api() 已经按 config.apiBase 拼接后端地址；这里必须使用后端真实路由，避免生产出现 /api/api/wsproxy。
      const d = await api(`/wsproxy/bots/${selfId}/unbind`, { method: 'POST' });
      if (d.ok) setBots(prev => prev.filter(b => b.selfId !== selfId));
    } catch { /* ignore */ }
    setUnbinding(null);
  };

  const onlineBots = bots.filter(b => b.status === 'online');
  const offlineBots = bots.filter(b => b.status === 'offline' && !b.banned);
  const bannedBots = bots.filter(b => b.banned);

  const filtered = bots.filter(b => {
    if (statusFilter === 'online' && b.status !== 'online') return false;
    if (statusFilter === 'offline' && (b.status !== 'offline' || b.banned)) return false;
    if (statusFilter === 'banned' && !b.banned) return false;
    if (search && !b.qqNumber.includes(search) && !(b.nickname && b.nickname.includes(search))) return false;
    return true;
  });

  return (
    <div className="animate-fade-in" style={{ maxWidth: 960, margin: '0 auto' }}>
      <ConfirmModal open={!!confirmTarget} title="确认解绑 Bot"
        message={`确定解绑 Bot ${confirmTarget?.qqNumber ?? ''}？解绑后将删除端点数据并断开连接。`}
        confirmLabel="确认解绑" danger onConfirm={doUnbind} onCancel={() => setConfirmTarget(null)} />

      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="page-title flex items-center gap-2.5 mb-1"><Bot size={22} />Bot 状态监控</h1>
          <p className="text-xs text-text-2">全部已注册 Bot 的实时连接状态</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchBots} className="btn btn-ghost btn-sm flex items-center gap-1.5" style={{ borderRadius: 6 }}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />刷新
          </button>
          <Link to="/bots/add" className="btn btn-sm flex items-center gap-1.5" style={{ borderRadius: 6 }}>
            <Plus size={14} />绑定 Bot
          </Link>
        </div>
      </div>

      {/* 搜索 + 过滤器 */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg flex-1" style={{ maxWidth: 280, background: 'var(--color-bg)' }}>
          <Search size={14} className="text-text-2 flex-shrink-0" />
          <input placeholder="搜索 QQ 号或昵称..." value={search} onChange={e => setSearch(e.target.value)}
            className="bg-transparent border-none outline-none text-sm w-full" style={{ color: 'var(--color-text)' }} />
        </div>
        <div className="flex items-center gap-1">
          {(['all', 'online', 'offline', 'banned'] as const).map(f => (
            <button key={f} onClick={() => setStatusFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${statusFilter === f ? 'text-white' : 'text-text-2 hover:text-text'}`}
              style={{ background: statusFilter === f ? 'var(--color-primary)' : 'var(--color-bg)', border: statusFilter === f ? 'none' : '1px solid var(--color-border)' }}>
              {f === 'all' ? '全部' : f === 'online' ? '在线' : f === 'offline' ? '离线' : '已封禁'}
            </button>
          ))}
        </div>
        <span className="text-xs text-text-2">{filtered.length} / {bots.length} 个 Bot</span>
      </div>

      {/* 统计概览 */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <StatCard icon={<Activity size={16} />} label="Bot 总数" value={bots.length} color="var(--color-primary)" />
        <StatCard icon={<Wifi size={16} />} label="在线" value={onlineBots.length} color="#16a34a" accent={onlineBots.length > 0} />
        <StatCard icon={<WifiOff size={16} />} label="离线" value={offlineBots.length} color="var(--color-text-2)" />
        <StatCard icon={<Shield size={16} />} label="已封禁" value={bannedBots.length} color="#dc2626" accent={bannedBots.length > 0} />
      </div>

      {/* 错误 */}
      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 rounded-lg text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626' }}>
          <AlertTriangle size={14} />{error}<button onClick={fetchBots} className="underline ml-2 font-medium text-xs">重试</button>
        </div>
      )}

      {/* 内容 */}
      {loading ? (
        <div className="space-y-3">
          {[1,2,3,4].map(i => (
            <div key={i} className="card p-5 animate-pulse">
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-bg" style={{ width: 44, height: 44 }} />
                <div className="flex-1 space-y-2"><div className="h-4 bg-bg rounded w-28" /><div className="h-3 bg-bg rounded w-20" /></div>
                <div className="h-6 bg-bg rounded w-14" /><div className="h-5 bg-bg rounded w-16" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-16" style={{ borderRadius: 12 }}>
          {bots.length === 0 ? (
            <>
              <div className="flex items-center justify-center mx-auto mb-4 rounded-full" style={{ width: 64, height: 64, background: 'var(--color-primary-soft)', opacity: 0.5 }}>
                <Bot size={32} className="text-primary opacity-60" />
              </div>
              <div className="text-base font-semibold mb-1.5">暂无 Bot</div>
              <div className="text-sm text-text-2 mb-5">绑定 NapCatQQ / OneBot 客户端开始使用</div>
              <Link to="/bots/add" className="btn btn-sm flex items-center gap-1.5" style={{ borderRadius: 6 }}>
                <Plus size={14} />绑定 Bot
              </Link>
            </>
          ) : (
            <>
              <Search size={28} className="mx-auto mb-3 text-text-2 opacity-40" />
              <div className="text-sm text-text-2">无匹配结果</div>
              <button onClick={() => { setSearch(''); setStatusFilter('all'); }} className="text-xs text-primary mt-2 underline">重置筛选</button>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {/* 表头 */}
          <div className="flex items-center gap-3 px-4 py-2 text-[11px] font-semibold text-text-2 uppercase tracking-wider">
            <div style={{ width: 44 }} />
            <div className="flex-1 min-w-0">Bot</div>
            <div className="w-16 text-center">状态</div>
            <div className="hidden sm:flex w-28 items-center justify-center gap-1">时长</div>
            <div className="hidden md:flex w-16 items-center justify-center gap-1">消息</div>
            <div className="hidden md:flex w-28 items-center justify-center gap-1">最后在线</div>
            <div className="w-20 text-right hidden sm:block">操作</div>
          </div>

          {filtered.map(b => {
            // 解绑只能展示给当前登录用户绑定的 Bot；后端仍保留 boundUserId 权限校验作为最终兜底。
            const canUnbind = !b.banned && mySelfIds.has(b.selfId);
            return (
              <div key={b.selfId} className={`card flex items-center gap-3 px-4 py-3 transition-all ${b.banned ? 'opacity-55' : ''}`}
                style={{ borderLeft: `3px solid ${b.status === 'online' ? '#16a34a' : b.banned ? '#dc2626' : 'var(--color-border)'}`, borderRadius: 8 }}>
                {/* 头像 */}
                <div className="flex-shrink-0 relative" style={{ width: 44, height: 44 }}>
                  <img src={`https://q.qlogo.cn/g?b=qq&nk=${b.qqNumber}&s=640`} alt="" loading="lazy"
                    className="w-full h-full rounded-full object-cover border-2"
                    style={{ borderColor: b.status === 'online' ? '#16a34a' : b.banned ? '#dc2626' : 'var(--color-border)' }}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  <div className="absolute inset-0 flex items-center justify-center rounded-full border-2" style={{ borderColor: b.status === 'online' ? '#16a34a' : b.banned ? '#dc2626' : 'var(--color-border)', background: 'var(--color-bg)', zIndex: -1 }}>
                    <Bot size={20} className={b.status === 'online' ? 'text-success' : 'text-text-2'} />
                  </div>
                </div>

              {/* Bot 信息 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-semibold truncate">{b.nickname || `Bot ${b.selfId}`}</span>
                  {mySelfIds.has(b.selfId) && (
                    <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}>我的</span>
                  )}
                  {b.status === 'online' && <span className="flex-shrink-0" style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', animation: 'pulse 2s infinite' }} />}
                </div>
                <div className="text-[11px] text-text-2 font-mono">{b.selfId}</div>
              </div>

              {/* 状态 */}
              <div className="w-16 flex justify-center">
                <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full"
                  style={{ background: b.banned ? '#fef2f2' : b.status === 'online' ? '#dcfce7' : '#f3f4f6', color: b.banned ? '#dc2626' : b.status === 'online' ? '#16a34a' : '#6b7280' }}>
                  <Circle size={6} fill="currentColor" />
                  {b.banned ? '已封禁' : b.status === 'online' ? '在线' : '离线'}
                </span>
              </div>

              {/* 时长 — 在线:运行时长 / 离线:离线时长 */}
              <div className="hidden sm:flex w-28 items-center justify-center">
                <DurationDisplay status={b.status} connectedAt={b.connectedAt} uptimeSec={b.uptimeSec} lastSeenAt={b.lastSeenAt} />
              </div>

              {/* 消息计数 */}
              <div className="hidden md:flex w-16 items-center justify-center text-[11px] text-text-2 font-mono">
                {(b.messageCount ?? 0).toLocaleString()}
              </div>

              {/* 最后在线 — 在线时显示「在线」，离线时显示距离上次在线的时间 */}
              <div className="hidden md:flex w-28 items-center justify-center text-[11px]">
                {b.status === 'online' ? <span style={{ color: '#16a34a' }}>在线</span> : b.lastSeenAt ? <span className="text-text-2">{timeAgo(b.lastSeenAt)}</span> : <span className="text-text-2">—</span>}
              </div>

              {/* 操作 — 仅 Bot 主人显示解绑按钮，避免非主人账户误以为可以操作。 */}
              <div className="w-20 justify-end hidden sm:flex">
                {canUnbind ? (
                  <button onClick={() => setConfirmTarget(b)} disabled={unbinding === b.selfId}
                    className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-md"
                    style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>
                    <Unlink size={11} />{unbinding === b.selfId ? '...' : '解绑'}
                  </button>
                ) : (
                  <span className="text-[11px] text-text-2 italic">—</span>
                )}
              </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, color, accent }: { icon: React.ReactNode; label: string; value: number; color: string; accent?: boolean }) {
  return (
    <div className="card px-4 py-3.5 text-center" style={{ borderTop: `2px solid ${accent ? color : 'var(--color-border)'}`, borderRadius: 8 }}>
      <div className="flex items-center justify-center gap-1.5 mb-1.5" style={{ color }}>
        {icon}<span className="text-[10px] font-medium uppercase tracking-wider text-text-2">{label}</span>
      </div>
      <div className="text-xl font-bold" style={{ color: accent ? color : 'var(--color-text-2)' }}>{value}</div>
    </div>
  );
}
