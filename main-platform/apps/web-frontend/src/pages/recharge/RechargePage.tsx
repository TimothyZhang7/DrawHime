/** 充值中心页面：三选项卡管理常规充值、钱包流水和邀请链接。 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ApplyReferralResponse,
  ReferralMeResponse,
  RechargeRedeemResponse,
  WalletBalanceView,
  WalletBalanceKind,
  WalletLedgerEntryView,
  WalletLedgerListResponse,
  WalletLedgerSource,
  WalletLedgerType,
  WalletStatusResponse,
} from '@aiimage/shared-contracts';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock3, Coins, Copy, Gift, Key, Link as LinkIcon, Mail, RefreshCw, ShoppingBag, Ticket, Wallet } from 'lucide-react';
import { useAuth } from '../../providers/AuthProvider';
import { useToast } from '../../providers/ToastProvider';
import { api } from '../../lib/api';
import { extractInviteCode, savePendingInviteCode } from '../../lib/invite';
import './RechargePage.css';
import './RechargePage.referral.css';
import './RechargePage.ledger.css';
import './RechargePage.mobile.css';

type Shop = { shopUrl: string; amounts?: number[] };
type QqStatus = { bound: boolean; botCmdPrefix?: string; balance?: { freeBalance: string; paidBalance: string } };
type RechargeTab = 'wallet' | 'records' | 'referral';
type LedgerFilters = {
  type: WalletLedgerType | 'all';
  balanceKind: WalletBalanceKind | 'all';
  source: WalletLedgerSource | 'all';
  dateFrom: string;
  dateTo: string;
};

const LEDGER_PAGE_SIZE = 30;
const DEFAULT_LEDGER_FILTERS: LedgerFilters = { type: 'all', balanceKind: 'all', source: 'all', dateFrom: '', dateTo: '' };

export function RechargePage() {
  const { user, refresh } = useAuth();
  const { show } = useToast();
  const [activeTab, setActiveTab] = useState<RechargeTab>('wallet');
  const [wallet, setWallet] = useState<WalletStatusResponse | null>(null);
  const [qqStatus, setQqStatus] = useState<QqStatus | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [bindKey, setBindKey] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [referral, setReferral] = useState<ReferralMeResponse | null>(null);
  const [inviteInput, setInviteInput] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [ledger, setLedger] = useState<WalletLedgerListResponse | null>(null);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerFilters, setLedgerFilters] = useState<LedgerFilters>(DEFAULT_LEDGER_FILTERS);

  useEffect(() => {
    const currentInvite = extractInviteCode(new URLSearchParams(window.location.search).get('invite'));
    if (currentInvite) {
      savePendingInviteCode(currentInvite);
      setInviteInput(currentInvite);
      setActiveTab('referral');
    }
    void reloadStatus();
    api<Shop>('/api/recharge/shop').then(d => { if (d.ok) setShop(d.data!); });
  }, []);

  // 重发验证邮件前端冷却 60 秒，后端限流仍是最终兜底。
  useEffect(() => {
    if (emailCooldown <= 0) return;
    const timer = window.setInterval(() => setEmailCooldown(v => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [emailCooldown]);

  useEffect(() => {
    if (activeTab !== 'records') return;
    void loadLedger(ledgerPage);
  }, [activeTab, ledgerPage, ledgerFilters]);

  const botPrefix = qqStatus?.botCmdPrefix || '#';
  const bindCommand = bindKey ? `${botPrefix}绑定 ${bindKey}` : '';
  const qqNumber = wallet?.linkedQqNumber ?? user?.qqNumber;

  const walletRows = useMemo(() => {
    if (!wallet) return [];
    return [
      { label: '网页钱包', desc: `UID ${wallet.primaryWallet.ownerKey}`, item: wallet.primaryWallet },
      ...(wallet.linkedWallet ? [{ label: 'QQ 钱包', desc: `QQ ${wallet.linkedWallet.ownerKey}`, item: wallet.linkedWallet }] : []),
    ];
  }, [wallet]);

  async function reloadStatus() {
    const [walletResult, qqResult, referralResult] = await Promise.all([
      api<WalletStatusResponse>('/api/wallet/status'),
      api<QqStatus>('/qq/status'),
      api<ReferralMeResponse>('/api/referrals/me'),
    ]);
    if (walletResult.ok && walletResult.data) setWallet(walletResult.data);
    if (qqResult.ok && qqResult.data) setQqStatus(qqResult.data);
    if (referralResult.ok && referralResult.data) setReferral(referralResult.data);
    await refresh();
  }

  /** 读取当前用户可访问钱包流水；只用于展示，不参与余额计算或扣费。 */
  async function loadLedger(page = 1) {
    setLedgerLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(LEDGER_PAGE_SIZE) });
    if (ledgerFilters.type !== 'all') qs.set('type', ledgerFilters.type);
    if (ledgerFilters.balanceKind !== 'all') qs.set('balanceKind', ledgerFilters.balanceKind);
    if (ledgerFilters.source !== 'all') qs.set('source', ledgerFilters.source);
    if (ledgerFilters.dateFrom) qs.set('dateFrom', ledgerFilters.dateFrom);
    if (ledgerFilters.dateTo) qs.set('dateTo', ledgerFilters.dateTo);
    const d = await api<WalletLedgerListResponse>(`/api/wallet/ledger?${qs.toString()}`);
    if (d.ok && d.data) {
      setLedger(d.data);
    } else {
      show(d.message ?? '余额记录加载失败', 'error');
    }
    setLedgerLoading(false);
  }

  /** 更新流水筛选时回到第一页，避免当前页超出筛选后的总页数。 */
  function updateLedgerFilter<K extends keyof LedgerFilters>(key: K, value: LedgerFilters[K]) {
    setLedgerPage(1);
    setLedgerFilters(prev => ({ ...prev, [key]: value }));
  }

  /** 重发验证邮件；邮箱已解绑时没有真实投递地址，必须先绑定新邮箱。 */
  async function resendVerifyEmail() {
    if (user?.emailBound === false || !user?.email) return show('请先绑定邮箱', 'warn');
    if (emailSending || emailCooldown > 0) return;
    setEmailSending(true);
    const d = await api('/auth/resend-verification', { method: 'POST' });
    if (d.ok) {
      show('验证邮件已发送，请查收邮箱', 'success');
      setEmailCooldown(60);
    } else {
      show(d.message ?? '验证邮件发送失败', 'error');
    }
    setEmailSending(false);
  }

  async function generateBindKey() {
    const d = await api<{ verificationKey: string }>('/qq/generate-key', { method: 'POST' });
    if (d.ok && d.data) {
      setBindKey(d.data.verificationKey);
      show('绑定验证码已生成', 'success');
    } else {
      show(d.message ?? '生成绑定验证码失败', 'error');
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      show('已复制', 'success');
    } catch {
      show('复制失败，请手动复制', 'error');
    }
  }

  /** 网页兑换卡密：只进入 Web 用户钱包；绑定 QQ 后由钱包共享规则提供可访问余额。 */
  async function redeem() {
    if (!code.trim()) return;
    setLoading(true);
    const d = await api<RechargeRedeemResponse>('/api/recharge/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim() }),
    });
    if (d.ok && d.data) {
      show(`兑换成功！¥${d.data.amount} 已到账`, 'success');
      setCode('');
      setLedgerPage(1);
      await reloadStatus();
      if (activeTab === 'records') await loadLedger(1);
    } else {
      show(d.message ?? '兑换失败', 'error');
    }
    setLoading(false);
  }

  /** 使用邀请码；奖励由后端钱包事务写入付费余额流水。 */
  async function applyInviteCode() {
    const code = extractInviteCode(inviteInput);
    if (!code) return show('请输入正确的邀请码', 'warn');
    setInviteLoading(true);
    const d = await api<ApplyReferralResponse>('/api/referrals/apply', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    if (d.ok && d.data) {
      show(d.data.rewarded ? `邀请码使用成功，奖励 ¥${d.data.inviteeRewardAmount} 已到账` : '邀请码已绑定，邮箱验证后奖励到账', 'success');
      setInviteInput('');
      setLedgerPage(1);
      await reloadStatus();
    } else {
      show(d.message ?? '邀请码使用失败', 'error');
    }
    setInviteLoading(false);
  }

  if (!user) return null;

  return (
    <div className="recharge-page animate-fade-in">
      <header className="recharge-header">
        <div>
          <h1><Wallet size={21} />充值</h1>
          <p>管理钱包充值、完整余额流水和邀请奖励。</p>
        </div>
        <button type="button" onClick={() => { void reloadStatus(); if (activeTab === 'records') void loadLedger(ledgerPage); }} className="btn btn-outline btn-sm">
          <RefreshCw size={14} />刷新
        </button>
      </header>

      <nav className="recharge-tabs" aria-label="充值页面选项卡">
        <TabButton active={activeTab === 'wallet'} onClick={() => setActiveTab('wallet')} icon={<Wallet size={15} />} label="充值" desc="余额与卡密" />
        <TabButton active={activeTab === 'records'} onClick={() => setActiveTab('records')} icon={<Clock3 size={15} />} label="记录" desc="收支明细" />
        <TabButton active={activeTab === 'referral'} onClick={() => setActiveTab('referral')} icon={<Gift size={15} />} label="邀请链接" desc="奖励与分享" />
      </nav>

      {activeTab === 'wallet' && (
        <WalletRechargeTab
          user={user}
          wallet={wallet}
          walletRows={walletRows}
          qqNumber={qqNumber}
          bindKey={bindKey}
          bindCommand={bindCommand}
          shop={shop}
          code={code}
          loading={loading}
          emailSending={emailSending}
          emailCooldown={emailCooldown}
          onCode={setCode}
          onRedeem={redeem}
          onResendEmail={resendVerifyEmail}
          onGenerateBindKey={generateBindKey}
          onCopy={copyText}
        />
      )}

      {activeTab === 'records' && (
        <LedgerTab
          ledger={ledger}
          loading={ledgerLoading}
          page={ledgerPage}
          filters={ledgerFilters}
          onPage={setLedgerPage}
          onFilter={updateLedgerFilter}
          onResetFilters={() => { setLedgerPage(1); setLedgerFilters(DEFAULT_LEDGER_FILTERS); }}
          onReload={() => loadLedger(ledgerPage)}
        />
      )}

      {activeTab === 'referral' && (
        <ReferralPanel
          referral={referral}
          inviteInput={inviteInput}
          inviteLoading={inviteLoading}
          emailVerified={user.emailVerified}
          onInput={setInviteInput}
          onApply={applyInviteCode}
          onCopy={copyText}
        />
      )}
    </div>
  );
}

