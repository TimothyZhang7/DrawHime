/** 本文件兼容展示短期版本产生的单项反推本地结果。 */
import { Clipboard } from 'lucide-react';
import type {
  ImageReverseDescriptionResultView,
  ImageReverseFocus,
  ImageReverseFocusedLanguageResultView,
  ImageReverseLanguage,
} from '@aiimage/shared-contracts';
import './ImageReverseFocus.css';

/** 旧单项结果的视觉范围名称。 */
export const IMAGE_REVERSE_FOCUS_OPTIONS: Array<{
  value: Exclude<ImageReverseFocus, 'all'>;
  label: string;
}> = [
  { value: 'overall', label: '整体' },
  { value: 'subject', label: '主体' },
  { value: 'character', label: '角色' },
  { value: 'pose', label: '姿势' },
  { value: 'outfit', label: '服装' },
  { value: 'composition', label: '构图' },
  { value: 'style', label: '风格' },
  { value: 'lighting', label: '光影' },
  { value: 'background', label: '背景' },
];

/** 单项结果面板；只渲染 focused 契约，不读取综合描述字段。 */
export function ImageReverseFocusedResult({ result, language, copied, onCopy, onLanguageChange }: {
  result: ImageReverseDescriptionResultView;
  language: ImageReverseLanguage;
  copied: string;
  onCopy: (kind: string, text: string) => Promise<void>;
  onLanguageChange: (language: ImageReverseLanguage) => void;
}) {
  const active = resolveFocusedResult(result, language);
  if (!active) return <div className="reverse-language-empty">单项结果结构不完整，请重新提取。</div>;
  const label = IMAGE_REVERSE_FOCUS_OPTIONS.find((item) => item.value === active.focus)?.label ?? '单项';
  const fullText = [active.summary, ...active.observations, active.promptFragment].filter(Boolean).join('\n');
  return (
    <div className="reverse-focused-result">
      <div className="reverse-focused-toolbar">
        <div className="reverse-language-tabs" role="tablist" aria-label="单项结果语言">
          <button type="button" className={language === 'zh' ? 'is-active' : ''} onClick={() => onLanguageChange('zh')}>中文</button>
          <button type="button" className={language === 'en' ? 'is-active' : ''} onClick={() => onLanguageChange('en')}>English</button>
        </div>
        <button type="button" className="reverse-focused-copy" onClick={() => void onCopy('focused-all', fullText)}>
          <Clipboard size={14} />{copied === 'focused-all' ? '已复制' : '复制全部'}
        </button>
      </div>
      <article className="reverse-focused-summary">
        <span>{label}摘要</span>
        <p>{active.summary}</p>
      </article>
      <article className="reverse-focused-observations">
        <div><strong>可见事实</strong><span>{active.observations.length}</span></div>
        <ol>{active.observations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol>
      </article>
      <article className="reverse-focused-prompt">
        <div>
          <strong>{label}提示词片段</strong>
          <button type="button" onClick={() => void onCopy('focused-prompt', active.promptFragment)}><Clipboard size={13} />{copied === 'focused-prompt' ? '已复制' : '复制'}</button>
        </div>
        <p>{active.promptFragment}</p>
      </article>
    </div>
  );
}

function resolveFocusedResult(result: ImageReverseDescriptionResultView, language: ImageReverseLanguage): ImageReverseFocusedLanguageResultView | undefined {
  return result.focusedLocalized?.[language]
    ?? result.focusedLocalized?.[language === 'zh' ? 'zh-CN' : 'en-US']
    ?? result.focused;
}
