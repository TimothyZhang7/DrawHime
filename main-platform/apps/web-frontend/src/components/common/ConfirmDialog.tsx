/** 本文件提供通用二次确认对话框，用于删除、隐私切换等需要用户明确确认的操作。 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';

/** 确认对话框的视觉语义。 */
export type ConfirmDialogTone = 'default' | 'warning' | 'danger';

/** 通用确认对话框参数。 */
export type ConfirmDialogProps = {
  /** 是否显示对话框。 */
  open: boolean;
  /** 标题，说明即将执行的操作。 */
  title: string;
  /** 正文说明，必须明确操作影响。 */
  message: ReactNode;
  /** 确认按钮文案。 */
  confirmLabel: string;
  /** 取消按钮文案。 */
  cancelLabel?: string;
  /** 视觉语义，危险删除使用 danger。 */
  tone?: ConfirmDialogTone;
  /** 操作执行中时禁用按钮。 */
  pending?: boolean;
  /** 用户确认后的回调。 */
  onConfirm: () => void;
  /** 用户取消或关闭后的回调。 */
  onCancel: () => void;
};

/** 通用二次确认对话框；只负责确认交互，真实权限仍必须由后端接口校验。 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = '取消',
  tone = 'default',
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, pending, onCancel]);

  if (!open) return null;

  const confirmColor = tone === 'danger'
    ? 'var(--color-error)'
    : tone === 'warning'
      ? 'var(--color-warning)'
      : 'var(--color-primary)';

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center px-4"
      style={{ background: 'rgba(15, 23, 42, .58)', backdropFilter: 'blur(10px)' }}
      onClick={() => { if (!pending) onCancel(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card"
        style={{ width: 'min(420px, 100%)', padding: 0, overflow: 'hidden' }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-flex items-center justify-center flex-shrink-0"
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                color: confirmColor,
                background: `color-mix(in srgb, ${confirmColor} 12%, transparent)`,
              }}
            >
              <AlertTriangle size={16} />
            </span>
            <h3 className="text-sm font-bold truncate">{title}</h3>
          </div>
          <button
            type="button"
            className="btn-ghost"
            style={{ width: 32, height: 32, padding: 0, borderRadius: 8 }}
            disabled={pending}
            onClick={onCancel}
            aria-label="关闭确认框"
          >
            <X size={15} />
          </button>
        </header>
        <div className="px-4 py-4 text-sm text-text leading-relaxed">
          {message}
        </div>
        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-bg/60">
          <button type="button" className="btn btn-outline btn-sm" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={pending}
            onClick={onConfirm}
            style={{ background: confirmColor, color: '#fff', borderColor: confirmColor }}
          >
            {pending ? '处理中...' : confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
