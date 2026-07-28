/** 个人中心页面：展示账号状态、QQ 绑定、钱包余额和账户设置。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  Hash,
  Image,
  Key,
  Lock,
  Mail,
  Paintbrush,
  Plus,
  Settings,
  Ticket,
  Unlink,
  User,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AuthUser } from '@aiimage/shared-contracts';
import { useAuth } from '../../providers/AuthProvider';
import { useToast } from '../../providers/ToastProvider';
import { useAppearance } from '../../providers/AppearanceProvider';
import { api } from '../../lib/api';
import { buildQqAvatarUrl, getAvatarInitial, resolveDisplayAvatar } from '../../lib/avatar';
import { config } from '../../lib/config';
import './ProfilePage.css';

type TabKey = 'overview' | 'account' | 'settings';
/** 单个身份钱包的余额摘要，字段与 backend 钱包状态接口保持一致。 */
type WalletBalanceView = { walletId: number; ownerType: 'user' | 'qq'; ownerKey: string; freeBalance: string; paidBalance: string };
/** 当前网页用户可访问的钱包余额聚合，用于替代旧 QQ 余额链路。 */
type WalletStatusResponse = {
  primaryWallet: WalletBalanceView;
  linkedWallet?: WalletBalanceView;
  linkedQqNumber?: string;
  freeBalance: string;
  paidBalance: string;
  totalBalance: string;
};

const tabs: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: 'overview', label: '概览', icon: Activity },
  { key: 'account', label: '账户', icon: Wallet },
  { key: 'settings', label: '设置', icon: Settings },
];

function StatusPill({ tone, children }: { tone: 'admin' | 'success' | 'warning' | 'primary'; children: ReactNode }) {
  return <span className={`profile-pill profile-pill-${tone}`}>{children}</span>;
}

