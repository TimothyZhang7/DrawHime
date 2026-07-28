/** 本文件提供独立本地模型平台管理端首页。 */
import { useEffect, useMemo, useState } from 'react';
import { LOCAL_MODEL_REGISTRY_SEED, createLocalModelPlatformTitle, type LocalModelRegistrySeed, type LocalModelStorageDirectoryMappingView } from '../shared-models.js';
import type { ConfigResponse, OverviewResponse } from './types.js';

/** 管理端首页，展示 backend 概览并支持配置编辑。 */
export function App() {
  const [models, setModels] = useState<readonly LocalModelRegistrySeed[]>(LOCAL_MODEL_REGISTRY_SEED);
  const [summary, setSummary] = useState({ hosts: 0, providers: 0, models: 0, versions: 0, assets: 0 });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [storage, setStorage] = useState<OverviewResponse['data']['storage']>({
    rootDir: '',
    directoryMappings: [],
    visibleFiles: [],
    directories: [],
  });
  const [config, setConfig] = useState<OverviewResponse['data']['config'] | null>(null);
  const [draftRootDir, setDraftRootDir] = useState('');
  const [draftMappings, setDraftMappings] = useState<LocalModelStorageDirectoryMappingView[]>([]);

  useEffect(() => {
    void loadOverview();
  }, []);

  const dirty = useMemo(() => {
    if (!config) return false;
    return draftRootDir !== config.modelRootDir || JSON.stringify(draftMappings) !== JSON.stringify(config.directoryMappings);
  }, [config, draftMappings, draftRootDir]);

  const loadOverview = async () => {
    setReloading(true);
    setError(null);
    try {
      const response = await fetch('/api/local-model-platform/overview');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as OverviewResponse;
      if (!payload.ok) return;
      setConfig(payload.data.config);
      setDraftRootDir(payload.data.config.modelRootDir);
      setDraftMappings(payload.data.config.directoryMappings.map((item) => ({ ...item })));
      setSummary({
        hosts: payload.data.hosts.length,
        providers: payload.data.providers.length,
        models: payload.data.models.length,
        versions: payload.data.versions.length,
        assets: payload.data.assets.length,
      });
      setStorage(payload.data.storage);
      setModels(payload.data.models.map((item) => ({
        modelKey: item.modelKey,
        displayName: item.displayName,
        usage: item.usage,
        source: item.source,
        precision: item.precision,
        defaultWidth: item.defaultWidth,
        defaultHeight: item.defaultHeight,
        defaultSteps: item.defaultSteps,
        defaultCfg: item.defaultCfg,
        vramRecommendedGb: item.vramRecommendedGb,
        tags: [...item.capabilities],
        notes: item.notes ?? '',
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setReloading(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/local-model-platform/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelRootDir: draftRootDir.trim(),
          directoryMappings: draftMappings,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as ConfigResponse;
      if (payload.ok) {
        setConfig(payload.data.config);
        setDraftRootDir(payload.data.config.modelRootDir);
        setDraftMappings(payload.data.config.directoryMappings.map((item) => ({ ...item })));
        await loadOverview();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main style={pageStyle}>
      <header style={heroStyle}>
        <div>
          <div style={eyebrowStyle}>LOCAL MODEL PLATFORM / ADMIN</div>
          <h1 style={titleStyle}>{createLocalModelPlatformTitle()} 管理端</h1>
          <p style={leadStyle}>读取真实概览，编辑扫描根目录与目录映射，保存到本地私有配置文件。</p>
        </div>
        <div style={heroActionsStyle}>
          <button onClick={loadOverview} style={buttonStyle} type="button" disabled={reloading}>
            {reloading ? '刷新中...' : '刷新概览'}
          </button>
          <button onClick={saveConfig} style={buttonPrimaryStyle} type="button" disabled={!dirty || saving}>
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </header>

      {error && <section style={alertStyle}>{error}</section>}

      <section style={statsGridStyle}>
        <Stat label="主机" value={summary.hosts} />
        <Stat label="Provider" value={summary.providers} />
        <Stat label="模型" value={summary.models} />
        <Stat label="版本" value={summary.versions} />
        <Stat label="资产" value={summary.assets} />
      </section>

      <section style={contentGridStyle}>
        <Panel title="配置" subtitle="保存到 local/private/local-model-platform-config.json">
          <label style={fieldStyle}>
            <span style={fieldLabelStyle}>扫描根目录</span>
            <input value={draftRootDir} onChange={(e) => setDraftRootDir(e.target.value)} style={inputStyle} />
          </label>

          <div style={{ marginTop: 16 }}>
            <div style={sectionLabelStyle}>目录映射</div>
            <div style={mappingListStyle}>
              {draftMappings.map((item, index) => (
                <div key={`${item.name}-${index}`} style={mappingRowStyle}>
                  <input value={item.name} onChange={(e) => updateMapping(index, { name: e.target.value })} style={inputStyle} />
                  <input value={item.relativeDir} onChange={(e) => updateMapping(index, { relativeDir: e.target.value })} style={inputStyle} />
                  <select value={item.usage} onChange={(e) => updateMapping(index, { usage: e.target.value as LocalModelStorageDirectoryMappingView['usage'] })} style={inputStyle}>
                    <option value="generation">generation</option>
                    <option value="caption">caption</option>
                    <option value="vae">vae</option>
                  </select>
                  <label style={checkLabelStyle}>
                    <input type="checkbox" checked={item.enabled} onChange={(e) => updateMapping(index, { enabled: e.target.checked })} />
                    启用
                  </label>
                  <button type="button" onClick={() => removeMapping(index)} style={ghostButtonStyle}>
                    删除
                  </button>
                </div>
              ))}
            </div>
            <div style={toolbarStyle}>
              <button type="button" onClick={() => setDraftMappings((prev) => [...prev, createEmptyMapping(prev.length)])} style={buttonStyle}>
                新增目录
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="存储状态" subtitle="按真实目录扫描返回">
          <div style={fieldStyle}>
            <span style={fieldLabelStyle}>扫描根目录</span>
            <code style={codeStyle}>{storage.rootDir || '未配置'}</code>
          </div>
          <div style={fieldStyle}>
            <span style={fieldLabelStyle}>目录状态</span>
            <div style={dirGridStyle}>
              {storage.directories.map((item) => (
                <div key={item.name} style={dirCardStyle}>
                  <div style={dirTitleStyle}>{item.name}</div>
                  <div style={dirMetaStyle}>{item.exists ? '存在' : '不存在'} · {item.fileCount} 个文件</div>
                </div>
              ))}
            </div>
          </div>
          <div style={fieldStyle}>
            <span style={fieldLabelStyle}>可见文件</span>
            <div style={monoListStyle}>
              {storage.visibleFiles.length > 0 ? storage.visibleFiles.join('、') : '当前目录下没有可见文件'}
            </div>
          </div>
        </Panel>
      </section>

      <section style={bottomGridStyle}>
        <Panel title="注册模型" subtitle="真实模型注册清单">
          <div style={listStyle}>
            {models.map((item) => (
              <article key={item.modelKey} style={rowStyle}>
                <div style={rowHeadStyle}>
                  <div>
                    <div style={rowTitleStyle}>{item.displayName}</div>
                    <div style={rowMetaStyle}>{item.modelKey} · {item.usage} · {item.precision}</div>
                  </div>
                </div>
                <div style={tagWrapStyle}>
                  {item.tags.map((tag) => (
                    <span key={tag} style={tagStyle}>
                      {tag}
                    </span>
                  ))}
                </div>
                <div style={rowNoteStyle}>{item.notes}</div>
              </article>
            ))}
          </div>
        </Panel>

        <Panel title="配置摘要" subtitle="当前生效状态">
          <div style={summaryListStyle}>
            <SummaryItem label="来源" value={config?.source || 'unknown'} />
            <SummaryItem label="配置文件" value={config?.configFilePath || '-'} />
            <SummaryItem label="当前根目录" value={config?.modelRootDir || '-'} />
            <SummaryItem label="目录映射" value={`${draftMappings.length} 项`} />
            <SummaryItem label="保存状态" value={dirty ? '未保存' : '已同步'} />
          </div>
        </Panel>
      </section>
    </main>
  );

  /** 更新目录映射。 */
  function updateMapping(index: number, patch: Partial<LocalModelStorageDirectoryMappingView>) {
    setDraftMappings((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  /** 删除目录映射。 */
  function removeMapping(index: number) {
    setDraftMappings((prev) => prev.filter((_, i) => i !== index));
  }
}

/** 统计卡片。 */
function Stat(props: { label: string; value: number }) {
  return (
    <div style={statStyle}>
      <div style={statLabelStyle}>{props.label}</div>
      <div style={statValueStyle}>{props.value}</div>
    </div>
  );
}

/** 面板。 */
function Panel(props: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section style={panelStyle}>
      <div style={panelHeaderStyle}>
        <div style={panelTitleStyle}>{props.title}</div>
        <div style={panelSubtitleStyle}>{props.subtitle}</div>
      </div>
      {props.children}
    </section>
  );
}

/** 摘要项。 */
function SummaryItem(props: { label: string; value: string }) {
  return (
    <div style={summaryItemStyle}>
      <div style={summaryLabelStyle}>{props.label}</div>
      <div style={summaryValueStyle}>{props.value}</div>
    </div>
  );
}

/** 生成空目录映射。 */
function createEmptyMapping(index: number): LocalModelStorageDirectoryMappingView {
  return {
    name: `custom_${index + 1}`,
    relativeDir: `models/custom_${index + 1}`,
    usage: 'generation',
    enabled: true,
  };
}

/** 页面样式。 */
const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  padding: '28px 24px 40px',
  background: 'linear-gradient(180deg, #f7f8fc 0%, #eef2f8 100%)',
  color: '#101828',
  fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
};

/** 英文眉头。 */
const eyebrowStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: 0.4,
  color: '#667085',
  fontWeight: 700,
};

/** 标题。 */
const titleStyle: React.CSSProperties = {
  margin: '8px 0 10px',
  fontSize: 34,
  lineHeight: 1.1,
  fontWeight: 800,
};

/** 说明。 */
const leadStyle: React.CSSProperties = {
  margin: 0,
  maxWidth: 780,
  fontSize: 15,
  lineHeight: 1.7,
  color: '#475467',
};

/** 顶部操作区。 */
const heroActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
};

/** 顶部。 */
const heroStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 20,
  alignItems: 'end',
  marginBottom: 20,
};

/** 错误提示。 */
const alertStyle: React.CSSProperties = {
  border: '1px solid #f2b8b5',
  background: '#fff1f0',
  color: '#b42318',
  borderRadius: 8,
  padding: 12,
  marginBottom: 16,
};

/** 统计网格。 */
const statsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
  gap: 12,
  marginBottom: 20,
};

/** 统计卡片。 */
const statStyle: React.CSSProperties = {
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  background: '#fff',
  padding: '14px 16px',
};

/** 统计标签。 */
const statLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
  marginBottom: 8,
};

/** 统计值。 */
const statValueStyle: React.CSSProperties = {
  fontSize: 26,
  lineHeight: 1,
  fontWeight: 800,
};

/** 双栏。 */
const contentGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.15fr 0.85fr',
  gap: 16,
  alignItems: 'start',
};

/** 底部双栏。 */
const bottomGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.1fr 0.9fr',
  gap: 16,
  alignItems: 'start',
  marginTop: 16,
};

/** 面板。 */
const panelStyle: React.CSSProperties = {
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  background: '#fff',
  padding: 16,
};

/** 面板头。 */
const panelHeaderStyle: React.CSSProperties = {
  marginBottom: 12,
};

/** 面板标题。 */
const panelTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
};

