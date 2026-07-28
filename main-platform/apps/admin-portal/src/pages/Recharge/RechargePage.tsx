/** 充值管理 — 卡密生成与管理 + 兑换记录 */
import { useState, useEffect, useCallback } from 'react';
import { CreditCard, Plus, Download, RotateCw, Gift, Save, Settings2, Search, Ban, CheckCircle, Copy, Users, Link, ChevronLeft, ChevronRight } from 'lucide-react';
import type { AdminInviteCodeListResponse, AdminInviteCodeView, AdminReferralOverviewResponse, AdminReferralRelationListResponse, AdminReferralRelationView } from '@aiimage/shared-contracts';
import { api } from '../../api/client';
import Toast from '../../components/Toast';

const BASE: string = import.meta.env.VITE_API_BASE ?? '';

interface OverviewData {
  totalIssued: string;
  totalRedeemed: string;
  totalUnused: string;
  redeemedUserCount: number;
  recentRedeems: Array<{ id: number; amount: string; qqNumber?: string; redeemSource?: 'web' | 'qq'; redeemerLabel?: string; redeemedAt: string | null; batchId: number; redeemedWalletId?: number | null }>;
  batchStats: Array<{ id: number; amount: string; count: number; usedCount: number; fileName: string; createdAt: string }>;
}

interface GenerateResult {
  batch: { id: number; amount: string; count: number; usedCount: number; fileName: string; createdByUsername: string; createdAt: string };
  codes: string[];
}

interface ReferralConfig {
  enabled: boolean;
  inviterReward: string;
  inviteeReward: string;
  maxSingleReward: string;
  inviteUrlTemplate: string;
}

interface RechargeGenerationConfig {
  supportedAmounts: number[];
  defaultBatchCount: number;
  maxBatchCount: number;
}

const REFERRAL_DEFAULTS: ReferralConfig = {
  enabled: true,
  inviterReward: '0.50',
  inviteeReward: '0.50',
  maxSingleReward: '100',
  inviteUrlTemplate: '/login?tab=register&invite={code}',
};

const RECHARGE_GENERATION_DEFAULTS: RechargeGenerationConfig = {
  supportedAmounts: [5, 10, 25, 50, 100, 150],
  defaultBatchCount: 100,
  maxBatchCount: 1000,
};

