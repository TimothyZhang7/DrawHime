/** 本页面实现“图片放大”工具：上传图片后创建后端异步任务，刷新页面后继续展示进度和历史。 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowLeft, CheckCircle2, Download, FolderPlus, History, ImageUpscale, Loader2, Upload, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ImageUpscaleJobCancelResponse, ImageUpscaleJobCreateResponse, ImageUpscaleJobDetailResponse, ImageUpscaleJobListResponse, ImageUpscaleJobView, ImageUpscaleRunResponse, ImageUpscaleScale } from '@aiimage/shared-contracts';
import { Seo } from '../../../components/Seo';
import { api } from '../../../lib/api';
import { useToolsConfig } from '../useToolsConfig';
import './ImageUpscalePage.css';

const STORAGE_JOB_IDS = 'aiimage:image-upscale:jobs';
const STORAGE_ACTIVE_JOB_ID = 'aiimage:image-upscale:active-job';

interface SourcePreview {
  url: string;
  width: number;
  height: number;
}

interface UpscaleModelDisplay {
  /** 用户端模型外显名称；真实提交仍使用模型 ID。 */
  title: string;
  /** 简短用途说明，帮助用户按图像类型选择模型。 */
  note: string;
}

const UPSCALE_MODEL_DISPLAY: Record<string, UpscaleModelDisplay> = {
  RealESRGAN_x4plus_anime_6B: { title: '动漫插画默认', note: '线稿、二次元、插画优先' },
  'realesr-animevideov3': { title: '动漫轻量快速', note: '速度优先，适合低分辨率动漫图' },
  'realesr-general-x4v3': { title: '通用快速', note: '照片、截图和混合风格通用' },
  'realesr-general-wdn-x4v3': { title: '通用降噪', note: '噪点、压缩痕迹较重时使用' },
  RealESRGAN_x2plus: { title: '通用轻度 2x', note: '轻度增强，保留原图观感' },
  RealESRGAN_x4plus: { title: '通用细节 4x', note: '真实照片和细节增强' },
  RealESRNet_x4plus: { title: '通用保守 4x', note: '减少锐化和风格化痕迹' },
};

