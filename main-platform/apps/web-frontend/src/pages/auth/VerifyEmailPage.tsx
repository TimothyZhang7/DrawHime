/** 邮箱验证页 — URL token 参数解析 */
import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Mail, Check, X, Loader2, Send } from 'lucide-react';
import { config } from '../../lib/config';
import { Seo } from '../../components/Seo';
import { clearPendingInviteCode } from '../../lib/invite';

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'loading' | 'success' | 'error' | 'resending' | 'resent'>('loading');
  const [msg, setMsg] = useState('');
  const [resendEmail, setResendEmail] = useState('');

  useEffect(() => {
    if (!token) { setState('error'); setMsg('缺少验证 token，请检查链接是否完整'); return; }
    fetch(`${config.apiBase}/auth/verify-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(r => r.json()).then((d: { ok?: boolean; message?: string; data?: { referralRewarded?: boolean; inviteeRewardAmount?: string } }) => {
        if (d.ok) {
          clearPendingInviteCode();
          setState('success');
          setMsg(d.data?.referralRewarded ? `邮箱验证成功，邀请奖励 ¥${d.data.inviteeRewardAmount ?? '0.00'} 已到账。` : '邮箱验证成功！');
        }
        else { setState('error'); setMsg(d.message ?? '验证失败，链接可能已过期'); }
      }).catch(() => { setState('error'); setMsg('网络错误，请稍后重试'); });
  }, [token]);

  const handleResend = async () => {
    if (!resendEmail.trim()) return;
    setState('resending');
    try {
      const r = await fetch(`${config.apiBase}/auth/resend-verification-email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resendEmail.trim() }),
      });
      const d = await r.json() as { ok?: boolean; message?: string };
      if (d.ok) { setState('resent'); setMsg(d.message ?? '验证邮件已发送，请查收'); }
      else { setState('error'); setMsg(d.message ?? '发送失败'); }
    } catch {
      setState('error'); setMsg('网络错误，请稍后重试');
    }
  };

  return (
    <div className="animate-fade-in max-w-[400px] mx-auto mt-20 card text-center">
      <Seo title="邮箱验证" description="验证绘图姬 DrawHime 账号邮箱，完成账号安全设置。" path="/verify-email" index={false} />
      {state === 'loading' && <div className="flex flex-col items-center gap-3 py-8"><Loader2 size={28} className="animate-spin text-primary" /><span className="text-sm text-text-2">正在验证邮箱...</span></div>}
      {state === 'resending' && <div className="flex flex-col items-center gap-3 py-8"><Loader2 size={28} className="animate-spin text-primary" /><span className="text-sm text-text-2">正在发送验证邮件...</span></div>}
      {state === 'success' && <div className="flex flex-col items-center gap-3 py-8"><div className="flex items-center justify-center border" style={{ width: 48, height: 48, borderColor: 'var(--color-success)' }}><Check size={24} className="text-success" /></div><h2 className="text-lg font-bold">{msg}</h2><Link to="/" className="btn btn-lg mt-2">开始使用</Link></div>}
      {state === 'resent' && <div className="flex flex-col items-center gap-3 py-8"><div className="flex items-center justify-center border" style={{ width: 48, height: 48, borderColor: 'var(--color-success)' }}><Mail size={24} className="text-success" /></div><h2 className="text-lg font-bold">邮件已发送</h2><p className="text-sm text-text-2">{msg}</p><Link to="/login" className="btn btn-outline btn-sm mt-2">返回登录</Link></div>}
      {state === 'error' && <div className="flex flex-col items-center gap-3 py-8"><div className="flex items-center justify-center border" style={{ width: 48, height: 48, borderColor: 'var(--color-error)' }}><X size={24} className="text-error" /></div><h2 className="text-lg font-bold">验证失败</h2><p className="text-sm text-text-2 max-w-[280px]">{msg}</p>
        {/* 重发验证邮件 */}
        <div className="border-t border-border pt-4 mt-2 w-full">
          <p className="text-xs text-text-2 mb-2">输入注册邮箱重新发送验证邮件</p>
          <div className="flex gap-2">
            <input type="email" placeholder="注册邮箱" value={resendEmail} onChange={e => setResendEmail(e.target.value)} className="input flex-1" style={{ fontSize: 12 }} />
            <button onClick={handleResend} disabled={!resendEmail.trim()} className="btn btn-sm flex items-center gap-1 whitespace-nowrap"><Send size={12} />重发</button>
          </div>
        </div>
        <div className="flex gap-2 mt-1"><Link to="/login" className="btn btn-outline btn-sm">返回登录</Link></div></div>}
    </div>
  );
}
