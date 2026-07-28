/** 全局浮动队列 — 右下角悬浮 */
import { useState, useEffect } from 'react';
import { List, X, ChevronDown, ChevronRight, Clock, Check, Loader2, History } from 'lucide-react';
import { api } from '../../lib/api';
import { formatDrawingModelNameByMap, useDrawingModelDisplayMap } from '../../lib/drawingModelDisplay';

type TaskInfo = { id?: string; taskId?: string; status: string; prompt: string; error?: string; subTasks?: { kind: string; status: string; siteName?: string; model?: string; error?: string; latencyMs?: number }[] };
function getRecent(): string[] { try { return JSON.parse(localStorage.getItem('aiimage_recent_tasks') ?? '[]').slice(0, 10); } catch { return []; } }

const sColor = (s: string) => s === 'success' ? 'var(--color-success)' : s === 'failed' ? 'var(--color-error)' : (s === 'running' || s === 'finalizing') ? 'var(--color-primary)' : 'var(--color-text-2)';
const sIcon = (s: string) => s === 'success' ? <Check size={9} className="text-success" /> : s === 'failed' ? <X size={9} className="text-error" /> : (s === 'running' || s === 'finalizing') ? <span className="flex items-center justify-center" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-primary)', animation: 'pulse 1.5s infinite' }} /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-text-2)' }} />;

export function FloatingQueue() {
  const hiddenOnMobile = useHideFloatingQueueOnMobile();
  const modelDisplayMap = useDrawingModelDisplayMap();
  const [open, setOpen] = useState(false);
  const [taskIds, setTaskIds] = useState<string[]>(getRecent);
  const [tasks, setTasks] = useState<Record<string, TaskInfo>>({});

  // 监听新任务事件，实时更新列表
  useEffect(() => {
    const handler = () => setTaskIds(getRecent());
    window.addEventListener('aiimage:task-added', handler);
    return () => window.removeEventListener('aiimage:task-added', handler);
  }, []);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // 手机端不显示全局任务悬浮框，也不启动后台轮询，避免所有页面右上角出现任务入口。
    if (hiddenOnMobile) return;
    if (taskIds.length === 0 || !localStorage.getItem('token')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** 安排下一次轮询，保证上一次请求完成后才会继续，避免慢接口下请求堆积。 */
    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      timer = setTimeout(poll, delayMs);
    };

    const poll = async () => {
      const ids = taskIds.join(','); if (!ids) return;
      const d = await api<{ tasks: { id: string; status: string; prompt: string; subTasks?: TaskInfo['subTasks'] }[] }>(`/api/generations/tasks?ids=${ids}`);
      if (cancelled) return;
      if (d.ok && d.data?.tasks) {
        setTasks(prev => { const n = { ...prev }; for (const t of d.data!.tasks) n[t.id] = { ...n[t.id], ...t } as TaskInfo; return n; });
        // 自适应轮询：有活跃任务时更快刷新，完成后降低频率保护后端。
        const hasActive = d.data.tasks.some(t => t.status === 'running' || t.status === 'queued' || t.status === 'finalizing');
        scheduleNext(hasActive ? 2000 : 8000);
        return;
      }
      // 失败时放慢重试，避免网络抖动或鉴权异常导致高频请求。
      scheduleNext(8000);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hiddenOnMobile, taskIds]);

  const running = Object.values(tasks).filter(t => t.status === 'running' || t.status === 'queued' || t.status === 'finalizing').length;
  if (hiddenOnMobile || taskIds.length === 0) return null;

  return (
    <div className="floating-queue fixed bottom-4 right-4 z-[999] flex flex-col items-end gap-2">
      {open && (
        <div className="floating-queue-panel card p-0 overflow-hidden flex flex-col" style={{ width: 340, height: 420, scrollbarGutter: 'stable' }}>
          <div className="flex items-center justify-between px-4 flex-shrink-0" style={{ height: 40, borderBottom: '1px solid var(--color-border)' }}>
            <span className="text-xs font-semibold flex items-center gap-1.5"><History size={13} />任务队列<span className="text-text-2 font-normal">· {taskIds.length}个</span></span>
            <button onClick={() => setOpen(false)} className="flex items-center justify-center rounded-full hover:bg-bg" style={{ width: 24, height: 24, border: 'none', cursor: 'pointer' }}><X size={13} /></button>
          </div>
          <div className="overflow-y-auto flex-1" style={{ scrollbarWidth: 'none' }}>
            <style>{`.no-scrollbar::-webkit-scrollbar { display: none }`}</style>
            {taskIds.map(id => {
              const t = tasks[id]; const isOpen = expanded[id];
              const attempts = t?.subTasks?.filter(s => s.kind === 'upstream_attempt') ?? [];
              return (
                <div key={id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <button onClick={() => setExpanded(p => ({ ...p, [id]: !p[id] }))}
                    className="w-full flex items-center gap-2 px-4 text-left hover:bg-bg transition-colors" style={{ height: 40, border: 'none', background: 'transparent', cursor: 'pointer' }}>
                    {sIcon(t?.status ?? 'queued')}
                    <span className="flex-1 truncate text-xs">{t?.prompt?.slice(0, 50) ?? id.slice(0, 12)}</span>
                    <span className="text-[10px] font-medium flex-shrink-0" style={{ color: sColor(t?.status ?? 'queued') }}>
                      {t?.status === 'success' ? '完成' : t?.status === 'failed' ? '失败' : t?.status === 'finalizing' ? '收尾中' : t?.status === 'running' ? '生成中' : '排队'}
                    </span>
                    <span className="text-text-2 flex-shrink-0">{isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-2.5">
                      {t?.error && (
                        <div className="text-[10px] text-error leading-relaxed mb-1.5" style={{ wordBreak: 'break-all' }}>{t.error}</div>
                      )}
                      {attempts.length > 0 ? (
                        attempts.map((s, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-[10px] leading-relaxed text-text-2">
                            {sIcon(s.status)}
                            <span className="text-text-2 font-medium mr-1">#{i + 1}</span>
                            <span className="truncate">{s.siteName ? `${s.siteName} / ${formatDrawingModelNameByMap(s.model, modelDisplayMap) || '-'}` : '等待站点分配'}</span>
                            {s.latencyMs ? <span className="flex-shrink-0">{(s.latencyMs/1000).toFixed(1)}s</span> : null}
                          </div>
                        ))
                      ) : (
                        <div className="text-[10px] text-text-2">等待处理…</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button onClick={() => setOpen(!open)}
        aria-label="任务队列"
        className="flex items-center gap-2 shadow-lg border-0 cursor-pointer"
        style={{ height: 40, borderRadius: 20, padding: '0 16px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)', fontSize: 13, fontWeight: 500 }}>
        {running > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className="relative flex items-center justify-center" style={{ width: 7, height: 7 }}>
              <span className="absolute inset-0 rounded-full animate-ping opacity-75" style={{ background: 'var(--color-primary)' }} />
              <span className="relative rounded-full" style={{ width: 6, height: 6, background: 'var(--color-primary)' }} />
            </span>
            {running} 运行中
          </span>
        ) : (
          <span className="flex items-center gap-1.5"><List size={14} />{taskIds.length} 个任务</span>
        )}
      </button>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>
    </div>
  );
}

/** 判断当前是否为手机端视口；手机端完全关闭全局任务悬浮框。 */
function useHideFloatingQueueOnMobile() {
  const [hidden, setHidden] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia('(max-width: 768px)');
    const update = () => setHidden(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return hidden;
}
