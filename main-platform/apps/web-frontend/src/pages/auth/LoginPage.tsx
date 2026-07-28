/** 登录/注册 */
import { useState, useEffect } from 'react';
import type { AuthUser } from '@aiimage/shared-contracts';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../providers/AuthProvider';
import { useToast } from '../../providers/ToastProvider';
import { Paintbrush, LogIn, UserPlus } from 'lucide-react';
import { config } from '../../lib/config';
import { Seo } from '../../components/Seo';
import { clearPendingInviteCode, extractInviteCode, readPendingInviteCode, savePendingInviteCode } from '../../lib/invite';

export function AuthPage() {
  const { user, login } = useAuth(); const { show } = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();

  // 已登录账号直接进入当前首页绘图工作台。
  useEffect(() => { if (user) nav('/', { replace: true }); }, [user, nav]);
  const [tab, setTab] = useState<'login' | 'register'>(params.get('tab') === 'register' ? 'register' : 'login');
  const [f, setF] = useState({ username: '', email: '', password: '', account: '', inviteCode: readPendingInviteCode() });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const code = extractInviteCode(params.get('invite') || params.get('ref') || params.get('code'));
    if (!code) return;
    const saved = savePendingInviteCode(code);
    setF(prev => ({ ...prev, inviteCode: saved }));
    setTab('register');
    show('已识别邀请链接，注册并验证邮箱后可领取奖励', 'success');
  }, [params, show]);

  /** 提交登录或注册；响应用户类型复用共享契约，避免遗漏邮箱绑定状态。 */
  const submit = async () => {
    setLoading(true);
    try {
      const isReg = tab === 'register';
      const inviteCode = extractInviteCode(f.inviteCode);
      const body = isReg
        ? { username: f.username, email: f.email, password: f.password, ...(inviteCode ? { inviteCode } : {}) }
        : { account: f.account || f.username, password: f.password };
      const r = await fetch(`${config.apiBase}/auth/${isReg ? 'register' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json() as { ok?: boolean; token?: string; user?: AuthUser; message?: string };
      if (d.ok) { if (isReg) clearPendingInviteCode(); login(d.token!, d.user!); show(isReg ? '注册成功！验证邮件已发送至您的邮箱，请查收' : '登录成功', 'success'); nav('/', { replace: true }); }
      else show(d.message ?? '操作失败', 'error');
    } catch { show('网络错误', 'error'); }
    setLoading(false);
  };

  return (
    <div className="animate-fade-in max-w-[400px] mx-auto mt-20 card">
      <Seo title="登录注册" description="登录或注册绘图姬 DrawHime，使用 AI 绘图、图生图、个人图库和 Bot 绘图能力。" path="/login" index={false} />
      <h1 className="page-title text-center mb-6 flex items-center justify-center gap-2 justify-center"><Paintbrush size={20} />绘图姬</h1>
      <div className="flex mb-5 border border-border">
        <button onClick={() => setTab('login')} className="flex-1 tab flex items-center justify-center gap-1" style={tab === 'login' ? { color: 'var(--color-text)', borderBottomColor: 'var(--color-text)' } : {}}><LogIn size={14} />登录</button>
        <button onClick={() => setTab('register')} className="flex-1 tab flex items-center justify-center gap-1" style={tab === 'register' ? { color: 'var(--color-text)', borderBottomColor: 'var(--color-text)' } : {}}><UserPlus size={14} />注册</button>
      </div>
      {tab === 'register' && <><input placeholder="用户名" value={f.username} onChange={e => setF({ ...f, username: e.target.value })} className="input mb-3" /><input placeholder="邮箱" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} className="input mb-3" /></>}
      {tab === 'login' && <input placeholder="用户名或邮箱" value={f.account} onChange={e => setF({ ...f, account: e.target.value })} className="input mb-3" />}
      <input placeholder="密码（至少8位）" type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} className="input mb-4" />
      {tab === 'register' && <input placeholder="邀请码（可选）" value={f.inviteCode} onChange={e => setF({ ...f, inviteCode: e.target.value.toUpperCase() })} className="input mb-4" />}
      <button onClick={submit} disabled={loading} className="btn btn-block">{loading ? '处理中...' : tab === 'login' ? '登录' : '注册'}</button>
      {tab === 'login' && <div className="text-center mt-4"><a href="/forgot" className="text-sm text-text-2">忘记密码？</a></div>}
    </div>
  );
}
