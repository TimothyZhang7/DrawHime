/** 通用配置表单组件 */
import { useState, useEffect } from 'react';
import { Save, RotateCw } from 'lucide-react';
import { api } from '../api/client';

interface ConfigField {
  name: string;
  key: string;
  type: 'text' | 'number' | 'toggle' | 'select';
  label: string;
  desc?: string;
  defaultValue?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** 显示前转换（如 ms→秒: v/1000） */
  display?: (v: string) => string;
  /** 保存前转换（如 秒→ms: v*1000） */
  save?: (v: string) => string;
}

interface Props {
  fields: ConfigField[];
  sectionKey: string;
  onSaved?: () => void;
}

export function ConfigForm({ fields, sectionKey, onSaved }: Props) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api<Record<string, string>>('/admin/config').then((r: any) => {
      if (r.ok && r.data) { setCfg(r.data); setVersion(v => v + 1); }
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const payload: Record<string, string> = {};
    for (const f of fields) {
      let val = f.type === 'toggle' ? String(form.has(f.name)) : String(form.get(f.name) ?? '');
      if (f.save && f.type !== 'toggle') val = f.save(val);
      payload[f.key] = val;
    }
    const res = await api('/admin/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) {
      setMsg('已保存');
      const refresh = await api<Record<string, string>>('/admin/config');
      if (refresh.ok && refresh.data) { setCfg(refresh.data); setVersion(v => v + 1); }
      onSaved?.();
    } else {
      setMsg(res.message ?? '保存失败');
    }
    setSaving(false);
  };

  const g = (key: string, def = '') => { const v = cfg[key] ?? def; return v; };

  return (
    <form key={version} onSubmit={handleSubmit} className="space-y-4">
      {msg && <div className={`text-xs px-3 py-1.5 rounded ${msg === '已保存' ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>{msg}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {fields.map(f => (
          <div key={f.name}>
            <label className="block text-[11px] font-semibold text-gray-500 mb-0.5">{f.label}</label>
            {f.desc && <span className="block text-[10px] text-gray-400 mb-1.5 leading-tight">{f.desc}</span>}
            {f.type === 'toggle' ? (
              <input type="checkbox" name={f.name} defaultChecked={g(f.key, f.defaultValue || '') === 'true'} className="appearance-none relative w-10 h-5 bg-gray-200 rounded-full checked:bg-indigo-500 cursor-pointer transition-colors before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:w-4 before:h-4 before:bg-white before:rounded-full before:shadow before:transition-transform checked:before:translate-x-5" />
            ) : f.type === 'select' ? (
              <select name={f.name} defaultValue={g(f.key, f.defaultValue || '')} className="w-full h-9 px-2.5 text-xs rounded-lg border border-gray-200 focus:border-indigo-400 outline-none bg-white">
                {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input type={f.type} name={f.name} defaultValue={f.display ? f.display(g(f.key, f.defaultValue || '')) : g(f.key, f.defaultValue || '')} min={f.min} max={f.max} step={f.step} placeholder={f.placeholder} className="w-full h-9 px-2.5 text-xs rounded-lg border border-gray-200 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200 outline-none" />
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-end pt-2 border-t border-gray-100">
        <button type="submit" disabled={saving} className="btn btn-sm">{saving ? <RotateCw size={14} className="animate-spin mr-1" /> : <Save size={14} className="mr-1" />}保存</button>
      </div>
    </form>
  );
}