/** 图片放大页面。 */
export function ImageUpscalePage() {
  const [searchParams] = useSearchParams();
  const requestedJobId = searchParams.get('job')?.trim() ?? '';
  const { loading: configLoading, getToolConfig } = useToolsConfig();
  const toolConfig = getToolConfig('image-upscale');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [scale, setScale] = useState<ImageUpscaleScale>(2);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  const [modelName, setModelName] = useState('RealESRGAN_x4plus_anime_6B');
  const [jobs, setJobs] = useState<ImageUpscaleJobView[]>([]);
  const [activeJobId, setActiveJobId] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [cancellingJobIds, setCancellingJobIds] = useState<Set<string>>(() => new Set());
  const fetchedResultJobIdsRef = useRef(new Set<string>());
  const missingRunningJobCountsRef = useRef(new Map<string, number>());

  const enabled = toolConfig?.enabled === true;
  const maxFileSizeMb = toolConfig?.maxFileSizeMb ?? 30;
  const maxOutputPixels = toolConfig?.upscaleMaxOutputPixels ?? 64_000_000;
  const activeJob = useMemo(() => jobs.find((job) => job.id === activeJobId) ?? jobs[0] ?? null, [activeJobId, jobs]);
  const activeResult = activeJob?.result ?? null;
  const hasRunningJobs = jobs.some((job) => job.status === 'queued' || job.status === 'running');
  const activeJobCancelable = Boolean(activeJob && (activeJob.status === 'queued' || activeJob.status === 'running'));
  /** 轮询依赖只保留运行中任务 ID，成功任务的结果图另走单次补拉，避免持续拉取大体积 base64。 */
  const pollingJobIds = useMemo(() => {
    return Array.from(
      new Set(
        jobs
          .filter((job) => job.status === 'queued' || job.status === 'running')
          .map((job) => job.id),
      ),
    );
  }, [jobs]);
  const pollingJobKey = pollingJobIds.join('|');
  const allowedScales = useMemo(() => {
    const list = toolConfig?.upscaleAllowedScales?.length ? toolConfig.upscaleAllowedScales : [2, 4];
    return list.filter((item): item is ImageUpscaleScale => item === 2 || item === 3 || item === 4);
  }, [toolConfig?.upscaleAllowedScales]);
  const modelOptions = useMemo(() => {
    const defaultModel = toolConfig?.upscaleModel ?? 'RealESRGAN_x4plus_anime_6B';
    const list = toolConfig?.upscaleAllowedModels?.length ? toolConfig.upscaleAllowedModels : [defaultModel];
    return Array.from(new Set([defaultModel, ...list].map((item) => item.trim()).filter(Boolean)));
  }, [toolConfig?.upscaleAllowedModels, toolConfig?.upscaleModel]);
  const currentModelDisplay = getUpscaleModelDisplay(modelName);

  useEffect(() => {
    const defaultScale = toolConfig?.upscaleDefaultScale ?? allowedScales[0] ?? 2;
    setScale(allowedScales.includes(defaultScale) ? defaultScale : (allowedScales[0] ?? 2));
  }, [allowedScales, toolConfig?.upscaleDefaultScale]);

  useEffect(() => {
    const defaultModel = toolConfig?.upscaleModel ?? modelOptions[0] ?? 'RealESRGAN_x4plus_anime_6B';
    setModelName(modelOptions.includes(defaultModel) ? defaultModel : (modelOptions[0] ?? defaultModel));
  }, [modelOptions, toolConfig?.upscaleModel]);

  useEffect(() => {
    if (!preview) return;
    const usableScales = allowedScales.filter((item) => !isScaleOutputTooLarge(preview.width, preview.height, item, maxOutputPixels));
    if (usableScales.length > 0 && !usableScales.includes(scale)) setScale(usableScales[0]);
  }, [allowedScales, maxOutputPixels, preview, scale]);

  useEffect(() => {
    return () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    };
  }, [preview?.url]);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    void api<ImageUpscaleJobListResponse>('/api/tools/image-upscale/jobs').then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) {
        const merged = mergeJobs([], res.data.jobs);
        setJobs(merged);
        const savedActiveId = readStoredActiveJobId();
        const nextActive = merged.find((job) => job.id === requestedJobId)?.id
          ?? merged.find((job) => job.id === savedActiveId)?.id
          ?? merged[0]?.id
          ?? '';
        setActiveJobId(nextActive);
      }
    }).finally(() => {
      if (!cancelled) setHistoryLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [requestedJobId]);

  useEffect(() => {
    persistJobIds(jobs.map((job) => job.id));
  }, [jobs]);

  useEffect(() => {
    persistActiveJobId(activeJobId);
  }, [activeJobId]);

  /** 按任务 ID 拉取详情，成功结果图只在详情接口中按需取回，避免列表接口过重。 */
  const refreshJob = useCallback(async (jobId: string): Promise<ImageUpscaleJobView | null> => {
    const res = await api<ImageUpscaleJobDetailResponse>(`/api/tools/image-upscale/jobs/${encodeURIComponent(jobId)}`);
    return res.ok && res.data ? res.data.job : null;
  }, []);

  useEffect(() => {
    if (pollingJobIds.length === 0) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const results = await Promise.all(pollingJobIds.map(async (jobId) => ({ jobId, job: await refreshJob(jobId).catch(() => null) })));
        const nextJobs = results.map((item) => item.job).filter((job): job is ImageUpscaleJobView => Boolean(job));
        const missingJobIds = results.filter((item) => !item.job).map((item) => item.jobId);
        for (const job of nextJobs) missingRunningJobCountsRef.current.delete(job.id);
        for (const jobId of missingJobIds) {
          missingRunningJobCountsRef.current.set(jobId, (missingRunningJobCountsRef.current.get(jobId) ?? 0) + 1);
        }
        if (!cancelled && (nextJobs.length > 0 || missingJobIds.length > 0)) {
          setJobs((prev) => markMissingRunningJobs(mergeJobs(prev, nextJobs), missingRunningJobCountsRef.current));
        }
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollingJobKey, refreshJob]);

  useEffect(() => {
    if (!activeJob || activeJob.status !== 'succeeded' || activeJob.result) return;
    if (fetchedResultJobIdsRef.current.has(activeJob.id)) return;
    fetchedResultJobIdsRef.current.add(activeJob.id);
    let cancelled = false;
    /** 成功历史任务只补拉一次详情，避免结果图响应较大时形成持续网络压力。 */
    void refreshJob(activeJob.id).then((next) => {
      if (!cancelled && next) setJobs((prev) => mergeJobs(prev, [next]));
    }).catch(() => {
      fetchedResultJobIdsRef.current.delete(activeJob.id);
    });
    return () => {
      cancelled = true;
    };
  }, [activeJob, refreshJob]);

  /** 读取用户选择的本地图片，只替换待提交文件，不清空后端任务和历史结果。 */
  const onFileChange = async (picked: File | null) => {
    releasePreview();
    setDragging(false);
    if (!picked) {
      setFile(null);
      return;
    }
    if (!picked.type.startsWith('image/')) {
      setError('只支持上传图片文件。');
      return;
    }
    if (picked.size > maxFileSizeMb * 1024 * 1024) {
      setError(`图片大小不能超过 ${maxFileSizeMb}MB。`);
      return;
    }
    try {
      const loaded = await loadImagePreview(picked);
      setFile(picked);
      setPreview(loaded);
      setError('');
    } catch (err) {
      setFile(null);
      setError(err instanceof Error ? err.message : '图片读取失败');
    }
  };

  /** 拖入图片时阻止浏览器直接打开文件。 */
  const onDragOverImage = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!submitting) setDragging(true);
  };

  /** 离开上传区域时移除拖拽态。 */
  const onDragLeaveImage = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragging(false);
  };

  /** 接收拖拽图片并复用上传校验逻辑。 */
  const onDropImage = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (submitting) return;
    const dropped = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/')) ?? null;
    if (!dropped) {
      setError('请拖入图片文件。');
      return;
    }
    void onFileChange(dropped);
  };

  /** 创建后端异步任务，页面刷新后可继续通过任务 ID 查询状态。 */
  const runUpscale = async () => {
    if (!file || submitting) return;
    if (preview && isScaleOutputTooLarge(preview.width, preview.height, scale, maxOutputPixels)) {
      setError(`当前倍率预计输出 ${formatPixels(preview.width * preview.height * scale * scale)}，超过后台限制 ${formatPixels(maxOutputPixels)}。`);
      return;
    }
    setSubmitting(true);
    setError('');
    const res = await api<ImageUpscaleJobCreateResponse>('/api/tools/image-upscale/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'image/png',
        // 输出格式由后端固定为 WebP；请求里保留 webp 只用于旧链路兼容和排障。
        'x-aiimage-upscale-options': JSON.stringify({ scale, model: modelName, outputFormat: 'webp', saveToLibrary }),
        'x-aiimage-file-name': encodeURIComponent(file.name || 'image'),
      },
      body: file,
    });
    setSubmitting(false);
    if (!res.ok || !res.data) {
      setError(res.message ?? '图片放大任务创建失败');
      return;
    }
    const createdJob = res.data.job;
    setJobs((prev) => mergeJobs(prev, [createdJob]));
    setActiveJobId(createdJob.id);
  };

  /** 切换历史任务；成功任务缺少结果时立即拉取详情。 */
  const selectJob = (job: ImageUpscaleJobView) => {
    setActiveJobId(job.id);
    if (job.status === 'succeeded' && !job.result) {
      void refreshJob(job.id).then((next) => {
        if (next) setJobs((prev) => mergeJobs(prev, [next]));
      });
    }
  };

  /** 下载当前选中的放大图片。 */
  const downloadResult = () => {
    if (!activeResult) return;
    downloadUpscaleResult(activeResult);
  };

  /** 手动结束当前任务；只结束当前登录用户自己的后端任务，不删除历史记录。 */
  const cancelActiveJob = async () => {
    if (!activeJob || !activeJobCancelable || cancellingJobIds.has(activeJob.id)) return;
    const jobId = activeJob.id;
    setCancellingJobIds((prev) => new Set(prev).add(jobId));
    setError('');
    const res = await api<ImageUpscaleJobCancelResponse>(`/api/tools/image-upscale/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    setCancellingJobIds((prev) => {
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
    if (!res.ok || !res.data) {
      setError(res.message ?? '任务结束失败');
      return;
    }
    missingRunningJobCountsRef.current.delete(jobId);
    const cancelledJob = res.data.job;
    setJobs((prev) => mergeJobs(prev, [cancelledJob]));
  };

  /** 清空当前待上传图片，不影响已提交任务和历史任务。 */
  const clearImage = () => {
    releasePreview();
    setFile(null);
    setError('');
  };

  const sourceMeta = preview ? `${preview.width} × ${preview.height} · ${formatBytes(file?.size ?? 0)}` : `最大 ${maxFileSizeMb}MB`;
  const resultImageUrl = activeResult?.image.url || (activeResult?.image.base64 ? `data:${activeResult.image.mimeType};base64,${activeResult.image.base64}` : '');
  const selectedScaleTooLarge = Boolean(preview && isScaleOutputTooLarge(preview.width, preview.height, scale, maxOutputPixels));
  const outputEstimate = preview ? formatPixels(preview.width * preview.height * scale * scale) : '待选择图片';
  const activeMeta = activeJob ? buildJobMeta(activeJob, activeResult) : '等待放大结果';
  const activeTiming = activeResult ? buildTimingText(activeResult) : '';

  if (configLoading) {
    return (
      <div className="upscale-shell">
        <Seo title="图片放大" description="绘图姬 DrawHime 图片放大工具。" path="/tools/image-upscale" />
        <div className="tool-disabled">
          <Loader2 size={18} className="animate-spin" />
          <h1>图片放大</h1>
          <p>正在读取工具配置...</p>
        </div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="upscale-shell">
        <Seo title="图片放大" description="绘图姬 DrawHime 图片放大工具。" path="/tools/image-upscale" />
        <div className="tool-disabled">
          <h1>图片放大</h1>
          <p>该工具当前未开放。</p>
          <Link to="/tools" className="btn btn-outline btn-sm"><ArrowLeft size={14} />返回工具中心</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="upscale-shell">
      <Seo title="图片放大" description="上传一张图片，调用本地 GPU 超分模型放大并增强细节。" path="/tools/image-upscale" />
      <Link to="/tools" className="tool-back-strip"><ArrowLeft size={14} />返回工具中心</Link>

      <section className="upscale-workbench">
        <aside className="upscale-control">
          <header className="upscale-head">
            <div>
              <h1>图片放大</h1>
            </div>
            <div className="upscale-head-actions">
              <Link to="/upscale/history" className="upscale-history-link"><History size={13} />记录</Link>
              <span className="upscale-model-chip" title={`${currentModelDisplay.title} · ${modelName}`}>{currentModelDisplay.title}</span>
            </div>
          </header>

          <label
            className={`upscale-dropzone${preview ? ' has-image' : ''}${dragging ? ' is-dragging' : ''}`}
            onDragEnter={onDragOverImage}
            onDragOver={onDragOverImage}
            onDragLeave={onDragLeaveImage}
            onDrop={onDropImage}
          >
            <input type="file" accept="image/*" onChange={(event) => void onFileChange(event.target.files?.[0] ?? null)} />
            {preview ? (
              <img src={preview.url} alt="待放大图片预览" />
            ) : (
              <div>
                <Upload size={24} />
                <strong>{dragging ? '松开导入图片' : '选择或拖入图片'}</strong>
                <small>支持 PNG、JPEG、WebP 等图片格式，{sourceMeta}</small>
              </div>
            )}
          </label>

          <div className="upscale-filebar">
            <span>{file ? `${file.name} · ${sourceMeta}` : '未选择图片'}</span>
            {file && (
              <button type="button" onClick={clearImage} aria-label="清空图片">
                <X size={14} />
              </button>
            )}
          </div>

          <div className="upscale-scale-row" role="radiogroup" aria-label="放大倍率">
            {allowedScales.map((item) => {
              const scaleTooLarge = Boolean(preview && isScaleOutputTooLarge(preview.width, preview.height, item, maxOutputPixels));
              return (
                <button
                  key={item}
                  type="button"
                  className={scale === item ? 'is-active' : ''}
                  onClick={() => setScale(item)}
                  disabled={submitting || scaleTooLarge}
                  title={scaleTooLarge ? `预计输出超过 ${formatPixels(maxOutputPixels)}` : `预计输出 ${preview ? formatPixels(preview.width * preview.height * item * item) : '待选择图片后计算'}`}
                >
                  {item}x
                </button>
              );
            })}
          </div>
          <div className={`upscale-estimate${selectedScaleTooLarge ? ' is-warning' : ''}`}>
            <span>预计输出</span>
            <strong>{outputEstimate}</strong>
            <small>上限 {formatPixels(maxOutputPixels)}</small>
          </div>

          <div className="upscale-option-grid">
            <label>
              <span>模型</span>
              <select value={modelName} onChange={(event) => setModelName(event.target.value)} disabled={submitting}>
                {modelOptions.map((item) => <option key={item} value={item}>{formatUpscaleModelOption(item)}</option>)}
              </select>
              <small className="upscale-model-hint">{currentModelDisplay.note} · {modelName}</small>
            </label>
          </div>

          <label className="upscale-save-row">
            <input
              type="checkbox"
              checked={saveToLibrary}
              disabled={submitting}
              onChange={(event) => setSaveToLibrary(event.target.checked)}
            />
            <span><FolderPlus size={15} />保存到我的图片</span>
            <small>按账号默认隐私保存</small>
          </label>

          {error && <div className="upscale-alert">{error}</div>}
          {selectedScaleTooLarge && <div className="upscale-alert">当前倍率超过输出像素限制，请降低倍率或换更小的源图。</div>}

          <button type="button" className="upscale-submit" onClick={() => void runUpscale()} disabled={!file || submitting || selectedScaleTooLarge}>
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <ImageUpscale size={16} />}
            {submitting ? '正在提交' : '开始放大'}
          </button>

          <section className="upscale-job-panel" aria-label="图片放大任务历史">
            <div className="upscale-job-panel-head">
              <span><History size={15} />任务</span>
              <small>{historyLoading ? '加载中' : hasRunningJobs ? '处理中' : `${jobs.length} 条`}</small>
            </div>
            <div className="upscale-job-list">
              {jobs.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  className={`upscale-job-item${activeJob?.id === job.id ? ' is-active' : ''}`}
                  onClick={() => selectJob(job)}
                >
                  <span className={`upscale-job-state is-${job.status}`}>{formatJobStatus(job.status)}</span>
                  <strong title={job.sourceFileName}>{job.sourceFileName}</strong>
                  <small title={job.model}>{job.scale}x · {getUpscaleModelDisplay(job.model).title} · {formatDateTime(job.createdAt)}</small>
                </button>
              ))}
              {!historyLoading && jobs.length === 0 && <div className="upscale-job-empty">暂无任务</div>}
            </div>
          </section>
        </aside>

        <section className={`upscale-result${activeResult ? ' has-result' : ''}`}>
          <div className="upscale-result-head">
            <div>
              <h2>{activeJob ? '当前任务' : '结果'}</h2>
              <span>{activeMeta}</span>
            </div>
            <div className="upscale-result-actions">
              {activeJobCancelable && activeJob && (
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void cancelActiveJob()} disabled={cancellingJobIds.has(activeJob.id)}>
                  {cancellingJobIds.has(activeJob.id) ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                  {cancellingJobIds.has(activeJob.id) ? '结束中' : '结束'}
                </button>
              )}
              {activeResult?.savedTask && (
                <Link to={activeResult.savedTask.detailPath} className="btn btn-sm btn-outline">
                  <CheckCircle2 size={13} />
                  已保存
                </Link>
              )}
              <button type="button" className="btn btn-sm btn-outline" onClick={downloadResult} disabled={!activeResult}>
                <Download size={13} />
                下载
              </button>
            </div>
          </div>

          {activeJob && (
            <div className={`upscale-progress-card is-${activeJob.status}`}>
              <div className="upscale-progress-copy">
                <strong>{activeJob.progressText}</strong>
                <span>{formatJobStatus(activeJob.status)} · {Math.round(activeJob.progress)}%</span>
              </div>
              <div className="upscale-progress-track" aria-label="任务进度">
                <span style={{ width: `${Math.max(0, Math.min(100, activeJob.progress))}%` }} />
              </div>
              {activeTiming && <p>{activeTiming}</p>}
              {activeJob.error && <p>{activeJob.error}</p>}
            </div>
          )}

          <div className="upscale-result-stage">
            {activeJob && (activeJob.status === 'queued' || activeJob.status === 'running') && (
              <div className="upscale-loading">
                <Loader2 size={24} className="animate-spin" />
                <strong>{activeJob.progressText}</strong>
                <span>可刷新页面，任务会继续在后台处理。</span>
              </div>
            )}
            {activeResult && resultImageUrl && <img src={resultImageUrl} alt="图片放大结果" />}
            {!activeResult && activeJob?.status === 'failed' && <div className="upscale-empty">{activeJob.error ?? '图片放大失败'}</div>}
            {!activeResult && activeJob?.status === 'cancelled' && <div className="upscale-empty">{activeJob.error ?? '任务已手动结束'}</div>}
            {!activeJob && <div className="upscale-empty">上传图片并点击开始放大后，任务和结果会显示在这里。</div>}
          </div>
        </section>
      </section>
    </div>
  );

  function releasePreview() {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }
}

/** 浏览器端读取图片尺寸，避免用户提交前没有任何反馈。 */
function loadImagePreview(file: File): Promise<SourcePreview> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法读取，请更换文件'));
    };
    img.src = url;
  });
}

/** 合并任务列表，保留已经取回的结果图，避免列表刷新时丢失当前结果。 */
function mergeJobs(current: ImageUpscaleJobView[], incoming: ImageUpscaleJobView[]): ImageUpscaleJobView[] {
  const map = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = map.get(job.id);
    map.set(job.id, { ...previous, ...job, result: job.result ?? previous?.result });
  }
  return [...map.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 50);
}

/** 后端重启后进程内任务会消失；连续查不到时结束本地轮询并提示用户重试。 */
function markMissingRunningJobs(jobs: ImageUpscaleJobView[], missingCounts: Map<string, number>): ImageUpscaleJobView[] {
  return jobs.map((job) => {
    if ((job.status !== 'queued' && job.status !== 'running') || (missingCounts.get(job.id) ?? 0) < 3) return job;
    return {
      ...job,
      status: 'failed',
      progress: 100,
      progressText: '任务已过期或服务重启',
      error: '任务状态已丢失，请重新提交图片放大任务。',
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  });
}

/** 下载后端返回的放大图片。 */
function downloadUpscaleResult(result: ImageUpscaleRunResponse): void {
  if (result.image.url && !result.image.base64) {
    const link = document.createElement('a');
    link.href = result.image.url;
    link.download = result.image.filename;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  if (!result.image.base64) return;
  const blob = base64ToBlob(result.image.base64, result.image.mimeType);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.image.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** 判断某个倍率是否会超过后台最大输出像素限制。 */
function isScaleOutputTooLarge(width: number, height: number, scale: ImageUpscaleScale, maxOutputPixels: number): boolean {
  return width * height * scale * scale > maxOutputPixels;
}

/** 把像素数量转成简短中文展示，便于用户理解后台限制。 */
function formatPixels(pixels: number): string {
  if (!Number.isFinite(pixels) || pixels <= 0) return '0 像素';
  if (pixels >= 10_000_000) return `${(pixels / 10_000_000).toFixed(1)} 千万像素`;
  if (pixels >= 10_000) return `${Math.round(pixels / 10_000)} 万像素`;
  return `${Math.round(pixels)} 像素`;
}

/** 生成当前任务头部摘要。 */
function buildJobMeta(job: ImageUpscaleJobView, result: ImageUpscaleRunResponse | null): string {
  if (result) {
    const sourceSize = formatDimensions(result.source.width, result.source.height);
    const outputSize = formatDimensions(result.image.width, result.image.height);
    return `原图 ${sourceSize} -> 返回图 ${outputSize} · ${formatBytes(result.image.sizeBytes)} · 总耗时 ${(result.elapsedMs / 1000).toFixed(1)}s`;
  }
  return `${job.sourceFileName} · ${job.scale}x · ${job.model}`;
}

/** 读取图片放大模型外显配置，未知模型保持真实 ID 便于排障。 */
function getUpscaleModelDisplay(model: string): UpscaleModelDisplay {
  return UPSCALE_MODEL_DISPLAY[model] ?? { title: model, note: '后台开放的自定义模型' };
}

/** 生成模型下拉选项文案；value 仍然是后端白名单中的真实模型 ID。 */
function formatUpscaleModelOption(model: string): string {
  const display = getUpscaleModelDisplay(model);
  return display.title === model ? model : `${display.title} - ${model}`;
}

/** 格式化图片尺寸，避免任务摘要里重复拼接宽高逻辑。 */
function formatDimensions(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '-';
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** 展示后端返回的真实阶段耗时，避免把 GPU 推理耗时误解为用户端完整等待时间。 */
function buildTimingText(result: ImageUpscaleRunResponse): string {
  const timings = result.timings;
  if (!timings) return '';
  const parts = [
    `GPU响应 ${(timings.upstreamHeadersMs / 1000).toFixed(1)}s`,
    `下载 ${(timings.upstreamDownloadMs / 1000).toFixed(1)}s`,
  ];
  if (typeof timings.upstreamStorageUploadMs === 'number') parts.push(`上传 ${(timings.upstreamStorageUploadMs / 1000).toFixed(1)}s`);
  if (typeof timings.upstreamReportedMs === 'number') parts.unshift(`推理 ${(timings.upstreamReportedMs / 1000).toFixed(1)}s`);
  if (typeof result.queueWaitMs === 'number' && result.queueWaitMs > 0) parts.unshift(`排队 ${(result.queueWaitMs / 1000).toFixed(1)}s`);
  return parts.join(' · ');
}

function formatJobStatus(status: ImageUpscaleJobView['status']): string {
  if (status === 'queued') return '排队';
  if (status === 'running') return '处理';
  if (status === 'succeeded') return '完成';
  if (status === 'cancelled') return '已结束';
  return '失败';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 读取本地保存的最后选中任务 ID；只存 ID，不保存图片结果。 */
function readStoredActiveJobId(): string {
  try {
    return localStorage.getItem(STORAGE_ACTIVE_JOB_ID) ?? '';
  } catch {
    return '';
  }
}

/** 记录近期任务 ID，仅作为当前选中态兜底；任务权威历史来自 backend 数据库。 */
function persistJobIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_JOB_IDS, JSON.stringify(ids.slice(0, 50)));
  } catch {
    // 本地存储不可用时不影响后端任务执行。
  }
}

/** 记录当前选中任务 ID，刷新页面后优先展示同一任务。 */
function persistActiveJobId(jobId: string): void {
  try {
    if (jobId) localStorage.setItem(STORAGE_ACTIVE_JOB_ID, jobId);
    else localStorage.removeItem(STORAGE_ACTIVE_JOB_ID);
  } catch {
    // 本地存储不可用时不影响工具主流程。
  }
}
