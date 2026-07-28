/** 绘图工作台 — 重新设计：聚焦输入 + 图片条 + 任务侧栏 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../providers/AuthProvider';
import { useToast } from '../../providers/ToastProvider';
import { api, BACKEND_UNREACHABLE } from '../../lib/api';
import { config } from '../../lib/config';
import { resolveMediaUrl } from '../../lib/media';
import { usePrivacyPreferences } from '../../lib/usePrivacyPreferences';
import { PrivacySwitch } from '../../components/common/PrivacySwitch';
import { AlertTriangle, Sparkles, Loader2, Image, Plus, X, Upload, PanelRightClose, PanelRightOpen, Coins, Clock, ChevronDown, ChevronRight, Mail, ArrowLeft, ArrowRight, GripVertical } from 'lucide-react';
import { TaskPanel, addRecentTask, addRecentTasks } from './TaskPanel';
import { formatDrawingModelDisplayName } from '../../lib/drawingModelDisplay';
import {
  DRAWING_ASPECT_RATIO_OPTIONS,
  type DrawingAspectRatio,
  type DrawingMode,
  type DrawingPublicConfigResponse,
  type DrawingVideoResolution,
  type UpdateUserModelPreferenceResponse,
  type UserModelPreferenceResponse,
} from '@aiimage/shared-contracts';
import './GeneratePage.css';
import { takeGenerationPromptDraft } from './generationPromptDraft';

/** 前端绘图模型视图，对齐 shared-contracts 的 DrawingModelOptionView。 */
type DrawingModelOptionView = {
  /** 用户提交使用的统一主模型名。 */
  name: string;
  /** 用户端短展示名。 */
  label?: string;
  /** 可用于 Bot/后端解析的别名。 */
  aliases?: string[];
  /** 外显排序权重。 */
  weight?: number;
  /** 是否为默认模型。 */
  isDefault?: boolean;
  /** 视频模型是否允许在提交前调用反推模型设计分镜。 */
  storyboardDesignEnabled?: boolean;
  /** 文生图模型是否开放 AI 提示增强。 */
  referencePromptAssistEnabled?: boolean;
  /** 规范化模型类型。 */
  type?: 'universal' | 'text_to_image' | 'image_to_image' | 'video' | 'text';
  /** 当前模型能力，用于按文生图/图生图筛选。 */
  capabilities?: {
    textToImage?: boolean;
    imageToImage?: boolean;
    text?: boolean;
    textToVideo?: boolean;
    imageToVideo?: boolean;
  };
  /** 模型说明。 */
  description?: string;
  /** 是否推荐默认选中。 */
  recommended?: boolean;
  /** 至少一个启用站点原生支持的画幅比例。 */
  supportedAspectRatios?: DrawingAspectRatio[];
};

type ImageItem = {
  id: number;
  name: string;
  dataUrl: string;
  /** 上传时使用的原始 File；只在上传中暂存，成功后清除，避免长期占用内存。 */
  uploadFile?: File;
  /** 上传到任务链路的参考图字节数；大源图压缩后按压缩文件大小累计。 */
  size?: number;
  /** 本地文件内容哈希，用于前端去重，避免同一参考图重复上传。 */
  contentHash?: string;
  /** 上传后的短文件名 */
  filename?: string;
  /** 上传状态 */
  uploading?: boolean;
  /** 单张参考图上传进度，0-100；服务端未返回前保持动画态。 */
  progress?: number;
  /** 上传失败时用于卡片内展示短提示。 */
  error?: string;
};
/** 参考图上传成功后的前端会话缓存，用于同内容文件再次添加时复用已落库媒资。 */
type ReferenceUploadCacheItem = Pick<ImageItem, 'name' | 'dataUrl' | 'filename' | 'size'>;
/** 单张参考图上传后大小上限，单位字节；backend 仍会按同一上限兜底。 */
const MAX_REFERENCE_IMAGE_BYTES = config.maxImageSizeMb * 1024 * 1024;
/** 单任务参考图上传后大小合计上限，单位字节。 */
const MAX_REFERENCE_TOTAL_BYTES = config.maxReferenceImagesTotalSizeMb * 1024 * 1024;
/** 浏览器允许读取的单张源图上限，避免超大源图在客户端解码压缩时占用过多内存。 */
const MAX_REFERENCE_SOURCE_BYTES = MAX_REFERENCE_TOTAL_BYTES;
/** 前端参考图压缩触发阈值；小图保持原样，避免无意义的画质损失和 CPU 消耗。 */
const REFERENCE_CLIENT_COMPRESS_THRESHOLD_BYTES = 3 * 1024 * 1024;
/** 前端参考图压缩目标；仍由 backend/media-service 做最终 3MB 兜底校验。 */
const REFERENCE_CLIENT_COMPRESS_TARGET_BYTES = Math.min(3 * 1024 * 1024, MAX_REFERENCE_IMAGE_BYTES);
/** 前端压缩参考图的最长边，降低手机端上行体积，同时保留图生图参考细节。 */
const REFERENCE_CLIENT_COMPRESS_MAX_EDGE = 1800;
/** 网页参考图上传并发上限；media-service 负责串行转码，前端不能一次把全部图片和重试同时压入队列。 */
const REFERENCE_UPLOAD_CONCURRENCY = 2;
/** 浏览器侧最近模型键；用于接口暂时不可达时仍保持刷新前选择。 */
const LAST_SELECTED_MODEL_STORAGE_KEY = 'aiimage:last-selected-drawing-model';
let _id = 0; function nextId() { return ++_id; }

/** 读取浏览器最近模型；存储异常不应阻断生成页加载。 */
function readLastSelectedModel() {
  try { return localStorage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY)?.trim() ?? ''; } catch { return ''; }
}

/** 写入浏览器最近模型；账号级持久化仍以后端接口为准。 */
function writeLastSelectedModel(model: string) {
  try { localStorage.setItem(LAST_SELECTED_MODEL_STORAGE_KEY, model); } catch { /* 浏览器禁用存储时保留当前会话状态。 */ }
}

