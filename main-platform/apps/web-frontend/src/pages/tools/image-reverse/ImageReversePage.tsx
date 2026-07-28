/** 本页面实现图片反推工具：用户先选择描述或标签模式，再上传单张图片调用后端真实识图链路。 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowLeft, Clipboard, FileImage, History, Loader2, ScanSearch, Send, Upload, X } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  ImageReverseDescriptionLanguageResultView,
  ImageReverseDescriptionResultView,
  ImageReverseAnalysisMode,
  ImageReverseExtractOptions,
  ImageReverseFocus,
  ImageReverseJobCreateResponse,
  ImageReverseJobDetailResponse,
  ImageReverseJobListResponse,
  ImageReverseJobView,
  ImageReverseLanguage,
  ImageReverseLocalModelTagView,
  ImageReverseMode,
  ImageReversePromptLanguageResultView,
  ImageReverseResultView,
  ImageReverseTagResultView,
} from '@aiimage/shared-contracts';
import { Seo } from '../../../components/Seo';
import { api } from '../../../lib/api';
import { saveGenerationPromptDraft } from '../../generate/generationPromptDraft';
import { useToolsConfig } from '../useToolsConfig';
import { ImageReverseFocusedResult, IMAGE_REVERSE_FOCUS_OPTIONS } from './ImageReverseFocus';
import { ImageReverseEvidenceOption, ImageReverseEvidencePanel } from './ImageReverseEvidencePanel';
import { fetchImageReverseSource } from './imageReverseApi';
import './ImageReversePage.css';

type CopyHandler = (kind: string, text: string) => Promise<void>;

/** 图片反推页面。 */
export function ImageReversePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { loading: configLoading, getToolConfig } = useToolsConfig();
  const toolConfig = getToolConfig('image-reverse');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [language, setLanguage] = useState<ImageReverseLanguage>('zh');
  const [extractMode, setExtractMode] = useState<ImageReverseMode>('description');
  const [promptTarget, setPromptTarget] = useState<ImageReverseExtractOptions['promptTarget']>('general');
  const [tagPreset, setTagPreset] = useState<ImageReverseExtractOptions['tagPreset']>('sdxl');
  const [tagDensity, setTagDensity] = useState<ImageReverseExtractOptions['tagDensity']>('standard');
  const [editIntent, setEditIntent] = useState<ImageReverseExtractOptions['editIntent']>('auto');
  const [includeTagWeights, setIncludeTagWeights] = useState(true);
  const [includeEvidence, setIncludeEvidence] = useState(true);
  const [analysisMode, setAnalysisMode] = useState<ImageReverseAnalysisMode>('vision-only');
  const [result, setResult] = useState<ImageReverseResultView | null>(null);
  const [activeJobId, setActiveJobId] = useState('');
  const latestUrlRef = useRef('');
  const persistentRestoreRef = useRef(false);
  const activeExtractRef = useRef(0);

  const enabled = toolConfig?.enabled === true;
  const maxFileSizeMb = toolConfig?.maxFileSizeMb ?? 20;
  const modelName = toolConfig?.reverseModel ?? 'gpt-5.6-sol';
  const enabledModes = toolConfig?.reverseEnabledModes?.length ? toolConfig.reverseEnabledModes : REVERSE_MODES.map((item) => item.mode);
  const hybridAvailable = toolConfig?.reverseHybridAvailable === true;
  const descriptionResult = result?.mode === 'description' ? result : null;
  const tagResult = result?.mode === 'tags' ? result : null;

  useEffect(() => {
    latestUrlRef.current = previewUrl;
  }, [previewUrl]);

  useEffect(() => {
    // 反推记录已由 backend 持久化；后台清理旧 IndexedDB 大图，避免浏览器继续占用本地空间。
    clearLegacyReverseLocalDatabase();
  }, []);

  useEffect(() => {
    /** 反推页需要固定在视口内展示，避免浏览器整页滚动条出现；只在当前页挂载期间生效。 */
    if (window.matchMedia('(max-width: 860px)').matches) return undefined;
    document.documentElement.classList.add('reverse-page-locked');
    document.body.classList.add('reverse-page-locked');
    return () => {
      document.documentElement.classList.remove('reverse-page-locked');
      document.body.classList.remove('reverse-page-locked');
    };
  }, []);

  useEffect(() => {
    return () => {
      activeExtractRef.current += 1;
      if (latestUrlRef.current) URL.revokeObjectURL(latestUrlRef.current);
    };
  }, []);

  const sourceText = useMemo(() => {
    if (!result) return '';
    return `${result.source.width} × ${result.source.height} · ${formatBytes(result.source.sizeBytes)} · ${result.model}`;
  }, [result]);

  /** 把持久化任务里的提取选项恢复到页面控件。 */
  const applyPersistedOptions = (job: ImageReverseJobView) => {
    setExtractMode(job.mode);
    setLanguage(job.options.language.primaryLanguage ?? 'zh');
    setPromptTarget(job.options.promptTarget ?? 'general');
    setTagPreset(job.options.tagPreset ?? 'sdxl');
    setTagDensity(job.options.tagDensity ?? 'standard');
    setEditIntent(job.options.editIntent ?? 'auto');
    setIncludeTagWeights(job.options.tagWeightMode !== 'none');
    setIncludeEvidence(job.options.includeEvidence !== false);
    setAnalysisMode(job.options.analysisMode ?? 'vision-only');
  };

  /** 鉴权读取 backend 私有轻量预览；完整源图不再阻塞历史结果展示。 */
  const restorePersistedPreview = async (job: ImageReverseJobView, requestId: number): Promise<void> => {
    try {
      const blob = await fetchImageReverseSource(job.previewUrl);
      if (activeExtractRef.current !== requestId) return;
      if (latestUrlRef.current) URL.revokeObjectURL(latestUrlRef.current);
      const url = URL.createObjectURL(blob);
      latestUrlRef.current = url;
      setPreviewUrl(url);
    } catch {
      if (activeExtractRef.current === requestId) setError('任务已恢复，但私有预览读取失败。');
    }
  };

  /** 持续轮询数据库任务；页面刷新只会重新绑定任务，不会重新提交识图。 */
  const pollPersistedJob = async (jobId: string, requestId: number) => {
    while (activeExtractRef.current === requestId) {
      await wait(1800);
      if (activeExtractRef.current !== requestId) return;
      const detail = await api<ImageReverseJobDetailResponse>(`/api/tools/image-reverse/jobs/${encodeURIComponent(jobId)}`);
      if (!detail.ok || !detail.data?.job) {
        setError(detail.message ?? '图片反推任务状态读取失败');
        setBusy(false);
        setProgressText('');
        return;
      }
      const job = detail.data.job;
      setProgressText(`${job.progressText} · ${job.progress}%`);
      if (job.status === 'succeeded' && job.result) {
        setResult(job.result);
        applyPersistedOptions(job);
        setBusy(false);
        setProgressText('');
        return;
      }
      if (job.status === 'failed') {
        setError(job.error ?? '图片反推失败');
        setBusy(false);
        setProgressText('');
        return;
      }
    }
  };

  /** 从数据库恢复指定任务的源图、选项、进度和完整结果。 */
  const restorePersistentJob = async (jobId: string) => {
    const requestId = activeExtractRef.current + 1;
    activeExtractRef.current = requestId;
    const detail = await api<ImageReverseJobDetailResponse>(`/api/tools/image-reverse/jobs/${encodeURIComponent(jobId)}`);
    if (!detail.ok || !detail.data?.job || activeExtractRef.current !== requestId) {
      if (activeExtractRef.current === requestId) setError(detail.message ?? '反推记录读取失败');
      return;
    }
    const job = detail.data.job;
    setActiveJobId(job.id);
    setSearchParams({ job: job.id }, { replace: true });
    applyPersistedOptions(job);
    setResult(job.result ?? null);
    setError(job.status === 'failed' ? (job.error ?? '图片反推失败') : '');
    setBusy(job.status === 'queued' || job.status === 'running');
    setProgressText(job.status === 'queued' || job.status === 'running' ? `${job.progressText} · ${job.progress}%` : '');
    await restorePersistedPreview(job, requestId);
    if ((job.status === 'queued' || job.status === 'running') && activeExtractRef.current === requestId) {
      await pollPersistedJob(job.id, requestId);
    }
  };

  useEffect(() => {
    if (persistentRestoreRef.current) return;
    persistentRestoreRef.current = true;
    const requestedJobId = String(searchParams.get('job') ?? '').trim();
    /** 显式任务直接恢复；普通进入页面只恢复未完成任务，不自动下载最近完成记录。 */
    const restoreLatest = async () => {
      let jobId = requestedJobId;
      if (!jobId) {
        const response = await api<ImageReverseJobListResponse>('/api/tools/image-reverse/jobs');
        if (!response.ok || !response.data?.jobs.length) return;
        const active = response.data.jobs.find((job) => job.status === 'queued' || job.status === 'running');
        jobId = active?.id ?? '';
      }
      if (jobId) await restorePersistentJob(jobId);
    };
    void restoreLatest();
  }, []);

  /** 选择或拖入图片后建立本地预览，不上传到图库、不写业务记录。 */
  const chooseFile = (picked: File | null) => {
    activeExtractRef.current += 1;
    setBusy(false);
    setProgressText('');
    setDragging(false);
    setCopied('');
    setResult(null);
    setError('');
    setActiveJobId('');
    setSearchParams({}, { replace: true });
    if (!picked) return;
    if (!picked.type.startsWith('image/')) {
      setError('请上传图片文件。');
      return;
    }
    if (picked.size > maxFileSizeMb * 1024 * 1024) {
      setError(`图片大小不能超过 ${maxFileSizeMb}MB。`);
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
  };

  /** 提交异步反推任务并短轮询结果，避免模型长响应被浏览器或中间网络提前断开。 */
  const extract = async () => {
    if (!file || busy) return;
    const requestId = activeExtractRef.current + 1;
    activeExtractRef.current = requestId;
    setBusy(true);
    setProgressText('正在上传图片');
    setError('');
    setCopied('');
    setResult(null);
    const requestedMode = extractMode;
    const options = buildReverseOptions({
      mode: requestedMode,
      language,
      promptTarget,
      tagPreset,
      tagDensity,
      includeTagWeights,
      editIntent,
      includeEvidence,
      analysisMode,
    });
    const created = await api<ImageReverseJobCreateResponse>('/api/tools/image-reverse/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'x-aiimage-reverse-mode': requestedMode,
        'x-aiimage-reverse-options': JSON.stringify(options),
        'x-aiimage-file-name': encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!created.ok || !created.data?.job.id) {
      if (activeExtractRef.current === requestId) {
        setError(created.message ?? '图片反推任务提交失败');
        setBusy(false);
        setProgressText('');
      }
      return;
    }
    setActiveJobId(created.data.job.id);
    setSearchParams({ job: created.data.job.id }, { replace: true });
    setProgressText(created.data.job.progressText);
    await pollPersistedJob(created.data.job.id, requestId);
  };

  /** 拖拽进入上传区时阻止浏览器默认打开文件。 */
  const onDragOver = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) setDragging(true);
  };

  /** 拖拽离开上传区时移除高亮。 */
  const onDragLeave = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragging(false);
  };

  /** 拖入图片后复用文件选择逻辑。 */
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const dropped = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/')) ?? null;
    chooseFile(dropped);
  };

  /** 清空当前图片和结果。 */
  const clear = () => {
    activeExtractRef.current += 1;
    setBusy(false);
    setProgressText('');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl('');
    setResult(null);
    setError('');
    setCopied('');
    setActiveJobId('');
    setSearchParams({}, { replace: true });
  };

  /** 切换提取模式会清空旧结果，避免用描述模式结果误当标签模式展示。 */
  const updateExtractMode = (nextMode: ImageReverseMode) => {
    setExtractMode(nextMode);
    setCopied('');
    setResult(null);
  };

  /** 更新结果展示语言。 */
  const updateLanguage = (nextLanguage: ImageReverseLanguage) => {
    setLanguage(nextLanguage);
  };

  /** 更新标签权重开关。 */
  const updateIncludeTagWeights = (nextValue: boolean) => {
    setIncludeTagWeights(nextValue);
  };

  /** 复制文本到剪贴板，失败时给出可见错误。 */
  const copyText = async (kind: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setError('复制失败，请手动选择文本复制。');
    }
  };

  /** 复用当前持久化结果写入一次性绘图草稿；不会重新识图、自动提交或切换用户模型。 */
  const bringAnimaPromptToGeneration = (prompt: string) => {
    try {
      saveGenerationPromptDraft({ prompt, source: 'image-reverse', sourceJobId: activeJobId || undefined, recommendedPromptFormat: 'anima' });
      navigate('/');
    } catch {
      setError('写入绘图草稿失败，请复制 Prompt 后手动粘贴。');
    }
  };

  if (configLoading) {
    return (
      <div className="reverse-shell">
        <Seo title="图片反推" description="绘图姬 DrawHime 图片反推工具。" path="/reverse" />
        <div className="tool-disabled">
          <Loader2 size={18} className="animate-spin" />
          <h1>图片反推</h1>
          <p>正在读取工具配置...</p>
        </div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="reverse-shell">
        <Seo title="图片反推" description="绘图姬 DrawHime 图片反推工具。" path="/reverse" />
        <div className="tool-disabled">
          <h1>图片反推</h1>
          <p>该工具当前未开放。</p>
          <Link to="/tools" className="btn btn-outline btn-sm"><ArrowLeft size={14} />返回工具中心</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="reverse-shell">
      <Seo title="图片反推" description="上传一张图片，用 AI 识图模型提取完整风格、角色特征、构图和可复用绘图提示词。" path="/reverse" />

      <section className="reverse-workbench">
        <div className="reverse-left">
          <header className="reverse-head">
            <div>
              <span><ScanSearch size={15} />图片反推</span>
              <h1>上传图片，提取提示词</h1>
            </div>
            <div className="reverse-head-actions">
              <small>{modelName}</small>
              <Link to="/reverse/history"><History size={14} />记录</Link>
            </div>
          </header>

          <div className="reverse-input-mode">
            <span>提取格式</span>
            <div className="reverse-mode-tabs" role="tablist" aria-label="提取格式">
              {REVERSE_MODES.filter((item) => enabledModes.includes(item.mode)).map((item) => (
                <button key={item.mode} type="button" role="tab" aria-selected={extractMode === item.mode} className={extractMode === item.mode ? 'is-active' : ''} onClick={() => updateExtractMode(item.mode)}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <ReverseModeOptions
            mode={extractMode}
            promptTarget={promptTarget ?? 'general'}
            tagPreset={tagPreset ?? 'sdxl'}
            tagDensity={tagDensity ?? 'standard'}
            editIntent={editIntent ?? 'auto'}
            onPromptTargetChange={setPromptTarget}
            onTagPresetChange={setTagPreset}
            onTagDensityChange={setTagDensity}
            onEditIntentChange={setEditIntent}
          />
          <ImageReverseEvidenceOption
            checked={includeEvidence}
            onChange={setIncludeEvidence}
            analysisMode={analysisMode}
            hybridAvailable={hybridAvailable}
            hybridApplicable={extractMode === 'tags'}
            onAnalysisModeChange={setAnalysisMode}
          />
          <label
            className={`reverse-dropzone${previewUrl ? ' has-image' : ''}${dragging ? ' is-dragging' : ''}`}
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <input type="file" accept="image/*" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
            {previewUrl ? (
              <img src={previewUrl} alt="待反推图片预览" />
            ) : (
              <div>
                <Upload size={24} />
                <strong>{dragging ? '松开导入图片' : '选择或拖入图片'}</strong>
                <small>最大 {maxFileSizeMb}MB，源图仅保存到账号私有反推记录</small>
              </div>
            )}
          </label>

          {file && (
            <div className="reverse-filebar">
              <FileImage size={15} />
              <span>{file.name}</span>
              <strong>{formatBytes(file.size)}</strong>
              <button type="button" onClick={clear} aria-label="清空图片"><X size={15} /></button>
            </div>
          )}
          {activeJobId && !file && previewUrl && <div className="reverse-local-note">已载入私有历史预览 · {activeJobId}</div>}

          {error && <div className="reverse-alert">{error}</div>}

          <button type="button" className="reverse-submit" onClick={() => void extract()} disabled={!file || busy}>
            {busy ? <Loader2 size={17} className="animate-spin" /> : <ScanSearch size={17} />}
            {busy ? '正在提取' : `提取${REVERSE_MODES.find((item) => item.mode === extractMode)?.shortLabel ?? '内容'}`}
          </button>
        </div>

        <section className="reverse-result">
          <div className="reverse-result-head">
            <div>
              <h2>反推结果</h2>
              <span>{sourceText || '等待图片提取'}</span>
            </div>
            {tagResult && (
              <div className="reverse-copy-actions">
                <button type="button" onClick={() => void copyText('tag-all', buildTagFullText(tagResult.tagPrompt, includeTagWeights))}>
                  <Clipboard size={14} />复制完整
                </button>
                <button type="button" onClick={() => void copyText('tag-positive', getTagPromptText(tagResult.tagPrompt, 'positive', includeTagWeights))}>
                  <Clipboard size={14} />复制正向
                </button>
                <button type="button" onClick={() => void copyText('tag-negative', getTagPromptText(tagResult.tagPrompt, 'negative', includeTagWeights))}>
                  <Clipboard size={14} />复制负向
                </button>
              </div>
            )}
          </div>

          {!result ? (
            <div className="reverse-empty">{busy ? `${progressText || '模型正在读取图片内容'}。` : '先选择输出格式，再上传图片点击提取；描述模式会一次返回全部分类。'}</div>
          ) : (
            <div className="reverse-sections">
              <div className="reverse-result-mode-badge">
                <strong>{getResultModeMeta(result).title}</strong>
                <span>{getResultModeMeta(result).description}</span>
                {copied && <em>{getCopiedLabel(copied)}</em>}
              </div>
              <ImageReverseEvidencePanel analysis={result.analysis} copied={copied} onCopy={copyText} />

              {descriptionResult ? (
                descriptionResult.focus && descriptionResult.focus !== 'all' ? (
                  <ImageReverseFocusedResult result={descriptionResult} language={language} copied={copied} onCopy={copyText} onLanguageChange={updateLanguage} />
                ) : (
                  <DescriptionPanel result={descriptionResult} copied={copied} onCopy={copyText} />
                )
              ) : tagResult ? (
                <TagPromptPanel tagPrompt={tagResult.tagPrompt} includeWeights={includeTagWeights} copied={copied} onCopy={copyText} onWeightChange={updateIncludeTagWeights} onBringToGeneration={bringAnimaPromptToGeneration} />
              ) : result?.mode === 'prompt' ? (
                <PromptPanel result={result} copied={copied} onCopy={copyText} />
              ) : result?.mode === 'character' ? (
                <CharacterProfilePanel result={result} language={language} copied={copied} onCopy={copyText} onLanguageChange={updateLanguage} />
              ) : result?.mode === 'edit' ? (
                <EditPromptPanel result={result} language={language} copied={copied} onCopy={copyText} onLanguageChange={updateLanguage} />
              ) : (
                <div className="reverse-language-empty">结果结构不正确，请重新提取。</div>
              )}
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

/** 模式专属配置区，用户先选用途，再微调输出内容。 */
function ReverseModeOptions(props: {
  mode: ImageReverseMode;
  promptTarget: NonNullable<ImageReverseExtractOptions['promptTarget']>;
  tagPreset: NonNullable<ImageReverseExtractOptions['tagPreset']>;
  tagDensity: NonNullable<ImageReverseExtractOptions['tagDensity']>;
  editIntent: NonNullable<ImageReverseExtractOptions['editIntent']>;
  onPromptTargetChange: (value: NonNullable<ImageReverseExtractOptions['promptTarget']>) => void;
  onTagPresetChange: (value: NonNullable<ImageReverseExtractOptions['tagPreset']>) => void;
  onTagDensityChange: (value: NonNullable<ImageReverseExtractOptions['tagDensity']>) => void;
  onEditIntentChange: (value: NonNullable<ImageReverseExtractOptions['editIntent']>) => void;
}) {
  if (props.mode === 'description' || props.mode === 'character') return null;
  return (
    <div className="reverse-option-grid">
      {props.mode === 'prompt' && (
        <label>
          <span>目标模型</span>
          <select value={props.promptTarget} onChange={(event) => props.onPromptTargetChange(event.target.value as NonNullable<ImageReverseExtractOptions['promptTarget']>)}>
            <option value="general">通用</option>
            <option value="gpt-image">GPT Image</option>
            <option value="gemini-image">Gemini Image</option>
            <option value="sdxl">SDXL</option>
          </select>
        </label>
      )}
      {props.mode === 'tags' && (
        <>
          <label>
            <span>标签格式</span>
            <select value={props.tagPreset} onChange={(event) => props.onTagPresetChange(event.target.value as NonNullable<ImageReverseExtractOptions['tagPreset']>)}>
              <option value="sdxl">SDXL</option>
              <option value="nai">NAI</option>
              <option value="sd15">SD 1.5</option>
              <option value="comfyui">ComfyUI</option>
              <option value="anima">Anima</option>
            </select>
          </label>
          <label>
            <span>标签密度</span>
            <select value={props.tagDensity} onChange={(event) => props.onTagDensityChange(event.target.value as NonNullable<ImageReverseExtractOptions['tagDensity']>)}>
              <option value="compact">少量</option>
              <option value="standard">标准</option>
              <option value="rich">尽可能多</option>
            </select>
          </label>
        </>
      )}
      {props.mode === 'edit' && (
        <label>
          <span>编辑用途</span>
          <select value={props.editIntent} onChange={(event) => props.onEditIntentChange(event.target.value as NonNullable<ImageReverseExtractOptions['editIntent']>)}>
            <option value="auto">自动判断</option>
            <option value="character-replace">角色替换</option>
            <option value="style-transfer">风格迁移</option>
            <option value="outfit-replace">服装替换</option>
            <option value="background-replace">背景替换</option>
            <option value="composition-redraw">保持构图重绘</option>
            <option value="multi-reference">多参考图关系</option>
          </select>
        </label>
      )}
    </div>
  );
}

/** 描述模式结果面板；固定展示中英双栏，便于核对原图事实和绘图提示词。 */
function DescriptionPanel({ result, copied, onCopy }: { result: ImageReverseDescriptionResultView; copied: string; onCopy: CopyHandler }) {
  const [activeTab, setActiveTab] = useState<'description' | 'prompt'>('description');
  const localizedZh = result.localized.zh ?? result.localized['zh-CN'];
  const localizedEn = result.localized.en ?? result.localized['en-US'];
  const showZh = Boolean(localizedZh) || !localizedEn;
  const showEn = Boolean(localizedEn);
  const singleLanguage = !(showZh && showEn);
  const zhDescription = localizedZh ?? result;
  const enDescription = localizedEn ?? result;
  const descriptionZhText = buildDescriptionOnlyText(zhDescription, 'zh');
  const descriptionEnText = buildDescriptionOnlyText(enDescription, 'en');
  const promptZhText = buildNaturalGenerationPrompt(zhDescription, 'zh');
  const promptEnText = buildNaturalGenerationPrompt(enDescription, 'en');
  return (
    <>
      <div className="reverse-description-tabs" role="tablist" aria-label="描述模式切换">
        <button type="button" role="tab" aria-selected={activeTab === 'description'} className={activeTab === 'description' ? 'is-active' : ''} onClick={() => setActiveTab('description')}>
          描述
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'prompt'} className={activeTab === 'prompt' ? 'is-active' : ''} onClick={() => setActiveTab('prompt')}>
          提示词
        </button>
      </div>
      {activeTab === 'description' ? (
        <div className={`reverse-description-compare${singleLanguage ? ' is-single' : ''}`}>
          {showZh && (
          <article className="reverse-description-panel is-description">
            <div className="reverse-description-panel-head">
              <div>
                <h3>中文描述</h3>
                <span>一次返回全部分类，每条可见事实只归属一个描述字段。</span>
              </div>
              <button type="button" onClick={() => void onCopy('description-zh', descriptionZhText)}>
                <Clipboard size={13} />{copied === 'description-zh' ? '已复制' : '复制描述'}
              </button>
            </div>
            <DescriptionField title={getResultLabel('zh', 'overview')} body={zhDescription.overview} />
            <DescriptionCharacterSummary character={zhDescription.character} language="zh" />
            <DescriptionField title={getResultLabel('zh', 'subjects')} body={zhDescription.subjects.join('；')} />
            <DescriptionField title={getResultLabel('zh', 'details')} body={zhDescription.details.join('；')} />
            <DescriptionField title={getResultLabel('zh', 'composition')} body={zhDescription.composition} />
            <DescriptionField title={getResultLabel('zh', 'style')} body={zhDescription.style} />
            <DescriptionField title={getResultLabel('zh', 'colorLighting')} body={zhDescription.colorLighting} />
            <DescriptionField title={getResultLabel('zh', 'backgroundAtmosphere')} body={zhDescription.backgroundAtmosphere} />
          </article>
          )}
          {showEn && (
          <article className="reverse-description-panel is-description">
            <div className="reverse-description-panel-head">
              <div>
                <h3>English Description</h3>
                <span>All categories are returned once without repeating facts across fields.</span>
              </div>
              <button type="button" onClick={() => void onCopy('description-en', descriptionEnText)}>
                <Clipboard size={13} />{copied === 'description-en' ? '已复制' : '复制描述'}
              </button>
            </div>
            <DescriptionField title={getResultLabel('en', 'overview')} body={enDescription.overview} />
            <DescriptionCharacterSummary character={enDescription.character} language="en" />
            <DescriptionField title={getResultLabel('en', 'subjects')} body={enDescription.subjects.join('; ')} />
            <DescriptionField title={getResultLabel('en', 'details')} body={enDescription.details.join('; ')} />
            <DescriptionField title={getResultLabel('en', 'composition')} body={enDescription.composition} />
            <DescriptionField title={getResultLabel('en', 'style')} body={enDescription.style} />
            <DescriptionField title={getResultLabel('en', 'colorLighting')} body={enDescription.colorLighting} />
            <DescriptionField title={getResultLabel('en', 'backgroundAtmosphere')} body={enDescription.backgroundAtmosphere} />
          </article>
          )}
        </div>
      ) : (
        <div className={`reverse-description-compare${singleLanguage ? ' is-single' : ''}`}>
          {showZh && (
          <article className="reverse-description-panel is-prompt">
            <div className="reverse-description-panel-head">
              <div>
                <h3>中文角色参考图迁移提示词</h3>
                <span>搭配任意数量角色参考图使用；同角色多图只补充视角和细节，不按图片数量复制角色。</span>
              </div>
              <button type="button" onClick={() => void onCopy('prompt-zh', promptZhText)}>
                <Clipboard size={13} />{copied === 'prompt-zh' ? '已复制' : '复制提示词'}
              </button>
            </div>
            <DescriptionField title={getResultLabel('zh', 'drawingPrompt')} body={zhDescription.drawingPrompt} strong />
            <DescriptionField title={getResultLabel('zh', 'negativePrompt')} body={zhDescription.negativePrompt} />
          </article>
          )}
          {showEn && (
          <article className="reverse-description-panel is-prompt">
            <div className="reverse-description-panel-head">
              <div>
                <h3>English Character-Reference Transfer Prompt</h3>
                <span>Use with any number of character references. Multiple images of the same character supplement views and details rather than creating copies.</span>
              </div>
              <button type="button" onClick={() => void onCopy('prompt-en', promptEnText)}>
                <Clipboard size={13} />{copied === 'prompt-en' ? '已复制' : '复制提示词'}
              </button>
            </div>
            <DescriptionField title={getResultLabel('en', 'drawingPrompt')} body={enDescription.drawingPrompt} strong />
            <DescriptionField title={getResultLabel('en', 'negativePrompt')} body={enDescription.negativePrompt} />
          </article>
          )}
        </div>
      )}
    </>
  );
}

/** 描述模式两栏中的普通字段；不提供局部复制，避免按钮过多干扰主操作。 */
function DescriptionField({ title, body, strong = false, compact = false, negative = false }: { title: string; body: string; strong?: boolean; compact?: boolean; negative?: boolean }) {
  if (!body) return null;
  return (
    <section className={`reverse-description-field${strong ? ' is-strong' : ''}${compact ? ' is-compact' : ''}${negative ? ' is-negative' : ''}`}>
      <span>{title}</span>
      <p>{body}</p>
    </section>
  );
}

/** 描述栏中的角色摘要，只展示客观描述，不重复展示 characterPrompt。 */
function DescriptionCharacterSummary({ character, language }: { character: ImageReverseDescriptionLanguageResultView['character']; language: ImageReverseLanguage }) {
  if (!character.present) return null;
  const labels = CHARACTER_LABELS[language];
  const lines = [
    [labels.type, character.type],
    [labels.countAndRole, character.countAndRole],
    [labels.bodyAndProportion, character.bodyAndProportion],
    [labels.faceFeatures, character.faceFeatures],
    [labels.hair, character.hair],
    [labels.eyes, character.eyes],
    [labels.skinAndMakeup, character.skinAndMakeup],
    [labels.expressionAndTemperament, character.expressionAndTemperament],
    [labels.outfit, character.outfit],
    [labels.accessoriesAndProps, character.accessoriesAndProps],
    [labels.poseAndAction, character.poseAndAction],
  ].filter(([, value]) => Boolean(value));
  return (
    <section className="reverse-description-field is-character-summary">
      <span>{language === 'zh' ? '角色特征' : 'Character Details'}</span>
      <div>
        {lines.map(([label, value]) => <p key={label}><strong>{label}</strong>{value}</p>)}
      </div>
    </section>
  );
}

/** 角色面板把复现同一角色最关键的结构字段单独展示，方便直接复制到绘图提示词。 */
function CharacterPanel({ character, language, copied, onCopy }: { character: ImageReverseDescriptionLanguageResultView['character']; language: ImageReverseLanguage; copied: string; onCopy: CopyHandler }) {
  if (!character.present) return null;
  const labels = CHARACTER_LABELS[language];
  const rows = [
    [labels.type, character.type],
    [labels.countAndRole, character.countAndRole],
    [labels.bodyAndProportion, character.bodyAndProportion],
    [labels.faceFeatures, character.faceFeatures],
    [labels.hair, character.hair],
    [labels.eyes, character.eyes],
    [labels.skinAndMakeup, character.skinAndMakeup],
    [labels.expressionAndTemperament, character.expressionAndTemperament],
    [labels.outfit, character.outfit],
    [labels.accessoriesAndProps, character.accessoriesAndProps],
    [labels.poseAndAction, character.poseAndAction],
  ].filter(([, value]) => Boolean(value));
  const copyText = buildCharacterText(character, language);
  return (
    <article className="reverse-character-card">
      <div className="reverse-block-title">
        <h3>{language === 'zh' ? '角色特征' : 'Character Details'}</h3>
        <button type="button" onClick={() => void onCopy(`character-${language}`, copyText)}><Clipboard size={13} />{copied === `character-${language}` ? '已复制' : '复制'}</button>
      </div>
      <div className="reverse-character-grid">
        {rows.map(([label, value]) => (
          <section key={label}>
            <span>{label}</span>
            <p>{value}</p>
          </section>
        ))}
      </div>
      {character.identityAnchors.length > 0 && (
        <div className="reverse-character-anchors">
          {character.identityAnchors.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
        </div>
      )}
      {character.characterPrompt && (
        <div className="reverse-character-prompt">
          <strong>{language === 'zh' ? '角色复现提示词' : 'Character Recreation Prompt'}</strong>
          <p>{character.characterPrompt}</p>
        </div>
      )}
    </article>
  );
}

/** 标签模式结果面板，只展示本地模型标签结构，不展示描述模式字段。 */
function TagPromptPanel({ tagPrompt, includeWeights, copied, onCopy, onWeightChange, onBringToGeneration }: { tagPrompt: ImageReverseTagResultView; includeWeights: boolean; copied: string; onCopy: CopyHandler; onWeightChange: (value: boolean) => void; onBringToGeneration: (prompt: string) => void }) {
  const positivePrompt = getTagPromptText(tagPrompt, 'positive', includeWeights);
  const negativePrompt = getTagPromptText(tagPrompt, 'negative', includeWeights);
  return (
    <>
      <div className="reverse-mode-row">
        <label className="reverse-weight-toggle">
          <input type="checkbox" checked={includeWeights} onChange={(event) => onWeightChange(event.target.checked)} />
          <span>复制时带权重</span>
        </label>
        <div className="reverse-tag-note">英文标签可用于 Stable Diffusion、NAI、ComfyUI；Anima 使用下方无权重单行格式。</div>
      </div>
      <article className="reverse-tag-prompt is-positive">
        <div className="reverse-block-title">
          <h3>正向 Prompt</h3>
          <button type="button" onClick={() => void onCopy('tag-positive', positivePrompt)}><Clipboard size={13} />{copied === 'tag-positive' ? '已复制' : '复制'}</button>
        </div>
        <p>{positivePrompt}</p>
      </article>
      {tagPrompt.animaPrompt && (
        <article className="reverse-tag-prompt is-positive">
          <div className="reverse-block-title">
            <h3>Anima 单行 Prompt</h3>
            <button type="button" onClick={() => onBringToGeneration(tagPrompt.animaPrompt ?? '')}><Send size={13} />带入绘图</button>
            <button type="button" onClick={() => void onCopy('tag-anima', tagPrompt.animaPrompt ?? '')}><Clipboard size={13} />{copied === 'tag-anima' ? '已复制' : '复制'}</button>
          </div>
          <p>{tagPrompt.animaPrompt}</p>
        </article>
      )}
      <TagList title="画质标签" tags={tagPrompt.qualityTags} includeWeights={includeWeights} copyKey="tag-quality" copied={copied} onCopy={onCopy} />
      <TagList title="角色标签" tags={tagPrompt.characterTags} includeWeights={includeWeights} copyKey="tag-character" copied={copied} onCopy={onCopy} emphasized />
      <TagList title="细节标签" tags={tagPrompt.detailTags} includeWeights={includeWeights} copyKey="tag-detail" copied={copied} onCopy={onCopy} />
      <TagList title="构图动作标签" tags={tagPrompt.compositionTags} includeWeights={includeWeights} copyKey="tag-composition" copied={copied} onCopy={onCopy} />
      <TagList title="画风标签" tags={tagPrompt.styleTags} includeWeights={includeWeights} copyKey="tag-style" copied={copied} onCopy={onCopy} />
      <TagList title="环境光影标签" tags={tagPrompt.environmentTags} includeWeights={includeWeights} copyKey="tag-environment" copied={copied} onCopy={onCopy} />
      <article className="reverse-tag-prompt is-negative">
        <div className="reverse-block-title">
          <h3>负向 Prompt</h3>
          <button type="button" onClick={() => void onCopy('tag-negative', negativePrompt)}><Clipboard size={13} />{copied === 'tag-negative' ? '已复制' : '复制'}</button>
        </div>
        <p>{negativePrompt}</p>
      </article>
      <TagList title="负向标签" tags={tagPrompt.negativeTags} includeWeights={includeWeights} copyKey="tag-negative-list" copied={copied} onCopy={onCopy} />
    </>
  );
}

/** Prompt 模式面板，优先展示可直接送入生成页的提示词包。 */
function PromptPanel({ result, copied, onCopy }: { result: Extract<ImageReverseResultView, { mode: 'prompt' }>; copied: string; onCopy: CopyHandler }) {
  return (
    <>
      <ResultBlock title="正向 Prompt" body={result.positivePrompt} copyKey="prompt-positive" copied={copied} onCopy={onCopy} strong />
      <ResultBlock title="反向 Prompt" body={result.negativePrompt} copyKey="prompt-negative" copied={copied} onCopy={onCopy} />
      <ResultBlock title="角色段" body={result.characterPrompt} copyKey="prompt-character" copied={copied} onCopy={onCopy} />
      <ResultBlock title="构图段" body={result.compositionPrompt} copyKey="prompt-composition" copied={copied} onCopy={onCopy} />
      <ResultBlock title="风格段" body={result.stylePrompt} copyKey="prompt-style" copied={copied} onCopy={onCopy} />
      <ResultBlock title="背景 / 光影段" body={result.backgroundPrompt} copyKey="prompt-background" copied={copied} onCopy={onCopy} />
    </>
  );
}

/** 角色复刻模式面板，强调不可丢失特征和复现 Prompt。 */
function CharacterProfilePanel({ result, language, copied, onCopy, onLanguageChange }: { result: Extract<ImageReverseResultView, { mode: 'character' }>; language: ImageReverseLanguage; copied: string; onCopy: CopyHandler; onLanguageChange: (language: ImageReverseLanguage) => void }) {
  const active = result.localized[language] ?? result.localized[language === 'zh' ? 'zh-CN' : 'en-US'] ?? result;
  return (
    <>
      <div className="reverse-language-row">
        <div className="reverse-language-tabs" role="tablist" aria-label="角色语言">
          <button type="button" className={language === 'zh' ? 'is-active' : ''} onClick={() => onLanguageChange('zh')}>中文</button>
          <button type="button" className={language === 'en' ? 'is-active' : ''} onClick={() => onLanguageChange('en')}>English</button>
        </div>
      </div>
      <ResultBlock title="角色摘要" body={active.summary} copyKey={`character-summary-${language}`} copied={copied} onCopy={onCopy} />
      <CharacterPanel character={active.character} language={language} copied={copied} onCopy={onCopy} />
      <ResultList title="局部特征" items={active.featureBreakdown} copyKey={`character-features-${language}`} copied={copied} onCopy={onCopy} />
      <ResultList title="服装拆解" items={active.outfitBreakdown} copyKey={`character-outfit-${language}`} copied={copied} onCopy={onCopy} />
      <ResultList title="不可丢失特征" items={active.identityAnchors} copyKey={`character-anchors-${language}`} copied={copied} onCopy={onCopy} dense />
      <ResultBlock title="角色复现 Prompt" body={active.reproductionPrompt} copyKey={`character-prompt-${language}`} copied={copied} onCopy={onCopy} strong />
      <ResultBlock title="避免项" body={active.avoidPrompt} copyKey={`character-avoid-${language}`} copied={copied} onCopy={onCopy} />
    </>
  );
}

/** 图生图编辑模式面板，输出保持项、修改项和最终编辑 Prompt。 */
function EditPromptPanel({ result, language, copied, onCopy, onLanguageChange }: { result: Extract<ImageReverseResultView, { mode: 'edit' }>; language: ImageReverseLanguage; copied: string; onCopy: CopyHandler; onLanguageChange: (language: ImageReverseLanguage) => void }) {
  const active = result.localized[language] ?? result.localized[language === 'zh' ? 'zh-CN' : 'en-US'] ?? result;
  return (
    <>
      <div className="reverse-language-row">
        <div className="reverse-language-tabs" role="tablist" aria-label="编辑语言">
          <button type="button" className={language === 'zh' ? 'is-active' : ''} onClick={() => onLanguageChange('zh')}>中文</button>
          <button type="button" className={language === 'en' ? 'is-active' : ''} onClick={() => onLanguageChange('en')}>English</button>
        </div>
      </div>
      <ResultBlock title="源图摘要" body={active.sourceSummary} copyKey={`edit-summary-${language}`} copied={copied} onCopy={onCopy} />
      <ResultList title="必须保持" items={active.keep} copyKey={`edit-keep-${language}`} copied={copied} onCopy={onCopy} />
      <ResultList title="需要改变" items={active.change} copyKey={`edit-change-${language}`} copied={copied} onCopy={onCopy} />
      <ResultList title="需要移除" items={active.remove} copyKey={`edit-remove-${language}`} copied={copied} onCopy={onCopy} />
      <ResultList title="禁止项" items={active.avoid} copyKey={`edit-avoid-${language}`} copied={copied} onCopy={onCopy} />
      <ResultList title="参考图关系" items={active.referenceMapping} copyKey={`edit-mapping-${language}`} copied={copied} onCopy={onCopy} />
      <ResultBlock title="图生图编辑 Prompt" body={active.editPrompt} copyKey={`edit-prompt-${language}`} copied={copied} onCopy={onCopy} strong />
    </>
  );
}

/** 渲染中英文标签对照表，帮助用户确认本地模型标签含义。 */
function TagList({ title, tags, includeWeights, copyKey, copied, onCopy, emphasized = false }: { title: string; tags: ImageReverseLocalModelTagView[]; includeWeights: boolean; copyKey: string; copied: string; onCopy: CopyHandler; emphasized?: boolean }) {
  if (!tags.length) return <div className="reverse-language-empty">{title} 未返回，请重新提取。</div>;
  const text = tags.map((tag) => formatTagForModel(tag, includeWeights)).join(', ');
  return (
    <article className={`reverse-tag-list${emphasized ? ' is-emphasized' : ''}`}>
      <div className="reverse-block-title">
        <h3>{title}<span>{tags.length}</span></h3>
        <button type="button" onClick={() => void onCopy(copyKey, text)}><Clipboard size={13} />{copied === copyKey ? '已复制' : '复制'}</button>
      </div>
      <div className="reverse-tag-grid">
        {tags.map((tag, index) => (
          <div className="reverse-tag-card" key={`${tag.en}-${index}`}>
            <strong>{formatTagForModel(tag, includeWeights)}</strong>
            <span>{tag.zh}</span>
            <small>{tag.weight.toFixed(2)}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

/** 渲染单个文本结果块，并提供该区域独立复制。 */
function ResultBlock({ title, body, copyKey, copied, onCopy, strong = false }: { title: string; body: string; copyKey: string; copied: string; onCopy: CopyHandler; strong?: boolean }) {
  if (!body) return null;
  return (
    <article className={`reverse-block${strong ? ' is-strong' : ''}`}>
      <div className="reverse-block-title">
        <h3>{title}</h3>
        <button type="button" onClick={() => void onCopy(copyKey, body)}><Clipboard size={13} />{copied === copyKey ? '已复制' : '复制'}</button>
      </div>
      <p>{body}</p>
    </article>
  );
}

/** 渲染数组型结果块，并提供该区域独立复制。 */
function ResultList({ title, items, copyKey, copied, onCopy, dense = false }: { title: string; items: string[]; copyKey: string; copied: string; onCopy: CopyHandler; dense?: boolean }) {
  if (!items.length) return null;
  const copyText = items.join('\n');
  return (
    <article className={`reverse-block${dense ? ' is-dense' : ''}`}>
      <div className="reverse-block-title">
        <h3>{title}</h3>
        <button type="button" onClick={() => void onCopy(copyKey, copyText)}><Clipboard size={13} />{copied === copyKey ? '已复制' : '复制'}</button>
      </div>
      <div className="reverse-chip-list">
        {items.map((item, index) => <span key={`${title}-${index}`}>{item}</span>)}
      </div>
    </article>
  );
}

/** 拼接描述模式的纯描述文本；不包含 drawingPrompt/negativePrompt，避免和提示词栏重复。 */
function buildDescriptionOnlyText(result: ImageReverseDescriptionLanguageResultView, language: ImageReverseLanguage): string {
  const labels = RESULT_LABELS[language];
  const joiner = language === 'zh' ? '；' : '; ';
  return uniqueTextLines([
    `${labels.overview}：${result.overview}`,
    `${language === 'zh' ? '角色特征' : 'Character Details'}：${buildCharacterText(result.character, language, false)}`,
    `${labels.subjects}：${result.subjects.join(joiner)}`,
    `${labels.details}：${result.details.join(joiner)}`,
    `${labels.composition}：${result.composition}`,
    `${labels.style}：${result.style}`,
    `${labels.colorLighting}：${result.colorLighting}`,
    `${labels.backgroundAtmosphere}：${result.backgroundAtmosphere}`,
  ]).join('\n');
}

/** 拼接不定数量参考图适用的角色保留提示词；禁止再次加入原角色特征、角色复现段或质量标签。 */
function buildNaturalGenerationPrompt(result: ImageReverseDescriptionLanguageResultView, language: ImageReverseLanguage): string {
  const labels = RESULT_LABELS[language];
  const negative = result.negativePrompt.trim();
  return uniqueTextLines([
    result.drawingPrompt,
    negative ? `${labels.negativePrompt}：${negative}` : '',
  ]).join('\n');
}

/** 拼接角色细节文本。 */
function buildCharacterText(character: ImageReverseDescriptionLanguageResultView['character'], language: ImageReverseLanguage, includePrompt = true): string {
  if (!character.present) return language === 'zh' ? '未检测到明确角色' : 'No clear character detected';
  const labels = CHARACTER_LABELS[language];
  const lines = [
    `${labels.type}: ${character.type}`,
    `${labels.countAndRole}: ${character.countAndRole}`,
    `${labels.bodyAndProportion}: ${character.bodyAndProportion}`,
    `${labels.faceFeatures}: ${character.faceFeatures}`,
    `${labels.hair}: ${character.hair}`,
    `${labels.eyes}: ${character.eyes}`,
    `${labels.skinAndMakeup}: ${character.skinAndMakeup}`,
    `${labels.expressionAndTemperament}: ${character.expressionAndTemperament}`,
    `${labels.outfit}: ${character.outfit}`,
    `${labels.accessoriesAndProps}: ${character.accessoriesAndProps}`,
    `${labels.poseAndAction}: ${character.poseAndAction}`,
    `${labels.identityAnchors}: ${character.identityAnchors.join(language === 'zh' ? '，' : ', ')}`,
  ];
  if (includePrompt) lines.push(`${labels.characterPrompt}: ${character.characterPrompt}`);
  return uniqueTextLines(lines).join('\n');
}

/** 按段落去重并过滤空标签，避免复制文本反复出现同一描述。 */
function uniqueTextLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const normalized = line.trim().replace(/\s+/g, ' ');
    if (!normalized || normalized.endsWith('：') || normalized.endsWith(':')) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line.trim());
  }
  return result;
}

/** 拼接标签模式完整文本。 */
function buildTagFullText(tagPrompt: ImageReverseTagResultView, includeWeights: boolean): string {
  return [
    '【Positive Prompt】',
    getTagPromptText(tagPrompt, 'positive', includeWeights),
    '',
    '【Negative Prompt】',
    getTagPromptText(tagPrompt, 'negative', includeWeights),
    ...(tagPrompt.animaPrompt ? ['', '【Anima Prompt】', tagPrompt.animaPrompt] : []),
    '',
    '【Quality Tags】',
    formatTagGlossary(tagPrompt.qualityTags, includeWeights),
    '',
    '【Character Tags】',
    formatTagGlossary(tagPrompt.characterTags, includeWeights),
    '',
    '【Detail Tags】',
    formatTagGlossary(tagPrompt.detailTags, includeWeights),
    '',
    '【Composition Tags】',
    formatTagGlossary(tagPrompt.compositionTags, includeWeights),
    '',
    '【Style Tags】',
    formatTagGlossary(tagPrompt.styleTags, includeWeights),
    '',
    '【Environment Tags】',
    formatTagGlossary(tagPrompt.environmentTags, includeWeights),
    '',
    '【Negative Tags】',
    formatTagGlossary(tagPrompt.negativeTags, includeWeights),
  ].join('\n');
}

/** 读取正向或负向标签 prompt，权重开关只影响复制格式。 */
function getTagPromptText(tagPrompt: ImageReverseTagResultView, kind: 'positive' | 'negative', includeWeights: boolean): string {
  if (kind === 'positive') return includeWeights ? tagPrompt.positivePromptWithWeights : tagPrompt.positivePrompt;
  return includeWeights ? tagPrompt.negativePromptWithWeights : tagPrompt.negativePrompt;
}

/** 格式化标签对照列表。 */
function formatTagGlossary(tags: ImageReverseLocalModelTagView[], includeWeights: boolean): string {
  return tags.map((tag) => `${formatTagForModel(tag, includeWeights)} = ${tag.zh}`).join('\n');
}

/** 格式化单个本地模型标签。 */
function formatTagForModel(tag: ImageReverseLocalModelTagView, includeWeights: boolean): string {
  if (!includeWeights || Math.abs(tag.weight - 1) < 0.01) return tag.en;
  return `(${tag.en}:${tag.weight.toFixed(2)})`;
}

/** 删除旧版反推本地大图数据库；删除请求不读取 Blob，也不阻塞页面初始化。 */
function clearLegacyReverseLocalDatabase(): void {
  if (typeof indexedDB === 'undefined') return;
  try {
    indexedDB.deleteDatabase('aiimage-tools-local');
  } catch {
    // 浏览器禁用 IndexedDB 时保持后端任务恢复链路继续运行。
  }
}

const RESULT_LABELS: Record<string, Omit<Record<keyof ImageReverseDescriptionLanguageResultView, string>, 'character'>> = {
  zh: {
    overview: '图片概述',
    subjects: '主体',
    details: '细节',
    composition: '构图 / 镜头',
    style: '画风',
    colorLighting: '色彩 / 光影',
    backgroundAtmosphere: '背景 / 氛围',
    qualityTags: '质量标签',
    drawingPrompt: '角色参考图保留提示词',
    negativePrompt: '参考图使用规则 / 生成约束',
  },
  en: {
    overview: 'Overview',
    subjects: 'Subjects',
    details: 'Details',
    composition: 'Composition / Camera',
    style: 'Style',
    colorLighting: 'Color / Lighting',
    backgroundAtmosphere: 'Background / Mood',
    qualityTags: 'Quality Tags',
    drawingPrompt: 'Character-Reference Preserving Prompt',
    negativePrompt: 'Reference Usage Rules / Generation Constraints',
  },
};

const CHARACTER_LABELS: Record<string, Record<keyof Omit<ImageReverseDescriptionLanguageResultView['character'], 'present'>, string>> = {
  zh: {
    type: '角色类型',
    countAndRole: '数量与主次',
    bodyAndProportion: '体型比例',
    faceFeatures: '脸部五官',
    hair: '发型发色',
    eyes: '眼睛眼神',
    skinAndMakeup: '肤色妆容',
    expressionAndTemperament: '表情气质',
    outfit: '服装',
    accessoriesAndProps: '配饰道具',
    poseAndAction: '姿势动作',
    identityAnchors: '不可丢失特征',
    characterPrompt: '角色复现提示词',
  },
  en: {
    type: 'Character Type',
    countAndRole: 'Count / Role',
    bodyAndProportion: 'Body / Proportion',
    faceFeatures: 'Face Features',
    hair: 'Hair',
    eyes: 'Eyes',
    skinAndMakeup: 'Skin / Makeup',
    expressionAndTemperament: 'Expression / Temperament',
    outfit: 'Outfit',
    accessoriesAndProps: 'Accessories / Props',
    poseAndAction: 'Pose / Action',
    identityAnchors: 'Identity Anchors',
    characterPrompt: 'Character Prompt',
  },
};
RESULT_LABELS['zh-CN'] = RESULT_LABELS.zh;
RESULT_LABELS['en-US'] = RESULT_LABELS.en;
RESULT_LABELS['ja-JP'] = RESULT_LABELS.en;
RESULT_LABELS['ko-KR'] = RESULT_LABELS.en;
RESULT_LABELS['zh-TW'] = RESULT_LABELS.zh;
CHARACTER_LABELS['zh-CN'] = CHARACTER_LABELS.zh;
CHARACTER_LABELS['en-US'] = CHARACTER_LABELS.en;
CHARACTER_LABELS['ja-JP'] = CHARACTER_LABELS.en;
CHARACTER_LABELS['ko-KR'] = CHARACTER_LABELS.en;
CHARACTER_LABELS['zh-TW'] = CHARACTER_LABELS.zh;

const REVERSE_MODES: Array<{ mode: ImageReverseMode; label: string; shortLabel: string }> = [
  { mode: 'description', label: '描述', shortLabel: '描述' },
  { mode: 'prompt', label: 'Prompt', shortLabel: 'Prompt' },
  { mode: 'character', label: '角色', shortLabel: '角色' },
  { mode: 'tags', label: '标签', shortLabel: '标签' },
  { mode: 'edit', label: '编辑', shortLabel: '编辑指令' },
];

/** 构造后端反推选项；前端只传当前模式需要的配置，避免不同模式逻辑互相干扰。 */
function buildReverseOptions(input: {
  mode: ImageReverseMode;
  language: ImageReverseLanguage;
  promptTarget: ImageReverseExtractOptions['promptTarget'];
  tagPreset: ImageReverseExtractOptions['tagPreset'];
  tagDensity: ImageReverseExtractOptions['tagDensity'];
  includeTagWeights: boolean;
  editIntent: ImageReverseExtractOptions['editIntent'];
  includeEvidence: boolean;
  analysisMode: ImageReverseAnalysisMode;
}): ImageReverseExtractOptions {
  return {
    mode: input.mode,
    language: {
      resultLanguageMode: input.mode === 'description' ? 'bilingual' : input.language === 'en' ? 'single' : 'bilingual',
      primaryLanguage: input.mode === 'description' ? 'zh' : input.language,
      secondaryLanguage: input.mode === 'description' ? 'en' : input.language === 'en' ? undefined : 'en',
      promptLanguage: input.mode === 'description' ? 'bilingual' : input.mode === 'tags' || input.mode === 'prompt' || input.mode === 'character' ? 'auto' : input.language,
    },
    // 前端不再提供详细度选择，始终请求最高详细度；后端也会做同样兜底。
    detailLevel: 'forensic',
    sections: sectionsForMode(input.mode),
    focus: 'all',
    promptTarget: input.promptTarget,
    tagPreset: input.tagPreset,
    tagDensity: input.tagDensity,
    tagWeightMode: input.includeTagWeights ? 'important' : 'none',
    characterConsistency: input.mode === 'character' ? 'strict' : 'standard',
    editIntent: input.editIntent,
    includeEvidence: input.includeEvidence,
    analysisMode: input.analysisMode,
  };
}

/** 当前模式默认输出区域。 */
function sectionsForMode(mode: ImageReverseMode): string[] {
  if (mode === 'prompt') return ['positive', 'negative', 'character', 'composition', 'style', 'background'];
  if (mode === 'character') return ['profile', 'features', 'outfit', 'anchors', 'prompt', 'avoid'];
  if (mode === 'tags') return ['quality', 'character', 'details', 'composition', 'style', 'environment', 'negative'];
  if (mode === 'edit') return ['summary', 'keep', 'change', 'remove', 'avoid', 'mapping', 'prompt'];
  return ['overview', 'subjects', 'character', 'details', 'composition', 'style', 'colorLighting', 'backgroundAtmosphere', 'qualityTags', 'drawingPrompt', 'negativePrompt'];
}

/** 读取单项范围的用户可见名称。 */
function getFocusLabel(focus: Exclude<ImageReverseFocus, 'all'>): string {
  return IMAGE_REVERSE_FOCUS_OPTIONS.find((item) => item.value === focus)?.label ?? '单项';
}

/** 生成结果头部文案，确保五种格式与单项范围不会被统称为描述模式。 */
function getResultModeMeta(result: ImageReverseResultView): { title: string; description: string } {
  if (result.mode === 'description' && result.focus && result.focus !== 'all') {
    const label = getFocusLabel(result.focus);
    return { title: `${label}单项`, description: `仅包含${label}范围，不混入其他视觉维度` };
  }
  if (result.mode === 'prompt') return { title: 'Prompt 模式', description: '输出可直接用于绘图的提示词包' };
  if (result.mode === 'character') return { title: '角色模式', description: '输出角色复刻档案和一致性提示词' };
  if (result.mode === 'tags') return { title: '标签模式', description: '仅输出本地模型标签格式' };
  if (result.mode === 'edit') return { title: '编辑模式', description: '输出图生图编辑约束和提示词' };
  return { title: '综合描述', description: '旧记录的完整结构化描述结果' };
}

/** 读取当前语言下的区域标题。 */
function getResultLabel(language: ImageReverseLanguage, key: Exclude<keyof ImageReverseDescriptionLanguageResultView, 'character'>): string {
  return RESULT_LABELS[language][key];
}

/** 根据复制来源显示紧凑反馈。 */
function getCopiedLabel(kind: string): string {
  if (kind.includes('bilingual')) return '双语结果已复制';
  if (kind.startsWith('tag-all')) return '完整标签已复制';
  if (kind.startsWith('tag-positive')) return '正向 Prompt 已复制';
  if (kind.startsWith('tag-negative')) return '负向 Prompt 已复制';
  if (kind.startsWith('tag-')) return '标签区域已复制';
  if (kind.startsWith('prompt-')) return '提示词已复制';
  return '该区域已复制';
}

/** 等待下一次任务状态轮询，避免持续请求 backend。 */
function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

/** 格式化文件大小。 */
function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}
