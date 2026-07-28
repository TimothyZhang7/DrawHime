/** Bot 管理页面 — 在线状态 / Bot账号 / QQ绑定 (Tailwind) */
import { useState, useEffect, useCallback } from 'react';
import { Bot, Shield, Ban, Trash2, Link, RotateCw, Wifi, WifiOff, Settings } from 'lucide-react';
import { api } from '../../api/client';
import Toast from '../../components/Toast';
import { Modal } from '../../components/Modal';
import { ConfigForm } from '../../components/ConfigForm';
import { useAdminRuntimeConfig } from '../../app/runtime-config';

const BOT_CONFIG_FIELDS = [
  { name: 'cmdPrefix', key: 'bot_cmd_prefix', type: 'text' as const, label: '命令前缀', defaultValue: '#', placeholder: '#' },
  {
    name: 'adminQqNumbers',
    key: 'bot_admin_qq_numbers',
    type: 'text' as const,
    label: 'QQ 管理员白名单',
    defaultValue: '',
    placeholder: '多个 QQ 用逗号或空格分隔',
    desc: '可执行 QQ 端额度调整命令；已绑定 Web 管理员账号的 QQ 自动拥有权限。',
  },
];

/* ─── 类型定义 ─── */

interface BotStatus {
  onlineCount: number;
  registeredBots: { selfId: string; qqNumber: string; status: string }[];
}

interface BotAccount {
  selfId: string;
  qqNumber: string;
  status: 'online' | 'offline';
  banned: boolean;
  lastSeenAt: string;
}

interface QQBinding {
  id: number;
  username: string;
  qqNumber: string;
}

/* ─── 常量 ─── */

const TABS = [
  { key: 'status', label: '在线状态' },
  { key: 'accounts', label: 'Bot账号' },
  { key: 'bindings', label: 'QQ绑定' },
  { key: 'config', label: 'Bot配置' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/* ═══════════════════════════════════════════════════════════════════════
   主页面
   ═══════════════════════════════════════════════════════════════════════ */

export function BotPage() {
  const { pollIntervalSec } = useAdminRuntimeConfig();
  const [tab, setTab] = useState<TabKey>('status');

  /* 数据 */
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [accounts, setAccounts] = useState<BotAccount[]>([]);
  const [bindings, setBindings] = useState<QQBinding[]>([]);

  /* UI */
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  };

  /* 数据加载 */
  const refresh = useCallback(async () => {
    const [statusRes, accountsRes, bindingsRes] = await Promise.all([
      api<BotStatus>('/admin/bot/status'),
      api<BotAccount[]>('/admin/bot/accounts'),
      api<QQBinding[]>('/admin/bot/qq-bindings'),
    ]);
    if (statusRes.ok) setStatus(statusRes.data ?? null);
    if (accountsRes.ok) setAccounts(accountsRes.data ?? []);
    if (bindingsRes.ok) setBindings(bindingsRes.data ?? []);
    setLoading(false);
  }, []);

  /* Bot 在线状态轮询使用后台系统设置的间隔，避免页面固定 30 秒刷新。 */
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollIntervalSec * 1000);
    return () => clearInterval(interval);
  }, [refresh, pollIntervalSec]);

  /* 操作 */
  const handleBan = async (selfId: string, currentlyBanned: boolean) => {
    const endpoint = currentlyBanned ? 'unban' : 'ban';
    const res = await api(`/wsproxy/bots/${selfId}/${endpoint}`, { method: 'POST' });
    showToast(res.ok ? (currentlyBanned ? '已解封' : '已封禁') : (res.message ?? '操作失败'), res.ok ? 'success' : 'error');
    if (res.ok) refresh();
  };

  const handleDelete = async (selfId: string) => {
    const res = await api(`/wsproxy/bots/${selfId}`, { method: 'DELETE' });
    showToast(res.ok ? '已删除' : (res.message ?? '删除失败'), res.ok ? 'success' : 'error');
    setDeleteTarget(null);
    if (res.ok) refresh();
  };

  /* 计算 */
  const onlineCount = status?.onlineCount ?? 0;
  const registeredCount = status?.registeredBots?.length ?? accounts.length;
  const bannedCount = accounts.filter((a) => a.banned).length;

  /* 加载态 */
  if (loading) {
    return (
      <div className="max-w-5xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Bot 管理</h2>
        </div>
        <div className="card p-10 text-center text-text-2">加载中...</div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Bot 管理</h2>
        <button onClick={refresh} className="btn btn-sm btn-outline">
          <RotateCw className="w-3.5 h-3.5 mr-1.5" />
          刷新
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* 标签栏 */}
      <div className="flex gap-0 mb-4 border-b border-border overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 标签内容 */}
      {tab === 'status' && (
        <StatusOverviewTab
          onlineCount={onlineCount}
          registeredCount={registeredCount}
          bindingsCount={bindings.length}
          bannedCount={bannedCount}
        />
      )}

      {tab === 'accounts' && (
        <AccountsTab
          accounts={accounts}
          onBan={handleBan}
          onDeleteRequest={(id) => setDeleteTarget(id)}
        />
      )}

      {tab === 'bindings' && (
        <BindingsTab bindings={bindings} />
      )}

      {tab === 'config' && (
        <div className="card"><ConfigForm fields={BOT_CONFIG_FIELDS} sectionKey="bot" /></div>
      )}

      {/* 删除确认弹窗 */}
      <Modal
        open={deleteTarget !== null}
        title="确认删除"
        onClose={() => setDeleteTarget(null)}
      >
        <p className="text-sm text-text-2 mb-4">
          此操作不可撤销，确定删除该 Bot 账号？
        </p>
        <div className="flex justify-end gap-3">
          <button
            className="btn btn-outline btn-sm"
            onClick={() => setDeleteTarget(null)}
          >
            取消
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => deleteTarget && handleDelete(deleteTarget)}
          >
            删除
          </button>
        </div>
      </Modal>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   子组件
   ═══════════════════════════════════════════════════════════════════════ */

