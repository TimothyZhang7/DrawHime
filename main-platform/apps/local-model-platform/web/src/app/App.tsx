/** 本文件提供独立本地模型平台用户端首页。 */
import { useEffect, useMemo, useState } from 'react';
import { LOCAL_MODEL_REGISTRY_SEED, createLocalModelPlatformTitle, type LocalModelRegistrySeed } from '../shared-models.js';
import type { OverviewResponse } from './types.js';

/** 用户端首页，展示 backend 注册清单和真实存储状态。 */
export function App() {
  const [models, setModels] = useState<readonly LocalModelRegistrySeed[]>(LOCAL_MODEL_REGISTRY_SEED);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [storage, setStorage] = useState<OverviewResponse['data']['storage']>({
    rootDir: '',
    visibleFiles: [],
    directories: [],
    directoryMappings: [],
  });
  const [config, setConfig] = useState<OverviewResponse['data']['config'] | null>(null);
  const [summary, setSummary] = useState({ hosts: 0, providers: 0, models: 0, versions: 0, assets: 0 });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/local-model-platform/overview', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<OverviewResponse>;
      })
      .then((payload) => {
        if (!payload.ok) return;
        setConfig(payload.data.config);
        setStorage(payload.data.storage);
        setSummary({
          hosts: payload.data.hosts.length,
          providers: payload.data.providers.length,
          models: payload.data.models.length,
          versions: payload.data.versions.length,
          assets: payload.data.assets.length,
        });
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
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const enabledModels = useMemo(() => models.filter((item) => item.modelKey), [models]);

  return (
    <main style={pageStyle}>
      <header style={heroStyle}>
        <div>
          <div style={eyebrowStyle}>LOCAL MODEL PLATFORM</div>
          <h1 style={titleStyle}>{createLocalModelPlatformTitle()}</h1>
          <p style={leadStyle}>直接读取 backend 的真实扫描结果、注册清单与配置状态，不下载模型，不伪造资产。</p>
        </div>
        <div style={heroMetaStyle}>
          <Meta label="配置来源" value={config?.source || 'unknown'} />
          <Meta label="根目录" value={config?.modelRootDir || '未配置'} />
          <Meta label="状态" value={loading ? '加载中' : error ? '异常' : '正常'} />
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
        <Panel title="模型注册" subtitle="首批模型文件名与用途">
          <div style={listStyle}>
            {enabledModels.map((item) => (
              <Row key={item.modelKey} title={item.displayName} meta={`${item.modelKey} · ${item.usage} · ${item.precision}`} tags={item.tags} note={item.notes} />
            ))}
          </div>
        </Panel>

        <Panel title="目录状态" subtitle="按 backend 当前配置扫描">
          <div style={dirGridStyle}>
            {storage.directories.map((item) => (
              <div key={item.name} style={dirCardStyle}>
                <div style={dirTitleStyle}>{item.name}</div>
                <div style={dirMetaStyle}>{item.exists ? '存在' : '不存在'} · {item.fileCount} 个文件</div>
              </div>
            ))}
          </div>
          <div style={fieldStyle}>
            <span style={fieldLabelStyle}>扫描根目录</span>
            <code style={codeStyle}>{storage.rootDir || '未配置'}</code>
          </div>
          <div style={fieldStyle}>
            <span style={fieldLabelStyle}>可见文件</span>
            <div style={monoListStyle}>
              {storage.visibleFiles.length > 0 ? storage.visibleFiles.join('、') : '当前目录下没有可见文件'}
            </div>
          </div>
          <div style={fieldStyle}>
            <span style={fieldLabelStyle}>目录映射</span>
            <div style={monoListStyle}>
              {storage.directoryMappings.map((item) => `${item.name}:${item.relativeDir}`).join(' · ')}
            </div>
          </div>
        </Panel>
      </section>
    </main>
  );
}

/** 卡片标题区。 */
function Panel(props: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section style={panelStyle}>
      <div style={panelHeaderStyle}>
        <div>
          <div style={panelTitleStyle}>{props.title}</div>
          <div style={panelSubtitleStyle}>{props.subtitle}</div>
        </div>
      </div>
      {props.children}
    </section>
  );
}

/** 统计块。 */
function Stat(props: { label: string; value: number }) {
  return (
    <div style={statStyle}>
      <div style={statLabelStyle}>{props.label}</div>
      <div style={statValueStyle}>{props.value}</div>
    </div>
  );
}

/** 细项信息。 */
function Meta(props: { label: string; value: string }) {
  return (
    <div style={metaStyle}>
      <div style={metaLabelStyle}>{props.label}</div>
      <div style={metaValueStyle}>{props.value}</div>
    </div>
  );
}

/** 模型行。 */
function Row(props: { title: string; meta: string; tags: readonly string[]; note: string }) {
  return (
    <article style={rowStyle}>
      <div style={rowHeadStyle}>
        <div>
          <div style={rowTitleStyle}>{props.title}</div>
          <div style={rowMetaStyle}>{props.meta}</div>
        </div>
      </div>
      <div style={tagWrapStyle}>
        {props.tags.map((tag) => (
          <span key={tag} style={tagStyle}>
            {tag}
          </span>
        ))}
      </div>
      <div style={rowNoteStyle}>{props.note}</div>
    </article>
  );
}

/** 页面样式。 */
const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  padding: '28px 24px 40px',
  background: 'linear-gradient(180deg, #f6f7fb 0%, #eef1f6 100%)',
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
  fontSize: 36,
  lineHeight: 1.1,
  fontWeight: 800,
};

/** 说明文字。 */
const leadStyle: React.CSSProperties = {
  margin: 0,
  maxWidth: 760,
  fontSize: 15,
  lineHeight: 1.7,
  color: '#475467',
};

/** 顶部元信息。 */
const heroMetaStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 12,
  minWidth: 420,
};

/** 顶部区块。 */
const heroStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 20,
  alignItems: 'end',
  marginBottom: 20,
};

/** 元信息样式。 */
const metaStyle: React.CSSProperties = {
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  padding: '12px 14px',
  background: '#fff',
  minWidth: 0,
};

/** 元信息标签。 */
const metaLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#667085',
  marginBottom: 4,
};

/** 元信息值。 */
const metaValueStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#101828',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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

/** 内容区。 */
const contentGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.35fr 0.95fr',
  gap: 16,
  alignItems: 'start',
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

/** 目录卡片网格。 */
const dirGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
  marginBottom: 12,
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

/** 代码样式。 */
const codeStyle: React.CSSProperties = {
  display: 'block',
  padding: 12,
  borderRadius: 8,
  background: '#f2f4f7',
  border: '1px solid #eaecf0',
  fontSize: 12,
  overflowX: 'auto',
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
