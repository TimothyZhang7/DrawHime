/** 分页组件 — 纯 Tailwind，无第三方依赖 */
import { useMemo } from 'react';

export interface PaginationProps {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}

/** 生成页码数组，超出范围时插入省略号 */
function buildPages(current: number, totalPages: number): (number | 'ellipsis')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: (number | 'ellipsis')[] = [];

  // 始终包含第一页
  pages.push(1);

  if (current <= 3) {
    // 靠近开头：1 2 3 4 ... N
    for (let i = 2; i <= 4; i++) pages.push(i);
    pages.push('ellipsis');
    pages.push(totalPages);
  } else if (current >= totalPages - 2) {
    // 靠近末尾：1 ... N-3 N-2 N-1 N
    pages.push('ellipsis');
    for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
  } else {
    // 中间：1 ... C-1 C C+1 ... N
    pages.push('ellipsis');
    pages.push(current - 1, current, current + 1);
    pages.push('ellipsis');
    pages.push(totalPages);
  }

  return pages;
}

function PaginationButton({
  children,
  active,
  disabled,
  onClick,
  ariaLabel,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel?: string;
}) {
  const base =
    'inline-flex items-center justify-center min-w-[36px] h-9 px-2 text-[13px] font-medium rounded-lg transition-colors select-none';

  if (disabled) {
    return (
      <span
        className={`${base} cursor-not-allowed`}
        style={{ color: 'var(--color-soft)', opacity: 0.5 }}
        aria-disabled="true"
      >
        {children}
      </span>
    );
  }

  if (active) {
    return (
      <button
        className={base}
        style={{
          background: 'var(--color-primary)',
          color: '#fff',
        }}
        onClick={onClick}
        aria-label={ariaLabel}
        aria-current="page"
      >
        {children}
      </button>
    );
  }

  return (
    <button
      className={base}
      style={{ color: 'var(--color-text-2)' }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--color-bg)';
        (e.currentTarget as HTMLElement).style.color = 'var(--color-text)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
        (e.currentTarget as HTMLElement).style.color = 'var(--color-text-2)';
      }}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

export function Pagination({ page, total, pageSize, onChange }: PaginationProps) {
  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);
  const clampedPage = Math.max(1, Math.min(page, totalPages));

  const pages = useMemo(() => buildPages(clampedPage, totalPages), [clampedPage, totalPages]);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center py-4">
        <span className="text-xs" style={{ color: 'var(--color-soft)' }}>
          暂无数据
        </span>
      </div>
    );
  }

  return (
    <nav aria-label="分页导航" className="flex items-center justify-center gap-2 py-3">
      {/* 上一页 */}
      <PaginationButton
        disabled={clampedPage <= 1}
        onClick={() => onChange(clampedPage - 1)}
        ariaLabel="上一页"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </PaginationButton>

      {/* 页码 */}
      {pages.map((p, i) =>
        p === 'ellipsis' ? (
          <span
            key={`ellipsis-${i}`}
            className="inline-flex items-center justify-center min-w-[36px] h-9 text-[13px] select-none"
            style={{ color: 'var(--color-soft)' }}
          >
            ...
          </span>
        ) : (
          <PaginationButton
            key={p}
            active={p === clampedPage}
            onClick={() => onChange(p)}
            ariaLabel={`第 ${p} 页`}
          >
            {p}
          </PaginationButton>
        ),
      )}

      {/* 下一页 */}
      <PaginationButton
        disabled={clampedPage >= totalPages}
        onClick={() => onChange(clampedPage + 1)}
        ariaLabel="下一页"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </PaginationButton>
    </nav>
  );
}
