/** 本文件实现管理后台钱包管理页：按 Web/QQ 钱包查询、调付费余额、重置免费余额。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, RefreshCw, RotateCw, Search, Wallet, X } from 'lucide-react';
import { api } from '../../api/client';

type OwnerTypeFilter = 'all' | 'user' | 'qq';
type AdjustDirection = 'add' | 'subtract';

/** 后端钱包列表项；金额字段均为格式化字符串，前端只负责展示和提交操作。 */
interface WalletItem {
  walletId: number;
  ownerType: 'user' | 'qq';
  ownerKey: string;
  freeBalance: string;
  paidBalance: string;
  totalBalance: string;
  linkedUserId: number | null;
  linkedUsername: string | null;
  linkedQqNumber: string | null;
  email: string | null;
  emailVerified: boolean | null;
  ledgerCount: number;
  chargeCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ToastState { message: string; type: 'success' | 'error'; }

const PAGE_SIZE = 20;

/** 钱包管理页主组件。 */
export function BalancePage() {
  const [items, setItems] = useState<WalletItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [ownerType, setOwnerType] = useState<OwnerTypeFilter>('all');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [detail, setDetail] = useState<WalletItem | null>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustDirection, setAdjustDirection] = useState<AdjustDirection>('add');
  const [submitting, setSubmitting] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const summary = useMemo(() => {
    return items.reduce((acc, item) => ({
      free: acc.free + Number(item.freeBalance),
      paid: acc.paid + Number(item.paidBalance),
      user: acc.user + (item.ownerType === 'user' ? 1 : 0),
      qq: acc.qq + (item.ownerType === 'qq' ? 1 : 0),
    }), { free: 0, paid: 0, user: 0, qq: 0 });
  }, [items]);