/** 充值页主选项卡：桌面展示入口说明，移动端由 CSS 压缩为紧凑三列。 */
function TabButton({ active, onClick, icon, label, desc }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; desc: string }) {
  return (
    <button type="button" className={`recharge-tab ${active ? 'is-active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>
      <span className="recharge-tab-icon" aria-hidden="true">{icon}</span>
      <span className="recharge-tab-copy">
        <span>{label}</span>
        <small>{desc}</small>
      </span>
    </button>
  );
}

/** 充值内容页：只展示账号状态、钱包余额、卡密兑换和购买入口，不参与余额计算。 */
function WalletRechargeTab({
  user,
  wallet,
  walletRows,
  qqNumber,
  bindKey,
  bindCommand,
  shop,
  code,
  loading,
  emailSending,
  emailCooldown,
  onCode,
  onRedeem,
  onResendEmail,
  onGenerateBindKey,
  onCopy,
}: {
  user: { emailVerified: boolean; emailBound?: boolean; email: string; qqNumber?: string };
  wallet: WalletStatusResponse | null;
  walletRows: Array<{ label: string; desc: string; item: WalletBalanceView }>;
  qqNumber?: string;
  bindKey: string;
  bindCommand: string;
  shop: Shop | null;
  code: string;
  loading: boolean;
  emailSending: boolean;
  emailCooldown: number;
  onCode: (value: string) => void;
  onRedeem: () => void;
  onResendEmail: () => void;
  onGenerateBindKey: () => void;
  onCopy: (text: string) => void;
}) {
  const shopAmounts = shop?.amounts ?? [];

  return (
    <>
      <section className="recharge-status-grid" aria-label="账号状态">
        <EmailStatusCard verified={user.emailVerified} bound={user.emailBound !== false && Boolean(user.email)} email={user.email} sending={emailSending} cooldown={emailCooldown} onResend={onResendEmail} />
        <QqBindingCard qqNumber={qqNumber} bindKey={bindKey} bindCommand={bindCommand} onGenerate={onGenerateBindKey} onCopy={onCopy} />
      </section>

      <section className="recharge-balance-panel">
        <div className="recharge-section-title">
          <span><Coins size={16} />钱包余额</span>
          <strong>合计 ¥{wallet?.totalBalance ?? '0.00'}</strong>
        </div>
        <div className="recharge-balance-summary">
          <BalanceMetric label="免费余额" value={wallet?.freeBalance ?? '0.00'} tone="free" />
          <BalanceMetric label="付费余额" value={wallet?.paidBalance ?? '0.00'} tone="paid" />
          <BalanceMetric label="可用总额" value={wallet?.totalBalance ?? '0.00'} tone="total" />
        </div>
        <div className="recharge-wallet-table">
          <div className="recharge-wallet-head">
            <span>钱包</span><span>免费</span><span>付费</span><span>小计</span>
          </div>
          {walletRows.map(row => <WalletRow key={row.item.walletId} label={row.label} desc={row.desc} item={row.item} />)}
          {!wallet?.linkedWallet && (
            <div className="recharge-wallet-empty">
              <AlertTriangle size={14} />未绑定 QQ，当前仅使用网页钱包。绑定后可同时访问 QQ 钱包。
            </div>
          )}
        </div>
      </section>

      <div className="recharge-work-grid">
        <section className="recharge-panel recharge-action-panel is-redeem">
          <div className="recharge-section-title"><span><Ticket size={16} />卡密兑换</span><strong>即时到账</strong></div>
          <div className="recharge-redeem-row">
            <input placeholder="输入卡密，如 YUKI-50R-XXXX" value={code} onChange={e => onCode(e.target.value)} className="input" onKeyDown={e => e.key === 'Enter' && onRedeem()} />
            <button type="button" onClick={onRedeem} disabled={loading || !code.trim()} className="btn">{loading ? '兑换中...' : '兑换'}</button>
          </div>
          <p className="recharge-muted">兑换成功后进入网页付费余额；生成扣费优先消耗免费余额，再消耗付费余额。</p>
        </section>

        <section className="recharge-panel recharge-action-panel is-shop">
          <div className="recharge-section-title"><span><ShoppingBag size={16} />购买卡密</span><strong>{shopAmounts.length ? `${shopAmounts.length} 个面额` : '待配置'}</strong></div>
          <div className="recharge-shop-row">
            <div>
              <strong>{shop?.shopUrl ? '外部商店已配置' : '暂未配置商店'}</strong>
              <span>{shopAmounts.length ? '选择合适面额购买，完成后回到此页兑换卡密。' : '购买完成后回到此页兑换卡密'}</span>
              {shopAmounts.length > 0 && (
                <div className="recharge-shop-amounts" aria-label="可选充值面额">
                  {shopAmounts.map(amount => <span key={amount}>¥{amount}</span>)}
                </div>
              )}
            </div>
            <a href={shop?.shopUrl || '#'} target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm" onClick={e => { if (!shop?.shopUrl) e.preventDefault(); }}>
              <ShoppingBag size={14} />前往购买
            </a>
          </div>
        </section>
      </div>
    </>
  );
}

function EmailStatusCard({ verified, bound, email, sending, cooldown, onResend }: { verified: boolean; bound: boolean; email: string; sending: boolean; cooldown: number; onResend: () => void }) {
  return (
    <section className={`recharge-status-card ${verified ? 'is-ok' : 'is-warning'}`}>
      <div className="recharge-status-icon">{verified ? <Check size={18} /> : <Mail size={18} />}</div>
      <div className="recharge-status-body">
        <strong>{verified ? '邮箱已验证' : bound ? '邮箱未验证' : '邮箱未绑定'}</strong>
        <span>{bound ? email : '请到个人中心绑定正确邮箱'}</span>
      </div>
      {!verified && bound && (
        <button type="button" onClick={onResend} disabled={sending || cooldown > 0} className="btn btn-outline btn-sm">
          <Mail size={13} />{sending ? '发送中' : cooldown > 0 ? `${cooldown}s` : '重发验证'}
        </button>
      )}
      {!verified && !bound && <Link to="/profile" className="btn btn-outline btn-sm"><Mail size={13} />绑定邮箱</Link>}
    </section>
  );
}

function QqBindingCard({ qqNumber, bindKey, bindCommand, onGenerate, onCopy }: { qqNumber?: string; bindKey: string; bindCommand: string; onGenerate: () => void; onCopy: (text: string) => void }) {
  if (qqNumber) {
    return (
      <section className="recharge-status-card is-ok">
        <img src={`https://q.qlogo.cn/headimg_dl?dst_uin=${qqNumber}&spec=100`} alt="" loading="lazy" className="recharge-qq-avatar" />
        <div className="recharge-status-body">
          <strong>QQ 已绑定</strong>
          <span>QQ {qqNumber}</span>
        </div>
        <Link to="/profile" className="btn btn-outline btn-sm">管理绑定</Link>
      </section>
    );
  }

  return (
    <section className="recharge-status-card is-warning">
      <div className="recharge-status-icon"><Key size={18} /></div>
      <div className="recharge-status-body">
        <strong>QQ 未绑定</strong>
        <span>绑定后可与 Bot 共用余额，并展示 QQ 钱包分布。</span>
        {bindKey && (
          <div className="recharge-bind-code">
            <button type="button" onClick={() => onCopy(bindKey)}><Copy size={12} />{bindKey}</button>
            <button type="button" onClick={() => onCopy(bindCommand)}><Copy size={12} />{bindCommand}</button>
          </div>
        )}
      </div>
      <button type="button" onClick={onGenerate} className="btn btn-outline btn-sm">{bindKey ? '重新生成' : '生成验证码'}</button>
    </section>
  );
}

