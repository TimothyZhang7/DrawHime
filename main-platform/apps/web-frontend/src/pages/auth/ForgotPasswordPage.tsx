/** 忘记密码 */
import { useState } from 'react';
import { useToast } from '../../providers/ToastProvider';
import { config } from '../../lib/config';
import { Key, Mail } from 'lucide-react';
import { Seo } from '../../components/Seo';

export function ForgotPasswordPage() {
  const { show } = useToast(); const [email, setEmail] = useState('');
  return (
    <div className="animate-fade-in max-w-[400px] mx-auto mt-20 card">
      <Seo title="找回密码" description="找回绘图姬 DrawHime 账号密码，继续使用 AI 绘图和个人图库。" path="/forgot" index={false} />
      <h2 className="text-lg font-bold mb-3 flex items-center gap-2"><Key size={18} />忘记密码</h2>
      <p className="text-sm text-text-2 mb-4">输入注册邮箱，我们将发送重置链接。</p>
      <div className="input flex items-center gap-2 mb-4"><Mail size={14} className="text-text-2" /><input placeholder="注册邮箱" value={email} onChange={e => setEmail(e.target.value)} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13, flex: 1 }} /></div>
      <button onClick={async () => { if (!email) return show('请输入邮箱', 'warn'); const r = await fetch(`${config.apiBase}/auth/forgot-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }); show(((await r.json()) as { message?: string }).message ?? '已发送', 'info'); }} className="btn btn-block">发送重置邮件</button>
      <div className="text-center mt-4"><a href="/login" className="text-sm text-text-2">返回登录</a></div>
    </div>
  );
}