  const fetchWallets = useCallback(async (nextPage = page) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(nextPage), pageSize: String(PAGE_SIZE) });
    if (search.trim()) params.set('search', search.trim());
    if (ownerType !== 'all') params.set('ownerType', ownerType);
    const res = await api<{ items: WalletItem[]; total: number }>(`/admin/balance/wallets?${params}`);
    if (res.ok && res.data) {
      setItems(res.data.items ?? []);
      setTotal(res.data.total ?? 0);
    } else {
      setToast({ type: 'error', message: res.message ?? '加载钱包列表失败' });
    }
    setLoading(false);
  }, [ownerType, page, search]);

  useEffect(() => {
    fetchWallets();
  }, [fetchWallets]);

  const runSearch = () => {
    setPage(1);
    fetchWallets(1);
  };

  const adjustWallet = async () => {
    if (!detail) return;
    const amount = Number(adjustAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setToast({ type: 'error', message: '请输入有效金额' });
      return;
    }
    setSubmitting(true);
    const signedAmount = adjustDirection === 'subtract' ? -amount : amount;
    const res = await api<{ action: string; newBalance: string }>('/admin/balance/wallet-adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletId: detail.walletId, amount: signedAmount, reason: adjustReason || undefined }),
    });
    setSubmitting(false);
    if (res.ok) {
      setToast({ type: 'success', message: res.data?.action ?? '余额已调整' });
      setAdjustAmount('');
      setAdjustReason('');
      setDetail(null);
      fetchWallets();
    } else {
      setToast({ type: 'error', message: res.message ?? '调整失败' });
    }
  };

  const resetWalletFree = async () => {
    if (!detail) return;
    setSubmitting(true);
    const res = await api<{ freeBalance: string }>(`/admin/balance/reset-free-wallet/${detail.walletId}`, { method: 'POST' });
    setSubmitting(false);
    if (res.ok) {
      setToast({ type: 'success', message: `已重置钱包 #${detail.walletId} 免费余额` });
      setDetail(null);
      fetchWallets();
    } else {
      setToast({ type: 'error', message: res.message ?? '重置失败' });
    }
  };

  const resetAllFree = async () => {
    if (!window.confirm('确认重置所有 Web/QQ 钱包的每日免费余额？该操作会影响全部用户。')) return;
    setResettingAll(true);
    const res = await api<{ count: number; freeBalance: string }>('/admin/balance/reset-free-all', { method: 'POST' });
    setResettingAll(false);
    setToast({
      type: res.ok ? 'success' : 'error',
      message: res.ok ? `已重置 ${res.data?.count ?? 0} 个钱包，单钱包免费余额 ${res.data?.freeBalance ?? '0.00'}` : res.message ?? '重置失败',
    });
    if (res.ok) fetchWallets();
  };

  return (
    <div className="max-w-[1500px]">
      {toast && <Toast state={toast} onClose={() => setToast(null)} />}

      <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Wallet size={20} style={{ color: 'var(--color-primary)' }} />
            <h2 className="page-title">钱包管理</h2>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-2)' }}>
            Web 钱包和 QQ 钱包独立展示，绑定只代表共享访问权，余额操作必须落到具体钱包。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={resetAllFree} disabled={resettingAll} className="btn btn-sm btn-outline">
            <RefreshCw size={14} className={resettingAll ? 'animate-spin mr-1' : 'mr-1'} />
            重置全部免费余额
          </button>
          <button onClick={() => fetchWallets()} className="btn btn-sm btn-outline">
            <RotateCw size={14} className={loading ? 'animate-spin mr-1' : 'mr-1'} />
            刷新
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Metric label="当前页免费余额" value={`¥${summary.free.toFixed(2)}`} tone="green" />
        <Metric label="当前页付费余额" value={`¥${summary.paid.toFixed(2)}`} tone="blue" />
        <Metric label="Web 钱包" value={String(summary.user)} tone="neutral" />
        <Metric label="QQ 钱包" value={String(summary.qq)} tone="neutral" />
      </div>

      <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-4">
        <div className="flex items-center gap-1 bg-[var(--color-bg)] rounded-lg p-1 border" style={{ borderColor: 'var(--color-border)' }}>
          {(['all', 'user', 'qq'] as OwnerTypeFilter[]).map((type) => (
            <button
              key={type}
              onClick={() => { setOwnerType(type); setPage(1); }}
              className="px-3 py-1.5 text-xs rounded-md transition-colors"
              style={{
                background: ownerType === type ? 'var(--color-primary)' : 'transparent',
                color: ownerType === type ? '#fff' : 'var(--color-text-2)',
              }}
            >
              {type === 'all' ? '全部' : type === 'user' ? 'Web' : 'QQ'}
            </button>
          ))}
        </div>
        <div className="flex items-center flex-1 max-w-md">
          <input
            className="input rounded-r-none text-sm"
            placeholder="搜索钱包归属、用户名或邮箱"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && runSearch()}
          />
          <button onClick={runSearch} className="btn rounded-l-none">
            <Search size={14} />
          </button>
        </div>
        <span className="text-xs lg:ml-auto" style={{ color: 'var(--color-text-2)' }}>
          共 {total} 个钱包
        </span>
      </div>

      <div className="card overflow-x-auto" style={{ padding: 0 }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b" style={{ borderColor: 'var(--color-border)' }}>
              {['钱包', '归属', '绑定', '免费', '付费', '总额', '流水', '更新时间', '操作'].map((label) => (
                <th key={label} className="p-2.5 text-left text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr><td colSpan={9} className="text-center py-14" style={{ color: 'var(--color-text-2)' }}><RotateCw size={18} className="animate-spin mx-auto mb-2" />加载中...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={9} className="text-center py-14" style={{ color: 'var(--color-text-2)' }}>暂无钱包</td></tr>
            ) : items.map((item) => (
              <tr key={item.walletId} className="border-b hover:bg-gray-50 transition-colors" style={{ borderColor: 'var(--color-border)' }}>
                <td className="p-2.5">
                  <div className="font-semibold">#{item.walletId}</div>
                  <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>{item.ownerType === 'user' ? 'Web 钱包' : 'QQ 钱包'}</div>
                </td>
                <td className="p-2.5">
                  <div className="font-mono text-xs">{item.ownerKey}</div>
                  <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>{item.email ?? '-'}</div>
                </td>
                <td className="p-2.5">
                  <div>{item.linkedUsername ?? (item.linkedUserId ? `用户 #${item.linkedUserId}` : '-')}</div>
                  <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>{item.linkedQqNumber ? `QQ ${item.linkedQqNumber}` : '未绑定 QQ'}</div>
                </td>
                <td className="p-2.5 text-green-600 font-medium">¥{item.freeBalance}</td>
                <td className="p-2.5 text-indigo-600 font-medium">¥{item.paidBalance}</td>
                <td className="p-2.5 font-semibold">¥{item.totalBalance}</td>
                <td className="p-2.5 text-xs" style={{ color: 'var(--color-text-2)' }}>{item.ledgerCount} / 扣费 {item.chargeCount}</td>
                <td className="p-2.5 text-xs" style={{ color: 'var(--color-text-2)' }}>{String(item.updatedAt).slice(0, 19)}</td>
                <td className="p-2.5">
                  <button className="btn btn-sm btn-outline" onClick={() => setDetail(item)}>操作</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-4">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="btn btn-sm btn-outline"><ChevronLeft size={14} /></button>
          <span className="text-xs px-3" style={{ color: 'var(--color-text-2)' }}>{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="btn btn-sm btn-outline"><ChevronRight size={14} /></button>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4" onClick={() => setDetail(null)}>
          <div className="w-full max-w-lg rounded-xl bg-[var(--color-surface)] shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
              <div>
                <h3 className="font-bold">钱包 #{detail.walletId}</h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-2)' }}>{detail.ownerType === 'user' ? 'Web 用户钱包' : 'QQ 独立钱包'}</p>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setDetail(null)}><X size={16} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <Metric label="免费" value={`¥${detail.freeBalance}`} tone="green" />
                <Metric label="付费" value={`¥${detail.paidBalance}`} tone="blue" />
                <Metric label="总额" value={`¥${detail.totalBalance}`} tone="neutral" />
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Info label="归属键" value={detail.ownerKey} />
                <Info label="绑定 QQ" value={detail.linkedQqNumber ?? '-'} />
                <Info label="绑定用户" value={detail.linkedUsername ?? (detail.linkedUserId ? `#${detail.linkedUserId}` : '-')} />
                <Info label="邮箱验证" value={detail.emailVerified === null ? '-' : detail.emailVerified ? '已验证' : '未验证'} />
              </div>
              <div className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
                <div className="flex flex-wrap items-center gap-2">
                  <select className="input text-sm w-24" value={adjustDirection} onChange={(event) => setAdjustDirection(event.target.value as AdjustDirection)}>
                    <option value="add">增加</option>
                    <option value="subtract">扣除</option>
                  </select>
                  <input className="input text-sm w-28" type="number" min="0.01" step="0.01" placeholder="金额" value={adjustAmount} onChange={(event) => setAdjustAmount(event.target.value)} />
                  <input className="input text-sm flex-1 min-w-[140px]" placeholder="原因，可选" value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} />
                  <button onClick={adjustWallet} disabled={submitting} className="btn btn-sm">
                    {submitting ? <RotateCw size={14} className="animate-spin mr-1" /> : adjustDirection === 'add' ? <Plus size={14} className="mr-1" /> : <Minus size={14} className="mr-1" />}
                    调整付费
                  </button>
                </div>
                <button onClick={resetWalletFree} disabled={submitting} className="btn btn-sm btn-outline w-full mt-3">
                  <RefreshCw size={14} className={submitting ? 'animate-spin mr-1' : 'mr-1'} />
                  重置该钱包免费余额
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Toast({ state, onClose }: { state: ToastState; onClose: () => void }) {
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm text-white ${state.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
      <span>{state.message}</span>
      <button onClick={onClose} className="ml-3 text-white/80 hover:text-white">×</button>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'green' | 'blue' | 'neutral' }) {
  const color = tone === 'green' ? 'var(--color-success)' : tone === 'blue' ? 'var(--color-primary)' : 'var(--color-text)';
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}>
      <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>{label}</div>
      <div className="text-base font-bold mt-1" style={{ color }}>{value}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>{label}</div>
      <div className="mt-1 break-all">{value}</div>
    </div>
  );
}
