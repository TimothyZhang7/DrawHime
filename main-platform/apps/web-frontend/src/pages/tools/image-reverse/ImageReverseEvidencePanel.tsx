/** 本文件提供图片反推证据保存开关和可筛选审计面板，结果完全来自后端持久化任务。 */
import { CheckCircle2, Clipboard, Database, Eye, Filter, Info, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ImageReverseAnalysisMode, ImageReverseAnalysisView, ImageReverseEvidenceCategory } from '@aiimage/shared-contracts';
import './ImageReverseEvidencePanel.css';

const CATEGORY_LABELS: Record<ImageReverseEvidenceCategory, string> = {
  subject: '主体',
  character: '角色',
  outfit: '服装',
  action: '动作',
  expression: '表情',
  composition: '构图',
  style: '画风',
  lighting: '光影',
  background: '背景',
  detail: '细节',
  quality: '质量',
  negative: '避免项',
};

/** 提交前的证据保存开关；关闭只隐藏逐条证据，阶段和 Provider 状态仍会保存。 */
export function ImageReverseEvidenceOption({ checked, onChange, analysisMode, hybridAvailable, hybridApplicable, onAnalysisModeChange }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  analysisMode: ImageReverseAnalysisMode;
  hybridAvailable: boolean;
  hybridApplicable: boolean;
  onAnalysisModeChange: (mode: ImageReverseAnalysisMode) => void;
}) {
  return (
    <div className="reverse-evidence-options">
      {hybridApplicable && (
        <div className="reverse-analysis-mode">
          <span><strong>证据管线</strong><small>混合模式并行使用视觉模型与 WD14 标签器。</small></span>
          <div role="group" aria-label="证据管线">
            <button type="button" className={analysisMode === 'vision-only' ? 'is-active' : ''} onClick={() => onAnalysisModeChange('vision-only')}>视觉</button>
            <button type="button" disabled={!hybridAvailable} className={analysisMode === 'hybrid' ? 'is-active' : ''} onClick={() => onAnalysisModeChange('hybrid')}>{hybridAvailable ? '视觉 + WD14' : 'WD14 未配置'}</button>
          </div>
        </div>
      )}
      <label className="reverse-evidence-option">
        <span className="reverse-evidence-option-icon"><Database size={15} /></span>
        <span className="reverse-evidence-option-copy">
          <strong>保存分析证据</strong>
          <small>记录分类、来源与处理阶段，刷新后仍可核对；不会额外调用模型。</small>
        </span>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="reverse-evidence-switch" aria-hidden="true" />
      </label>
    </div>
  );
}

