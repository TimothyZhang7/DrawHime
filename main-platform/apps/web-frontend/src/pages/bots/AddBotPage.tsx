/** 添加 Bot — 生成端点 → 配置 NapCat → 测试检测 → 确认绑定 */
import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bot, Copy, Check, Link2, Wifi, ArrowRight, RotateCw, Clock, AlertTriangle, ChevronRight, Key, Search } from 'lucide-react';
import { useToast } from '../../providers/ToastProvider';
import { config } from '../../lib/config';

type Step = 'create' | 'config' | 'test' | 'confirm' | 'done';
type Endpoint = { pathSuffix: string; token: string; wsUrl: string; expiresAt: string };
type DetectedBot = { selfId: string; connectedAt: string; uptimeSec: number };

export function AddBotPage() {
  const { show } = useToast(); const nav = useNavigate();
  const [step, setStep] = useState<Step>('create');
  const [ep, setEp] = useState<Endpoint | null>(null);
  const [detectedBots, setDetectedBots] = useState<DetectedBot[]>([]);
  const [selectedBot, setSelectedBot] = useState<DetectedBot | null>(null);
  const [testing, setTesting] = useState(false);
  const [binding, setBinding] = useState(false);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!ep) return;
    const ms = new Date(ep.expiresAt).getTime() - Date.now();
    if (ms <= 0) { setExpired(true); return; }
    const t = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(t);
  }, [ep]);

  /** 步骤 1：生成 WebSocket 端点 */
  const create = async () => {
    const r = await fetch(`${config.apiBase}/wsproxy/create-endpoint`, { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` } });
    const d = await r.json() as { ok?: boolean; data?: { endpoint: { pathSuffix: string; expiresAt: string }; accessToken: string; websocketUrl: string } };
    if (d.ok) {
      const e = d.data!;
      setEp({ pathSuffix: e.endpoint.pathSuffix, token: e.accessToken, wsUrl: e.websocketUrl, expiresAt: e.endpoint.expiresAt });
      setStep('config');
    } else show('创建失败，请稍后重试', 'error');
  };

  /** 步骤 2→3：检测新连接的 Bot（自动发现未绑定的连接） */
  const detect = async () => {
    setTesting(true);
    setDetectedBots([]); setSelectedBot(null);
    try {
      const r = await fetch(`${config.apiBase}/wsproxy/test-connection`, {
        method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
      });
      const d = await r.json() as { ok?: boolean; data?: { connected: boolean; bots: DetectedBot[] } };
      if (d.ok && d.data?.bots?.length) {
        setDetectedBots(d.data.bots);
        setSelectedBot(d.data.bots[0]); // 默认选中第一个
        setStep('confirm');
      } else {
        setStep('test');
        show('未检测到新 Bot 连接，请确认 NapCat 配置正确并已重启', 'warn');
      }
    } catch { show('检测失败，请稍后重试', 'error'); }
    setTesting(false);
  };

  /** 步骤 4：确认绑定 */
  const bind = async () => {
    if (!selectedBot) return;
    setBinding(true);
    try {
      const r = await fetch(`${config.apiBase}/wsproxy/bind-bot`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
        body: JSON.stringify({ selfId: selectedBot.selfId }),
      });
      const d = await r.json() as { ok?: boolean };
      if (d.ok) { setStep('done'); show('Bot 绑定成功！', 'success'); }
      else show('绑定失败，请稍后重试', 'error');
    } catch { show('操作失败', 'error'); }
    setBinding(false);
  };

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label); setTimeout(() => setCopied(''), 2000);
  };

  return (
    <div className="animate-fade-in">
      <h1 className="page-title mb-5 flex items-center gap-2"><Bot size={20} />添加 Bot</h1>

      {/* 步骤指示器 */}
      <StepIndicator step={step} />

      {/* 步骤 1：生成端点 */}
      {step === 'create' && (
        <div className="card text-center py-10" style={{ maxWidth: 420, margin: '0 auto' }}>
          <Link2 size={32} className="mx-auto mb-3 text-primary" />
          <h2 className="text-base font-semibold mb-2">生成连接端点</h2>
          <p className="text-sm text-text-2 mb-5">创建临时 WebSocket 端点，有效期 30 分钟</p>
          <button onClick={create} className="btn btn-lg flex items-center gap-2 mx-auto">生成端点 <ArrowRight size={16} /></button>
        </div>
      )}

      {/* 步骤 2：配置 NapCat */}
      {step === 'config' && ep && (
        <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}>
          {expired && <div className="flex items-center gap-2 p-3 mb-4 rounded text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626' }}><AlertTriangle size={14} />端点已过期 <button onClick={create} className="underline ml-1 font-medium">重新生成</button></div>}

          <h2 className="text-base font-semibold mb-4 flex items-center gap-2"><Key size={16} />配置 NapCatQQ</h2>

          <Field label="WebSocket 地址" value={ep.wsUrl} copyKey="url" copied={copied} onCopy={copy} description="填入 NapCat 的 URL 字段" />
          <Field label="Access Token" value={ep.token} copyKey="token" copied={copied} onCopy={copy} description="填入 NapCat 的 Access Token 字段" />
          <div className="text-xs text-text-2 mb-4 flex items-center gap-1"><Clock size={12} />有效期至 {new Date(ep.expiresAt).toLocaleTimeString()}</div>

          <div className="p-3 border border-border rounded text-xs mb-4" style={{ background: 'var(--color-bg)' }}>
            <div className="font-semibold mb-2">NapCatQQ 配置步骤</div>
            <ol className="space-y-1.5" style={{ paddingLeft: 18 }}>
              <li>打开 NapCatQQ → 网络设置 → 添加 <b>WebSocket 客户端</b></li>
              <li>URL 填入上方 <b>WebSocket 地址</b></li>
              <li>Access Token 填入上方 <b>Access Token</b></li>
              <li>消息格式选择 <b>消息段（array）</b></li>
              <li>心跳间隔设为 <b>60000</b> 毫秒</li>
              <li>保存并重启 NapCat → 回到本页点击「检测连接」</li>
            </ol>
          </div>

          <button onClick={detect} disabled={testing || expired} className="btn w-full flex items-center justify-center gap-2">
            {testing ? <><RotateCw size={14} className="animate-spin" />检测中...</> : <><Search size={14} />检测连接</>}
          </button>
        </div>
      )}

      {/* 步骤 3：检测中 / 未检测到 */}
      {step === 'test' && (
        <div className="card text-center py-10" style={{ maxWidth: 420, margin: '0 auto' }}>
          <Search size={32} className="mx-auto mb-3 text-text-2" />
          <h2 className="text-base font-semibold mb-2">未检测到 Bot</h2>
          <p className="text-sm text-text-2 mb-5">请确认 NapCat 已配置并重启完成，然后重试</p>
          <div className="flex gap-2 justify-center">
            <button onClick={() => setStep('config')} className="btn btn-outline">返回配置</button>
            <button onClick={detect} disabled={testing} className="btn flex items-center gap-2">{testing ? '检测中...' : <><Search size={14} />重新检测</>}</button>
          </div>
        </div>
      )}

      {/* 步骤 4：确认绑定（显示检测到的 Bot 信息） */}
      {step === 'confirm' && detectedBots.length > 0 && (
        <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
          <h2 className="text-base font-semibold mb-1 flex items-center gap-2"><Wifi size={16} className="text-success" />检测到 Bot 连接</h2>
          <p className="text-xs text-text-2 mb-4">以下 Bot 已通过 WebSocket 连接，请确认并绑定</p>

          <div className="flex flex-col gap-2 mb-5">
            {detectedBots.map(b => (
              <button key={b.selfId} onClick={() => setSelectedBot(b)}
                className="flex items-center gap-3 p-3 rounded-lg border text-left w-full transition-colors"
                style={{
                  borderColor: selectedBot?.selfId === b.selfId ? 'var(--color-primary)' : 'var(--color-border)',
                  background: selectedBot?.selfId === b.selfId ? 'var(--color-primary-soft)' : 'transparent',
                  cursor: 'pointer',
                }}>
                {/* 头像占位 */}
                <div className="flex items-center justify-center rounded-full flex-shrink-0" style={{ width: 44, height: 44, background: 'var(--color-primary-soft)', border: '2px solid var(--color-primary)' }}>
                  <Bot size={22} className="text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">Bot {b.selfId}</div>
                  <div className="text-[11px] text-text-2">QQ: {b.selfId}</div>
                  <div className="text-[11px] text-text-2 flex items-center gap-1 mt-0.5">
                    <Clock size={10} />已连接 {formatUptime(b.uptimeSec)}
                  </div>
                </div>
                {selectedBot?.selfId === b.selfId && (
                  <Check size={18} className="text-primary flex-shrink-0" />
                )}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button onClick={() => { setStep('test'); setDetectedBots([]); }} className="btn btn-outline btn-sm">重新检测</button>
            <button onClick={bind} disabled={!selectedBot || binding} className="btn flex-1 flex items-center justify-center gap-2">
              {binding ? '绑定中...' : <>绑定 Bot {selectedBot?.selfId}</>}
            </button>
          </div>
        </div>
      )}

      {/* 完成 */}
      {step === 'done' && (
        <div className="card text-center py-10" style={{ maxWidth: 420, margin: '0 auto' }}>
          <div className="flex items-center justify-center mx-auto mb-3 rounded-full" style={{ width: 52, height: 52, background: '#dcfce7', border: '2px solid #16a34a' }}>
            <Check size={26} className="text-success" />
          </div>
          <h2 className="text-base font-semibold mb-2">Bot 已绑定</h2>
          <p className="text-sm text-text-2 mb-1">{selectedBot?.selfId} 已绑定到您的账号</p>
          <p className="text-xs text-text-2 mb-5">现在可以在 QQ 群中使用命令生成图片了</p>
          <Link to="/bots" className="btn btn-lg">查看 Bot 列表</Link>
        </div>
      )}
    </div>
  );
}

/* ====== 子组件 ====== */

function StepIndicator({ step }: { step: Step }) {
  const steps = [
    { key: 'create' as Step, label: '生成端点', icon: Link2 },
    { key: 'config' as Step, label: '配置 NapCat', icon: Key },
    { key: 'confirm' as Step, label: '确认绑定', icon: Wifi },
    { key: 'done' as Step, label: '完成', icon: Check },
  ];
  const stepIdx = Math.max(0, steps.findIndex(s => s.key === step || (step === 'test' && s.key === 'confirm')));
  return (
    <div className="flex items-center justify-center gap-0 mb-6 flex-wrap">
      {steps.map((s, i) => (
        <span key={s.key} className="flex items-center gap-0">
          <span className={`flex items-center gap-1.5 text-xs font-medium ${i === stepIdx ? 'text-primary' : i < stepIdx ? 'text-success' : 'text-text-2'}`}>
            <span className="flex items-center justify-center rounded-full" style={{ width: 24, height: 24, background: i <= stepIdx ? 'var(--color-primary-soft)' : 'var(--color-bg)', border: `1.5px solid ${i <= stepIdx ? 'var(--color-primary)' : 'var(--color-border)'}` }}>
              {i < stepIdx ? <Check size={12} className="text-success" /> : <s.icon size={12} />}
            </span>
            {s.label}
          </span>
          {i < steps.length - 1 && <ChevronRight size={12} className="text-text-2 mx-1 flex-shrink-0" />}
        </span>
      ))}
    </div>
  );
}

function Field({ label, value, copyKey, copied, onCopy, description }: { label: string; value: string; copyKey: string; copied: string; onCopy: (text: string, label: string) => void; description?: string }) {
  return (
    <div className="mb-3">
      <div className="text-xs text-text-2 mb-1">{label}{description && <span className="ml-1 opacity-60">— {description}</span>}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs p-2.5 border border-border bg-bg break-all rounded select-all">{value}</code>
        <button onClick={() => onCopy(value, copyKey)} className="btn btn-outline btn-sm flex-shrink-0">
          {copied === copyKey ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d`;
}
