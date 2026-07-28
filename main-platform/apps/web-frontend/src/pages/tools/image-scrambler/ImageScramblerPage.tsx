/** 本页面实现“图片混淆”工具：用户上传一张图片后即可一键混淆、解混淆、还原和下载。 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowLeft, Download, EyeOff, Loader2, RotateCcw, Undo2, Upload, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Seo } from '../../../components/Seo';
import { useToolsConfig } from '../useToolsConfig';
import { recordToolUsage } from '../toolUsage';
import {
  buildSafeBaseName,
  createImageStateFromLoaded,
  createImageStateFromResult,
  downloadBlob,
  loadImageFile,
  processGilbertScramble,
  revokeScrambleResult,
  type ImageScrambleResult,
  type LoadedImageSource,
  type ScramblerImageState,
  type ScramblerMode,
} from './image-scrambler';
import './ImageScramblerPage.css';

/** 图片混淆页面。 */
export function ImageScramblerPage() {
  const { getToolConfig } = useToolsConfig();
  const toolConfig = getToolConfig('image-scrambler');
  const [file, setFile] = useState<File | null>(null);
  const [original, setOriginal] = useState<LoadedImageSource | null>(null);
  const [current, setCurrent] = useState<ScramblerImageState | null>(null);
  const [result, setResult] = useState<ImageScrambleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('选择一张图片开始处理');
  const latestOriginalUrlRef = useRef('');
  const latestResultUrlRef = useRef('');

  const enabled = toolConfig?.enabled !== false;
  const maxFileSizeMb = toolConfig?.maxFileSizeMb ?? 30;

  useEffect(() => {
    latestOriginalUrlRef.current = original?.objectUrl ?? '';
    latestResultUrlRef.current = result?.url ?? '';
  }, [original, result]);

  useEffect(() => {
    return () => releaseUrls(latestOriginalUrlRef.current, latestResultUrlRef.current);
    // 页面卸载时通过 ref 释放最新对象 URL，避免清理函数拿到初始空状态。
  }, []);

  /** 处理本地文件输入。 */
  const onFileChange = async (picked: File | null) => {
    setDragging(false);
    releaseAll();
    if (!picked) {
      resetState();
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
    setBusy(true);
    setError('');
    try {
      const loaded = await loadImageFile(picked);
      setFile(picked);
      setOriginal(loaded);
      setCurrent(createImageStateFromLoaded(loaded));
      setStatus(`${loaded.width} × ${loaded.height}`);
    } catch (err) {
      resetState();
      setError(err instanceof Error ? err.message : '图片加载失败');
    } finally {
      setBusy(false);
    }
  };

  /** 拖入图片时阻止浏览器默认打开文件，并给上传区域增加明确反馈。 */
  const onDragOverImage = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) setDragging(true);
  };

  /** 离开上传区域时移除拖拽高亮，避免子元素切换导致状态误清。 */
  const onDragLeaveImage = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragging(false);
  };

  /** 处理拖拽释放的文件，复用同一套本地图片校验与读取逻辑。 */
  const onDropImage = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (busy) return;
    const dropped = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/')) ?? null;
    if (!dropped) {
      setError('请拖入图片文件。');
      return;
    }
    void onFileChange(dropped);
  };

  /** 执行参考页同款 Gilbert 曲线混淆或解混淆。 */
  const runProcess = async (mode: ScramblerMode) => {
    if (!file || !current) return;
    setBusy(true);
    setError('');
    setStatus(mode === 'scramble' ? '正在生成混淆图...' : '正在解混淆...');
    try {
      const next = await processGilbertScramble(current, file.name, mode);
      const nextState = await createImageStateFromResult(next);
      if (result) revokeScrambleResult(result);
      setResult(next);
      setCurrent(nextState);
      setStatus(mode === 'scramble' ? '已生成混淆图，可直接下载' : '已执行解混淆，可直接下载');
      recordToolUsage('image-scrambler');
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片处理失败');
      setStatus(current ? `${current.width} × ${current.height}` : '处理失败');
    } finally {
      setBusy(false);
    }
  };

  /** 还原到最初上传的图片，不重新读取磁盘文件。 */
  const restoreOriginal = () => {
    if (!original) return;
    if (result) revokeScrambleResult(result);
    setResult(null);
    setCurrent(createImageStateFromLoaded(original));
    setError('');
    setStatus(`${original.width} × ${original.height}`);
  };

  /** 下载当前显示图片；未处理时下载原文件，处理后下载 JPEG 结果。 */
  const downloadCurrent = () => {
    if (!file) return;
    if (result) {
      downloadBlob(result.blob, result.filename);
      return;
    }
    downloadBlob(file, `${buildSafeBaseName(file.name)}_original${getFileExtension(file.name)}`);
  };

  /** 清空当前工具状态。 */
  const clearImage = () => {
    releaseAll();
    resetState();
  };

  /** 重置 React 状态，不负责释放 URL。 */
  const resetState = () => {
    setFile(null);
    setOriginal(null);
    setCurrent(null);
    setResult(null);
    setBusy(false);
    setDragging(false);
    setError('');
    setStatus('选择一张图片开始处理');
  };

  /** 释放当前持有的对象 URL；原图和结果 URL 分开判断，避免重复释放同一个地址。 */
  const releaseAll = () => {
    releaseUrls(original?.objectUrl ?? '', result?.url ?? '');
  };

  if (!enabled) {
    return (
      <div className="scrambler-shell">
        <Seo title="图片混淆" description="绘图姬 DrawHime 图片混淆工具。" path="/tools/image-scrambler" />
        <div className="tool-disabled">
          <h1>图片混淆</h1>
          <p>该工具当前未开放。</p>
          <Link to="/tools" className="btn btn-outline btn-sm"><ArrowLeft size={14} />返回工具中心</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="scrambler-shell">
      <Seo title="图片混淆" description="上传一张图片后，一键使用空间填充曲线完成混淆或解混淆。" path="/tools/image-scrambler" />
      <Link to="/tools" className="tool-back-strip"><ArrowLeft size={14} />返回工具中心</Link>

      <section className="scrambler-workbench">
        <header className="scrambler-head">
          <div>
            <h1>图片混淆</h1>
            <p>上传一张图片后直接点击混淆或解混淆，处理过程只在当前浏览器执行。</p>
          </div>
          <span>{status}</span>
        </header>

        <label
          className={`scrambler-dropzone${current ? ' has-image' : ''}${dragging ? ' is-dragging' : ''}`}
          onDragEnter={onDragOverImage}
          onDragOver={onDragOverImage}
          onDragLeave={onDragLeaveImage}
          onDrop={onDropImage}
        >
          <input type="file" accept="image/*" onChange={(event) => void onFileChange(event.target.files?.[0] ?? null)} />
          {current ? (
            <img src={current.url} alt="当前处理图片" />
          ) : (
            <div>
              {busy ? <Loader2 size={24} className="animate-spin" /> : <Upload size={24} />}
              <strong>{dragging ? '松开导入图片' : '选择或拖入图片'}</strong>
              <small>支持浏览器可读取的大部分图片格式，最大 {maxFileSizeMb}MB</small>
            </div>
          )}
        </label>

        {current && (
          <div className="scrambler-filebar">
            <span>{file?.name}</span>
            <button type="button" onClick={clearImage} title="清空图片"><X size={15} /></button>
          </div>
        )}

        {error && <div className="scrambler-alert is-error">{error}</div>}

        <div className="scrambler-actions" aria-label="图片混淆操作">
          <button type="button" className="scrambler-action is-primary" onClick={() => void runProcess('scramble')} disabled={!current || busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <EyeOff size={16} />}
            混淆
          </button>
          <button type="button" className="scrambler-action is-accent" onClick={() => void runProcess('restore')} disabled={!current || busy}>
            <Undo2 size={16} />
            解混淆
          </button>
          <button type="button" className="scrambler-action" onClick={restoreOriginal} disabled={!original || busy}>
            <RotateCcw size={16} />
            还原
          </button>
          <button type="button" className="scrambler-action" onClick={downloadCurrent} disabled={!current || busy}>
            <Download size={16} />
            下载
          </button>
        </div>
      </section>
    </div>
  );
}

/** 保留原文件扩展名用于下载未处理图片。 */
function getFileExtension(filename: string): string {
  const match = filename.match(/\.[a-z0-9]+$/i);
  return match?.[0] ?? '';
}

/** 释放对象 URL，同一地址只释放一次，避免当前原图和结果指向相同 URL 时重复处理。 */
function releaseUrls(originalUrl: string, resultUrl: string): void {
  if (originalUrl) URL.revokeObjectURL(originalUrl);
  if (resultUrl && resultUrl !== originalUrl) URL.revokeObjectURL(resultUrl);
}
