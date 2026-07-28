/** 全局通知 — 自动消失 */
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, Info, AlertTriangle } from 'lucide-react';

type Ctx = { show: (msg: string, type?: 'success' | 'error' | 'info' | 'warn') => void };
const C = createContext<Ctx>({ show: () => {} });
export const useToast = () => useContext(C);

const cfg = {
  success: { bg: '#059669', icon: Check },
  error:   { bg: '#dc2626', icon: X },
  info:    { bg: '#4f46e5', icon: Info },
  warn:    { bg: '#d97706', icon: AlertTriangle },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: string }[]>([]);
  const show = useCallback((msg: string, type = 'info') => {
    const id = Date.now();
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3000);
  }, []);

  return (
    <C.Provider value={{ show }}>
      {children}
      {typeof document !== 'undefined' && createPortal(
        // 全局提示必须挂载到 body，避免被页面 contain 或弹窗 Portal 的层叠上下文遮挡。
        <div className="toast-stack fixed top-4 right-4 z-[9999] flex flex-col gap-2" role="status" aria-live="polite">
          {toasts.map(t => {
            const c = cfg[t.type as keyof typeof cfg] ?? cfg.info;
            const Icon = c.icon;
            return (
              <div key={t.id} className="toast-item flex items-center gap-2 px-4 text-sm text-white" style={{ minHeight: 40, background: c.bg, minWidth: 200 }}>
                <Icon size={14} />{t.msg}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </C.Provider>
  );
}