/** 面板副标题。 */
const panelSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
  marginTop: 4,
};

/** 字段。 */
const fieldStyle: React.CSSProperties = {
  marginTop: 12,
};

/** 字段标签。 */
const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#667085',
  marginBottom: 6,
};

/** 输入。 */
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #d0d5dd',
  boxSizing: 'border-box',
  background: '#fff',
  color: '#101828',
};

/** 映射列表。 */
const mappingListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

/** 映射行。 */
const mappingRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1.6fr 0.8fr 110px 72px',
  gap: 8,
  alignItems: 'center',
};

/** 复选标签。 */
const checkLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  color: '#344054',
};

/** 目录区标题。 */
const sectionLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#475467',
  marginBottom: 8,
};

/** 工具条。 */
const toolbarStyle: React.CSSProperties = {
  marginTop: 12,
  display: 'flex',
  gap: 8,
};

/** 按钮。 */
const buttonStyle: React.CSSProperties = {
  padding: '10px 14px',
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  background: '#fff',
  color: '#101828',
  cursor: 'pointer',
};

/** 主要按钮。 */
const buttonPrimaryStyle: React.CSSProperties = {
  ...buttonStyle,
  background: '#111827',
  borderColor: '#111827',
  color: '#fff',
};

/** 次要按钮。 */
const ghostButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  padding: '10px 10px',
};

