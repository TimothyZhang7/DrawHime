/** 重置密码页 — URL token 参数 */
import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Key } from 'lucide-react';
import { config } from '../../lib/config';

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (pw.length < 8) return setError('密码至少 8 位');
    const r = await fetch(`${config.apiBase}/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, newPassword: pw }) });
    const d = await r.json() as { ok?: boolean; message?: string };
    if (d.ok) setDone(true); else setError(d.message ?? '重置失败，链接可能已过期');
  };

  if (done) return (
    <div className="animate-fade-in max-w-[400px] mx-auto mt-20 card text-center">
      <Key size={24} className="animate-fade-in mx-auto mb-3 text-success" />
      <h2 className="text-lg font-bold mb-2">密码已重置</h2>
      <p className="text-sm text-text-2 mb-4">请使用新密码登录。</p>
      <Link to="/login" className="btn btn-block">去登录</Link>
    </div>
  );

  return (
    <div className="animate-fade-in max-w-[400px] mx-auto mt-20 card">
      <h2 className="text-lg font-bold mb-3 flex items-center gap-2"><Key size={18} />重置密码</h2>
      {!token ? <p className="text-sm text-error">缺少重置 token，请检查链接是否完整。</p> : <>
        <p className="text-sm text-text-2 mb-4">请输入新密码（至少 8 位）。</p>
        <input type="password" placeholder="新密码" value={pw} onChange={e => { setPw(e.target.value); setError(''); }} className="input mb-3" />
        {error && <p className="text-sm text-error mb-3">{error}</p>}
        <button onClick={submit} className="btn btn-block">重置密码</button>
      </>}
      <div className="text-center mt-4"><Link to="/login" className="text-sm text-text-2">返回登录</Link></div>
    </div>
  );
}