/** 规范化本次生成张数字段；输入编辑中允许为空，真正提交时再回落到 1。 */
function normalizeGenerateCountInput(value: string, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

/** 将钱包接口金额转为安全数字；展示层容错不能参与真实扣费。 */
function parseWalletAmount(value: string | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

/** 兼容旧模型接口只返回 name 的情况，并对 Gemini 文本模型显式标记为不可绘图。 */
function normalizeDrawingModelOption(model: DrawingModelOptionView): DrawingModelOptionView {
  const type = model.type ?? (model.name === 'gemini-3.5-flash' ? 'text' : 'universal');
  const capabilities = model.capabilities ?? {
    textToImage: type === 'universal' || type === 'text_to_image',
    imageToImage: type === 'universal' || type === 'image_to_image',
    text: type === 'text',
    textToVideo: type === 'video',
    imageToVideo: type === 'video',
  };
  return { ...model, type, capabilities };
}

/** 判断模型是否可用于当前绘图模式，提交前和展示层都使用同一规则。 */
function isModelUsableForInput(model: DrawingModelOptionView, hasImages: boolean, referencePromptAssist = false) {
  return hasImages
    ? Boolean(model.capabilities?.imageToImage || model.capabilities?.imageToVideo || (referencePromptAssist && model.referencePromptAssistEnabled && model.capabilities?.textToImage))
    : Boolean(model.capabilities?.textToImage || model.capabilities?.textToVideo);
}

/** 根据模型真实能力和参考图状态确定最终生成模式。 */
function resolveGenerationMode(model: DrawingModelOptionView, hasImages: boolean, referencePromptAssist = false): DrawingMode {
  const isVideo = Boolean(model.capabilities?.textToVideo || model.capabilities?.imageToVideo || model.type === 'video');
  if (isVideo) return hasImages ? 'image-to-video' : 'text-to-video';
  return hasImages && !referencePromptAssist ? 'image-to-image' : 'text-to-image';
}

export function GeneratePage() {
  const { user } = useAuth(); const { show } = useToast();
  const [searchParams] = useSearchParams();
  // 工具页草稿只消费一次；URL prompt 继续作为旧入口兼容，且不会覆盖明确带入的持久化反推结果。
  const [prompt, setPrompt] = useState(() => takeGenerationPromptDraft()?.prompt ?? searchParams.get('prompt') ?? '');
  const [images, setImages] = useState<ImageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [imgOpen, setImgOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [balance, setBalance] = useState<{ paidBalance: string; freeBalance: string } | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [emailSending, setEmailSending] = useState(false);
  const [model, setModel] = useState(readLastSelectedModel);
  const [models, setModels] = useState<DrawingModelOptionView[]>([]);
  const [aspectRatio, setAspectRatio] = useState<DrawingAspectRatio>('auto');
  const [videoDuration, setVideoDuration] = useState(5);
  const [videoResolution, setVideoResolution] = useState<DrawingVideoResolution>('720p');
  const [storyboardDesign, setStoryboardDesign] = useState(true);
  const [referencePromptAssist, setReferencePromptAssist] = useState(true);
  const [maxPromptLength, setMaxPromptLength] = useState<number | null>(null);
  const [generateCount, setGenerateCount] = useState(1);
  const [generateCountInput, setGenerateCountInput] = useState('1');
  const [multiConfig, setMultiConfig] = useState({ enabled: true, max: 4 });
  const internalDrag = useRef(false);
  const referenceGridRef = useRef<HTMLDivElement | null>(null);
  const referenceDragRef = useRef<{ pointerId: number; index: number; startX: number; startY: number; dragging: boolean; element: HTMLElement } | null>(null);
  const referenceDragCleanupRef = useRef<(() => void) | null>(null);
  const referenceHtmlDragIndexRef = useRef<number | null>(null);
  const referenceContentHashesRef = useRef<Set<string>>(new Set());
  const referenceUploadCacheRef = useRef<Map<string, ReferenceUploadCacheItem>>(new Map());
  const modelSelectionRevisionRef = useRef(0);
  const modelPreferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const privacyPrefs = usePrivacyPreferences(Boolean(user));
  const isPrivate = privacyPrefs.preferences.webDefaultPrivate;
  const selectedAspectRatio = DRAWING_ASPECT_RATIO_OPTIONS.find((option) => option.value === aspectRatio) ?? DRAWING_ASPECT_RATIO_OPTIONS[0];
  const selectedPreviewRatio = selectedAspectRatio.width && selectedAspectRatio.height ? selectedAspectRatio.width / selectedAspectRatio.height : 1;
  const selectedModelOption = models.find(item => item.name === model) ?? models[0];
  const nativeReferenceUploadAvailable = Boolean(selectedModelOption?.capabilities?.imageToImage || selectedModelOption?.capabilities?.imageToVideo);
  const referencePromptAssistAvailable = Boolean(selectedModelOption?.referencePromptAssistEnabled && selectedModelOption?.capabilities?.textToImage);
  const referenceUploadEnabled = nativeReferenceUploadAvailable || (referencePromptAssistAvailable && referencePromptAssist);
  const referenceImageLimit = referencePromptAssistAvailable && referencePromptAssist ? 4 : config.maxReferenceImages;

  useEffect(() => {
    // 后台对模型开放 AI 提示增强后，网页默认开启；用户仍可在本次模型选择下手动关闭。
    setReferencePromptAssist(referencePromptAssistAvailable);
  }, [selectedModelOption?.name, referencePromptAssistAvailable]);

  // 获取钱包余额 + 模型列表（从 drawing-service 聚合全部站点可用模型）
  useEffect(() => {
    api<{ paidBalance: string; freeBalance: string }>('/api/wallet/status').then(d => { if (d.ok && d.data) setBalance({ paidBalance: d.data.paidBalance, freeBalance: d.data.freeBalance }); });
    // 通过 backend 代理获取模型列表，避免跨域
    fetch(`${config.apiBase}/api/drawing/models`).then(r => r.json()).then((d: { ok?: boolean; data?: { models: DrawingModelOptionView[]; defaultModel?: string } }) => {
      if (d.ok && d.data?.models?.length) {
        const imageModels = d.data.models
          .map(normalizeDrawingModelOption)
          .filter(m => m.capabilities?.textToImage || m.capabilities?.imageToImage || m.capabilities?.textToVideo || m.capabilities?.imageToVideo);
        setModels(imageModels);
        const defaultModel = d.data.defaultModel && imageModels.some(m => m.name === d.data?.defaultModel) ? d.data.defaultModel : imageModels[0]?.name;
        setModel(current => imageModels.some(item => item.name === current) ? current : (defaultModel ?? ''));
      }
    }).catch(() => {});
    api<DrawingPublicConfigResponse>('/api/drawing/config').then(d => {
      if (d.ok && d.data) {
        const max = Math.min(Math.max(Number(d.data.multiCountMax) || 4, 1), 20);
        setMultiConfig({ enabled: d.data.multiEnabled !== false, max });
        const promptLimit = Number(d.data.maxPromptLength);
        if (Number.isFinite(promptLimit) && promptLimit > 0) setMaxPromptLength(Math.floor(promptLimit));
        setGenerateCount(value => {
          const next = Math.min(value, max);
          setGenerateCountInput(String(next));
          return next;
        });
      }
    });
  }, []);

  // 登录用户模型列表就绪后恢复账号偏好；旧用户没有偏好时由后端回退上一个网页任务模型。
  useEffect(() => {
    if (!user || models.length === 0) return;
    let cancelled = false;
    const selectionRevision = modelSelectionRevisionRef.current;
    void api<UserModelPreferenceResponse>('/api/user-model-pref').then(result => {
      const preferredModel = result.ok ? result.data?.model?.trim() : '';
      if (cancelled || selectionRevision !== modelSelectionRevisionRef.current || !preferredModel) return;
      if (!models.some(item => item.name === preferredModel)) return;
      setModel(preferredModel);
      writeLastSelectedModel(preferredModel);
    });
    return () => { cancelled = true; };
  }, [user?.id, models]);

  /** 串行保存模型选择，避免快速切换时较慢的旧请求覆盖最后一次选择。 */
  const persistModelPreference = useCallback((nextModel: string, updateSelection: boolean, reportFailure: boolean) => {
    const revision = ++modelSelectionRevisionRef.current;
    if (updateSelection) setModel(nextModel);
    writeLastSelectedModel(nextModel);
    if (!user) return;

    modelPreferenceSaveQueueRef.current = modelPreferenceSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const result = await api<UpdateUserModelPreferenceResponse>('/api/user-model-pref', {
          method: 'POST',
          body: JSON.stringify({ model: nextModel }),
        });
        if (!result.ok && reportFailure && revision === modelSelectionRevisionRef.current) {
          show(result.message ?? '模型偏好保存失败，本机仍会保留当前选择', 'warn');
        }
      });
  }, [show, user]);

  useEffect(() => {
    if (!privacyPrefs.error) return;
    show(privacyPrefs.error, 'error');
    privacyPrefs.clearError();
  }, [privacyPrefs.error, privacyPrefs.clearError, show]);

  // 邮箱验证邮件重发冷却在前端固定 60 秒，后端仍保留真实限流兜底。
  useEffect(() => {
    if (emailCooldown <= 0) return;
    const timer = window.setInterval(() => setEmailCooldown(v => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [emailCooldown]);

  /** 重发验证邮件；邮箱已解绑时没有可投递地址，必须先到个人中心绑定新邮箱。 */
  const resendVerifyEmail = async () => {
    if (user?.emailBound === false || !user?.email) return show('请先绑定邮箱', 'warn');
    if (emailSending || emailCooldown > 0) return;
    setEmailSending(true);
    const d = await api('/auth/resend-verification', { method: 'POST' });
    if (d.ok) {
      show('验证邮件已发送，请查收邮箱', 'success');
      setEmailCooldown(60);
    } else {
      show(d.message ?? '验证邮件发送失败', 'error');
    }
    setEmailSending(false);
  };

  /** 更新单张参考图上传进度；上传中的每张图各自独立动画。 */
  const updateImageProgress = useCallback((id: number, progress: number) => {
    setImages(prev => prev.map(img => img.id === id ? { ...img, progress } : img));
  }, []);

  /** 上传单张参考图（带重试，最多 3 次），失败返回 null。 */
  const uploadRefImage = useCallback(async (item: ImageItem): Promise<ImageItem | null> => {
    const mime = item.uploadFile?.type || item.dataUrl.match(/data:(image\/\w+)/)?.[1] || 'image/png';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        updateImageProgress(item.id, attempt === 1 ? 6 : 12);
        const uploaded = await uploadReferenceWithProgress(item.uploadFile ?? item.dataUrl, mime, (progress) => updateImageProgress(item.id, progress));
        const nextDataUrl = uploaded.url ? resolveMediaUrl(uploaded.url) : item.dataUrl;
        if (item.dataUrl.startsWith('blob:')) URL.revokeObjectURL(item.dataUrl);
        // 服务端已把参考图统一转成 PNG，任务大小必须使用真实返回值而不是浏览器源文件大小。
        const uploadedItem = { ...item, uploadFile: undefined, filename: uploaded.filename, dataUrl: nextDataUrl, size: uploaded.size ?? item.size, uploading: false, progress: 100, error: undefined };
        if (uploadedItem.contentHash && uploadedItem.filename) {
          // 单张上传完成后立即缓存真实媒体文件名，不再等待整批参考图全部完成。
          referenceUploadCacheRef.current.set(uploadedItem.contentHash, {
            name: uploadedItem.name,
            dataUrl: uploadedItem.dataUrl,
            filename: uploadedItem.filename,
            size: uploadedItem.size,
          });
        }
        // 单张上传完成后立即落 UI 状态；后续批量兜底更新只会重复写入同一结果。
        setImages(prev => prev.map(i => i.id === uploadedItem.id ? uploadedItem : i));
        return uploadedItem;
      } catch (error) {
        // 格式、体积等 4xx 属于确定失败，继续重试只会重复占用转码队列；拥塞和服务异常才退避重试。
        if (error instanceof ReferenceUploadError && !error.retryable) break;
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
    return null; // 3 次全失败
  }, [updateImageProgress]);

  /** 原文件和预览仍保留在当前页面时允许原位重试，避免临时拥塞迫使用户重新选择图片。 */
  const retryReferenceImage = useCallback(async (id: number) => {
    const item = images.find(image => image.id === id);
    if (!item || item.uploading || item.filename || !item.uploadFile) return;
    setImages(previous => previous.map(image => image.id === id
      ? { ...image, uploading: true, progress: 0, error: undefined }
      : image));
    const uploaded = await uploadRefImage({ ...item, uploading: true, progress: 0, error: undefined });
    if (uploaded) return;
    setImages(previous => previous.map(image => image.id === id
      ? { ...image, uploading: false, progress: 0, error: '点击重试' }
      : image));
  }, [images, uploadRefImage]);

  const processFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!referenceUploadEnabled) { show(referencePromptAssistAvailable ? '请先开启 AI 提示增强' : '当前模型不支持参考图', 'warn'); return; }
    const remaining = referenceImageLimit - images.length;
    if (remaining <= 0) { show(`最多 ${referenceImageLimit} 张`, 'warn'); return; }
    const toProcess = Array.from(files);
    const acceptedEntries: Array<
      | { kind: 'file'; file: File; uploadFile: File; uploadSize: number; contentHash: string; dataUrl: string }
      | { kind: 'cached'; file: File; contentHash: string; cached: ReferenceUploadCacheItem }
    > = [];
    const acceptedHashes: string[] = [];
    const existingHashes = new Set([...referenceContentHashesRef.current, ...images.map(item => item.contentHash).filter((hash): hash is string => Boolean(hash))]);
    let nextTotalBytes = images.reduce((sum, item) => sum + Math.max(0, item.size ?? 0), 0);
    let duplicateCount = 0;
    let reusedCount = 0;
    for (const f of toProcess) {
      if (acceptedEntries.length >= remaining) break;
      if (!isSupportedReferenceImageFile(f)) { show('仅支持 PNG/JPEG/JFIF/WebP/GIF/AVIF/TIFF/SVG', 'error'); continue; }
      // 源文件只限制浏览器可安全读取范围；真正进入任务的单张大小按压缩后的上传文件校验。
      if (f.size > MAX_REFERENCE_SOURCE_BYTES) { show(`单张源图不能超过 ${config.maxReferenceImagesTotalSizeMb}MB`, 'error'); continue; }
      let prepared: { contentHash: string; uploadFile: File };
      try {
        // 关键分支：上传优先走压缩后的 File，预览仍用原图 blob URL，避免大图上行拖慢浏览器。
        prepared = await prepareReferenceFileForUpload(f);
      } catch {
        show('参考图读取失败，请重新选择', 'error');
        continue;
      }
      // TIFF/SVG 等浏览器未必能在本地解码，允许把原始文件交给服务端转换；任务体积按服务端单图上限保守估算。
      const uploadSize = Math.min(prepared.uploadFile.size, MAX_REFERENCE_IMAGE_BYTES);
      if (nextTotalBytes + uploadSize > MAX_REFERENCE_TOTAL_BYTES) { show(`单任务参考图合计不能超过 ${config.maxReferenceImagesTotalSizeMb}MB`, 'error'); continue; }
      const { contentHash } = prepared;
      if (existingHashes.has(contentHash)) {
        duplicateCount += 1;
        continue;
      }
      existingHashes.add(contentHash);
      referenceContentHashesRef.current.add(contentHash);
      acceptedHashes.push(contentHash);
      const cached = referenceUploadCacheRef.current.get(contentHash);
      if (cached?.filename) {
        acceptedEntries.push({ kind: 'cached', file: f, contentHash, cached });
        reusedCount += 1;
        nextTotalBytes += Math.max(0, cached.size ?? uploadSize);
        continue;
      }
      acceptedEntries.push({ kind: 'file', file: f, uploadFile: prepared.uploadFile, uploadSize, contentHash, dataUrl: URL.createObjectURL(f) });
      nextTotalBytes += uploadSize;
    }
    if (duplicateCount > 0) show(`已跳过 ${duplicateCount} 张重复参考图`, 'info');
    if (reusedCount > 0) show(`已复用 ${reusedCount} 张已上传参考图`, 'success');
    if (acceptedEntries.length === 0) return;
    // 并行读取所有新文件；已上传成功的同内容参考图直接复用 filename，不再重复请求上传接口。
    Promise.all(acceptedEntries.map(entry => {
      if (entry.kind === 'cached') {
        return Promise.resolve<ImageItem>({
          id: nextId(),
          name: entry.file.name || entry.cached.name,
          dataUrl: entry.cached.dataUrl,
          size: entry.cached.size,
          contentHash: entry.contentHash,
          filename: entry.cached.filename,
          uploading: false,
          progress: 100,
          error: undefined,
        });
      }
      return Promise.resolve<ImageItem>({
        id: nextId(),
        name: entry.file.name,
        dataUrl: entry.dataUrl,
        uploadFile: entry.uploadFile,
        size: entry.uploadSize,
        contentHash: entry.contentHash,
        uploading: true,
        progress: 0,
      });
    })).then(newItems => {
      setImages(prev => [...prev, ...newItems]);
      const uploadItems = newItems.filter(item => item.uploading);
      if (uploadItems.length === 0) return;
      // 使用受控并发上传，避免多图与自动重试共同放大 media-service 的转码等待队列。
      uploadReferenceItemsWithConcurrency(uploadItems, uploadRefImage, REFERENCE_UPLOAD_CONCURRENCY).then(results => {
        for (const uploaded of results) {
          if (uploaded?.contentHash && uploaded.filename) {
            // 上传成功后仅缓存媒资短文件名和预览地址；删除当前卡片时不清缓存，方便同图再次添加时复用。
            referenceUploadCacheRef.current.set(uploaded.contentHash, {
              name: uploaded.name,
              dataUrl: uploaded.dataUrl,
              filename: uploaded.filename,
              size: uploaded.size,
            });
          }
        }
        setImages(prev => prev.map(i => {
          const uploaded = results.find(r => r?.id === i.id);
          return uploaded ? { ...uploaded, uploading: false, progress: 100, error: undefined } : uploadItems.some(item => item.id === i.id) ? { ...i, uploading: false, progress: 0, filename: undefined, error: '上传失败' } : i;
        }));
        // 统计失败
        const failed = results.filter(r => r === null).length;
        if (failed > 0) show(`${failed} 张参考图上传失败，请重新添加`, 'warn');
        for (const failedItem of uploadItems) {
          if (results.some(r => r?.id === failedItem.id)) continue;
          if (failedItem.contentHash) {
            referenceContentHashesRef.current.delete(failedItem.contentHash);
            referenceUploadCacheRef.current.delete(failedItem.contentHash);
          }
        }
      });
    }).catch(() => {
      for (const hash of acceptedHashes) referenceContentHashesRef.current.delete(hash);
      show('参考图读取失败，请重新选择', 'error');
    });
  }, [images, referenceImageLimit, referencePromptAssistAvailable, referenceUploadEnabled, show, uploadRefImage]);

  const onDropZone = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); if (internalDrag.current) return; if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files); };
  const onDragOverZone = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (referenceUploadEnabled && e.dataTransfer.types.includes('Files') && !internalDrag.current) setDragOver(true); };
  const onDragLeaveZone = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); };

  const removeImage = (id: number) => setImages(prev => {
    const removed = prev.find(i => i.id === id);
    if (removed?.dataUrl.startsWith('blob:')) {
      URL.revokeObjectURL(removed.dataUrl);
    }
    // 删除参考图时只释放当前列表内的占位哈希；已上传成功的会话缓存保留，允许用户重新添加同图时直接复用 ref 文件。
    if (removed?.contentHash) {
      referenceContentHashesRef.current.delete(removed.contentHash);
    }
    return prev.filter(i => i.id !== id);
  });

  /** 调整参考图顺序：按钮兜底用于手机端和触控板场景，上传中/失败的图片也允许先排位。 */
  const moveReferenceImage = (id: number, offset: number) => {
    cancelReferencePointerDrag();
    setImages(prev => {
      const currentIndex = prev.findIndex(item => item.id === id);
      const nextIndex = currentIndex + offset;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(currentIndex, 1);
      if (!moved) return prev;
      next.splice(nextIndex, 0, moved);
      return next;
    });
  };

  /** 桌面端原生拖放兜底：部分浏览器会优先进入 HTML drag，不再持续派发 pointermove。 */
  const startReferenceHtmlDrag = (event: React.DragEvent<HTMLDivElement>, idx: number) => {
    if ((event.target as HTMLElement).closest('button')) {
      event.preventDefault();
      return;
    }
    cancelReferencePointerDrag();
    referenceHtmlDragIndexRef.current = idx;
    internalDrag.current = true;
    setDragIdx(idx);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(idx));
  };

  /** 桌面端原生拖放移动：拖过目标缩略图时立即重排，和 pointer 排序共享同一组图片状态。 */
  const moveReferenceHtmlDrag = (event: React.DragEvent<HTMLDivElement>, idx: number) => {
    const fromIndex = referenceHtmlDragIndexRef.current;
    if (fromIndex === null || fromIndex === idx) return;
    event.preventDefault();
    event.stopPropagation();
    setImages(prev => {
      if (fromIndex < 0 || fromIndex >= prev.length || idx < 0 || idx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return prev;
      next.splice(idx, 0, moved);
      return next;
    });
    referenceHtmlDragIndexRef.current = idx;
    setDragIdx(idx);
  };

  /** 清理桌面端原生拖放状态，避免影响外层参考图上传拖拽区域。 */
  const stopReferenceHtmlDrag = () => {
    referenceHtmlDragIndexRef.current = null;
    internalDrag.current = false;
    setDragIdx(null);
  };

  useEffect(() => {
    return () => referenceDragCleanupRef.current?.();
  }, []);

  /** 释放参考图排序指针捕获，避免拖拽结束后残留捕获状态影响点击、删除和继续上传。 */
  const releaseReferencePointerCapture = () => {
    const drag = referenceDragRef.current;
    if (!drag) return;
    try {
      if (drag.element.hasPointerCapture(drag.pointerId)) {
        drag.element.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // 浏览器可能已经在 pointerup、pointercancel 或 DOM 重排时自动释放，忽略即可。
    }
  };

  /** 移动端参考图排序：用全局 Pointer Events 命中缩略图，避免重排 DOM 后丢失 move/up 事件。 */
  const startReferencePointerDrag = (event: React.PointerEvent<HTMLDivElement>, idx: number) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (images.length < 2) return;
    // 桌面鼠标交给 HTML 原生 drag/drop；这里 preventDefault 会阻断 dragstart。
    if (event.pointerType === 'mouse') return;
    event.preventDefault();
    event.stopPropagation();
    referenceDragCleanupRef.current?.();
    internalDrag.current = true;
    // 关键分支：显式捕获指针，避免手机滚动层、图片重排或鼠标移出缩略图后丢失 move/up 事件。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch { /* 部分浏览器可能在快速取消时拒绝捕获，后续 window 监听仍可兜底。 */ }
    referenceDragRef.current = { pointerId: event.pointerId, index: idx, startX: event.clientX, startY: event.clientY, dragging: false, element: event.currentTarget };
    setDragIdx(idx);
    const move = (moveEvent: PointerEvent) => moveReferencePointerDrag(moveEvent);
    const stop = (stopEvent: PointerEvent) => stopReferencePointerDrag(stopEvent);
    const cancel = () => cancelReferencePointerDrag();
    window.addEventListener('pointermove', move, { passive: false, capture: true });
    window.addEventListener('pointerup', stop, { passive: false, capture: true });
    window.addEventListener('pointercancel', stop, { passive: false, capture: true });
    window.addEventListener('blur', cancel, { capture: true });
    referenceDragCleanupRef.current = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('blur', cancel, true);
      releaseReferencePointerCapture();
    };
  };

  /** Pointer/touch 共用同一套坐标排序，避免手机端 DOM 重排后事件目标变化导致顺序不更新。 */
  const moveReferenceDragAt = (pointerId: number, clientX: number, clientY: number) => {
    const drag = referenceDragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const movedEnough = Math.hypot(clientX - drag.startX, clientY - drag.startY) > 4;
    if (!movedEnough && !drag.dragging) return;
    drag.dragging = true;
    const nextIndex = findReferenceIndexAtPoint(referenceGridRef.current, clientX, clientY);
    if (!Number.isInteger(nextIndex) || nextIndex === drag.index) return;
    setImages(prev => {
      if (drag.index < 0 || drag.index >= prev.length || nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(drag.index, 1);
      if (!moved) return prev;
      next.splice(nextIndex, 0, moved);
      return next;
    });
    drag.index = nextIndex;
    setDragIdx(nextIndex);
  };

  const moveReferencePointerDrag = (event: PointerEvent) => {
    const drag = referenceDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    moveReferenceDragAt(event.pointerId, event.clientX, event.clientY);
  };

  /** 结束参考图拖拽，清理全局监听，防止状态残留影响继续上传或删除。 */
  const stopReferencePointerDrag = (event: PointerEvent) => {
    const drag = referenceDragRef.current;
    if (drag && drag.pointerId !== event.pointerId) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    cancelReferencePointerDrag();
  };

  /** React 层 pointer 兜底：被 setPointerCapture 捕获的事件有时只回到缩略图本身。 */
  const moveReferencePointerDragFromReact = (event: React.PointerEvent<HTMLDivElement>) => {
    moveReferencePointerDrag(event.nativeEvent);
  };

  /** React 层 pointer 结束兜底：保证缩略图自身收到 pointerup/cancel 时也能清理排序状态。 */
  const stopReferencePointerDragFromReact = (event: React.PointerEvent<HTMLDivElement>) => {
    stopReferencePointerDrag(event.nativeEvent);
  };

  /** 手机浏览器兜底：部分 WebView 对 Pointer Capture 支持不稳定，触摸排序用原生 Touch Events 保持连续追踪。 */
  const startReferenceTouchDrag = (event: React.TouchEvent<HTMLDivElement>, idx: number) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (images.length < 2) return;
    const touch = event.changedTouches[0] ?? event.touches[0];
    if (!touch) return;
    event.preventDefault();
    event.stopPropagation();
    referenceDragCleanupRef.current?.();
    referenceHtmlDragIndexRef.current = null;
    internalDrag.current = true;
    referenceDragRef.current = { pointerId: touch.identifier, index: idx, startX: touch.clientX, startY: touch.clientY, dragging: false, element: event.currentTarget };
    setDragIdx(idx);
    const move = (moveEvent: TouchEvent) => moveReferenceTouchDrag(moveEvent);
    const stop = (stopEvent: TouchEvent) => stopReferenceTouchDrag(stopEvent);
    const cancel = () => cancelReferencePointerDrag();
    window.addEventListener('touchmove', move, { passive: false, capture: true });
    window.addEventListener('touchend', stop, { passive: false, capture: true });
    window.addEventListener('touchcancel', stop, { passive: false, capture: true });
    window.addEventListener('blur', cancel, { capture: true });
    referenceDragCleanupRef.current = () => {
      window.removeEventListener('touchmove', move, true);
      window.removeEventListener('touchend', stop, true);
      window.removeEventListener('touchcancel', stop, true);
      window.removeEventListener('blur', cancel, true);
    };
  };

  /** 从触摸列表中找到本次排序手势，避免多指触控误改参考图顺序。 */
  const findReferenceTouch = (touches: TouchList, pointerId: number) => {
    for (let i = 0; i < touches.length; i += 1) {
      const touch = touches.item(i);
      if (touch?.identifier === pointerId) return touch;
    }
    return null;
  };

  /** 触摸移动排序：使用 window 级监听，手指移出缩略图后仍能命中最近的参考图卡片。 */
  const moveReferenceTouchDrag = (event: TouchEvent) => {
    const drag = referenceDragRef.current;
    if (!drag) return;
    const touch = findReferenceTouch(event.changedTouches, drag.pointerId) ?? findReferenceTouch(event.touches, drag.pointerId);
    if (!touch) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    moveReferenceDragAt(drag.pointerId, touch.clientX, touch.clientY);
  };

  /** 触摸结束排序：只有追踪的那根手指结束时才清理状态。 */
  const stopReferenceTouchDrag = (event: TouchEvent) => {
    const drag = referenceDragRef.current;
    if (!drag || !findReferenceTouch(event.changedTouches, drag.pointerId)) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    cancelReferencePointerDrag();
  };

  /** 取消参考图拖拽状态；窗口失焦或组件卸载时也必须执行。 */
  const cancelReferencePointerDrag = () => {
    referenceDragCleanupRef.current?.();
    referenceDragCleanupRef.current = null;
    releaseReferencePointerCapture();
    referenceDragRef.current = null;
    internalDrag.current = false;
    setDragIdx(null);
  };

  /** 将任务预览中的成功图片加入参考图；先交给统一压缩上传链路，避免大生成图在压缩前被误拦截。 */
  const addGeneratedImageToReferences = useCallback(async (image: { url: string; filename?: string; name?: string }) => {
    if (images.length >= config.maxReferenceImages) {
      show(`最多 ${config.maxReferenceImages} 张`, 'warn');
      return false;
    }
    try {
      const url = resolveMediaUrl(image.url);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download_generated_reference_failed:${response.status}`);
      const blob = await response.blob();
      if (blob.size > MAX_REFERENCE_SOURCE_BYTES) {
        show(`单张源图不能超过 ${config.maxReferenceImagesTotalSizeMb}MB`, 'error');
        return false;
      }
      const currentTotalBytes = images.reduce((sum, item) => sum + Math.max(0, item.size ?? 0), 0);
      if (currentTotalBytes >= MAX_REFERENCE_TOTAL_BYTES) {
        show(`单任务参考图合计不能超过 ${config.maxReferenceImagesTotalSizeMb}MB`, 'error');
        return false;
      }
      const filename = image.name ?? image.filename ?? extractMediaFilename(image.url) ?? 'generated-reference.png';
      const file = new File([blob], filename, { type: blob.type || 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      await processFiles(transfer.files);
      setImgOpen(true);
      return true;
    } catch {
      show('生成图加入参考图失败，请下载后重新上传', 'error');
      return false;
    }
  }, [images, processFiles, show]);

  /** 规范 §28：生成客户端幂等键，用于任务恢复 */
  const submitIdRef = useRef<string>('');
  /** 刷新期间保留尚未收到创建响应的幂等键，避免提示增强同步阶段丢失恢复入口。 */
  const pendingGenerateKey = 'aiimage:generate:pending-client-request-id';

  const submit = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return show('请输入提示词', 'warn');
    // 浏览器只使用后台公开配置做即时提示；backend 仍会按同一数据库配置执行最终校验。
    if (maxPromptLength !== null && cleanPrompt.length > maxPromptLength) return show(`提示词不能超过 ${maxPromptLength} 字符`, 'warn');
    if (!user) return show('请先登录', 'error');
    if (loading) return;
    // 检查是否有正在上传的参考图
    if (images.some(i => i.uploading)) return show('参考图正在上传中，请稍候', 'warn');
    // 检查是否有上传失败的图
    if (images.some(i => !i.uploading && !i.filename)) return show('有参考图上传失败，请移除后重试', 'warn');
    // 提交前再次按当前界面顺序收集短文件名；不允许 filter 静默丢掉后续参考图。
    const readySourceImageUrls: string[] = [];
    const readySourceImageSizes: number[] = [];
    const readySourceKeys = new Set<string>();
    for (const [index, image] of images.entries()) {
      const filename = image.filename?.trim();
      if (!filename) return show(`第 ${index + 1} 张参考图尚未上传完成，请重新上传或移除`, 'warn');
      const key = buildReferenceImageKey(filename);
      if (key && readySourceKeys.has(key)) return show(`第 ${index + 1} 张参考图与前面的参考图重复，请移除后重试`, 'warn');
      if (key) readySourceKeys.add(key);
      readySourceImageUrls.push(filename);
      readySourceImageSizes.push(Math.max(0, image.size ?? 0));
    }
    const readyTotalBytes = readySourceImageSizes.reduce((sum, size) => sum + size, 0);
    if (readyTotalBytes > MAX_REFERENCE_TOTAL_BYTES) return show(`单任务参考图合计不能超过 ${config.maxReferenceImagesTotalSizeMb}MB`, 'error');
    setLoading(true);

    // 生成客户端请求幂等键，格式：web_时间戳_随机数
    const crid = submitIdRef.current || `web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    submitIdRef.current = crid;
    sessionStorage.setItem(pendingGenerateKey, crid);
    const selectedModel = models.find(item => item.name === model);
    if (!selectedModel) {
      setLoading(false);
      return show('当前选择的模型不可用', 'error');
    }
    const useReferencePromptAssist = referencePromptAssistAvailable && referencePromptAssist;
    if (!isModelUsableForInput(selectedModel, images.length > 0, useReferencePromptAssist)) {
      setLoading(false);
      return show(referencePromptAssistAvailable ? '请先开启 AI 提示增强' : '当前模型不支持参考图', 'error');
    }
    if (useReferencePromptAssist && images.length > 4) {
      setLoading(false);
      return show('AI 提示增强最多接受 4 张参考图', 'error');
    }
    const mode = resolveGenerationMode(selectedModel, images.length > 0, useReferencePromptAssist);
    const videoTask = mode === 'text-to-video' || mode === 'image-to-video';

    try {
      const normalizedCount = normalizeGenerateCountInput(generateCountInput, multiConfig.max);
      // 输入框允许用户先删空；提交真实任务前必须同步为合法张数，默认 1。
      if (generateCountInput !== String(normalizedCount)) setGenerateCountInput(String(normalizedCount));
      setGenerateCount(normalizedCount);
      const requestCount = videoTask ? 1 : multiConfig.enabled ? normalizedCount : 1;
      const d = await api<{ task: { id: string; status: string; clientRequestId?: string; batchId?: string | null; batchTotal?: number | null }; batch?: { id: string; count?: number }; tasks?: { id: string; batchId?: string | null; batchTotal?: number | null }[] }>('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          clientRequestId: crid,
          prompt: cleanPrompt,
          mode,
          model: selectedModel.name,
          aspectRatio,
          isPrivate,
          count: requestCount,
          sourceImageUrls: readySourceImageUrls,
          sourceImageSizes: readySourceImageSizes,
          // 已开放模型必须显式传 true/false，保证用户关闭后 backend 不再按模型默认值重新开启。
          ...(referencePromptAssistAvailable ? { referencePromptAssist: useReferencePromptAssist } : {}),
          ...(videoTask ? { duration: videoDuration, resolution: videoResolution, storyboardDesign } : {}),
        }),
      });

      if (d.ok && d.data?.task) {
        const visibleTaskInfo = readVisibleTaskInfo({
          task: d.data.task,
          batch: d.data.batch,
          tasks: d.data.tasks,
        });
        const visibleTaskIds = visibleTaskInfo.ids;
        show(visibleTaskInfo.count > 1 ? `任务已提交，生成 ${visibleTaskInfo.count} 张` : '任务已提交', 'success');
        addRecentTasks(visibleTaskIds);
        // 任务创建成功后再次保存实际提交模型，保证自动兼容切换也成为下一次默认模型。
        persistModelPreference(selectedModel.name, false, false);
        // 保留提示词和参考图，便于用户基于同一组输入继续微调后再次提交。
        if (!panelOpen) setPanelOpen(true);
        submitIdRef.current = '';
        sessionStorage.removeItem(pendingGenerateKey);
      } else {
        // 只有浏览器未收到后端响应时才按幂等 ID 恢复；429/400 等明确业务错误没有已创建任务，不再制造 404 恢复噪声。
        const recovered = d.status === 0 ? await tryRecover(crid) : null;
        if (recovered) {
          show('任务已恢复', 'success');
          const visibleTaskInfo = readVisibleTaskInfo(recovered);
          addRecentTasks(visibleTaskInfo.ids);
          persistModelPreference(selectedModel.name, false, false);
          // 恢复已提交任务时也不清空输入，避免用户误以为参考图丢失。
          if (!panelOpen) setPanelOpen(true);
          submitIdRef.current = '';
          sessionStorage.removeItem(pendingGenerateKey);
        } else {
          show(d.message ?? '提交失败', 'error');
        }
      }
    } catch {
      // 规范 §28：网络中断时尝试恢复任务
      const recovered = await tryRecover(crid);
      if (recovered) {
        show('任务已提交（网络恢复）', 'success');
        const visibleTaskInfo = readVisibleTaskInfo(recovered);
        addRecentTasks(visibleTaskInfo.ids);
        persistModelPreference(selectedModel.name, false, false);
        // 网络恢复成功后同样保留参考图和提示词，保证输入状态连续。
        if (!panelOpen) setPanelOpen(true);
        submitIdRef.current = '';
        sessionStorage.removeItem(pendingGenerateKey);
      } else {
        show(BACKEND_UNREACHABLE, 'error');
      }
    }
    setLoading(false);
  };

  /** 生成张数加一；到后台配置最大值后回到 1，便于快速轮换常用批次。 */
  const incrementGenerateCount = useCallback(() => {
    if (!multiConfig.enabled || loading) return;
    setGenerateCount(prev => {
      const next = prev >= multiConfig.max ? 1 : prev + 1;
      setGenerateCountInput(String(next));
      return next;
    });
  }, [loading, multiConfig.enabled, multiConfig.max]);

  /** 规范 §28：按 clientRequestId 查询近期结果，恢复窗口 15 分钟 */
  const tryRecover = async (crid: string) => {
    try {
      const d = await api<{ task: { id: string; status: string; batchId?: string | null; batchTotal?: number | null }; batch?: { id: string; count?: number }; tasks?: { id: string; batchId?: string | null; batchTotal?: number | null }[] }>('/api/generate/recover', {
        method: 'POST',
        body: JSON.stringify({ clientRequestId: crid }),
      });
      if (d.ok && d.data?.task) return d.data;
    } catch { /* 恢复失败静默 */ }
    return null;
  };

  useEffect(() => {
    const crid = sessionStorage.getItem(pendingGenerateKey);
    if (!crid || loading) return;
    let cancelled = false;
    const recoverPending = async () => {
      for (let attempt = 0; attempt < 30 && !cancelled; attempt += 1) {
        const recovered = await tryRecover(crid);
        if (recovered) {
          const taskInfo = readVisibleTaskInfo(recovered);
          addRecentTasks(taskInfo.ids);
          sessionStorage.removeItem(pendingGenerateKey);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    void recoverPending();
    return () => { cancelled = true; };
  }, [loading]);

  const hasImages = images.length > 0;
  // 模型列表不再因添加参考图而静默切换；不兼容输入由明确开关和提交校验处理。
  const visibleModels = models;
  const currentModel = selectedModelOption;
  const currentReferencePromptAssist = referencePromptAssistAvailable && referencePromptAssist;
  const currentMode = currentModel ? resolveGenerationMode(currentModel, hasImages, currentReferencePromptAssist) : 'text-to-image';
  const isVideoMode = currentMode === 'text-to-video' || currentMode === 'image-to-video';
  const storyboardDesignAvailable = isVideoMode && currentModel?.storyboardDesignEnabled !== false;
  const availableAspectRatioOptions = DRAWING_ASPECT_RATIO_OPTIONS.filter((option) => (
    !currentModel?.supportedAspectRatios?.length || currentModel.supportedAspectRatios.includes(option.value)
  ));
  // 余额展示只做前端汇总，真实扣费和余额校验仍以后端钱包事务为准。
  const totalBalance = balance ? (parseWalletAmount(balance.freeBalance) + parseWalletAmount(balance.paidBalance)).toFixed(2) : '0.00';

  useEffect(() => {
    if (!visibleModels.length) return;
    if (!model || !visibleModels.some(item => item.name === model)) setModel(visibleModels[0].name);
  }, [model, visibleModels]);

  useEffect(() => {
    // 视频端点要求显式七种比例；图片模型仍优先回到 Auto。
    if (!availableAspectRatioOptions.some((option) => option.value === aspectRatio)) {
      const preferred = isVideoMode
        ? availableAspectRatioOptions.find((option) => option.value === '2:3') ?? availableAspectRatioOptions[0]
        : availableAspectRatioOptions.find((option) => option.value === 'auto') ?? availableAspectRatioOptions[0];
      if (preferred) setAspectRatio(preferred.value);
    }
  }, [aspectRatio, currentModel?.name, currentModel?.supportedAspectRatios?.join('|'), isVideoMode]);

  useEffect(() => {
    if (!isVideoMode) return;
    setGenerateCount(1);
    setGenerateCountInput('1');
  }, [isVideoMode]);

  useEffect(() => {
    // 每次切换到允许分镜的视频模型都恢复默认开启；后台关闭时前端同步锁定为关闭。
    setStoryboardDesign(storyboardDesignAvailable);
  }, [currentModel?.name, storyboardDesignAvailable]);

  return (
    <div className="generate-shell flex flex-wrap justify-center items-start gap-0" style={{ margin: '0 -4px' }} onDragOver={onDragOverZone} onDragLeave={onDragLeaveZone} onDrop={onDropZone}>
      {/* 拖放遮罩 */}
      {dragOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none" style={{ background: 'rgba(79,110,247,0.06)' }}>
          <div className="card flex flex-col items-center gap-3 py-12 px-16" style={{ border: '2px dashed var(--color-primary)' }}>
            <Upload size={36} className="text-primary" />
            <span className="text-sm font-semibold text-primary">释放以添加参考图</span>
          </div>
        </div>
      )}

      {/* 主区域 — 自适应宽度 */}
      <div className="generate-main px-3 sm:px-4 py-3 lg:py-5 flex-1" style={{ minWidth: 0, maxWidth: 680 }}>
          {/* 标题 + 余额信息 */}
          <div className="generate-header flex items-center justify-between mb-2.5 flex-wrap gap-2">
            <div className={`generate-title-row flex items-center gap-2 flex-shrink-0${visibleModels.length > 1 ? ' has-model-select' : ''}`}>
              <h1 className="generate-page-title page-title flex items-center gap-2 whitespace-nowrap"><Sparkles size={20} />AI 生成</h1>
              <div className="generate-model-tabs" aria-label="选择绘图模型">
                {visibleModels.length > 0 ? (
                  visibleModels.map(item => (
                    <button
                      key={item.name}
                      type="button"
                      className={`generate-model-tab${currentModel?.name === item.name ? ' is-active' : ''}`}
                      onClick={() => persistModelPreference(item.name, true, true)}
                      title={`${item.name}${item.description ? `：${item.description}` : ''}`}
                    >
                      {formatDrawingModelDisplayName(item)}
                    </button>
                  ))
                ) : models.length === 0 ? (
                  <span className="text-xs text-text-2">加载模型中...</span>
                ) : (
                  <span className="text-xs text-warning">当前模式暂无可用模型</span>
                )}
              </div>
            </div>
            <div className="generate-meta-row flex items-center gap-2 text-[11px] text-text-2 flex-shrink-0">
              {balance ? (
                <div className="generate-balance-card" aria-label={`当前余额合计 ${totalBalance} 元，免费余额 ${balance.freeBalance} 元，付费余额 ${balance.paidBalance} 元`}>
                  <div className="generate-balance-total">
                    <Coins size={13} />
                    <span>余额</span>
                    <strong>¥{totalBalance}</strong>
                  </div>
                  <div className="generate-balance-breakdown" aria-hidden="true">
                    <span className="is-free">免 ¥{balance.freeBalance}</span>
                    <span className="is-paid">付 ¥{balance.paidBalance}</span>
                  </div>
                </div>
              ) : (
                <div className="generate-balance-card is-loading" aria-label="余额加载中">
                  <div className="generate-balance-total">
                    <Coins size={13} />
                    <span>余额加载中</span>
                  </div>
                </div>
              )}
              {cooldown > 0 && <span className="flex items-center gap-1 text-warning whitespace-nowrap"><Clock size={12} />冷却{cooldown}s</span>}
              <button onClick={() => setPanelOpen(!panelOpen)} className="btn-ghost btn-sm flex items-center gap-1 flex-shrink-0">
                {panelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                <span className="hidden sm:inline text-[11px]">{panelOpen ? '隐藏预览' : '显示预览'}</span>
              </button>
            </div>
          </div>

          {user && !user.emailVerified && (
            <div className="generate-email-notice flex items-start justify-between gap-3 p-4 mb-3 border text-sm">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
                <span>{user.emailBound === false || !user.email ? '邮箱未绑定。请先绑定正确邮箱，确保账号安全并能接收重要通知。' : '邮箱未验证。请先完成邮箱验证，确保账号安全并能接收重要通知。'}</span>
              </div>
              {user.emailBound === false || !user.email ? (
                <Link to="/profile" className="btn btn-sm btn-outline flex items-center gap-1 flex-shrink-0">
                  <Mail size={13} />绑定邮箱
                </Link>
              ) : (
                <button type="button" onClick={resendVerifyEmail} disabled={emailSending || emailCooldown > 0} className="btn btn-sm btn-outline flex items-center gap-1 flex-shrink-0">
                  <Mail size={13} />{emailSending ? '发送中' : emailCooldown > 0 ? `${emailCooldown}s` : '重发验证'}
                </button>
              )}
            </div>
          )}

          {/* 提示词输入 — 打字机风格，现代设计 */}
          <div className="card overflow-hidden prompt-card" style={{ padding: 0 }}>
            {/* 工具栏 */}
            <div className="prompt-toolbar flex items-center justify-between px-4" style={{ minHeight: 38, borderBottom: '1px solid var(--color-border)', background: '#fafbfc' }}>
              <span className="prompt-toolbar-title text-xs text-text-2 font-medium flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-4 rounded-full prompt-indicator" style={{ background: 'var(--color-primary)' }} />
                提示词
              </span>
              <div className="prompt-toolbar-actions flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <div className="h-1 rounded-full overflow-hidden" style={{ width: 80, background: 'var(--color-border)' }}>
                    <div className="h-full rounded-full prompt-progress-fill"
                      style={{ width: `${maxPromptLength ? Math.min(100, (prompt.length / maxPromptLength) * 100) : 0}%`, background: maxPromptLength && prompt.length > maxPromptLength * 0.8 ? 'var(--color-warning)' : 'var(--color-primary)' }} />
                  </div>
                  <span className="prompt-char-count text-[11px] text-text-2 tabular-nums" style={{ minWidth: 48 }}>{prompt.length}{maxPromptLength ? `/${maxPromptLength}` : ''}</span>
                </div>
                <PrivacySwitch
                  size="sm"
                  checked={isPrivate}
                  disabled={privacyPrefs.loading}
                  pending={privacyPrefs.saving}
                  label={isPrivate ? '私密' : '公开'}
                  ariaLabel="生成页默认隐私"
                  className="prompt-private-toggle"
                  onChange={privacyPrefs.updateWebDefaultPrivate}
                />
              </div>
            </div>
            {/* 输入区 */}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={e => { setPrompt(e.target.value); }}
              placeholder="描述你想要的画面…&#10;&#10;例如：a beautiful cat sitting on a windowsill, soft morning light, cinematic photography"
              maxLength={maxPromptLength ?? undefined}
              className="w-full border-none bg-transparent resize-none px-5 py-4 prompt-textarea"
              style={{
                outline: 'none',
                minHeight: 200,
                fontSize: 15,
                lineHeight: 1.75,
                fontFamily: "'Noto Sans SC', 'SF Mono', 'Cascadia Code', monospace",
                color: 'var(--color-text)',
                letterSpacing: '0.01em',
                caretColor: 'var(--color-primary)',
              }}
              onFocus={e => { (e.target.closest('.card') as HTMLElement)?.style.setProperty('box-shadow', '0 1px 3px rgba(0,0,0,0.06), 0 4px 20px rgba(99,102,241,0.1)'); }}
              onBlur={e => { (e.target.closest('.card') as HTMLElement)?.style.removeProperty('box-shadow'); }}
            />
          </div>

          {referencePromptAssistAvailable && (
            <div className="generate-output-settings mt-3">
              <label className="generate-aspect-control generate-storyboard-control">
                <span className="generate-aspect-copy">
                  <strong>AI 提示增强</strong>
                  <small>无参考图时扩写提示词；有参考图时最多 4 张由视觉 AI 转写，绘图模型不直接读取图片</small>
                </span>
                <span className="generate-storyboard-toggle generate-assist-toggle">
                  <input
                    type="checkbox"
                    checked={referencePromptAssist}
                    disabled={loading}
                    onChange={event => {
                      const enabled = event.target.checked;
                      const mustClearReferences = !enabled && images.length > 0 && !nativeReferenceUploadAvailable;
                      if (mustClearReferences && !window.confirm('当前模型关闭 AI 提示增强后不能使用参考图，将清空已上传图片，是否继续？')) return;
                      if (mustClearReferences) {
                        for (const image of images) if (image.dataUrl.startsWith('blob:')) URL.revokeObjectURL(image.dataUrl);
                        referenceContentHashesRef.current.clear();
                        setImages([]);
                      }
                      setReferencePromptAssist(enabled);
                    }}
                    aria-label="是否开启 AI 提示增强"
                  />
                  <span className="generate-assist-toggle-track" aria-hidden="true" />
                  <b>{referencePromptAssist ? '开启' : '关闭'}</b>
                </span>
              </label>
            </div>
          )}

          {/* 参考图：原生图生图直接开放，纯文生图必须先开启 AI 提示增强。 */}
          <div className={`border mt-3 transition-colors ${dragOver ? 'border-primary' : 'border-border'}`}>
            <button onClick={() => referenceUploadEnabled && setImgOpen(!imgOpen)} disabled={!referenceUploadEnabled} className="w-full flex items-center justify-between px-3 text-xs font-medium" style={{ height: 34, background: 'var(--color-bg)', color: 'var(--color-text-2)', border: 'none', cursor: referenceUploadEnabled ? 'pointer' : 'not-allowed', opacity: referenceUploadEnabled ? 1 : 0.55 }}>
              <span className="flex items-center gap-1.5">{imgOpen && referenceUploadEnabled ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Image size={12} />参考图 {images.length > 0 && `(${images.length}/${referenceImageLimit})`}</span>
              {referenceUploadEnabled && images.length < referenceImageLimit && <span onClick={e => { e.stopPropagation(); fileRef.current?.click(); }} className="flex items-center gap-1 hover:text-primary transition-colors"><Plus size={12} />添加</span>}
            </button>
            {imgOpen && referenceUploadEnabled && (
              <div className="reference-panel p-3 border-t border-border">
                {images.length === 0 ? (
                  <div onClick={() => fileRef.current?.click()} className="border border-dashed border-border flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-primary transition-colors" style={{ height: 80, background: 'var(--color-bg)' }}><Upload size={18} className="text-text-2" /><span className="text-[11px] text-text-2">拖拽或点击上传（最多 {referenceImageLimit} 张）</span></div>
                ) : (
                  <div ref={referenceGridRef} className="reference-grid grid grid-cols-4 gap-2">
                    {images.map((img, idx) => (
                      <div
                        key={img.id}
                        data-reference-index={idx}
                        draggable={images.length > 1}
                        onDragStart={event => startReferenceHtmlDrag(event, idx)}
                        onDragOver={event => moveReferenceHtmlDrag(event, idx)}
                        onDrop={event => { event.preventDefault(); event.stopPropagation(); stopReferenceHtmlDrag(); }}
                        onDragEnd={stopReferenceHtmlDrag}
                        onPointerDown={event => startReferencePointerDrag(event, idx)}
                        onPointerMove={moveReferencePointerDragFromReact}
                        onPointerUp={stopReferencePointerDragFromReact}
                        onPointerCancel={stopReferencePointerDragFromReact}
                        onTouchStart={event => startReferenceTouchDrag(event, idx)}
                        className={`reference-thumb relative border cursor-grab active:cursor-grabbing ${img.uploading ? 'is-uploading' : ''} ${img.error ? 'is-error' : ''} ${dragIdx === idx ? 'opacity-40 border-primary' : 'border-border'}`}
                        style={{ aspectRatio: '1' }}
                      >
                        <img src={img.dataUrl} alt={img.name} draggable={false} loading="lazy" className="w-full h-full object-cover" />
                        <span className="absolute top-0 left-0 flex items-center justify-center text-white text-[10px] font-bold" style={{ width: 18, height: 18, background: 'var(--color-primary)' }}>{idx + 1}</span>
                        {img.uploading && (
                          <div className="reference-upload-overlay" aria-label={`参考图 ${idx + 1} 上传中`}>
                            <div className="reference-upload-ring" />
                            <div className="reference-upload-text">上传中</div>
                            <div className="reference-upload-bar"><span style={{ width: `${Math.max(8, Math.min(100, img.progress ?? 8))}%` }} /></div>
                          </div>
                        )}
                        {img.error && !img.uploading && (
                          <button
                            type="button"
                            className="reference-upload-error"
                            onClick={event => { event.stopPropagation(); void retryReferenceImage(img.id); }}
                            disabled={!img.uploadFile}
                            title={img.uploadFile ? '重新上传当前参考图' : img.error}
                          >
                            {img.uploadFile ? '点击重试' : img.error}
                          </button>
                        )}
                        <div className="reference-order-controls" aria-label={`调整参考图 ${idx + 1} 顺序`}>
                          <button type="button" onClick={event => { event.stopPropagation(); moveReferenceImage(img.id, -1); }} disabled={idx === 0} aria-label={`参考图 ${idx + 1} 前移`} title="前移"><ArrowLeft size={10} /></button>
                          <span className="reference-drag-handle" aria-hidden="true" title="拖动排序"><GripVertical size={12} /></span>
                          <button type="button" onClick={event => { event.stopPropagation(); moveReferenceImage(img.id, 1); }} disabled={idx === images.length - 1} aria-label={`参考图 ${idx + 1} 后移`} title="后移"><ArrowRight size={10} /></button>
                        </div>
                        <button onClick={() => removeImage(img.id)} className="absolute -top-1.5 -right-1.5 flex items-center justify-center border border-border bg-surface hover:bg-bg reference-remove-button" style={{ width: 18, height: 18, cursor: 'pointer' }}><X size={10} /></button>
                      </div>
                    ))}
                    {images.length < referenceImageLimit && <div onClick={() => fileRef.current?.click()} className="border border-dashed border-border flex items-center justify-center cursor-pointer hover:border-primary transition-colors" style={{ aspectRatio: '1', background: 'var(--color-bg)' }}><Plus size={18} className="text-text-2" /></div>}
                  </div>
                )}
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept={config.referenceImageAccept} multiple disabled={!referenceUploadEnabled} className="hidden" onChange={e => { processFiles(e.target.files); e.target.value = ''; }} />

          {/* 输出画幅使用统一比例语义，真实字段由 Worker 按站点协议转换。 */}
          <div className="generate-output-settings mt-3">
            <label className="generate-aspect-control" htmlFor="generate-aspect-ratio">
              <span className="generate-aspect-copy">
                <strong>画幅比例</strong>
                <small>{selectedAspectRatio.value === 'auto' ? '自动使用模型默认画幅' : '实际分辨率由所选模型决定'}</small>
              </span>
              <span
                className="generate-aspect-preview"
                aria-hidden="true"
              >
                <span style={{
                  width: `${selectedPreviewRatio >= 1 ? 100 : 100 * selectedPreviewRatio}%`,
                  height: `${selectedPreviewRatio >= 1 ? 100 / selectedPreviewRatio : 100}%`,
                }} />
              </span>
              <select
                id="generate-aspect-ratio"
                value={aspectRatio}
                disabled={loading}
                onChange={event => setAspectRatio(event.target.value as DrawingAspectRatio)}
                aria-label="选择生成画幅比例"
              >
                {availableAspectRatioOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.value === 'auto' ? '自动 · 模型默认' : `${option.value} · ${option.label}`}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {isVideoMode && (
            <div className="generate-output-settings generate-video-settings mt-2">
              <label className="generate-aspect-control generate-video-control">
                <span className="generate-aspect-copy"><strong>视频时长</strong><small>支持 1-15 秒</small></span>
                <select value={videoDuration} disabled={loading} onChange={event => setVideoDuration(Number(event.target.value))} aria-label="选择视频时长">
                  {Array.from({ length: 15 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} 秒</option>)}
                </select>
              </label>
              <label className="generate-aspect-control generate-video-control">
                <span className="generate-aspect-copy"><strong>视频分辨率</strong><small>由上游按档位输出</small></span>
                <select value={videoResolution} disabled={loading} onChange={event => setVideoResolution(event.target.value as DrawingVideoResolution)} aria-label="选择视频分辨率">
                  <option value="480p">480p</option>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p</option>
                </select>
              </label>
              <label className="generate-aspect-control generate-video-control generate-storyboard-control">
                <span className="generate-aspect-copy">
                  <strong>分镜设计</strong>
                  <small>{storyboardDesignAvailable ? '分析提示词与参考图，重新设计视频提示词' : '当前模型已在后台关闭'}</small>
                </span>
                <span className="generate-storyboard-toggle">
                  <input
                    type="checkbox"
                    checked={storyboardDesign}
                    disabled={loading || !storyboardDesignAvailable}
                    onChange={event => setStoryboardDesign(event.target.checked)}
                    aria-label="是否开启视频分镜设计"
                  />
                  <b>{storyboardDesign ? '开启' : '关闭'}</b>
                </span>
              </label>
            </div>
          )}

          {/* 生成按钮 */}
          <div className="generate-submit-row mt-3 flex items-stretch gap-2">
            <button onClick={submit} disabled={loading || !prompt.trim()}
              className="btn btn-lg flex-1 flex items-center justify-center gap-2 text-[15px]"
              style={{ height: 46, borderRadius: 12, fontWeight: 700, background: loading ? 'var(--color-primary)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
              {loading ? <><Loader2 size={18} className="animate-spin" />正在提交…</> : <><Sparkles size={18} />{isVideoMode ? (hasImages ? '开始参考图视频' : '开始文生视频') : hasImages ? '开始图生图' : '开始生成'}</>}
            </button>
            <div className="generate-count-control flex items-center border border-border bg-surface" title="本次生成张数">
              <span className="generate-count-label text-[11px] font-semibold text-text-2">N</span>
              <input
                type="number"
                min={1}
                max={multiConfig.enabled ? multiConfig.max : 1}
                value={generateCountInput}
                disabled={isVideoMode || !multiConfig.enabled || loading}
                onChange={event => {
                  const nextInput = event.target.value.replace(/\D/g, '');
                  setGenerateCountInput(nextInput);
                  if (nextInput) setGenerateCount(normalizeGenerateCountInput(nextInput, multiConfig.max));
                }}
                onBlur={() => {
                  const normalizedCount = normalizeGenerateCountInput(generateCountInput, multiConfig.max);
                  setGenerateCount(normalizedCount);
                  setGenerateCountInput(String(normalizedCount));
                }}
                className="generate-count-input"
                aria-label="本次生成张数"
              />
              <button
                type="button"
                className="generate-count-step"
                onClick={incrementGenerateCount}
                disabled={isVideoMode || !multiConfig.enabled || loading}
                aria-label="增加生成张数"
                title={`增加生成张数（1 到 ${multiConfig.max} 循环）`}
              >
                +
              </button>
            </div>
          </div>
      </div>

      {panelOpen && (
        <div className="task-panel-wrap flex px-3 sm:px-4 py-3 lg:py-5 items-start w-full sm:w-auto justify-center" style={{ flexShrink: 0 }}>
          <TaskPanel embedded onAddReference={addGeneratedImageToReferences} />
        </div>
      )}
    </div>
  );
}

/** 按原顺序执行有限并发上传；结果顺序必须与参考图顺序一致，不能影响多图语义。 */
async function uploadReferenceItemsWithConcurrency<T>(
  items: ImageItem[],
  upload: (item: ImageItem) => Promise<T>,
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.trunc(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await upload(items[index]!);
    }
  }));
  return results;
}

/** 从提交或恢复响应里读取外显任务 ID 和展示张数；多图提交统一外显为批次 ID。 */
function readVisibleTaskInfo(data: { task: { id: string; batchId?: string | null; batchTotal?: number | null }; batch?: { id: string; count?: number }; tasks?: { id: string; batchId?: string | null; batchTotal?: number | null }[] }) {
  const batchId = data.batch?.id || data.task.batchId || data.tasks?.find(item => item.batchId)?.batchId;
  const batchTotal = Math.max(1, data.batch?.count ?? data.task.batchTotal ?? data.tasks?.[0]?.batchTotal ?? 1);
  if (batchId && batchTotal > 1) return { ids: [batchId], count: batchTotal };
  const ids = data.tasks?.map(item => item.id).filter(Boolean);
  const visibleIds = ids && ids.length > 0 ? ids : [data.task.id];
  return { ids: visibleIds, count: visibleIds.length };
}

/** 读取参考图并准备内容哈希；预览改用 blob URL，避免大图转 base64 拖慢上传。 */
async function prepareReferenceFileForUpload(file: File) {
  const typedFile = ensureReferenceImageMimeType(file);
  const buffer = await typedFile.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const contentHash = await hashReferenceBytes(bytes);
  const uploadFile = await compressReferenceFileForUpload(typedFile, buffer);
  return { contentHash, uploadFile };
}

/** 判断浏览器文件是否属于参考图格式；MIME 缺失时按安全扩展名补充判断。 */
function isSupportedReferenceImageFile(file: File): boolean {
  return Boolean(inferReferenceImageMimeType(file));
}

/** 根据浏览器 MIME 或文件扩展名推断参考图 MIME，不为未知扩展伪造图片类型。 */
function inferReferenceImageMimeType(file: File): string | undefined {
  const declared = file.type.trim().toLowerCase();
  if (declared === 'image/jpg') return 'image/jpeg';
  if (config.referenceImageTypes.includes(declared)) return declared;
  const extension = file.name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const extensionMimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jfif: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    svg: 'image/svg+xml',
  };
  return extensionMimeTypes[extension];
}

/** 给 MIME 缺失或不规范的 File 补齐真实声明，确保二进制上传走 backend 图片分支。 */
function ensureReferenceImageMimeType(file: File): File {
  const mimeType = inferReferenceImageMimeType(file);
  if (!mimeType || file.type === mimeType) return file;
  return new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
}

/** 前端压缩大参考图，减少网页到 backend 的真实上传体积；失败时回退原图，后端仍做 3MB 兜底。 */
async function compressReferenceFileForUpload(file: File, buffer: ArrayBuffer): Promise<File> {
  if (file.size <= REFERENCE_CLIENT_COMPRESS_THRESHOLD_BYTES) return file;
  if (typeof document === 'undefined') return file;
  const source = new Blob([buffer], { type: file.type || 'image/png' });
  const bitmap = await loadReferenceImageBitmap(source).catch(() => null);
  if (!bitmap) return file;
  try {
    const scale = Math.min(1, REFERENCE_CLIENT_COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const compressed = await encodeReferenceCanvas(canvas);
    if (!compressed || compressed.size <= 0 || compressed.size >= file.size * 0.92) return file;
    return new File([compressed], buildCompressedReferenceName(file.name), { type: compressed.type || 'image/webp', lastModified: file.lastModified });
  } finally {
    if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

/** 解码参考图到浏览器位图；优先走 createImageBitmap，降低主线程图片元素布局参与度。 */
async function loadReferenceImageBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob, { imageOrientation: 'from-image' });
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('reference_image_decode_failed'));
      img.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 将参考图 canvas 编码为 WebP；逐步降低质量，优先保证上传体积明显小于原图。 */
async function encodeReferenceCanvas(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const quality of [0.86, 0.78, 0.7]) {
    const blob = await canvasToBlob(canvas, 'image/webp', quality);
    if (blob && blob.size <= REFERENCE_CLIENT_COMPRESS_TARGET_BYTES) return blob;
  }
  return canvasToBlob(canvas, 'image/webp', 0.64);
}

/** Promise 化 canvas.toBlob；部分浏览器编码失败时返回 null，由调用方回退原图。 */
function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), mimeType, quality));
}