function BalanceMetric({ label, value, tone }: { label: string; value: string; tone: 'free' | 'paid' | 'total' }) {
  return (
    <div className={`recharge-metric is-${tone}`}>
      <span>{label}</span>
      <strong>¥{value}</strong>
    </div>
  );
}

function WalletRow({ label, desc, item }: { label: string; desc: string; item: WalletBalanceView }) {
  const subtotal = (Number(item.freeBalance) + Number(item.paidBalance)).toFixed(2);
  return (
    <div className="recharge-wallet-row">
      <div><strong>{label}</strong><span>{desc}</span></div>
      <span>¥{item.freeBalance}</span>
      <span>¥{item.paidBalance}</span>
      <strong>¥{subtotal}</strong>
    </div>
  );
}

function LedgerTab({
  ledger,
  loading,
  page,
  filters,
  onPage,
  onFilter,
  onResetFilters,
  onReload,
}: {
  ledger: WalletLedgerListResponse | null;
  loading: boolean;
  page: number;
  filters: LedgerFilters;
  onPage: (page: number) => void;
  onFilter: <K extends keyof LedgerFilters>(key: K, value: LedgerFilters[K]) => void;
  onResetFilters: () => void;
  onReload: () => void;
}) {
  const items = ledger?.items ?? [];
  return (
    <section className="recharge-panel recharge-ledger-panel">
      <div className="recharge-section-title">
        <span><Clock3 size={16} />余额记录</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={onReload} disabled={loading}><RefreshCw size={13} />刷新记录</button>
      </div>
      <div className="recharge-ledger-summary">
        <span>包含免费余额和付费余额的发放、充值、扣费、退款、后台调整和邀请奖励。</span>
        <strong>{ledger ? `${ledger.total} 条` : loading ? '加载中' : '暂无记录'}</strong>
      </div>
      <div className="recharge-ledger-filters" aria-label="余额记录筛选">
        <label>
          <span>开始日期</span>
          <input type="date" className="input" value={filters.dateFrom} onChange={event => onFilter('dateFrom', event.target.value)} />
        </label>
        <label>
          <span>结束日期</span>
          <input type="date" className="input" value={filters.dateTo} onChange={event => onFilter('dateTo', event.target.value)} />
        </label>
        <label>
          <span>类型</span>
          <select className="input" value={filters.type} onChange={event => onFilter('type', event.target.value as LedgerFilters['type'])}>
            <option value="all">全部类型</option>
            <option value="daily_free">免费重置/发放</option>
            <option value="recharge">卡密充值</option>
            <option value="charge">生成扣费</option>
            <option value="refund">失败退款</option>
            <option value="admin_adjust">后台调整</option>
            <option value="referral_reward">邀请奖励</option>
          </select>
        </label>
        <label>
          <span>余额</span>
          <select className="input" value={filters.balanceKind} onChange={event => onFilter('balanceKind', event.target.value as LedgerFilters['balanceKind'])}>
            <option value="all">免费 + 付费</option>
            <option value="free">免费余额</option>
            <option value="paid">付费余额</option>
          </select>
        </label>
        <label>
          <span>渠道</span>
          <select className="input" value={filters.source} onChange={event => onFilter('source', event.target.value as LedgerFilters['source'])}>
            <option value="all">全部渠道</option>
            <option value="web">网页</option>
            <option value="bot">Bot</option>
            <option value="admin">后台</option>
            <option value="system">系统</option>
          </select>
        </label>
        <button type="button" className="btn btn-outline btn-sm" onClick={onResetFilters}>清空筛选</button>
      </div>
      <div className="recharge-ledger-table">
        <div className="recharge-ledger-head">
          <span>时间</span><span>类型</span><span>钱包</span><span>余额</span><span>来源</span><span>金额</span><span>记录后余额</span><span>关联</span>
        </div>
        {loading && items.length === 0 ? (
          <div className="recharge-ledger-empty">正在加载余额记录...</div>
        ) : items.length === 0 ? (
          <div className="recharge-ledger-empty">暂无余额记录</div>
        ) : items.map(item => <LedgerRow key={item.id} item={item} />)}
      </div>
      {ledger && ledger.totalPages > 1 && (
        <div className="recharge-ledger-pager">
          <button type="button" className="btn btn-outline btn-sm" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}><ChevronLeft size={14} />上一页</button>
          <span>第 {ledger.page} / {ledger.totalPages} 页</span>
          <button type="button" className="btn btn-outline btn-sm" disabled={page >= ledger.totalPages || loading} onClick={() => onPage(page + 1)}>下一页<ChevronRight size={14} /></button>
        </div>
      )}
    </section>
  );
}