/** 展示任务持久化的 Provider、阶段、兼容降级和逐条视觉证据。 */
export function ImageReverseEvidencePanel({ analysis, copied, onCopy }: {
  analysis?: ImageReverseAnalysisView;
  copied: string;
  onCopy: (kind: string, text: string) => Promise<void>;
}) {
  const [category, setCategory] = useState<ImageReverseEvidenceCategory | 'all'>('all');
  const categories = useMemo(() => analysis ? [...new Set(analysis.evidence.map((item) => item.category))] : [], [analysis]);
  const evidence = useMemo(() => analysis?.evidence.filter((item) => category === 'all' || item.category === category) ?? [], [analysis, category]);
  if (!analysis) return null;
  const successfulProviders = analysis.providers.filter((item) => item.status === 'succeeded').length;
  const sourceSummary = analysis.sourceSummary ?? [];
  const totalEvidence = sourceSummary.length > 0 ? sourceSummary.reduce((total, item) => total + item.count, 0) : analysis.evidence.length;
  const conflicts = analysis.conflicts ?? [];

  return (
    <details className="reverse-evidence-panel">
      <summary>
        <span className="reverse-evidence-summary-icon"><Eye size={16} /></span>
        <span>
          <strong>分析证据</strong>
          <small>{analysis.pipeline === 'hybrid' ? '混合证据' : '视觉证据'} · {totalEvidence} 条 · {successfulProviders} 个 Provider</small>
        </span>
        <em>{analysis.structuredOutputMode === 'json-schema' ? '严格结构' : '兼容结构'}</em>
      </summary>

      <div className="reverse-evidence-body">
        <div className="reverse-evidence-runtime">
          {analysis.providers.map((provider) => (
            <div key={provider.provider} className={`is-${provider.status}`}>
              {provider.status === 'succeeded' ? <CheckCircle2 size={14} /> : <Info size={14} />}
              <span><strong>{provider.label}</strong><small>{provider.model ?? provider.message ?? '未配置'}</small></span>
              {provider.durationMs !== undefined && <em>{(provider.durationMs / 1000).toFixed(1)}s</em>}
            </div>
          ))}
        </div>

        <div className="reverse-evidence-stages" aria-label="分析阶段">
          {analysis.stages.map((stage) => (
            <span key={stage.id} className={`is-${stage.status}`} title={stage.message ?? stage.label}>
              {stage.label}{stage.durationMs !== undefined ? ` ${stage.durationMs}ms` : ''}
            </span>
          ))}
        </div>

        {sourceSummary.length > 0 && (
          <div className="reverse-evidence-sources" aria-label="证据来源摘要">
            {sourceSummary.map((item) => (
              <div key={item.source}>
                <span>{item.label}</span>
                <strong>{item.count}</strong>
                <small>{item.confidenceCount > 0 ? `${item.confidenceCount} 条有原生分数` : '无统计分数'}</small>
              </div>
            ))}
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="reverse-evidence-conflicts">
            <strong><TriangleAlert size={13} />证据冲突 {conflicts.length}</strong>
            {conflicts.map((conflict) => (
              <article key={conflict.id}>
                <h4>{conflict.label}</h4>
                <div>{conflict.values.map((value, index) => <span key={`${conflict.id}-${value.label}-${index}`}>{value.label} · {formatEvidenceSource(value.source)}{value.confidence !== undefined ? ` ${Math.round(value.confidence * 100)}%` : ''}</span>)}</div>
                <p>{conflict.resolution}</p>
              </article>
            ))}
          </div>
        )}

        {analysis.warnings.length > 0 && (
          <div className="reverse-evidence-warnings">
            {analysis.warnings.map((warning) => <p key={warning}><TriangleAlert size={13} />{warning}</p>)}
          </div>
        )}

        {analysis.evidence.length > 0 ? (
          <>
            <div className="reverse-evidence-toolbar">
              <div><Filter size={13} /><strong>证据筛选</strong></div>
              <button type="button" onClick={() => void onCopy('evidence-json', JSON.stringify(analysis, null, 2))}>
                <Clipboard size={13} />{copied === 'evidence-json' ? '已复制' : '复制 JSON'}
              </button>
            </div>
            <div className="reverse-evidence-filters">
              <button type="button" className={category === 'all' ? 'is-active' : ''} onClick={() => setCategory('all')}>全部 {analysis.evidence.length}</button>
              {categories.map((item) => {
                const count = analysis.evidence.filter((evidenceItem) => evidenceItem.category === item).length;
                return <button type="button" key={item} className={category === item ? 'is-active' : ''} onClick={() => setCategory(item)}>{CATEGORY_LABELS[item]} {count}</button>;
              })}
            </div>
            <div className="reverse-evidence-list">
              {evidence.map((item) => (
                <article key={item.id}>
                  <span>{CATEGORY_LABELS[item.category]}</span>
                  <p>{item.text}</p>
                  <div><em>{formatEvidenceSource(item.source)}</em>{item.confidence !== undefined && <strong>{Math.round(item.confidence * 100)}%</strong>}{item.language && <small>{item.language}</small>}</div>
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="reverse-evidence-empty">本任务关闭了逐条证据保存；Provider 和阶段状态仍已持久化。</div>
        )}
      </div>
    </details>
  );
}

/** 将共享证据来源转换为稳定中文标签。 */
function formatEvidenceSource(source: ImageReverseAnalysisView['evidence'][number]['source']): string {
  if (source === 'vision') return '视觉模型';
  if (source === 'wd14') return 'WD14';
  if (source === 'metadata') return '可信元数据';
  if (source === 'user') return '用户要求';
  return '确定性派生';
}
