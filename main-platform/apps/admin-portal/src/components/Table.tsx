import React from 'react';

export interface TableColumn<T = any> {
  key: string;
  label: string;
  width?: string;
  render?: (val: unknown, row: T) => React.ReactNode;
}

export interface TableProps {
  columns: TableColumn<any>[];
  data: any[];
  rowKey?: string;
}

export default function Table({ columns, data, rowKey }: TableProps) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b" style={{ borderColor: 'var(--color-border)' }}>
            {columns.map(col => (
              <th key={col.key} className="p-2.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-2)', width: col.width }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="p-8 text-center text-sm" style={{ color: 'var(--color-text-2)' }}>暂无数据</td></tr>
          ) : rows.map((row, i) => (
            <tr key={rowKey ? row[rowKey] : i} className="border-b hover:bg-gray-50 transition-colors" style={{ borderColor: 'var(--color-border)' }}>
              {columns.map(col => (
                <td key={col.key} className="p-2.5" style={{ color: 'var(--color-text)' }}>
                  {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