/** 代码块。 */
const codeStyle: React.CSSProperties = {
  display: 'block',
  padding: 12,
  borderRadius: 8,
  background: '#f2f4f7',
  border: '1px solid #eaecf0',
  fontSize: 12,
  overflowX: 'auto',
};

/** 目录卡片网格。 */
const dirGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
};

/** 目录卡片。 */
const dirCardStyle: React.CSSProperties = {
  border: '1px solid #eaecf0',
  borderRadius: 8,
  padding: 12,
  background: '#fcfcfd',
};

/** 目录标题。 */
const dirTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  marginBottom: 4,
};

/** 目录元信息。 */
const dirMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
};

/** 等宽文本块。 */
const monoListStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 8,
  background: '#f9fafb',
  border: '1px solid #eaecf0',
  fontSize: 12,
  lineHeight: 1.6,
  color: '#344054',
};

/** 列表。 */
const listStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

/** 行卡。 */
const rowStyle: React.CSSProperties = {
  border: '1px solid #eaecf0',
  borderRadius: 8,
  padding: 12,
  background: '#fcfcfd',
};

/** 行头。 */
const rowHeadStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
};

/** 行标题。 */
const rowTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  marginBottom: 2,
};

/** 行元信息。 */
const rowMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
};

/** 标签容器。 */
const tagWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 10,
};

/** 标签。 */
const tagStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 8px',
  borderRadius: 999,
  background: '#eef4ff',
  color: '#3538cd',
  fontSize: 12,
  fontWeight: 600,
};

/** 行备注。 */
const rowNoteStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 12,
  lineHeight: 1.6,
  color: '#475467',
};

/** 摘要区。 */
const summaryListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 10,
};

/** 摘要项。 */
const summaryItemStyle: React.CSSProperties = {
  border: '1px solid #eaecf0',
  borderRadius: 8,
  padding: 12,
  background: '#fcfcfd',
};

/** 摘要标签。 */
const summaryLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
  marginBottom: 4,
};

/** 摘要值。 */
const summaryValueStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#101828',
  lineHeight: 1.6,
  wordBreak: 'break-all',
};
