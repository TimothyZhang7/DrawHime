/** 本页面提供合并后的“格式转换与压缩”工具，全部图片处理均在用户浏览器内完成。 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowLeft, CheckCircle2, Download, FileArchive, ImageDown, Loader2, Trash2, Upload, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Seo } from '../../../components/Seo';
import { createStoreZip } from '../image-splitter/zip-store';
import { recordToolUsage } from '../toolUsage';
import { useToolsConfig } from '../useToolsConfig';
import {
  convertImageFile,
  downloadImageBlob,
  isSupportedImageFile,
  type ImageConvertResult,
  type ImageOutputFormat,
} from './image-converter';
import './ImageConverterPage.css';

/** 页面中的单张处理结果。 */
interface BatchResult {
  /** 输入文件。 */
  source: File;
  /** 成功时的转换结果。 */
  output?: ImageConvertResult;
  /** 输出图预览地址。 */
  previewUrl?: string;
  /** 失败时的可见错误。 */
  error?: string;
}

/** 格式转换与压缩页面。 */
export function ImageConverterPage() {
  const { loading, getToolConfig } = useToolsConfig();
  const toolConfig = getToolConfig('image-converter');
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState<ImageOutputFormat>('webp');
  const [quality, setQuality] = useState(82);
  const [maxEdge, setMaxEdge] = useState(0);
  const [targetEnabled, setTargetEnabled] = useState(false);
  const [targetKb, setTargetKb] = useState(500);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const defaultsAppliedRef = useRef(false);
  const resultsRef = useRef<BatchResult[]>([]);

  const enabled = toolConfig?.enabled !== false;
  const maxFileSizeMb = toolConfig?.maxFileSizeMb ?? 30;
  const maxBatchCount = toolConfig?.convertMaxBatchCount ?? 20;
  const successResults = useMemo(() => results.filter((item) => item.output), [results]);

  useEffect(() => {
    if (!toolConfig || defaultsAppliedRef.current) return;
    defaultsAppliedRef.current = true;
    setFormat(toolConfig.convertDefaultFormat ?? 'webp');
    setQuality(toolConfig.convertDefaultQuality ?? 82);
  }, [toolConfig]);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => () => releaseResultUrls(resultsRef.current), []);

  useEffect(() => {
    if (format === 'png') setTargetEnabled(false);
  }, [format]);

  /** 校验并载入一批本地图片，新的选择会替换旧批次。 */
  const selectFiles = (picked: File[]) => {
    setDragging(false);
    setError('');
    if (busy || picked.length === 0) return;
    const supported = picked.filter(isSupportedImageFile);
    if (supported.length !== picked.length) {
      setError('仅支持 PNG、JPEG、WebP 和 BMP 静态图片。');
      return;
    }
    if (supported.length > maxBatchCount) {
      setError(`一次最多处理 ${maxBatchCount} 张图片。`);
      return;
    }
    const oversized = supported.find((file) => file.size > maxFileSizeMb * 1024 * 1024);
    if (oversized) {
      setError(`${oversized.name} 超过 ${maxFileSizeMb}MB 单文件限制。`);
      return;
    }
    releaseResultUrls(results);
    setResults([]);
    setFiles(supported);
    setProgress(`已选择 ${supported.length} 张图片`);
  };

  /** 接收拖入文件并复用统一校验。 */
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    selectFiles(Array.from(event.dataTransfer.files));
  };

  /** 顺序转换整批图片，避免并行创建多个大画布导致浏览器内存峰值过高。 */
  const runBatch = async () => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError('');
    releaseResultUrls(results);
    setResults([]);
    const nextResults: BatchResult[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const source = files[index];
      setProgress(`正在处理 ${index + 1} / ${files.length}：${source.name}`);
      try {
        const output = await convertImageFile(source, {
          format,
          quality,
          maxEdge: maxEdge || undefined,
          targetBytes: targetEnabled && format !== 'png' ? targetKb * 1024 : undefined,
        });
        nextResults.push({ source, output, previewUrl: URL.createObjectURL(output.blob) });
      } catch (batchError) {
        nextResults.push({ source, error: batchError instanceof Error ? batchError.message : '图片处理失败' });
      }
      setResults([...nextResults]);
      // 主动让出事件循环，使长批次处理期间页面进度仍可刷新。
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    const succeeded = nextResults.filter((item) => item.output).length;
    setProgress(`处理完成：成功 ${succeeded} 张，失败 ${nextResults.length - succeeded} 张`);
    if (succeeded > 0) recordToolUsage('image-converter');
    setBusy(false);
  };

  /** 下载全部成功结果；多张图片使用无压缩 ZIP，避免重复损失画质。 */
  const downloadAll = async () => {
    if (successResults.length === 0) return;
    if (successResults.length === 1) {
      const result = successResults[0].output!;
      downloadImageBlob(result.blob, result.filename);
      return;
    }
    const usedNames = new Map<string, number>();
    const entries = await Promise.all(successResults.map(async (item) => {
      const output = item.output!;
      const count = usedNames.get(output.filename) ?? 0;
      usedNames.set(output.filename, count + 1);
      const name = count === 0 ? output.filename : addFilenameSuffix(output.filename, count + 1);
      return { name, data: new Uint8Array(await output.blob.arrayBuffer()), modifiedAt: new Date() };
    }));
    downloadImageBlob(createStoreZip(entries), `converted_${Date.now()}.zip`);
  };

  /** 清空输入和输出，并释放所有对象 URL。 */
  const clearBatch = () => {
    releaseResultUrls(results);
    setFiles([]);
    setResults([]);
    setProgress('');
    setError('');
  };

  if (!loading && !enabled) {
    return (
      <div className="converter-shell">
        <Seo title="格式转换与压缩" description="绘图姬 DrawHime 图片格式转换与压缩工具。" path="/tools/image-converter" />
        <div className="tool-disabled">
          <h1>格式转换与压缩</h1>
          <p>该工具当前未开放。</p>
          <Link to="/tools" className="btn btn-outline btn-sm"><ArrowLeft size={14} />返回工具中心</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="converter-shell">
      <Seo title="格式转换与压缩" description="批量转换 PNG、JPEG、WebP，并按质量、尺寸或目标体积在浏览器本地压缩。" path="/tools/image-converter" />
      <Link to="/tools" className="tool-back-strip"><ArrowLeft size={14} />返回工具中心</Link>

      <header className="converter-header">
        <div>
          <span className="converter-kicker"><ImageDown size={15} />本地图片工具</span>
          <h1>格式转换与压缩</h1>
          <p>转换格式、缩小尺寸和控制文件体积集中在同一个工具中。图片仅在当前浏览器处理。</p>
        </div>
        <div className="converter-privacy">不上传原图</div>
      </header>

      <section className="converter-workbench">
        <div className="converter-controls">
          <label
            className={`converter-dropzone${dragging ? ' is-dragging' : ''}${files.length ? ' has-files' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
            onDrop={onDrop}
          >
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/bmp,.bmp"
              disabled={busy}
              onChange={(event) => selectFiles(Array.from(event.target.files ?? []))}
            />
            <Upload size={22} />
            <strong>{dragging ? '松开导入图片' : files.length ? `已选择 ${files.length} 张图片` : '选择或拖入图片'}</strong>
            <span>PNG / JPEG / WebP / BMP · 单张最大 {maxFileSizeMb}MB · 每批最多 {maxBatchCount} 张</span>
          </label>

          {files.length > 0 && (
            <div className="converter-file-list">
              {files.map((file, index) => <span key={`${file.name}-${file.lastModified}-${index}`}>{file.name}<small>{formatBytes(file.size)}</small></span>)}
            </div>
          )}

          <div className="converter-setting-group">
            <div className="converter-setting-title"><strong>输出格式</strong><span>转换</span></div>
            <div className="converter-format-grid">
              {(['webp', 'jpeg', 'png'] as ImageOutputFormat[]).map((item) => (
                <button key={item} type="button" className={format === item ? 'is-active' : ''} onClick={() => setFormat(item)} disabled={busy}>
                  {item === 'jpeg' ? 'JPEG' : item.toUpperCase()}
                  <small>{item === 'png' ? '无损' : item === 'webp' ? '体积更小' : '兼容广泛'}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="converter-setting-group">
            <div className="converter-setting-title"><strong>压缩设置</strong><span>{format === 'png' ? '无损输出' : `质量 ${quality}`}</span></div>
            <label className={`converter-range${format === 'png' ? ' is-disabled' : ''}`}>
              <span>图片质量</span>
              <input type="range" min={10} max={100} value={quality} disabled={format === 'png' || busy} onChange={(event) => setQuality(Number(event.target.value))} />
              <output>{format === 'png' ? '—' : quality}</output>
            </label>
            <label className="converter-select-row">
              <span>最长边</span>
              <select value={maxEdge} disabled={busy} onChange={(event) => setMaxEdge(Number(event.target.value))}>
                <option value={0}>保持原尺寸</option>
                <option value={4096}>4096 px</option>
                <option value={2048}>2048 px</option>
                <option value={1024}>1024 px</option>
              </select>
            </label>
            <label className={`converter-target-row${format === 'png' ? ' is-disabled' : ''}`}>
              <input type="checkbox" checked={targetEnabled} disabled={format === 'png' || busy} onChange={(event) => setTargetEnabled(event.target.checked)} />
              <span>限制每张最大体积</span>
              <input type="number" min={20} max={51200} value={targetKb} disabled={!targetEnabled || format === 'png' || busy} onChange={(event) => setTargetKb(clampNumber(event.target.value, 20, 51200))} />
              <b>KB</b>
            </label>
            {format === 'png' && <p className="converter-note">PNG 使用无损编码，质量和目标体积不适用；可通过缩小最长边降低体积。</p>}
          </div>

          {error && <div className="converter-alert"><XCircle size={15} />{error}</div>}
          <div className="converter-actions">
            <button type="button" className="btn btn-primary" disabled={files.length === 0 || busy} onClick={() => void runBatch()}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ImageDown size={16} />}
              {busy ? '处理中' : '开始转换与压缩'}
            </button>
            <button type="button" className="btn btn-outline" disabled={busy || (files.length === 0 && results.length === 0)} onClick={clearBatch}><Trash2 size={15} />清空</button>
          </div>
        </div>

        <div className="converter-results">
          <div className="converter-results-head">
            <div><h2>处理结果</h2><span>{progress || '结果会逐张显示在这里'}</span></div>
            <button type="button" className="btn btn-outline btn-sm" disabled={successResults.length === 0 || busy} onClick={() => void downloadAll()}>
              {successResults.length > 1 ? <FileArchive size={14} /> : <Download size={14} />}
              {successResults.length > 1 ? '下载 ZIP' : '下载结果'}
            </button>
          </div>

          {results.length === 0 ? (
            <div className="converter-empty"><ImageDown size={36} /><strong>等待图片</strong><span>支持一次处理多张，输出不会写入图库。</span></div>
          ) : (
            <div className="converter-result-list">
              {results.map((item, index) => (
                <article key={`${item.source.name}-${index}`} className={item.output ? 'is-success' : 'is-error'}>
                  <div className="converter-result-preview">
                    {item.previewUrl ? <img src={item.previewUrl} alt={`${item.source.name} 转换结果`} /> : <XCircle size={25} />}
                  </div>
                  <div className="converter-result-info">
                    <strong>{item.output?.filename ?? item.source.name}</strong>
                    {item.output ? (
                      <>
                        <span>{item.output.width} × {item.output.height} · {formatBytes(item.output.blob.size)}</span>
                        <small>{buildSavingText(item.source.size, item.output.blob.size)}{item.output.quality ? ` · 实际质量 ${item.output.quality}` : ''}</small>
                        {item.output.targetReached === false && <small className="is-warning">最低质量仍超过目标体积，可继续缩小最长边。</small>}
                      </>
                    ) : <span>{item.error}</span>}
                  </div>
                  {item.output && <button type="button" onClick={() => downloadImageBlob(item.output!.blob, item.output!.filename)} title="下载"><Download size={16} /></button>}
                  {item.output && <CheckCircle2 size={16} className="converter-success-icon" />}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** 释放批次结果持有的预览 URL，避免重复处理后持续占用浏览器内存。 */
function releaseResultUrls(results: BatchResult[]): void {
  for (const result of results) if (result.previewUrl) URL.revokeObjectURL(result.previewUrl);
}

/** 格式化文件大小。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 生成压缩前后体积变化文案，转换后变大时如实显示。 */
function buildSavingText(sourceBytes: number, outputBytes: number): string {
  const change = Math.round((1 - outputBytes / Math.max(1, sourceBytes)) * 100);
  return change >= 0 ? `比原图节省 ${change}%` : `比原图增大 ${Math.abs(change)}%`;
}

/** 同名 ZIP 条目增加数字后缀，避免批量下载覆盖。 */
function addFilenameSuffix(filename: string, count: number): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)}_${count}${filename.slice(dot)}` : `${filename}_${count}`;
}

/** 把数字输入限制到整数范围。 */
function clampNumber(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}
