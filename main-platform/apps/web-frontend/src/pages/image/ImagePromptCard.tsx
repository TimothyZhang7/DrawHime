/** 本文件封装图库详情提示词卡片，统一提供截断、复制和完整内容弹窗。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, FileText, X } from 'lucide-react';

/** 图库提示词卡片参数。 */
export interface ImagePromptCardProps {
  label: string;
  modalTitle: string;
  copyLabel: string;
  value: string;
  emptyLabel?: string;
}

/** 展示一类提示词，并保持正面与负面提示词的交互逻辑完全一致。 */
export function ImagePromptCard({ label, modalTitle, copyLabel, value, emptyLabel = '无提示词' }: ImagePromptCardProps) {
  const [copied, setCopied] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  /** 仅在固定高度真实溢出时展示渐隐和展开入口。 */
  const refreshTruncation = useCallback(() => {
    const element = textRef.current;
    setTruncated(Boolean(element && element.scrollHeight > element.clientHeight + 2));
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(refreshTruncation);
    const element = textRef.current;
    const observer = element && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refreshTruncation) : null;
    if (element) observer?.observe(element);
    window.addEventListener('resize', refreshTruncation);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', refreshTruncation);
    };
  }, [refreshTruncation, value]);

  useEffect(() => {
    if (!modalOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModalOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [modalOpen]);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  /** 复制当前卡片的完整提示词，复制状态在两秒后复原。 */
  const copyPrompt = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [value]);

  return (
    <>
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-text-2 font-medium tracking-wide uppercase">{label}</span>
          <button
            type="button"
            onClick={() => { void copyPrompt(); }}
            className="btn-ghost flex items-center gap-1"
            style={{ height: 28, padding: '0 8px', fontSize: 11, borderRadius: 6 }}
          >
            {copied ? <><Check size={11} />已复制</> : <><Copy size={11} />复制</>}
          </button>
        </div>
        <div
          ref={textRef}
          className={`image-detail-prompt-text text-sm leading-relaxed whitespace-pre-wrap break-words${truncated ? ' is-truncated' : ''}`}
        >
          {value || <span className="text-text-2 italic">{emptyLabel}</span>}
        </div>
        {truncated && (
          <button type="button" onClick={() => setModalOpen(true)} className="image-detail-prompt-expand">
            展开完整{label}
          </button>
        )}
      </div>

      {modalOpen && createPortal(
        <div className="prompt-modal-overlay" onClick={() => setModalOpen(false)}>
          <section className="prompt-modal-shell" role="dialog" aria-modal="true" aria-label={modalTitle} onClick={(event) => event.stopPropagation()}>
            <header className="prompt-modal-header">
              <div className="prompt-modal-title">
                <span className="prompt-modal-title-icon"><FileText size={15} /></span>
                <div>
                  <strong>{modalTitle}</strong>
                  <span>{value ? `${value.length} 字符` : '无内容'}</span>
                </div>
              </div>
              <div className="prompt-modal-actions">
                <button type="button" className="prompt-copy-button" onClick={(event) => { event.stopPropagation(); void copyPrompt(); }}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copied ? '已复制' : copyLabel}</span>
                </button>
                <button type="button" className="prompt-close-button" onClick={() => setModalOpen(false)} aria-label="关闭"><X size={16} /></button>
              </div>
            </header>
            <div className="prompt-modal-content">
              <pre>{value || emptyLabel}</pre>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
