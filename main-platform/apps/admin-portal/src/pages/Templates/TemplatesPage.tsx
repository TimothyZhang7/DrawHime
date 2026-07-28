/** 管理台 — 模板管理 (Tailwind + shared components) */
import { useState, useEffect, useRef, useCallback } from 'react';
import { FileText, Eye, EyeOff, Trash2, RotateCw, Star } from 'lucide-react';
import { api } from '../../api/client';
import Toast from '../../components/Toast';
import { Modal } from '../../components/Modal';
import Table from '../../components/Table';
import type { TableColumn } from '../../components/Table';
import { Pagination } from '../../components/Pagination';

/* ===== Types ===== */

interface TemplateRecord {
  id: number;
  name: string;
  isPublic: boolean;
  username?: string;
  userId?: number;
  favoriteCount: number;
}

interface TemplateListData {
  items: TemplateRecord[];
  total: number;
}

/* ===== Toast manager ===== */

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error';
}

const PAGE_SIZE = 20;

/* ===== Main Page Component ===== */

export function AdminTemplatesPage() {
  /* --- Data --- */
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  /* --- Delete confirm --- */
  const [deleteTarget, setDeleteTarget] = useState<TemplateRecord | null>(null);

  /* --- Toast --- */
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const addToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);
  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  /* ==================================================================
   *  Data fetching
   * ================================================================*/

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<TemplateListData>(`/api/templates?page=${page}&pageSize=${PAGE_SIZE}`);

      if (result.ok && result.data) {
        setTemplates(result.data.items ?? []);
        setTotal(result.data.total ?? 0);
      } else {
        addToast('error', result.message || '获取模板列表失败');
      }
    } catch {
      addToast('error', '网络错误，获取模板数据失败');
    } finally {
      setLoading(false);
    }
  }, [page, addToast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* ==================================================================
   *  CRUD handlers
   * ================================================================*/

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const result = await api(`/api/templates/${deleteTarget.id}`, { method: 'DELETE' });

    if (result.ok) {
      addToast('success', '模板已删除');
      setDeleteTarget(null);
      fetchData();
    } else {
      addToast('error', result.message || '删除失败');
    }
  };

  /* ==================================================================
   *  Table column definitions
   * ================================================================*/

  const columns: TableColumn<TemplateRecord>[] = [
    {
      key: 'id',
      label: 'ID',
      width: '60px',
    },
    {
      key: 'name',
      label: '名称',
      render: (_val, row) => (
        <div className="flex items-center gap-1.5">
          <FileText size={14} style={{ color: 'var(--color-primary)' }} className="flex-shrink-0" />
          <span className="font-medium truncate max-w-[200px]" style={{ color: 'var(--color-text)' }}>
            {row.name}
          </span>
        </div>
      ),
    },
    {
      key: 'isPublic',
      label: '公开',
      width: '80px',
      render: (_val, row) =>
        row.isPublic ? (
          <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--color-success)' }}>
            <Eye size={13} />
            公开
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-2)' }}>
            <EyeOff size={13} />
            私密
          </span>
        ),
    },
    {
      key: 'username',
      label: '创建者',
      width: '120px',
      render: (_val, row) => (
        <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
          {row.username || row.userId || '-'}
        </span>
      ),
    },
    {
      key: 'favoriteCount',
      label: '收藏',
      width: '80px',
      render: (_val, row) => (
        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--color-warning)' }}>
          <Star size={13} fill="currentColor" />
          {row.favoriteCount ?? 0}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '操作',
      width: '120px',
      render: (_val, row) => (
        <div className="flex items-center gap-1.5">
          <button
            className="btn btn-sm btn-outline"
            onClick={() => fetchData()}
            title="刷新"
          >
            <RotateCw size={14} />
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={() => setDeleteTarget(row)}
            title="删除"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  /* ==================================================================
   *  Render
   * ================================================================*/

  if (loading && templates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <div className="skeleton w-48 h-5" />
        <div className="skeleton w-64 h-4" />
      </div>
    );
  }

  return (
    <>
      {/* ---- Toasts ---- */}
      {toasts.map(t => (
        <Toast
          key={t.id}
          message={t.message}
          type={t.type}
          onClose={() => removeToast(t.id)}
        />
      ))}

      {/* ---- Page header ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <FileText size={20} style={{ color: 'var(--color-primary)' }} />
          <h2 className="page-title">模板管理</h2>
        </div>
        <button
          className="btn btn-outline btn-sm self-start sm:self-auto"
          onClick={fetchData}
        >
          <RotateCw size={14} className="mr-1" />
          刷新
        </button>
      </div>

      {/* ---- Templates table ---- */}
      <Table columns={columns} data={templates} />

      {/* ---- Pagination ---- */}
      <Pagination
        page={page}
        total={total}
        pageSize={PAGE_SIZE}
        onChange={setPage}
      />

      {/* ==================================================================
       *  Delete confirmation modal
       * ================================================================*/}
      <Modal
        open={deleteTarget !== null}
        title="确认删除"
        onClose={() => setDeleteTarget(null)}
      >
        <p className="text-sm mb-2" style={{ color: 'var(--color-text-2)' }}>
          确定要删除模板{' '}
          <span className="font-semibold" style={{ color: 'var(--color-text)' }}>
            {deleteTarget?.name}
          </span>{' '}
          吗？
        </p>
        <p className="text-xs mb-6" style={{ color: 'var(--color-error)' }}>
          此操作不可撤销，收藏数据也将被清除。
        </p>
        <div className="flex justify-end gap-3">
          <button className="btn btn-outline btn-sm" onClick={() => setDeleteTarget(null)}>
            取消
          </button>
          <button className="btn btn-sm btn-danger" onClick={handleDelete}>
            删除
          </button>
        </div>
      </Modal>
    </>
  );
}
