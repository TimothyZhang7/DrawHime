/** 本文件实现管理后台用户与钱包页：展示用户身份、邮箱验证、QQ 绑定和可访问钱包分布。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, Link2, Mail, RotateCw, Search, Shield, Trash2, Users, Wallet, X, XCircle } from 'lucide-react';
import { api } from '../../api/client';
import { useAdminRuntimeConfig } from '../../app/runtime-config';
import Toast from '../../components/Toast';
import { Modal } from '../../components/Modal';
import Table from '../../components/Table';
import type { TableColumn } from '../../components/Table';

interface WalletSummary {
  walletId: number;
  ownerType: 'user' | 'qq';
  ownerKey: string;
  label: string;
  freeBalance: string;
  paidBalance: string;
  totalBalance: string;
}

interface UserRecord {
  id: number;
  username: string;
  email: string | null;
  role: string;
  qqNumber: string | null;
  emailVerified: boolean;
  freeBalance: string;
  paidBalance: string;
  totalBalance: string;
  wallets: WalletSummary[];
  taskCount?: number;
  templateCount?: number;
  createdAt?: string;
}

interface UserDetail extends UserRecord {
  generationCount?: number;
  attemptCount?: number;
}

interface ToastItem { id: number; message: string; type: 'success' | 'error'; }

const PAGE_SIZE = 20;

/** 用户管理页主组件。 */
export function UsersPage() {
  const { pollIntervalSec } = useAdminRuntimeConfig();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [boundFilter, setBoundFilter] = useState<'all' | 'true' | 'false'>('all');
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRecord | null>(null);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  const addToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const fetchUsers = useCallback(async (nextPage = page) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(nextPage), pageSize: String(PAGE_SIZE) });
    if (search.trim()) params.set('search', search.trim());
    if (boundFilter !== 'all') params.set('bound', boundFilter);
    const res = await api<{ items: UserRecord[]; total: number }>(`/admin/users?${params}`);
    if (res.ok && res.data) {
      setUsers(res.data.items ?? []);
      setTotal(res.data.total ?? 0);
    } else {
      addToast('error', res.message || '获取用户列表失败');
    }
    setLoading(false);
  }, [addToast, boundFilter, page, search]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  /* 用户列表轮询使用后台系统设置的间隔，避免保留旧的固定 60 秒刷新。 */
  useEffect(() => {
    const timer = setInterval(fetchUsers, pollIntervalSec * 1000);
    return () => clearInterval(timer);
  }, [fetchUsers, pollIntervalSec]);

  const runSearch = () => {
    setPage(1);
    fetchUsers(1);
  };

  const showDetail = async (id: number) => {
    const res = await api<UserDetail>(`/admin/users/${id}`);
    if (res.ok && res.data) setDetail(res.data);
    else addToast('error', res.message || '获取详情失败');
  };

  const changeRole = async (userId: number, role: string) => {
    setSavingUserId(userId);
    const res = await api(`/admin/users/${userId}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    setSavingUserId(null);
    if (res.ok) {
      addToast('success', '角色已更新');
      fetchUsers();
    } else {
      addToast('error', res.message || '更新失败');
    }
  };

  const toggleEmailVerified = async (user: UserRecord | UserDetail) => {
    setSavingUserId(user.id);
    const next = !user.emailVerified;
    const res = await api<UserRecord>(`/admin/users/${user.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailVerified: next }),
    });
    setSavingUserId(null);
    if (res.ok) {
      addToast('success', next ? '已标记邮箱验证' : '已取消邮箱验证');
      if (detail?.id === user.id) setDetail({ ...detail, emailVerified: next });
      fetchUsers();
    } else {
      addToast('error', res.message || '更新邮箱验证状态失败');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const res = await api(`/admin/users/${deleteTarget.id}`, { method: 'DELETE' });
    if (res.ok) {
      addToast('success', '用户已软删除');
      setDeleteTarget(null);
      fetchUsers();
    } else {
      addToast('error', res.message || '删除失败');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns: TableColumn<UserRecord>[] = [
    {
      key: 'username',
      label: '用户',
      width: '210px',
      render: (_val, row) => (
        <button className="bg-transparent border-0 p-0 text-left cursor-pointer" onClick={() => showDetail(row.id)}>
          <div className="font-semibold" style={{ color: 'var(--color-primary)' }}>{row.username}</div>
          <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>ID {row.id}</div>
        </button>
      ),
    },
    {
      key: 'email',
      label: '邮箱',
      width: '230px',
      render: (_val, row) => (
        <div>
          <div className="truncate max-w-[220px]">{row.email ?? '-'}</div>
          <StatusBadge ok={row.emailVerified} okText="已验证" badText="未验证" />
        </div>
      ),
    },
    {
      key: 'qqNumber',
      label: 'QQ 绑定',
      width: '150px',
      render: (_val, row) => row.qqNumber ? (
        <span className="inline-flex items-center gap-1 text-xs"><Link2 size={13} />{row.qqNumber}</span>
      ) : <span style={{ color: 'var(--color-text-2)' }} className="text-xs">未绑定</span>,
    },
    {
      key: 'wallets',
      label: '钱包分布',
      width: '260px',
      render: (_val, row) => (
        <div className="space-y-1">
          {(row.wallets ?? []).length > 0 ? row.wallets.map((wallet) => (
            <div key={wallet.walletId} className="flex items-center justify-between gap-2 text-xs">
              <span style={{ color: 'var(--color-text-2)' }}>{wallet.ownerType === 'user' ? 'Web' : 'QQ'} #{wallet.walletId}</span>
              <span className="font-medium">免 ¥{wallet.freeBalance} / 付 ¥{wallet.paidBalance}</span>
            </div>
          )) : <span style={{ color: 'var(--color-text-2)' }} className="text-xs">暂无钱包记录</span>}
        </div>
      ),
    },
    {
      key: 'totalBalance',
      label: '可用余额',
      width: '150px',
      render: (_val, row) => (
        <div>
          <div className="font-semibold">¥{row.totalBalance ?? '0.00'}</div>
          <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>免 {row.freeBalance} / 付 {row.paidBalance}</div>
        </div>
      ),
    },
    {
      key: 'role',
      label: '角色',
      width: '120px',
      render: (_val, row) => (
        <select
          className="input input-sm text-xs"
          style={{ width: 100, height: 30, padding: '0 6px', borderRadius: 8, fontSize: 12 }}
          value={row.role ?? 'user'}
          disabled={savingUserId === row.id}
          onChange={(event) => changeRole(row.id, event.target.value)}
        >
          <option value="user">用户</option>
          <option value="admin">管理员</option>
        </select>
      ),
    },
    {
      key: 'taskCount',
      label: '使用',
      width: '110px',
      render: (_val, row) => (
        <div className="text-xs">
          <div>任务 {row.taskCount ?? 0}</div>
          <div style={{ color: 'var(--color-text-2)' }}>模板 {row.templateCount ?? 0}</div>
        </div>
      ),
    },
    {
      key: 'actions',
      label: '操作',
      width: '180px',
      render: (_val, row) => (
        <div className="flex items-center gap-1.5">
          <button className="btn btn-sm btn-outline" disabled={savingUserId === row.id} onClick={() => toggleEmailVerified(row)}>
            <Mail size={14} />
            <span className="hidden xl:inline ml-1">{row.emailVerified ? '取消验证' : '设为验证'}</span>
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => setDeleteTarget(row)} title="软删除用户">
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  if (loading && users.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <RotateCw size={22} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
        <span style={{ color: 'var(--color-text-2)' }} className="text-sm">加载中...</span>
      </div>
    );
  }

  return (
    <>
      {toasts.map((toast) => (
        <Toast key={toast.id} message={toast.message} type={toast.type} onClose={() => removeToast(toast.id)} />
      ))}

      <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Users size={20} style={{ color: 'var(--color-primary)' }} />
            <h2 className="page-title">用户与钱包</h2>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-2)' }}>
            用户身份、邮箱验证、QQ 绑定和 Web/QQ 钱包分布统一查看。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-[var(--color-bg)] rounded-lg p-1 border" style={{ borderColor: 'var(--color-border)' }}>
            {(['all', 'true', 'false'] as const).map((value) => (
              <button
                key={value}
                onClick={() => { setBoundFilter(value); setPage(1); }}
                className="px-3 py-1.5 text-xs rounded-md transition-colors"
                style={{
                  background: boundFilter === value ? 'var(--color-primary)' : 'transparent',
                  color: boundFilter === value ? '#fff' : 'var(--color-text-2)',
                }}
              >
                {value === 'all' ? '全部' : value === 'true' ? '已绑定 QQ' : '未绑定 QQ'}
              </button>
            ))}
          </div>
          <div className="flex items-center">
            <input
              className="input rounded-r-none text-sm"
              style={{ width: 240 }}
              placeholder="搜索用户名/邮箱/QQ"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && runSearch()}
            />
            <button className="btn rounded-l-none" onClick={runSearch} style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}>
              <Search size={14} />
            </button>
          </div>
          <button className="btn btn-sm btn-outline flex items-center gap-1" onClick={() => fetchUsers()}>
            <RotateCw size={14} className={loading ? 'animate-spin' : ''} />
            刷新
          </button>
        </div>
      </div>

      <div className="card overflow-hidden" style={{ padding: 0 }}>
        <Table columns={columns} data={users} rowKey="id" />
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 mt-4">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="btn btn-sm btn-outline">上一页</button>
          <span className="text-xs px-3" style={{ color: 'var(--color-text-2)' }}>{page} / {totalPages}，共 {total} 条</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="btn btn-sm btn-outline">下一页</button>
        </div>
      )}

      {detail && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setDetail(null)} />
          <div className="fixed top-0 right-0 h-full w-[480px] max-w-[92vw] bg-[var(--color-surface)] shadow-2xl z-50 overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
              <div className="flex items-center gap-2">
                <Shield size={16} style={{ color: 'var(--color-primary)' }} />
                <h3 className="text-base font-bold">{detail.username}</h3>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setDetail(null)} style={{ width: 32, height: 32, padding: 0 }}>
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-5">
              <section>
                <h4 className="text-xs font-bold mb-3" style={{ color: 'var(--color-text-2)' }}>身份</h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Info label="用户 ID" value={String(detail.id)} />
                  <Info label="角色" value={detail.role === 'admin' ? '管理员' : '用户'} />
                  <Info label="邮箱" value={detail.email ?? '-'} />
                  <Info label="QQ" value={detail.qqNumber ?? '未绑定'} />
                  <Info label="注册时间" value={String(detail.createdAt ?? '-').slice(0, 19)} />
                  <div>
                    <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>邮箱验证</div>
                    <button className="btn btn-sm btn-outline mt-1" disabled={savingUserId === detail.id} onClick={() => toggleEmailVerified(detail)}>
                      {detail.emailVerified ? <CheckCircle size={14} className="mr-1" /> : <XCircle size={14} className="mr-1" />}
                      {detail.emailVerified ? '已验证' : '未验证'}
                    </button>
                  </div>
                </div>
              </section>

              <section>
                <h4 className="text-xs font-bold mb-3" style={{ color: 'var(--color-text-2)' }}>钱包</h4>
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <Metric label="免费" value={`¥${detail.freeBalance ?? '0.00'}`} />
                  <Metric label="付费" value={`¥${detail.paidBalance ?? '0.00'}`} />
                  <Metric label="合计" value={`¥${detail.totalBalance ?? '0.00'}`} />
                </div>
                <div className="space-y-2">
                  {(detail.wallets ?? []).length > 0 ? detail.wallets.map((wallet) => (
                    <div key={wallet.walletId} className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Wallet size={15} style={{ color: 'var(--color-primary)' }} />
                          <span className="font-semibold text-sm">{wallet.label}</span>
                        </div>
                        <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>#{wallet.walletId}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                        <span>免费 ¥{wallet.freeBalance}</span>
                        <span>付费 ¥{wallet.paidBalance}</span>
                        <span>合计 ¥{wallet.totalBalance}</span>
                      </div>
                    </div>
                  )) : <div className="text-sm" style={{ color: 'var(--color-text-2)' }}>暂无钱包记录</div>}
                </div>
              </section>

              <section>
                <h4 className="text-xs font-bold mb-3" style={{ color: 'var(--color-text-2)' }}>统计与操作</h4>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <Metric label="任务" value={String(detail.generationCount ?? 0)} />
                  <Metric label="尝试" value={String(detail.attemptCount ?? 0)} />
                  <Metric label="模板" value={String(detail.templateCount ?? 0)} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <select className="input text-sm w-32" value={detail.role} disabled={savingUserId === detail.id} onChange={(event) => changeRole(detail.id, event.target.value)}>
                    <option value="user">用户</option>
                    <option value="admin">管理员</option>
                  </select>
                  <button className="btn btn-sm btn-danger" onClick={() => setDeleteTarget(detail)}>
                    <Trash2 size={14} className="mr-1" />
                    软删除用户
                  </button>
                </div>
              </section>
            </div>
          </div>
        </>
      )}

      <Modal open={deleteTarget !== null} title="确认软删除" onClose={() => setDeleteTarget(null)}>
        <p className="text-sm mb-2" style={{ color: 'var(--color-text-2)' }}>
          确定要软删除用户 <span className="font-semibold" style={{ color: 'var(--color-text)' }}>{deleteTarget?.username}</span> 吗？
        </p>
        <p className="text-xs mb-6" style={{ color: 'var(--color-error)' }}>
          该操作只改写用户名和邮箱标记，不会删除余额、任务和钱包记录。
        </p>
        <div className="flex justify-end gap-3">
          <button className="btn btn-outline btn-sm" onClick={() => setDeleteTarget(null)}>取消</button>
          <button className="btn btn-sm btn-danger" onClick={handleDelete}>
            <Trash2 size={14} className="mr-1" />
            软删除
          </button>
        </div>
      </Modal>
    </>
  );
}

function StatusBadge({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] mt-1 ${ok ? 'text-green-600' : 'text-amber-600'}`}>
      {ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
      {ok ? okText : badText}
    </span>
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}>
      <div className="text-[11px]" style={{ color: 'var(--color-text-2)' }}>{label}</div>
      <div className="text-base font-bold mt-1">{value}</div>
    </div>
  );
}
