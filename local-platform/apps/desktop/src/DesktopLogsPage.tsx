/**
 * 本文件提供设置页全局日志与图库任务日志，共用分页查询和紧凑日志列表。
 */
import type { DesktopLogEntryView, DesktopLogQueryInput } from "@drawhime/contracts";
import { AlertTriangle, CheckCircle2, ClipboardCopy, Clock3, LoaderCircle, RefreshCw, ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listDesktopLogs } from "./desktop-api";

type LogRange = "30" | "120" | "1440" | "all";

/** 设置页全局日志默认只读取最近 30 分钟，用户明确选择后才读取更长范围。 */
export function DesktopLogsPage({ active, onError }: { active: boolean; onError: (message: string) => void }) {
  const [range, setRange] = useState<LogRange>("30");
  const [level, setLevel] = useState("");
  const [scope, setScope] = useState("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [items, setItems] = useState<DesktopLogEntryView[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);

  const load = useCallback(async (offset = 0) => {
    if (!active) return;
    const requestId = ++requestVersion.current;
    setLoading(true);
    const input: DesktopLogQueryInput = { sinceMinutes: range === "all" ? null : Number(range), taskId: null, level: level ? level as DesktopLogQueryInput["level"] : null, scope: scope || null, search: appliedSearch || null, offset, limit: 200 };
    try {
      const page = await listDesktopLogs(input);
      if (requestId !== requestVersion.current) return;
      setItems((current) => offset > 0 ? [...current, ...page.items] : page.items);
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (error) { onError(errorMessage(error)); }
    finally { if (requestId === requestVersion.current) setLoading(false); }
  }, [active, appliedSearch, level, onError, range, scope]);

  useEffect(() => { if (active) void load(0); }, [active, load]);
  const copyText = useMemo(() => formatLogs(items), [items]);
  return <div className="desktop-page logs-page"><section className="logs-toolbar"><div className="logs-toolbar-title"><ScrollText /><span><strong>运行日志</strong><small>{rangeLabel(range)} · 共 {total} 条</small></span></div><div className="logs-filters"><select aria-label="日志时间范围" value={range} onChange={(event) => setRange(event.target.value as LogRange)}><option value="30">最近 30 分钟</option><option value="120">最近 2 小时</option><option value="1440">最近 24 小时</option><option value="all">全部保留日志</option></select><select aria-label="日志级别" value={level} onChange={(event) => setLevel(event.target.value)}><option value="">全部级别</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></select><select aria-label="日志作用域" value={scope} onChange={(event) => setScope(event.target.value)}><option value="">全部模块</option><option value="startup">启动</option><option value="environment">环境</option><option value="runtime">Runtime</option><option value="generation">生成</option><option value="training">训练</option><option value="captioning">打标</option><option value="resource">资源</option><option value="gallery">图库</option></select><form onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search.trim()); }}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索事件或错误" /><button type="submit">筛选</button></form><button title="刷新日志" disabled={loading} onClick={() => void load(0)}>{loading ? <LoaderCircle className="spin" /> : <RefreshCw />}</button><button title="复制当前日志" disabled={!items.length} onClick={() => void navigator.clipboard.writeText(copyText)}><ClipboardCopy /></button></div></section><LogList items={items} loading={loading && !items.length} emptyText="当前筛选范围内没有日志" />{hasMore && <button className="logs-load-more" disabled={loading} onClick={() => void load(items.length)}>{loading ? <LoaderCircle className="spin" /> : <Clock3 />}{loading ? "正在加载" : `继续加载 · 已显示 ${items.length}/${total}`}</button>}</div>;
}

/** 图库详情只查询当前任务日志，不让全局日志载荷进入任务列表。 */
export function TaskLogPanel({ taskId, refreshKey }: { taskId: string; refreshKey: string }) {
  const [items, setItems] = useState<DesktopLogEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listDesktopLogs({ sinceMinutes: null, taskId, level: null, scope: null, search: null, offset: 0, limit: 500 }).then((page) => { if (!cancelled) { setItems(page.items); setError(""); } }).catch((reason) => { if (!cancelled) setError(errorMessage(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, refreshKey]);
  return <section className="gallery-detail-section task-log-section"><header><ScrollText /><div><span>TASK LOGS</span><h2>任务日志</h2></div><small>{items.length} 条</small></header>{error ? <div className="logs-inline-error"><AlertTriangle />{error}</div> : <LogList items={items} loading={loading} emptyText="该任务暂时没有结构化日志；旧版本任务仍可查看执行尝试与错误" />}</section>;
}

function LogList({ items, loading, emptyText }: { items: DesktopLogEntryView[]; loading: boolean; emptyText: string }) {
  if (loading) return <div className="empty-block compact"><LoaderCircle className="spin" />正在读取日志</div>;
  if (!items.length) return <div className="empty-block compact">{emptyText}</div>;
  return <div className="desktop-log-list">{items.map((item) => <article key={item.id} className={`is-${item.level}`}><i>{item.level === "error" || item.level === "warn" ? <AlertTriangle /> : <CheckCircle2 />}</i><time>{formatTime(item.createdAt)}</time><div><strong>{item.message}</strong><span>{scopeLabel(item.scope)} · {item.event}{item.taskId ? ` · ${item.taskId}` : ""}</span>{item.details && <pre>{item.details}</pre>}</div></article>)}</div>;
}

function formatLogs(items: DesktopLogEntryView[]): string { return items.map((item) => `[${item.createdAt}] [${item.level.toUpperCase()}] [${item.scope}/${item.event}] ${item.message}${item.taskId ? ` task=${item.taskId}` : ""}${item.details ? `\n${item.details}` : ""}`).join("\n"); }
function rangeLabel(value: LogRange): string { return { "30": "最近 30 分钟", "120": "最近 2 小时", "1440": "最近 24 小时", all: "全部保留日志" }[value]; }
function formatTime(value: string): string { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
function scopeLabel(value: string): string { return { startup: "启动", environment: "环境", runtime: "Runtime", generation: "生成", training: "训练", captioning: "打标", resource: "资源", gallery: "图库" }[value] || value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error || "读取日志失败"); }