export function RechargePage() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [genAmount, setGenAmount] = useState<number>(5);
  const [genCount, setGenCount] = useState<number>(100);
  const [generationConfig, setGenerationConfig] = useState<RechargeGenerationConfig>(RECHARGE_GENERATION_DEFAULTS);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<GenerateResult | null>(null);
  const [referral, setReferral] = useState<ReferralConfig>(REFERRAL_DEFAULTS);
  const [savingReferral, setSavingReferral] = useState(false);
  const [referralOverview, setReferralOverview] = useState<AdminReferralOverviewResponse | null>(null);
  const [inviteCodes, setInviteCodes] = useState<AdminInviteCodeListResponse | null>(null);
  const [relations, setRelations] = useState<AdminReferralRelationListResponse | null>(null);
  const [referralOpsLoading, setReferralOpsLoading] = useState(false);
  const [referralTab, setReferralTab] = useState<'codes' | 'relations'>('codes');
  const [inviteSearchInput, setInviteSearchInput] = useState('');
  const [inviteSearch, setInviteSearch] = useState('');
  const [inviteStatus, setInviteStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [invitePage, setInvitePage] = useState(1);
  const [relationSearchInput, setRelationSearchInput] = useState('');
  const [relationSearch, setRelationSearch] = useState('');
  const [relationStatus, setRelationStatus] = useState<'all' | 'pending_email' | 'rewarded'>('all');
  const [relationPage, setRelationPage] = useState(1);
  const [togglingInviteUserId, setTogglingInviteUserId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    const [d, cfg] = await Promise.all([
      api<OverviewData>('/admin/recharge/overview'),
      api<Record<string, string>>('/admin/config'),
    ]);
    if (d.ok && d.data) setOverview(d.data);
    else setToast({ message: d.message ?? '获取概览失败', type: 'error' });
    if (cfg.ok && cfg.data) {
      setReferral(readReferralConfig(cfg.data));
      const nextGenerationConfig = readRechargeGenerationConfig(cfg.data);
      setGenerationConfig(nextGenerationConfig);
      setGenAmount((current) => nextGenerationConfig.supportedAmounts.includes(current) ? current : nextGenerationConfig.supportedAmounts[0]);
      setGenCount((current) => Math.min(nextGenerationConfig.maxBatchCount, Math.max(1, current || nextGenerationConfig.defaultBatchCount)));
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  /** 加载后台邀请运营数据；只读真实邀请表，禁用操作另行提交。 */
  const loadReferralOps = useCallback(async () => {
    setReferralOpsLoading(true);
    const inviteParams = new URLSearchParams({
      page: String(invitePage),
      pageSize: '12',
      status: inviteStatus,
      ...(inviteSearch ? { search: inviteSearch } : {}),
    });
    const relationParams = new URLSearchParams({
      page: String(relationPage),
      pageSize: '12',
      status: relationStatus,
      ...(relationSearch ? { search: relationSearch } : {}),
    });
    const [overviewRes, inviteRes, relationRes] = await Promise.all([
      api<AdminReferralOverviewResponse>('/admin/referrals/overview'),
      api<AdminInviteCodeListResponse>(`/admin/referrals/invite-codes?${inviteParams.toString()}`),
      api<AdminReferralRelationListResponse>(`/admin/referrals/relations?${relationParams.toString()}`),
    ]);
    if (overviewRes.ok && overviewRes.data) setReferralOverview(overviewRes.data);
    if (inviteRes.ok && inviteRes.data) setInviteCodes(inviteRes.data);
    if (relationRes.ok && relationRes.data) setRelations(relationRes.data);
    if (!overviewRes.ok || !inviteRes.ok || !relationRes.ok) {
      setToast({ message: overviewRes.message ?? inviteRes.message ?? relationRes.message ?? '获取邀请运营数据失败', type: 'error' });
    }
    setReferralOpsLoading(false);
  }, [invitePage, inviteSearch, inviteStatus, relationPage, relationSearch, relationStatus]);

  useEffect(() => { loadReferralOps(); }, [loadReferralOps]);

  const handleGenerate = async () => {
    if (!genAmount || genAmount <= 0) { setToast({ message: '请选择充值面额', type: 'error' }); return; }
    if (!genCount || genCount < 1) { setToast({ message: '数量需大于0', type: 'error' }); return; }
    setGenerating(true);
    const d = await api<GenerateResult>('/admin/recharge/cards/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: genAmount, count: genCount }),
    });
    setGenerating(false);
    if (d.ok) {
      setGenResult(d.data!);
      setToast({ message: `已生成 ${genCount} 张 ¥${genAmount} 卡密`, type: 'success' });
      loadOverview();
    } else setToast({ message: d.message ?? '生成失败', type: 'error' });
  };

  const handleDownload = async (batchId: number) => {
    try {
      const token = localStorage.getItem('admin_token') ?? '';
      const res = await fetch(`${BASE}/admin/recharge/batches/${batchId}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { setToast({ message: '下载失败', type: 'error' }); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `batch-${batchId}.txt`; a.click();
      URL.revokeObjectURL(url);
    } catch { setToast({ message: '下载失败', type: 'error' }); }
  };

  const saveReferralConfig = async () => {
    const inviter = normalizeMoney(referral.inviterReward);
    const invitee = normalizeMoney(referral.inviteeReward);
    const maxSingle = normalizeMoney(referral.maxSingleReward);
    if (!inviter || !invitee || !maxSingle) {
      setToast({ message: '邀请奖励金额必须是大于等于 0 的数字，上限必须大于 0', type: 'error' });
      return;
    }
    if (Number(inviter) > Number(maxSingle) || Number(invitee) > Number(maxSingle)) {
      setToast({ message: '单次奖励金额不能超过单次奖励上限', type: 'error' });
      return;
    }
    if (referral.inviteUrlTemplate && !referral.inviteUrlTemplate.includes('{code}')) {
      setToast({ message: '邀请链接模板必须包含 {code}', type: 'error' });
      return;
    }
    setSavingReferral(true);
    const res = await api('/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referral_enabled: String(referral.enabled),
        referral_inviter_reward_paid: inviter,
        referral_invitee_reward_paid: invitee,
        referral_max_single_reward_paid: maxSingle,
        referral_invite_url_template: referral.inviteUrlTemplate.trim() || REFERRAL_DEFAULTS.inviteUrlTemplate,
      }),
    });
    if (res.ok) {
      setToast({ message: '邀请奖励配置已保存', type: 'success' });
      await loadOverview();
    } else {
      setToast({ message: res.message ?? '保存邀请配置失败', type: 'error' });
    }
    setSavingReferral(false);
  };

  /** 禁用或恢复邀请码；后端只更新 disabledAt，不改历史邀请关系和余额。 */
  const toggleInviteCode = async (item: AdminInviteCodeView) => {
    setTogglingInviteUserId(item.userId);
    const res = await api<AdminInviteCodeView>(`/admin/referrals/invite-codes/${item.userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: !item.disabledAt }),
    });
    setTogglingInviteUserId(null);
    if (!res.ok) {
      setToast({ message: res.message ?? '更新邀请码状态失败', type: 'error' });
      return;
    }
    setToast({ message: item.disabledAt ? '邀请码已恢复' : '邀请码已禁用', type: 'success' });
    await loadReferralOps();
  };

  /** 复制邀请码或邀请链接，后台用于快速协助用户排查。 */
  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast({ message: `${label}已复制`, type: 'success' });
    } catch {
      setToast({ message: `${label}复制失败`, type: 'error' });
    }
  };

  const o = overview;
  const batches = o?.batchStats ?? [];

  return (
    <div className="space-y-5 max-w-[1400px] mx-auto">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="flex items-center justify-between">
        <div><h2 className="text-lg font-bold text-gray-800">充值管理</h2><p className="text-xs text-gray-400 mt-0.5">卡密生成与批次管理</p></div>
        <button onClick={loadOverview} className="btn btn-sm btn-outline"><RotateCw size={13} className={loading ? 'animate-spin mr-1' : 'mr-1'} />刷新</button>
      </div>

      {/* 统计卡片 */}
      {o && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { l: '已发行', v: `¥${o.totalIssued}`, c: 'text-indigo-600 bg-indigo-50' },
            { l: '已兑换', v: `¥${o.totalRedeemed}`, c: 'text-emerald-600 bg-emerald-50' },
            { l: '未兑换', v: `¥${o.totalUnused}`, c: 'text-amber-600 bg-amber-50' },
            { l: '兑换人次', v: o.redeemedUserCount, c: 'text-sky-600 bg-sky-50' },
            { l: '批次', v: batches.length, c: 'text-violet-600 bg-violet-50' },
            { l: '总卡数', v: batches.reduce((s,b)=>s+b.count,0), c: 'text-rose-600 bg-rose-50' },
          ].map(c => (
            <div key={c.l} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
              <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${c.c} mb-2 mx-auto`}><CreditCard className="w-5 h-5" /></div>
              <div className="text-lg font-bold text-gray-800 tabular-nums text-center">{c.v}</div>
              <div className="text-[11px] text-gray-400 text-center">{c.l}</div>
            </div>
          ))}
        </div>
      )}

      {/* 生成 */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 text-sm font-semibold text-gray-700 border-b flex items-center gap-2"><Plus size={15} className="text-indigo-500" />生成卡密</div>
        <div className="p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">面额</label>
              <select className="h-9 px-3 rounded-lg border border-gray-300 bg-white text-sm" value={genAmount} onChange={e => setGenAmount(Number(e.target.value))}>
                {generationConfig.supportedAmounts.map(a => <option key={a} value={a}>{a} 元</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">数量</label>
              <input type="number" className="h-9 px-3 rounded-lg border border-gray-300 bg-white text-sm w-28" min={1} max={generationConfig.maxBatchCount} value={genCount || ''} onChange={e => setGenCount(Number(e.target.value) || 0)} />
              <div className="mt-1 text-[10px] text-gray-400">上限 {generationConfig.maxBatchCount}</div>
            </div>
            <button onClick={handleGenerate} disabled={generating} className="btn btn-sm">{generating ? <RotateCw size={14} className="animate-spin mr-1" /> : <Plus size={14} className="mr-1" />}生成卡密</button>
          </div>
        </div>
      </div>

      {/* 邀请奖励配置 */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 text-sm font-semibold text-gray-700 border-b flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2"><Gift size={15} className="text-rose-500" />邀请奖励配置</span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full ${referral.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'}`}>
            {referral.enabled ? '已开启' : '已暂停'}
          </span>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
            <label className="flex items-center justify-between md:justify-start md:gap-3 rounded-lg border border-gray-200 px-3 py-2.5">
              <span className="text-xs font-semibold text-gray-600">邀请奖励</span>
              <input
                type="checkbox"
                checked={referral.enabled}
                onChange={event => setReferral(prev => ({ ...prev, enabled: event.target.checked }))}
                className="appearance-none relative w-10 h-5 bg-gray-200 rounded-full checked:bg-emerald-500 cursor-pointer transition-colors before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:w-4 before:h-4 before:bg-white before:rounded-full before:shadow before:transition-transform checked:before:translate-x-5"
              />
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <ReferralNumberField label="邀请人奖励" value={referral.inviterReward} onChange={value => setReferral(prev => ({ ...prev, inviterReward: value }))} />
              <ReferralNumberField label="被邀请人奖励" value={referral.inviteeReward} onChange={value => setReferral(prev => ({ ...prev, inviteeReward: value }))} />
              <ReferralNumberField label="单次奖励上限" value={referral.maxSingleReward} onChange={value => setReferral(prev => ({ ...prev, maxSingleReward: value }))} min={0.01} max={10000} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">邀请链接模板</label>
            <div className="flex flex-col lg:flex-row gap-3">
              <input
                type="text"
                value={referral.inviteUrlTemplate}
                onChange={event => setReferral(prev => ({ ...prev, inviteUrlTemplate: event.target.value }))}
                placeholder="/login?tab=register&invite={code}"
                className="h-9 px-3 rounded-lg border border-gray-300 bg-white text-sm flex-1 min-w-0"
              />
              <button type="button" onClick={saveReferralConfig} disabled={savingReferral} className="btn btn-sm">
                {savingReferral ? <RotateCw size={14} className="animate-spin mr-1" /> : <Save size={14} className="mr-1" />}
                保存邀请配置
              </button>
            </div>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-gray-500">
              <span className="inline-flex items-center gap-1"><Settings2 size={12} />模板必须包含 {'{code}'}</span>
              <span>相对路径会自动拼接前台域名</span>
              <span>奖励入 Web 付费余额并写流水</span>
            </div>
          </div>
        </div>
      </div>

      {/* 邀请运营 */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
            <Users size={15} className="text-indigo-500" />邀请码运营
            {referralOpsLoading && <RotateCw size={13} className="animate-spin text-gray-400" />}
          </div>
          <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 w-fit">
            <button onClick={() => setReferralTab('codes')} className={`px-3 py-1.5 text-xs rounded-md ${referralTab === 'codes' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500'}`}>邀请码</button>
            <button onClick={() => setReferralTab('relations')} className={`px-3 py-1.5 text-xs rounded-md ${referralTab === 'relations' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500'}`}>邀请关系</button>
          </div>
        </div>
        {referralOverview && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 p-4 border-b bg-gray-50/60">
            <MiniStat label="邀请码" value={referralOverview.inviteCodeTotal} />
            <MiniStat label="可用" value={referralOverview.enabledInviteCodeCount} tone="emerald" />
            <MiniStat label="禁用" value={referralOverview.disabledInviteCodeCount} tone="gray" />
            <MiniStat label="邀请关系" value={referralOverview.relationTotal} />
            <MiniStat label="已奖励" value={referralOverview.rewardedRelationCount} tone="emerald" />
            <MiniStat label="待验证" value={referralOverview.pendingRelationCount} tone="amber" />
            <MiniStat label="奖励总额" value={`¥${referralOverview.totalReward}`} tone="rose" />
          </div>
        )}
        {referralTab === 'codes' ? (
          <InviteCodePanel
            data={inviteCodes}
            searchInput={inviteSearchInput}
            status={inviteStatus}
            page={invitePage}
            togglingUserId={togglingInviteUserId}
            onSearchInput={setInviteSearchInput}
            onStatus={(value) => { setInviteStatus(value); setInvitePage(1); }}
            onSearch={() => { setInviteSearch(inviteSearchInput.trim()); setInvitePage(1); }}
            onPage={setInvitePage}
            onToggle={toggleInviteCode}
            onCopy={copyText}
          />
        ) : (
          <ReferralRelationPanel
            data={relations}
            searchInput={relationSearchInput}
            status={relationStatus}
            page={relationPage}
            onSearchInput={setRelationSearchInput}
            onStatus={(value) => { setRelationStatus(value); setRelationPage(1); }}
            onSearch={() => { setRelationSearch(relationSearchInput.trim()); setRelationPage(1); }}
            onPage={setRelationPage}
          />
        )}
      </div>

      {/* 生成结果 */}
      {genResult && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <h4 className="text-sm font-bold text-green-700 mb-2">生成成功 · {genResult.batch.fileName}</h4>
          <div className="bg-white rounded-lg border border-green-200 p-3 max-h-48 overflow-y-auto font-mono text-xs">
            {genResult.codes.map((c, i) => <div key={i}>{c}</div>)}
          </div>
          <button onClick={() => setGenResult(null)} className="text-xs text-green-600 mt-2 hover:underline">关闭</button>
        </div>
      )}

      {/* 批次列表 */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 text-sm font-semibold text-gray-700 border-b flex items-center gap-2"><Download size={15} className="text-emerald-500" />批次记录 ({batches.length})</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="border-b bg-gray-50 text-gray-500"><th className="text-left px-4 py-2.5">#</th><th className="text-left px-4 py-2.5">面额</th><th className="text-left px-4 py-2.5">总数</th><th className="text-left px-4 py-2.5">已用</th><th className="text-left px-4 py-2.5">未用</th><th className="text-left px-4 py-2.5">文件</th><th className="text-left px-4 py-2.5">创建时间</th><th className="text-left px-4 py-2.5">下载</th></tr></thead>
            <tbody>
              {batches.length === 0 ? <tr><td colSpan={8} className="text-center py-10 text-gray-400">暂无批次</td></tr> :
                batches.map(b => (
                  <tr key={b.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-400">{b.id}</td>
                    <td className="px-4 py-2.5 font-medium">¥{b.amount}</td>
                    <td className="px-4 py-2.5">{b.count}</td>
                    <td className="px-4 py-2.5 text-emerald-600">{b.usedCount}</td>
                    <td className="px-4 py-2.5 text-amber-600">{b.count - b.usedCount}</td>
                    <td className="px-4 py-2.5 text-gray-500">{b.fileName}</td>
                    <td className="px-4 py-2.5 text-gray-400">{b.createdAt?.slice(0,19)}</td>
                    <td className="px-4 py-2.5"><button onClick={() => handleDownload(b.id)} className="text-indigo-500 hover:text-indigo-700"><Download size={12} /></button></td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      </div>

      {/* 最近兑换 */}
      {o && o.recentRedeems.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 text-sm font-semibold text-gray-700 border-b">最近兑换记录</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b bg-gray-50 text-gray-500"><th className="text-left px-4 py-2.5">#</th><th className="text-left px-4 py-2.5">金额</th><th className="text-left px-4 py-2.5">入口</th><th className="text-left px-4 py-2.5">兑换身份</th><th className="text-left px-4 py-2.5">时间</th><th className="text-left px-4 py-2.5">批次</th></tr></thead>
              <tbody>{o.recentRedeems.map(r => (
                <tr key={r.id} className="border-b hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-gray-400">{r.id}</td>
                  <td className="px-4 py-2.5 text-emerald-600 font-medium">¥{r.amount}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold ${r.redeemSource === 'qq' ? 'bg-indigo-50 text-indigo-600' : 'bg-emerald-50 text-emerald-600'}`}>
                      {r.redeemSource === 'qq' ? 'QQ' : 'Web'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{r.redeemerLabel || r.qqNumber || '-'}</td>
                  <td className="px-4 py-2.5 text-gray-400">{r.redeemedAt?.slice(0,19) || '-'}</td>
                  <td className="px-4 py-2.5 text-gray-400 font-mono">#{r.batchId}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ReferralNumberField({ label, value, onChange, min = 0, max = 10000 }: { label: string; value: string; onChange: (value: string) => void; min?: number; max?: number }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-500 mb-1.5">{label}</span>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">¥</span>
        <input
          type="number"
          min={min}
          max={max}
          step="0.01"
          value={value}
          onChange={event => onChange(event.target.value)}
          className="h-9 w-full pl-7 pr-3 rounded-lg border border-gray-300 bg-white text-sm"
        />
      </div>
    </label>
  );
}

/** 后台邀请运营小统计块，保持充值页的密集信息风格。 */
function MiniStat({ label, value, tone = 'indigo' }: { label: string; value: string | number; tone?: 'indigo' | 'emerald' | 'amber' | 'rose' | 'gray' }) {
  const toneClass = {
    indigo: 'text-indigo-600 bg-indigo-50 border-indigo-100',
    emerald: 'text-emerald-600 bg-emerald-50 border-emerald-100',
    amber: 'text-amber-600 bg-amber-50 border-amber-100',
    rose: 'text-rose-600 bg-rose-50 border-rose-100',
    gray: 'text-gray-600 bg-gray-100 border-gray-200',
  }[tone];
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <div className="text-base font-bold tabular-nums truncate">{value}</div>
      <div className="text-[11px] opacity-75">{label}</div>
    </div>
  );
}

/** 后台邀请码列表面板，支持搜索、状态筛选、复制和禁用恢复。 */
function InviteCodePanel({
  data,
  searchInput,
  status,
  page,
  togglingUserId,
  onSearchInput,
  onStatus,
  onSearch,
  onPage,
  onToggle,
  onCopy,
}: {
  data: AdminInviteCodeListResponse | null;
  searchInput: string;
  status: 'all' | 'enabled' | 'disabled';
  page: number;
  togglingUserId: number | null;
  onSearchInput: (value: string) => void;
  onStatus: (value: 'all' | 'enabled' | 'disabled') => void;
  onSearch: () => void;
  onPage: (value: number) => void;
  onToggle: (item: AdminInviteCodeView) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const items = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 12)));
  return (
    <div className="p-4 space-y-3">
      <ReferralToolbar
        searchInput={searchInput}
        status={status}
        statusOptions={[['all', '全部'], ['enabled', '可用'], ['disabled', '禁用']]}
        placeholder="搜索用户名、邮箱或邀请码"
        onSearchInput={onSearchInput}
        onStatus={value => onStatus(value as 'all' | 'enabled' | 'disabled')}
        onSearch={onSearch}
      />
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-xs">
          <thead><tr className="bg-gray-50 text-gray-500 border-b"><th className="text-left px-3 py-2.5">用户</th><th className="text-left px-3 py-2.5">邀请码</th><th className="text-left px-3 py-2.5">状态</th><th className="text-left px-3 py-2.5">邀请</th><th className="text-left px-3 py-2.5">奖励</th><th className="text-left px-3 py-2.5">创建</th><th className="text-left px-3 py-2.5">操作</th></tr></thead>
          <tbody>
            {items.length === 0 ? <tr><td colSpan={7} className="text-center py-10 text-gray-400">暂无邀请码</td></tr> : items.map(item => (
              <tr key={item.userId} className="border-b last:border-b-0 hover:bg-gray-50">
                <td className="px-3 py-2.5 min-w-[180px]"><div className="font-medium text-gray-800">{item.username}</div><div className="text-gray-400">{item.email}</div></td>
                <td className="px-3 py-2.5 min-w-[150px]">
                  <div className="flex items-center gap-1.5"><span className="font-mono font-semibold text-indigo-600">{item.code}</span><button onClick={() => onCopy(item.code, '邀请码')} className="text-gray-400 hover:text-indigo-600"><Copy size={12} /></button></div>
                  <button onClick={() => onCopy(item.inviteUrl, '邀请链接')} className="mt-1 inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-indigo-600"><Link size={11} />复制链接</button>
                </td>
                <td className="px-3 py-2.5">{item.disabledAt ? <Badge tone="gray">已禁用</Badge> : <Badge tone="emerald">可使用</Badge>}</td>
                <td className="px-3 py-2.5 tabular-nums"><span className="font-semibold">{item.invitedCount}</span><span className="text-gray-400 ml-1">已奖 {item.rewardedCount} / 待验 {item.pendingCount}</span></td>
                <td className="px-3 py-2.5 text-rose-600 font-semibold">¥{item.inviterRewardTotal}</td>
                <td className="px-3 py-2.5 text-gray-400">{formatDateTime(item.createdAt)}</td>
                <td className="px-3 py-2.5">
                  <button onClick={() => onToggle(item)} disabled={togglingUserId === item.userId} className={`btn btn-sm ${item.disabledAt ? 'btn-outline' : 'btn-danger'}`}>
                    {togglingUserId === item.userId ? <RotateCw size={12} className="animate-spin" /> : item.disabledAt ? <CheckCircle size={12} /> : <Ban size={12} />}
                    {item.disabledAt ? '恢复' : '禁用'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} totalPages={totalPages} total={data?.total ?? 0} onPage={onPage} />
    </div>
  );
}

/** 后台邀请关系列表面板，用于审计奖励状态和来源。 */
function ReferralRelationPanel({
  data,
  searchInput,
  status,
  page,
  onSearchInput,
  onStatus,
  onSearch,
  onPage,
}: {
  data: AdminReferralRelationListResponse | null;
  searchInput: string;
  status: 'all' | 'pending_email' | 'rewarded';
  page: number;
  onSearchInput: (value: string) => void;
  onStatus: (value: 'all' | 'pending_email' | 'rewarded') => void;
  onSearch: () => void;
  onPage: (value: number) => void;
}) {
  const items = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 12)));
  return (
    <div className="p-4 space-y-3">
      <ReferralToolbar
        searchInput={searchInput}
        status={status}
        statusOptions={[['all', '全部'], ['pending_email', '待验证'], ['rewarded', '已奖励']]}
        placeholder="搜索邀请人、被邀请人或邀请码"
        onSearchInput={onSearchInput}
        onStatus={value => onStatus(value as 'all' | 'pending_email' | 'rewarded')}
        onSearch={onSearch}
      />
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-xs">
          <thead><tr className="bg-gray-50 text-gray-500 border-b"><th className="text-left px-3 py-2.5">邀请人</th><th className="text-left px-3 py-2.5">被邀请人</th><th className="text-left px-3 py-2.5">邀请码</th><th className="text-left px-3 py-2.5">状态</th><th className="text-left px-3 py-2.5">奖励</th><th className="text-left px-3 py-2.5">来源</th><th className="text-left px-3 py-2.5">时间</th></tr></thead>
          <tbody>
            {items.length === 0 ? <tr><td colSpan={7} className="text-center py-10 text-gray-400">暂无邀请关系</td></tr> : items.map(item => (
              <tr key={item.id} className="border-b last:border-b-0 hover:bg-gray-50">
                <td className="px-3 py-2.5 min-w-[170px]"><UserCell user={item.inviter} /></td>
                <td className="px-3 py-2.5 min-w-[170px]"><UserCell user={item.invitee} /></td>
                <td className="px-3 py-2.5 font-mono text-indigo-600">{item.inviteCode}</td>
                <td className="px-3 py-2.5">{item.status === 'rewarded' ? <Badge tone="emerald">已奖励</Badge> : <Badge tone="amber">待邮箱验证</Badge>}</td>
                <td className="px-3 py-2.5 min-w-[130px]"><div className="text-rose-600 font-semibold">邀请人 ¥{item.inviterRewardAmount}</div><div className="text-gray-400">被邀请人 ¥{item.inviteeRewardAmount}</div></td>
                <td className="px-3 py-2.5 text-gray-500">{sourceLabel(item.source)}</td>
                <td className="px-3 py-2.5 text-gray-400 min-w-[150px]"><div>{formatDateTime(item.createdAt)}</div>{item.rewardedAt && <div className="text-emerald-600">奖 {formatDateTime(item.rewardedAt)}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} totalPages={totalPages} total={data?.total ?? 0} onPage={onPage} />
    </div>
  );
}

/** 邀请运营筛选工具条，兼顾窄屏换行。 */
function ReferralToolbar({ searchInput, status, statusOptions, placeholder, onSearchInput, onStatus, onSearch }: { searchInput: string; status: string; statusOptions: Array<[string, string]>; placeholder: string; onSearchInput: (value: string) => void; onStatus: (value: string) => void; onSearch: () => void }) {
  return (
    <div className="flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
      <div className="flex flex-wrap gap-1">
        {statusOptions.map(([value, label]) => <button key={value} onClick={() => onStatus(value)} className={`px-3 py-1.5 text-xs rounded-lg border ${status === value ? 'border-indigo-200 bg-indigo-50 text-indigo-600' : 'border-gray-200 bg-white text-gray-500'}`}>{label}</button>)}
      </div>
      <div className="flex gap-2">
        <input
          value={searchInput}
          onChange={event => onSearchInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') onSearch(); }}
          placeholder={placeholder}
          className="h-9 w-full lg:w-72 px-3 rounded-lg border border-gray-300 bg-white text-sm"
        />
        <button onClick={onSearch} className="btn btn-sm btn-outline"><Search size={13} />搜索</button>
      </div>
    </div>
  );
}

/** 后台分页按钮，防止列表高度变化时操作位置飘移。 */
function Pager({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (page: number) => void }) {
  return (
    <div className="flex items-center justify-between text-xs text-gray-500">
      <span>共 {total} 条 · 第 {page}/{totalPages} 页</span>
      <div className="flex gap-2">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="btn btn-sm btn-outline"><ChevronLeft size={13} />上一页</button>
        <button disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="btn btn-sm btn-outline">下一页<ChevronRight size={13} /></button>
      </div>
    </div>
  );
}

/** 邀请关系里的用户摘要展示。 */
function UserCell({ user }: { user: { id: number; username: string; email: string; emailVerified: boolean } }) {
  return (
    <div>
      <div className="font-medium text-gray-800">#{user.id} {user.username}</div>
      <div className="text-gray-400">{user.email}</div>
      <div className={user.emailVerified ? 'text-[11px] text-emerald-600' : 'text-[11px] text-amber-600'}>{user.emailVerified ? '邮箱已验证' : '邮箱未验证'}</div>
    </div>
  );
}

/** 表格状态标签。 */
function Badge({ children, tone }: { children: string; tone: 'emerald' | 'amber' | 'gray' }) {
  const cls = tone === 'emerald' ? 'bg-emerald-50 text-emerald-600' : tone === 'amber' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-500';
  return <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold ${cls}`}>{children}</span>;
}

function readReferralConfig(cfg: Record<string, string>): ReferralConfig {
  return {
    enabled: cfg.referral_enabled !== 'false',
    inviterReward: cfg.referral_inviter_reward_paid ?? REFERRAL_DEFAULTS.inviterReward,
    inviteeReward: cfg.referral_invitee_reward_paid ?? REFERRAL_DEFAULTS.inviteeReward,
    maxSingleReward: cfg.referral_max_single_reward_paid ?? REFERRAL_DEFAULTS.maxSingleReward,
    inviteUrlTemplate: cfg.referral_invite_url_template ?? REFERRAL_DEFAULTS.inviteUrlTemplate,
  };
}

/** 从系统设置读取卡密生成配置，确保充值页表单和后端生成限制一致。 */
function readRechargeGenerationConfig(cfg: Record<string, string>): RechargeGenerationConfig {
  const supportedAmounts = (cfg.recharge_supported_amounts ?? '')
    .split(',')
    .map(item => Number(item.trim()))
    .filter(item => Number.isFinite(item) && item > 0);
  const maxBatchCount = clampInt(cfg.recharge_max_batch_count, RECHARGE_GENERATION_DEFAULTS.maxBatchCount, 1, 50000);
  const defaultBatchCount = clampInt(cfg.recharge_default_batch_count, RECHARGE_GENERATION_DEFAULTS.defaultBatchCount, 1, maxBatchCount);
  return {
    supportedAmounts: supportedAmounts.length > 0 ? [...new Set(supportedAmounts)] : RECHARGE_GENERATION_DEFAULTS.supportedAmounts,
    defaultBatchCount,
    maxBatchCount,
  };
}

/** 解析后台配置中的整数范围，避免无效配置导致页面输入框异常。 */
function clampInt(value: string | undefined, fallback: number, min: number, max: number) {
  const numeric = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeMoney(value: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return '';
  return (Math.round(numeric * 100) / 100).toFixed(2);
}

function formatDateTime(value: string | undefined) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function sourceLabel(source: string) {
  return source === 'register' ? '注册' : source === 'recharge' ? '充值页' : source === 'link' ? '邀请链接' : source;
}