/** 压缩后的上传文件名只用于调试和后端 MIME 判断，不参与最终媒体短文件名生成。 */
function buildCompressedReferenceName(name: string): string {
  const clean = name.trim() || 'reference-image';
  return clean.replace(/\.[a-z0-9]{2,5}$/i, '') + '.webp';
}

/** 参考图内容哈希；优先用 Web Crypto，失败时回落到本地 FNV1a。 */
async function hashReferenceBytes(bytes: Uint8Array) {
  if (globalThis.crypto?.subtle) {
    const digestInput = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return fallbackReferenceHash(bytes);
}

/** Web Crypto 不可用时的本地兜底哈希；带长度前缀降低小概率碰撞对去重的影响。 */
function fallbackReferenceHash(bytes: Uint8Array) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${bytes.length}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** 通过 XHR 上传参考图，以便获取浏览器真实上传进度；优先走二进制直传，旧 dataURL 只作为兼容兜底。 */
function uploadReferenceWithProgress(payload: File | string, mimeType: string, onProgress: (progress: number) => void): Promise<{ filename: string; url: string; size?: number; originalSize?: number; compressed?: boolean; mimeType?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${config.apiBase}/api/upload-reference`);
    const token = localStorage.getItem('token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (payload instanceof File) {
      xhr.setRequestHeader('Content-Type', payload.type || mimeType || 'application/octet-stream');
      xhr.setRequestHeader('x-aiimage-filename', encodeURIComponent(payload.name || 'reference-image'));
    } else {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        onProgress(18);
        return;
      }
      // 服务器保存和响应仍需时间，上传阶段最高显示到 92%，成功后再置满。
      onProgress(Math.min(92, Math.max(8, Math.round((event.loaded / event.total) * 92))));
    };
    xhr.onerror = () => reject(new ReferenceUploadError(BACKEND_UNREACHABLE, 0));
    xhr.onload = () => {
      const body = parseUploadResponse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && body.ok && body.data?.filename) {
        onProgress(100);
        resolve(body.data);
      } else {
        reject(new ReferenceUploadError(body.message || `上传失败：${xhr.status}`, xhr.status));
      }
    };
    if (payload instanceof File) {
      // 关键分支：网页新版本直接上传二进制，避免 base64 膨胀和 JSON 大字符串解析拖慢上传。
      xhr.send(payload);
    } else {
      const fileData = payload.includes('base64,') ? payload.split('base64,')[1] : payload;
      xhr.send(JSON.stringify({ fileData, mimeType }));
    }
  });
}

/** 参考图上传错误携带 HTTP 状态，用于区分可恢复拥塞与确定的图片校验失败。 */
class ReferenceUploadError extends Error {
  /** 仅网络异常、超时、限流和上游服务异常允许自动重试。 */
  readonly retryable: boolean;

  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ReferenceUploadError';
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}

/** 解析参考图上传响应；失败时返回稳定结构，避免 JSON 异常打断重试链路。 */
function parseUploadResponse(text: string): { ok: boolean; data?: { filename: string; url: string; size?: number; originalSize?: number; compressed?: boolean; mimeType?: string }; message?: string } {
  try {
    return JSON.parse(text) as { ok: boolean; data?: { filename: string; url: string; size?: number; originalSize?: number; compressed?: boolean; mimeType?: string }; message?: string };
  } catch {
    return { ok: false, message: '上传响应格式错误' };
  }
}

/** 从 /images/xxx 或完整 URL 中提取媒体短文件名，供图生图提交链路复用。 */
function extractMediaFilename(url: string) {
  const clean = String(url).split('?')[0] ?? '';
  const match = clean.match(/\/(?:api\/)?images\/([^/?#]+)$/);
  if (match?.[1]) return safeMediaFilename(decodeURIComponent(match[1]));
  if (!clean.startsWith('http://') && !clean.startsWith('https://') && !clean.includes('/')) {
    return safeMediaFilename(decodeURIComponent(clean));
  }
  return '';
}

/** 构建参考图确定性去重键；站内同一短文件名的不同 URL 形式视为重复。 */
function buildReferenceImageKey(value: string) {
  const filename = extractMediaFilename(value);
  if (filename) return `file:${filename}`;
  const clean = value.trim();
  return clean ? `raw:${clean}` : '';
}

/** 只接受站内媒体短文件名，避免外部同名图片被误判为重复。 */
function safeMediaFilename(value: string) {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(value) && !value.includes('..') ? value : '';
}

/** 根据指针坐标查找当前所在参考图索引，兼容手机触摸和桌面鼠标拖动。 */
function findReferenceIndexAtPoint(grid: HTMLDivElement | null, clientX: number, clientY: number) {
  if (!grid) return -1;
  const thumbs = Array.from(grid.querySelectorAll<HTMLElement>('[data-reference-index]'));
  for (const thumb of thumbs) {
    const rect = thumb.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return Number(thumb.dataset.referenceIndex);
    }
  }

  const gridRect = grid.getBoundingClientRect();
  const padding = 24;
  if (
    clientX < gridRect.left - padding ||
    clientX > gridRect.right + padding ||
    clientY < gridRect.top - padding ||
    clientY > gridRect.bottom + padding
  ) {
    return -1;
  }

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const thumb of thumbs) {
    const rect = thumb.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = Math.hypot(clientX - centerX, clientY - centerY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = Number(thumb.dataset.referenceIndex);
    }
  }
  return bestIndex;
}
