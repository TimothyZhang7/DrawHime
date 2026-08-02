/**
 * 本文件提供桌面长列表的通用分页状态和紧凑翻页控件，控制单次 DOM 与图片解码数量。
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/** 根据筛选结果返回当前页数据；筛选条件变化时自动回到第一页。 */
export function usePagedItems<Item>(items: readonly Item[], pageSize: number, resetKey: string) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => setPage(1), [resetKey]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);
  const pageItems = useMemo(() => items.slice((page - 1) * pageSize, page * pageSize), [items, page, pageSize]);
  return { page, pageCount, pageItems, setPage };
}

/** 分页控件只使用熟悉的方向图标，并以文本显示当前位置和总条目数。 */
export function PaginationControls({ page, pageCount, total, onPage }: { page: number; pageCount: number; total: number; onPage: (page: number) => void }) {
  if (pageCount <= 1) return null;
  return <nav className="collection-pagination" aria-label="分页"><span>第 {page} / {pageCount} 页 · 共 {total} 项</span><div><button type="button" title="上一页" aria-label="上一页" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft /></button><button type="button" title="下一页" aria-label="下一页" disabled={page >= pageCount} onClick={() => onPage(page + 1)}><ChevronRight /></button></div></nav>;
}