function Panel({ icon: Icon, title, children }: { icon?: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="profile-panel">
      <h2 className="profile-panel-title">
        {Icon && <Icon size={15} />}
        {title}
      </h2>
      {children}
    </section>
  );
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: string; icon: LucideIcon; tone: string }) {
  return (
    <div className={`profile-stat profile-stat-${tone}`}>
      <div className="profile-stat-icon">
        <Icon size={20} />
      </div>
      <div className="profile-stat-body">
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function SideMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="profile-side-meta">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const { show } = useToast();
  const {
    siteAppearance,
    userBackgroundEnabled,
    saving: appearanceSaving,
    updateUserBackgroundEnabled,
  } = useAppearance();
  const [tab, setTab] = useState<TabKey>('overview');
  const [bindKey, setBindKey] = useState('');
  const [wallet, setWallet] = useState<WalletStatusResponse | null>(null);
  const [botPrefix, setBotPrefix] = useState('');
  const [redeemCode, setRedeemCode] = useState('');
  const [genCount, setGenCount] = useState(0);
  const [resending, setResending] = useState(false);
  const [emailActionLoading, setEmailActionLoading] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [usernameDraft, setUsernameDraft] = useState('');
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const [pw, setPw] = useState({ old: '', newPw: '', confirm: '' });
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // QQ 状态只负责绑定命令前缀；余额统一从新钱包接口读取。
    api<{ bound: boolean; botCmdPrefix?: string }>('/qq/status').then(d => {
      if (!d.ok || !d.data) return;
      if (d.data.botCmdPrefix) setBotPrefix(d.data.botCmdPrefix);
    });
    void refreshWallet();
    api<{ total: number }>('/api/generations?pageSize=1').then(d => {
      if (d.ok && d.data) setGenCount(d.data.total);
    });
  }, []);

  useEffect(() => {
    if (user?.username) setUsernameDraft(user.username);
  }, [user?.username]);

  const refreshWallet = async () => {
    const d = await api<WalletStatusResponse>('/api/wallet/status');
    if (d.ok && d.data) setWallet(d.data);
  };

  if (!user) return null;

  const isAdmin = user.role === 'admin';
  const roleLabel = isAdmin ? '管理员' : '用户';
  const emailBound = user.emailBound !== false && Boolean(user.email);
  const emailLabel = emailBound ? user.email : '未绑定邮箱';
  const emailStatusLabel = user.emailVerified ? '邮箱已验证' : emailBound ? '邮箱未验证' : '邮箱未绑定';
  const avatarInitial = getAvatarInitial(user.username);
  const avatarDisplay = resolveDisplayAvatar(user);
  const qqAvatarUrl = buildQqAvatarUrl(user.qqNumber);
  const avatarSourceLabel = avatarDisplay.source === 'web' ? '网页' : avatarDisplay.source === 'qq' ? 'QQ' : '默认';
  const bindCommand = `${botPrefix || '/'}绑定 ${bindKey}`;
  const walletRows = useMemo(() => {
    if (!wallet) return [];
    return [
      { label: '网页钱包', desc: `UID ${wallet.primaryWallet.ownerKey}`, item: wallet.primaryWallet },
      ...(wallet.linkedWallet ? [{ label: 'QQ 钱包', desc: `QQ ${wallet.linkedWallet.ownerKey}`, item: wallet.linkedWallet }] : []),
    ];
  }, [wallet]);

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      show(message, 'success');
    } catch {
      show('复制失败，请手动复制', 'error');
    }
  };

  /** 切换当前用户的全站背景图显示偏好，并保持跨设备持久化。 */
  const toggleSiteBackground = async () => {
    if (userBackgroundEnabled === null || appearanceSaving) return;
    const nextEnabled = !userBackgroundEnabled;
    const result = await updateUserBackgroundEnabled(nextEnabled);
    show(result.ok ? (nextEnabled ? '已开启全站背景图' : '已关闭全站背景图') : result.message ?? '背景图设置失败', result.ok ? 'success' : 'error');
  };

  /** 提交密码修改；账号安全操作必须走 backend 真实认证接口。 */
  const changePassword = async () => {
    if (!pw.old || !pw.newPw || pw.newPw.length < 8) return show('新密码至少 8 位', 'warn');
    if (pw.newPw !== pw.confirm) return show('两次密码不一致', 'warn');
    const d = await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: pw.old, newPassword: pw.newPw }),
    });
    if (d.ok) {
      show('密码已修改', 'success');
      setPw({ old: '', newPw: '', confirm: '' });
    } else {
      show(d.message ?? '修改失败', 'error');
    }
  };

  /** 保存用户名；用户名是公开昵称，保存后必须刷新全局登录态和页面展示。 */
  const saveUsername = async () => {
    const username = usernameDraft.trim();
    if (username === user.username) return show('用户名没有变化', 'info');
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/.test(username)) {
      return show('用户名需 2-32 位，仅支持中英文、数字和下划线', 'warn');
    }
    setUsernameSaving(true);
    try {
      const d = await api<AuthUser>('/api/users/profile', {
        method: 'PUT',
        body: JSON.stringify({ username }),
      });
      if (d.ok) {
        show('用户名已更新', 'success');
        await refresh();
      } else {
        show(d.message ?? '用户名保存失败', 'error');
      }
    } finally {
      setUsernameSaving(false);
    }
  };

  const unbindQQ = async () => {
    if (!confirm('确定要解绑 QQ 吗？解绑后需重新绑定。')) return;
    const d = await api('/qq/unbind', { method: 'DELETE' });
    if (d.ok) {
      show('QQ 已解绑', 'success');
      await refresh();
      await refreshWallet();
    } else {
      show(d.message ?? '解绑失败', 'error');
    }
  };

  /** 未验证邮箱重发验证邮件；未绑定邮箱时先要求用户补绑真实邮箱。 */
  const resendVerify = async () => {
    if (!emailBound) return show('请先绑定邮箱', 'warn');
    setResending(true);
    try {
      const r = await api<{ ok?: boolean; message?: string }>('/auth/resend-verification', { method: 'POST' });
      if (r.ok) {
        show('验证邮件已发送，请查收邮箱', 'success');
        await refresh();
      } else {
        show(r.message ?? '发送失败', 'error');
      }
    } catch {
      show('网络错误', 'error');
    } finally {
      setResending(false);
    }
  };

  /** 绑定或更正未验证邮箱；用户输错邮箱时通过该入口换成真实可收信邮箱。 */
  const bindEmail = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return show('邮箱格式不正确', 'warn');
    setEmailActionLoading(true);
    try {
      const d = await api('/auth/bind-email', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      if (d.ok) {
        show('邮箱已绑定，验证邮件已发送', 'success');
        setNewEmail('');
        await refresh();
      } else {
        show(d.message ?? '绑定邮箱失败', 'error');
      }
    } finally {
      setEmailActionLoading(false);
    }
  };

  /** 解绑未验证邮箱；已验证邮箱不能直接解绑，避免破坏账号找回边界。 */
  const unbindEmail = async () => {
    if (user.emailVerified) return show('已验证邮箱不能直接解绑', 'warn');
    if (!emailBound) return show('当前未绑定邮箱', 'warn');
    if (!confirm('确定解绑当前未验证邮箱吗？旧验证链接会失效，之后需要绑定新邮箱。')) return;
    setEmailActionLoading(true);
    try {
      const d = await api('/auth/email', { method: 'DELETE' });
      if (d.ok) {
        show('未验证邮箱已解绑', 'success');
        await refresh();
      } else {
        show(d.message ?? '解绑邮箱失败', 'error');
      }
    } finally {
      setEmailActionLoading(false);
    }
  };

  const redeem = async () => {
    if (!redeemCode.trim()) return;
    const d = await api<{ amount: number; newBalance: string }>('/api/recharge/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: redeemCode.trim() }),
    });
    if (d.ok && d.data) {
      show(`兑换成功 ${d.data.amount} 元`, 'success');
      setRedeemCode('');
      await refreshWallet();
    } else {
      show(d.message ?? '兑换失败', 'error');
    }
  };

  const generateBindKey = async () => {
    const d = await api<{ verificationKey: string }>('/qq/generate-key', { method: 'POST' });
    if (d.ok && d.data) setBindKey(d.data.verificationKey);
    else show(d.message ?? '失败', 'error');
  };

  const uploadAvatar = async (file: File | null | undefined) => {
    if (!file || avatarUploading) return;
    if (!config.allowedImageTypes.includes(file.type)) return show('头像仅支持 PNG、JPEG、WebP', 'warn');
    if (file.size > 5 * 1024 * 1024) return show('头像图片不能超过 5MB', 'warn');
    setAvatarUploading(true);
    try {
      const token = localStorage.getItem('token') ?? '';
      const res = await fetch(`${config.apiBase}/api/users/me/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type },
        body: file,
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; message?: string };
      if (data.ok) {
        show('头像已更新', 'success');
        await refresh();
      } else {
        show(data.message ?? '头像上传失败', 'error');
      }
    } catch {
      show('头像上传失败', 'error');
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  const deleteAvatar = async () => {
    if (avatarUploading) return;
    const d = await api('/api/users/me/avatar', { method: 'DELETE' });
    if (d.ok) {
      show('已清除网页头像', 'success');
      await refresh();
    } else {
      show(d.message ?? '清除头像失败', 'error');
    }
  };

  const useQqAvatar = async () => {
    if (!user.qqNumber) return show('请先绑定 QQ', 'warn');
    if (!user.avatarUrl) return show('当前已按 QQ 头像展示', 'success');
    await deleteAvatar();
  };

  // 头像弹窗使用 Portal 挂到 body，避免被个人主页容器的宽度、滚动或层级上下文限制。
  const avatarDialog = avatarDialogOpen ? createPortal(
    <div className="profile-avatar-modal-backdrop" role="presentation" onMouseDown={() => setAvatarDialogOpen(false)}>
      <div className="profile-avatar-modal" role="dialog" aria-modal="true" aria-label="头像设置" onMouseDown={event => event.stopPropagation()}>
        <div className="profile-avatar-modal-head">
          <div>
            <strong>头像设置</strong>
            <span>网页头像 &gt; QQ 头像 &gt; 首字符</span>
          </div>
          <button type="button" onClick={() => setAvatarDialogOpen(false)} aria-label="关闭头像设置"><X size={16} /></button>
        </div>

        <div className="profile-avatar-preview-grid">
          <div className="profile-avatar-preview-card is-active">
            <span>当前外显</span>
            <div className="profile-avatar-preview">
              {avatarDisplay.url ? <img src={avatarDisplay.url} alt="" loading="lazy" /> : <strong>{avatarInitial}</strong>}
            </div>
            <small>{avatarSourceLabel}</small>
          </div>
          <div className={`profile-avatar-preview-card${qqAvatarUrl ? '' : ' is-disabled'}`}>
            <span>QQ 头像</span>
            <div className="profile-avatar-preview">
              {qqAvatarUrl ? <img src={qqAvatarUrl} alt="" loading="lazy" /> : <strong>QQ</strong>}
            </div>
            <small>{qqAvatarUrl ? `QQ ${user.qqNumber}` : '未绑定 QQ'}</small>
          </div>
        </div>

        <div className="profile-avatar-modal-actions">
          <button type="button" className="btn" disabled={avatarUploading} onClick={() => avatarInputRef.current?.click()}>
            <Image size={14} />{avatarUploading ? '上传中' : '上传头像'}
          </button>
          <button type="button" className="btn btn-outline" disabled={avatarUploading || !user.avatarUrl} onClick={deleteAvatar}>
            清除头像
          </button>
          <button type="button" className="btn btn-outline" disabled={avatarUploading || !user.qqNumber} onClick={useQqAvatar}>
            使用 QQ 头像
          </button>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="profile-page">
      <header className={`profile-hero${isAdmin ? ' profile-hero-admin' : ''}`}>
        <div className="profile-hero-inner">
          <div className="profile-avatar-wrap">
            <button type="button" className="profile-avatar" onClick={() => setAvatarDialogOpen(true)} aria-label="头像设置">
              {avatarDisplay.url ? <img src={avatarDisplay.url} alt="" loading="lazy" /> : <span>{avatarInitial}</span>}
              <small>{avatarSourceLabel}</small>
            </button>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="profile-avatar-input"
              onChange={event => uploadAvatar(event.target.files?.[0])}
            />
          </div>

          <div className="profile-identity">
            <div className="profile-name-row">
              <h1>{user.username}</h1>
              {isAdmin && <StatusPill tone="admin">管理员</StatusPill>}
              {user.emailVerified ? <StatusPill tone="success">邮箱已验证</StatusPill> : <StatusPill tone="warning">{emailBound ? '邮箱待验证' : '邮箱未绑定'}</StatusPill>}
              {user.qqNumber && <StatusPill tone="primary">QQ 已绑定</StatusPill>}
            </div>

            <div className="profile-meta-row">
              <span><Hash size={14} />UID {user.id}</span>
              <span><User size={14} />{roleLabel}</span>
              <span><Mail size={14} />{emailLabel}</span>
              {user.qqNumber && <span><Key size={14} />QQ {user.qqNumber}</span>}
            </div>
          </div>
        </div>
      </header>

      {avatarDialog}

      <div className="profile-tabs" role="tablist" aria-label="个人中心栏目">
        {tabs.map(item => {
          const Icon = item.icon;
          const active = tab === item.key;
          return (
            <button key={item.key} type="button" role="tab" className={active ? 'is-active' : ''} aria-selected={active} onClick={() => setTab(item.key)}>
              <Icon size={16} />
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="profile-layout">
        <main className="profile-content">
          {tab === 'overview' && (
            <div className="profile-stack">
              <div className="profile-stat-grid">
                <StatCard label="累计生成" value={`${genCount} 次`} icon={Paintbrush} tone="primary" />
                <StatCard label="免费余额" value={`¥${wallet?.freeBalance ?? '0.00'}`} icon={Wallet} tone="success" />
                <StatCard label="付费余额" value={`¥${wallet?.paidBalance ?? '0.00'}`} icon={Wallet} tone="warning" />
                <StatCard label="邮箱状态" value={user.emailVerified ? '已验证' : emailBound ? '未验证' : '未绑定'} icon={user.emailVerified ? Check : AlertTriangle} tone={user.emailVerified ? 'success' : 'danger'} />
              </div>

              <Panel title="快捷操作" icon={Activity}>
                <div className="profile-action-row">
                  <Link to="/" className="btn btn-sm"><Plus size={14} />开始创作</Link>
                  <Link to="/my-images" className="btn btn-outline btn-sm"><Image size={14} />我的图片</Link>
                  <Link to="/recharge" className="btn btn-outline btn-sm"><Wallet size={14} />充值兑换</Link>
                </div>
              </Panel>

              <Panel title="QQ 绑定" icon={Key}>
                {user.qqNumber ? (
                  <div className="profile-bind-state">
                    <div className="profile-state-line is-success"><Check size={15} />已绑定 QQ：{user.qqNumber}</div>
                    <button type="button" onClick={unbindQQ} className="btn btn-outline btn-sm profile-danger-button">
                      <Unlink size={13} />解绑 QQ
                    </button>
                  </div>
                ) : (
                  <div className="profile-stack profile-stack-tight">
                    <button type="button" onClick={generateBindKey} className="btn btn-sm profile-inline-button">生成绑定验证码</button>
                    {bindKey && (
                      <div className="profile-code-box">
                        <span>验证码</span>
                        <button type="button" onClick={() => copyText(bindKey, '已复制验证码')}>{bindKey}</button>
                        <span>QQ 绑定命令</span>
                        <button type="button" onClick={() => copyText(bindCommand, '命令已复制')}>{bindCommand}</button>
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            </div>
          )}

          {tab === 'account' && (
            <div className="profile-stack">
              <Panel title="余额明细" icon={Wallet}>
                <div className="profile-balance-grid">
                  <div className="profile-balance-card is-free">
                    <span>免费余额</span>
                    <strong>¥{wallet?.freeBalance ?? '0.00'}</strong>
                    <small>网页与已绑定 QQ 钱包合计</small>
                  </div>
                  <div className="profile-balance-card is-paid">
                    <span>付费余额</span>
                    <strong>¥{wallet?.paidBalance ?? '0.00'}</strong>
                    <small>永久有效 · 可充值</small>
                  </div>
                </div>
                <div className="profile-wallet-source-list">
                  {walletRows.map(row => <WalletSourceRow key={row.item.walletId} label={row.label} desc={row.desc} item={row.item} />)}
                </div>
              </Panel>

              <Panel title="卡密兑换" icon={Ticket}>
                <div className="profile-form-row">
                  <input
                    placeholder="输入卡密，如 YUKI-10R-XXXXXXXX"
                    value={redeemCode}
                    onChange={e => setRedeemCode(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && redeem()}
                    className="input"
                  />
                  <button type="button" onClick={redeem} className="btn">兑换</button>
                </div>
                <p className="profile-muted">卡密兑换进入网页付费余额；绑定 QQ 后 Bot 可按共享规则使用。</p>
              </Panel>
            </div>
          )}

          {tab === 'settings' && (
            <div className="profile-stack">
              <Panel title="全站背景" icon={Image}>
                <div className="profile-appearance-form">
                  <div className="profile-appearance-copy">
                    <strong>显示后台设置的背景图片</strong>
                    <span>
                      {!siteAppearance.backgroundImageUrl
                        ? '管理员尚未上传背景图。'
                        : siteAppearance.backgroundEnabled
                          ? '该设置会应用到绘图、图库、个人中心和其他前台页面。'
                          : '管理员当前已关闭全站背景图，你的个人选择会被保留。'}
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={userBackgroundEnabled === true}
                    className={`privacy-switch${userBackgroundEnabled === true ? ' is-on' : ''}`}
                    disabled={userBackgroundEnabled === null || appearanceSaving || !siteAppearance.backgroundImageUrl}
                    onClick={() => void toggleSiteBackground()}
                  >
                    <span className="privacy-switch-track"><span className="privacy-switch-thumb"><Image size={11} /></span></span>
                    <span className="privacy-switch-label">{appearanceSaving ? '保存中' : userBackgroundEnabled === true ? '已开启' : '已关闭'}</span>
                  </button>
                </div>
              </Panel>

              <Panel title="用户名" icon={User}>
                <div className="profile-username-form">
                  <div className="profile-username-copy">
                    <strong>公开展示昵称</strong>
                    <span>会显示在导航栏、个人主页、图库作者和排行榜中。</span>
                  </div>
                  <div className="profile-username-controls">
                    <input
                      placeholder="2-32 位中英文、数字或下划线"
                      value={usernameDraft}
                      maxLength={32}
                      onChange={event => setUsernameDraft(event.target.value)}
                      onKeyDown={event => event.key === 'Enter' && saveUsername()}
                      className="input"
                    />
                    <button type="button" onClick={saveUsername} disabled={usernameSaving || usernameDraft.trim() === user.username} className="btn btn-sm profile-inline-button">
                      <Check size={13} />{usernameSaving ? '保存中...' : '保存用户名'}
                    </button>
                  </div>
                </div>
              </Panel>

              <Panel title="修改密码" icon={Lock}>
                <div className="profile-password-form">
                  <input type="password" placeholder="当前密码" value={pw.old} onChange={e => setPw(p => ({ ...p, old: e.target.value }))} className="input" />
                  <input type="password" placeholder="新密码（至少 8 位）" value={pw.newPw} onChange={e => setPw(p => ({ ...p, newPw: e.target.value }))} className="input" />
                  <input type="password" placeholder="确认新密码" value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))} className="input" />
                  <button type="button" onClick={changePassword} className="btn btn-sm profile-inline-button">修改密码</button>
                </div>
              </Panel>

              <Panel title="邮箱" icon={Mail}>
                <div className="profile-mail-row">
                  <div>
                    <strong>{emailLabel}</strong>
                    <span className={user.emailVerified ? 'is-success' : 'is-warning'}>
                      {user.emailVerified ? <Check size={13} /> : <AlertTriangle size={13} />}
                      {emailStatusLabel}
                    </span>
                  </div>
                  {!user.emailVerified && emailBound && (
                    <div className="profile-mail-actions">
                      <button type="button" onClick={resendVerify} disabled={resending || emailActionLoading} className="btn btn-outline btn-sm">
                        <Mail size={13} />{resending ? '发送中...' : '重发验证邮件'}
                      </button>
                      <button type="button" onClick={unbindEmail} disabled={emailActionLoading} className="btn btn-outline btn-sm profile-danger-button">
                        <Unlink size={13} />解绑邮箱
                      </button>
                    </div>
                  )}
                </div>
                {!user.emailVerified && (
                  <div className="profile-email-bind-form">
                    <input
                      type="email"
                      placeholder={emailBound ? '输入新的正确邮箱' : '输入邮箱'}
                      value={newEmail}
                      onChange={event => setNewEmail(event.target.value)}
                      onKeyDown={event => event.key === 'Enter' && bindEmail()}
                      className="input"
                    />
                    <button type="button" onClick={bindEmail} disabled={emailActionLoading || !newEmail.trim()} className="btn btn-sm profile-inline-button">
                      <Mail size={13} />{emailActionLoading ? '处理中...' : emailBound ? '更换并发送验证' : '绑定并发送验证'}
                    </button>
                  </div>
                )}
              </Panel>
            </div>
          )}
        </main>

        <aside className="profile-aside">
          <Panel title="资料概览" icon={BarChart3}>
            <div className="profile-side-meta-list">
              <SideMeta label="身份" value={roleLabel} />
              <SideMeta label="用户名" value={user.username} />
              <SideMeta label="邮箱" value={emailLabel} />
              <SideMeta label="累计生成" value={`${genCount} 次`} />
              {wallet ? (
                <>
                  <SideMeta label="免费余额" value={`¥${wallet.freeBalance}`} />
                  <SideMeta label="付费余额" value={`¥${wallet.paidBalance}`} />
                  <SideMeta label="总余额" value={`¥${wallet.totalBalance}`} />
                </>
              ) : (
                <SideMeta label="余额" value="加载中" />
              )}
              <SideMeta label="QQ" value={user.qqNumber ? `已绑定 ${user.qqNumber}` : '未绑定'} />
            </div>
          </Panel>

        </aside>
      </div>
    </div>
  );
}

function WalletSourceRow({ label, desc, item }: { label: string; desc: string; item: WalletBalanceView }) {
  const subtotal = (Number(item.freeBalance) + Number(item.paidBalance)).toFixed(2);
  return (
    <div className="profile-wallet-source-row">
      <div>
        <strong>{label}</strong>
        <span>{desc}</span>
      </div>
      <span>免费 ¥{item.freeBalance}</span>
      <span>付费 ¥{item.paidBalance}</span>
      <strong>¥{subtotal}</strong>
    </div>
  );
}