/* ─── 总览统计卡片 ─── */

interface StatusOverviewProps {
  onlineCount: number;
  registeredCount: number;
  bindingsCount: number;
  bannedCount: number;
}

function StatusOverviewTab({ onlineCount, registeredCount, bindingsCount, bannedCount }: StatusOverviewProps) {
  const cards = [
    { label: '在线Bot', value: onlineCount, Icon: Wifi, color: 'text-green-500' },
    { label: '已注册', value: registeredCount, Icon: Bot, color: 'text-primary' },
    { label: 'QQ绑定', value: bindingsCount, Icon: Link, color: 'text-blue-500' },
    { label: '封禁中', value: bannedCount, Icon: Shield, color: 'text-error' },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="card p-4 text-center">
          <c.Icon className={`w-5 h-5 mx-auto mb-2 ${c.color}`} />
          <div className="text-2xl font-bold">{c.value}</div>
          <div className="text-xs text-text-2 mt-1">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ─── Bot 账号表格 ─── */

interface AccountsTabProps {
  accounts: BotAccount[];
  onBan: (selfId: string, currentlyBanned: boolean) => void;
  onDeleteRequest: (selfId: string) => void;
}

function AccountsTab({ accounts, onBan, onDeleteRequest }: AccountsTabProps) {
  if (accounts.length === 0) {
    return (
      <div className="card p-10 text-center text-text-2">暂无 Bot 账号</div>
    );
  }

  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-2 text-xs">
            <th className="p-2.5 font-semibold">QQ</th>
            <th className="p-2.5 font-semibold">状态</th>
            <th className="p-2.5 font-semibold">封禁</th>
            <th className="p-2.5 font-semibold hidden sm:table-cell">最近在线</th>
            <th className="p-2.5 font-semibold">操作</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((b) => (
            <tr
              key={b.selfId}
              className="border-b border-border last:border-0 hover:bg-bg/50 transition-colors"
            >
              <td className="p-2.5 font-mono text-xs">{b.qqNumber}</td>
              <td className="p-2.5">
                <span
                  className={`badge ${b.status === 'online' ? 'badge-success' : 'bg-gray-100 text-gray-500'}`}
                >
                  {b.status === 'online' ? (
                    <Wifi className="w-3 h-3" />
                  ) : (
                    <WifiOff className="w-3 h-3" />
                  )}
                  {b.status === 'online' ? '在线' : '离线'}
                </span>
              </td>
              <td className="p-2.5">
                <span
                  className={`badge ${b.banned ? 'badge-error' : 'badge-success'}`}
                >
                  {b.banned ? (
                    <Ban className="w-3 h-3" />
                  ) : (
                    <Shield className="w-3 h-3" />
                  )}
                  {b.banned ? '已封' : '正常'}
                </span>
              </td>
              <td className="p-2.5 text-xs text-text-2 hidden sm:table-cell">
                {b.lastSeenAt?.slice(0, 19) || '-'}
              </td>
              <td className="p-2.5">
                <div className="flex items-center gap-1.5">
                  {b.banned ? (
                    <button
                      onClick={() => onBan(b.selfId, true)}
                      className="btn btn-sm btn-outline"
                    >
                      解封
                    </button>
                  ) : (
                    <button
                      onClick={() => onBan(b.selfId, false)}
                      className="btn btn-sm btn-danger"
                    >
                      封禁
                    </button>
                  )}
                  <button
                    onClick={() => onDeleteRequest(b.selfId)}
                    className="btn btn-sm btn-ghost text-error hover:bg-error-soft"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── QQ 绑定表格 ─── */

interface BindingsTabProps {
  bindings: QQBinding[];
}

function BindingsTab({ bindings }: BindingsTabProps) {
  if (bindings.length === 0) {
    return (
      <div className="card p-10 text-center text-text-2">暂无 QQ 绑定</div>
    );
  }

  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-2 text-xs">
            <th className="p-2.5 font-semibold">ID</th>
            <th className="p-2.5 font-semibold">用户名</th>
            <th className="p-2.5 font-semibold">QQ</th>
          </tr>
        </thead>
        <tbody>
          {bindings.map((b) => (
            <tr
              key={b.id}
              className="border-b border-border last:border-0 hover:bg-bg/50 transition-colors"
            >
              <td className="p-2.5 text-text-2">{b.id}</td>
              <td className="p-2.5 font-medium">{b.username}</td>
              <td className="p-2.5 font-mono text-xs">{b.qqNumber}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