function LedgerRow({ item }: { item: WalletLedgerEntryView }) {
  const amount = Number(item.amount);
  const balanceKindLabel = item.balanceKind === 'free' ? '免费' : '付费';
  const balanceAfter = `免 ¥${item.freeBalanceAfter} / 付 ¥${item.paidBalanceAfter}`;
  return (
    <div className="recharge-ledger-row">
      <time data-label="时间">{formatDateTime(item.createdAt)}</time>
      <span data-label="类型">{formatLedgerType(item.type)}</span>
      <span data-label="钱包">{item.walletLabel}</span>
      <span data-label="余额" className={`recharge-ledger-kind is-${item.balanceKind}`}>{balanceKindLabel}</span>
      <span data-label="来源">{formatLedgerSource(item.source)}</span>
      <strong data-label="金额" className={amount >= 0 ? 'is-income' : 'is-expense'}>{amount >= 0 ? '+' : ''}¥{item.amount}</strong>
      <span data-label="记录后" className="recharge-ledger-after">{balanceAfter}</span>
      <small data-label="关联">{item.taskId ? `任务 ${item.taskId.slice(0, 8)}` : item.rechargeCardId ? `卡密 #${item.rechargeCardId}` : '-'}</small>
    </div>
  );
}

function ReferralPanel({
  referral,
  inviteInput,
  inviteLoading,
  emailVerified,
  onInput,
  onApply,
  onCopy,
}: {
  referral: ReferralMeResponse | null;
  inviteInput: string;
  inviteLoading: boolean;
  emailVerified: boolean;
  onInput: (value: string) => void;
  onApply: () => void;
  onCopy: (text: string) => void;
}) {
  const myReferral = referral?.myReferral;
  const canApply = referral?.referralEnabled !== false && (!myReferral || myReferral.status === 'none');
  const rewardLabel = referral
    ? `邀请人 ¥${referral.inviterRewardAmount} / 被邀请人 ¥${referral.inviteeRewardAmount}`
    : '加载中';
  return (
    <section className="recharge-panel recharge-referral-panel">
      <div className="recharge-section-title">
        <span><Gift size={16} />邀请链接</span>
        <strong>{rewardLabel}</strong>
      </div>
      <div className="recharge-referral-grid">
        <div className="recharge-referral-card">
          <span>我的邀请码</span>
          <strong>{referral?.inviteCode ?? '加载中'}</strong>
          <button type="button" className="btn btn-outline btn-sm" disabled={!referral?.inviteCode} onClick={() => referral?.inviteCode && onCopy(referral.inviteCode)}>
            <Copy size={13} />复制邀请码
          </button>
        </div>
        <div className="recharge-referral-card">
          <span>邀请链接</span>
          <code>{referral?.inviteUrl ?? '加载中'}</code>
          <button type="button" className="btn btn-outline btn-sm" disabled={!referral?.inviteUrl} onClick={() => referral?.inviteUrl && onCopy(referral.inviteUrl)}>
            <LinkIcon size={13} />复制链接
          </button>
        </div>
        <div className="recharge-referral-card">
          <span>邀请统计</span>
          <strong>{referral?.stats.rewardedCount ?? 0} / {referral?.stats.totalInvited ?? 0}</strong>
          <small>已奖励 / 总邀请，累计 ¥{referral?.stats.totalReward ?? '0.00'}</small>
        </div>
      </div>

      <div className="recharge-invite-apply">
        <div>
          <strong>{referral?.referralEnabled === false ? '邀请奖励已暂停' : canApply ? '使用邀请码' : '已使用邀请码'}</strong>
          <span>
            {referral?.referralEnabled === false
              ? '当前暂不可绑定新的邀请码，已绑定关系不受影响。'
              : canApply
              ? emailVerified ? '当前邮箱已验证，使用成功后奖励会立即到账。' : '当前邮箱未验证，使用后将在邮箱验证成功时到账。'
              : myReferral?.status === 'rewarded' ? `已通过 ${myReferral.inviterUsername ?? '邀请人'} 的邀请领取奖励。` : `已绑定 ${myReferral?.inviterUsername ?? '邀请人'}，邮箱验证后奖励到账。`}
          </span>
        </div>
        {canApply && (
          <div className="recharge-invite-row">
            <input className="input" placeholder="输入邀请码" value={inviteInput} onChange={event => onInput(event.target.value.toUpperCase())} onKeyDown={event => event.key === 'Enter' && onApply()} />
            <button type="button" className="btn" disabled={inviteLoading || !inviteInput.trim()} onClick={onApply}>{inviteLoading ? '提交中...' : '使用'}</button>
          </div>
        )}
      </div>
      <p className="recharge-muted">邀请奖励进入网页付费余额，可在“记录”选项卡查看对应流水。</p>
    </section>
  );
}

function formatLedgerType(type: WalletLedgerEntryView['type']) {
  const map: Record<WalletLedgerEntryView['type'], string> = {
    daily_free: '每日免费',
    recharge: '卡密充值',
    charge: '生成扣费',
    refund: '失败退款',
    admin_adjust: '后台调整',
    referral_reward: '邀请奖励',
  };
  return map[type] ?? type;
}

function formatLedgerSource(source: WalletLedgerEntryView['source']) {
  const map: Record<WalletLedgerEntryView['source'], string> = { web: '网页', bot: 'Bot', admin: '后台', system: '系统' };
  return map[source] ?? source;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
