/** 本页面实现“图片拆分”工具：本地上传、按行列拆分、表格预览和下载。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Download, Loader2, Scissors, Upload, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Seo } from '../../../components/Seo';
import { ImageLightbox, type ImageLightboxItem } from '../../../components/image/ImageLightbox';
import { resolveMediaUrl } from '../../../lib/media';
import { useToolsConfig } from '../useToolsConfig';
import { recordToolUsage } from '../toolUsage';
import { GalleryImagePicker, type GalleryPickerImage } from './GalleryImagePicker';
import {
  buildSafeBaseName,
  buildSliceLabel,
  downloadBlob,
  loadImageFile,
  revokeSlices,
  splitImageToSlices,
  toExcelColumnLabel,
  type ImageSlice,
  type LoadedImageSource,
} from './image-splitter';
import { createStoreZip } from './zip-store';
import './ImageSplitterPage.css';

/** 图片拆分页面。 */
export function ImageSplitterPage() {
  const { getToolConfig } = useToolsConfig();
  const toolConfig = getToolConfig('image-splitter');
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<LoadedImageSource | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [slices, setSlices] = useState<ImageSlice[]>([]);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState('');
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [galleryPickerOpen, setGalleryPickerOpen] = useState(false);
  const [galleryLoadingText, setGalleryLoadingText] = useState('');
  const [leftColumnHeight, setLeftColumnHeight] = useState(0);
  const leftColumnRef = useRef<HTMLDivElement | null>(null);

  const enabled = toolConfig?.enabled !== false;
  const maxRows = toolConfig?.maxRows ?? 12;
  const maxCols = toolConfig?.maxCols ?? 12;
  const maxFileSizeMb = toolConfig?.maxFileSizeMb ?? 30;
  const defaultRows = toolConfig?.defaultRows ?? 3;
  const defaultCols = toolConfig?.defaultCols ?? 3;
  const rowHeaders = useMemo(() => Array.from({ length: rows }, (_, index) => toExcelColumnLabel(index + 1)), [rows]);
  const colHeaders = useMemo(() => Array.from({ length: cols }, (_, index) => String(index + 1)), [cols]);
  const previewAspect = source ? source.width / Math.max(1, source.height) : 1;
  const lightboxImages = useMemo<ImageLightboxItem[]>(() => slices.map((slice) => {
    const label = buildSliceLabel(slice.row, slice.col);
    return {
      src: slice.url,
      title: `${label} · ${slice.width} × ${slice.height}px`,
      downloadName: slice.filename,
      alt: `${label} 拆分结果`,
    };
  }), [slices]);

  useEffect(() => {
    setRows(defaultRows);
    setCols(defaultCols);
  }, [defaultRows, defaultCols]);

  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      revokeSlices(slices);
    };
  }, [sourceUrl, slices]);

  useEffect(() => {
    if (!file || !source) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      setPreviewBusy(true);
      buildSlices()
        .then((list) => {
          if (!alive) {
            revokeSlices(list);
            return;
          }
          replaceSlices(list);
          setError('');
        })
        .catch((err) => {
          if (!alive) return;
          const text = err instanceof Error ? err.message : '预览生成失败';
          setError(text);
        })
        .finally(() => {
          if (alive) setPreviewBusy(false);
        });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [cols, file, rows, source]);

  useEffect(() => {
    const node = leftColumnRef.current;
    if (!node) return undefined;
    // 默认预览态需要与左侧返回按钮加上传规则区域底部对齐，使用实测高度避免响应式布局下估算偏差。
    const updateHeight = () => setLeftColumnHeight(Math.ceil(node.getBoundingClientRect().height));
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const summary = useMemo(() => {
    if (!source) return '未加载图片';
    return `${source.width} × ${source.height}，拆分为 ${rows} × ${cols} = ${rows * cols} 张`;
  }, [rows, cols, source]);

  /** 处理本地文件输入。 */
  const onFileChange = async (picked: File | null) => {
    clearOutput();
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
    setBusy(true);
    try {
      const loaded = await loadImageFile(picked);
      setFile(picked);
      setSource(loaded);
      setSourceUrl(loaded.objectUrl);
      setError('');
    } catch (err) {
      const text = err instanceof Error ? err.message : '图片加载失败';
      setError(text);
    } finally {
      setBusy(false);
    }
  };

  /** 从当前用户图片记录选择时，必须下载 imageUrl 原图并转换成 File 后复用本地上传链路。 */
  const selectGalleryImage = async (image: GalleryPickerImage) => {
    if (!image.imageUrl || busy) return;
    setGalleryPickerOpen(false);
    setGalleryLoadingText('正在载入原图');
    setBusy(true);
    try {
      const token = localStorage.getItem('token') ?? '';
      const response = await fetch(resolveMediaUrl(image.imageUrl), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error('原图读取失败，请稍后重试');
      const blob = await response.blob();
      const fileName = buildGalleryImageFileName(image, response.headers.get('Content-Type') || blob.type);
      await onFileChange(new File([blob], fileName, { type: blob.type || response.headers.get('Content-Type') || 'image/png' }));
    } catch (err) {
      const text = err instanceof Error ? err.message : '原图读取失败';
      setError(text);
    } finally {
      setGalleryLoadingText('');
      setBusy(false);
    }
  };

  /** 手动刷新预览。 */
  const refreshPreview = async () => {
    if (!file || !source || busy) return;
    setBusy(true);
    try {
      const list = await buildSlices();
      replaceSlices(list);
      setError('');
    } catch (err) {
      const text = err instanceof Error ? err.message : '拆分失败';
      setError(text);
    } finally {
      setBusy(false);
    }
  };

  /** 下载单张切片。 */
  const downloadSlice = (slice: ImageSlice) => {
    downloadBlob(slice.blob, slice.filename);
  };

  /** 打开对应切片的灯箱，预览窗口和下载矩阵共用同一组图片顺序。 */
  const openSliceLightbox = (slice: ImageSlice) => {
    const index = slices.findIndex((item) => item.filename === slice.filename);
    if (index < 0) return;
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  /** 异步打包并下载。 */
  const downloadAllAsync = async () => {
    if (!file || !source || busy) return;
    setBusy(true);
    let temporarySlices: ImageSlice[] | null = null;
    try {
      const currentSlices = slices.length > 0 ? slices : await buildSlices();
      if (slices.length === 0) temporarySlices = currentSlices;
      if (currentSlices.length === 0) return;
      if (currentSlices.length === 1) {
        downloadSlice(currentSlices[0]);
        recordToolUsage('image-splitter');
        return;
      }
      const zip = createStoreZip(
        await Promise.all(
          currentSlices.map(async (slice) => ({
            name: slice.filename,
            data: new Uint8Array(await slice.blob.arrayBuffer()),
            modifiedAt: new Date(),
          })),
        ),
      );
      const fileName = `${buildSafeBaseName(file?.name ?? 'image')}_${rows}x${cols}.zip`;
      downloadBlob(zip, fileName);
      recordToolUsage('image-splitter');
    } catch (err) {
      const text = err instanceof Error ? err.message : '打包失败';
      setError(text);
    } finally {
      if (temporarySlices) revokeSlices(temporarySlices);
      setBusy(false);
    }
  };

  /** 清空当前输出。 */
  const clearOutput = (clearFile = true) => {
    setError('');
    if (clearFile) {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      setFile(null);
      setSource(null);
      setSourceUrl('');
    }
    revokeSlices(slices);
    setSlices([]);
  };

  /** 按当前图片和行列生成切片，不直接写入状态，便于预览和下载共用。 */
  const buildSlices = async () => {
    if (!file || !source) return [];
    const baseName = buildSafeBaseName(file.name);
    return splitImageToSlices(source, rows, cols, baseName);
  };

  /** 替换切片列表前释放旧 URL，避免实时预览反复生成时占用内存。 */
  const replaceSlices = (next: ImageSlice[]) => {
    setSlices((prev) => {
      revokeSlices(prev);
      return next;
    });
  };

  if (!enabled) {
    return (
      <div className="tool-page-shell">
        <Seo title="图片拆分" description="绘图姬 DrawHime 图片拆分工具。" path="/tools/image-splitter" />
        <div className="tool-disabled">
          <h1>图片拆分</h1>
          <p>该工具当前未开放。</p>
          <Link to="/tools" className="btn btn-outline btn-sm"><ArrowLeft size={14} />返回工具中心</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="tool-page-shell">
      <Seo title="图片拆分" description="上传一张图片，按行列拆分为多张图片并本地打包下载。" path="/tools/image-splitter" />
      <section className="tool-split-workbench">
        <div className="tool-workbench-left" ref={leftColumnRef}>
          <Link to="/tools" className="tool-back-strip"><ArrowLeft size={14} />返回工具中心</Link>
          <aside className="tool-panel tool-upload-panel">
            <div className="tool-panel-title">
              <h2>上传与规则</h2>
              <span>{summary}</span>
            </div>

            <button
              type="button"
              className="tool-gallery-select-button"
              onClick={() => setGalleryPickerOpen(true)}
              disabled={busy || previewBusy}
            >
              {galleryLoadingText ? <Loader2 size={13} className="animate-spin" /> : null}
              {galleryLoadingText || '从我的图片选择'}
            </button>
            {galleryLoadingText && <div className="tool-gallery-loading-note">正在下载该记录的原图，请稍候。</div>}

            <div className="tool-upload-field">
              <label
                className={`tool-dropzone${file ? ' has-image' : ''}`}
                onDrop={(e) => {
                  e.preventDefault();
                  void onFileChange(e.dataTransfer.files?.[0] ?? null);
                }}
                onDragOver={(e) => e.preventDefault()}
              >
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => void onFileChange(e.target.files?.[0] ?? null)}
                />
                {file && sourceUrl ? (
                  <div className="tool-dropzone-filled">
                    <img src={sourceUrl} alt="上传图片预览" />
                    <div className="tool-upload-meta">
                      <strong>点击更换图片</strong>
                      <span>{source ? `${source.width} × ${source.height}` : ''} · {(file.size / 1024 / 1024).toFixed(2)} MB</span>
                    </div>
                  </div>
                ) : (
                  <div className="tool-dropzone-empty">
                    <Upload size={18} />
                    <span>点击选择图片，或把图片拖进来</span>
                  </div>
                )}
              </label>
              {file && (
                <button
                  type="button"
                  className="tool-upload-clear"
                  onClick={() => clearOutput()}
                  aria-label="清空上传图片"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="tool-grid-controls">
              <label>
                <span>行</span>
                <input type="number" min={1} max={maxRows} value={rows} onChange={(e) => setRows(clampNumber(e.target.value, 1, maxRows))} />
              </label>
              <label>
                <span>列</span>
                <input type="number" min={1} max={maxCols} value={cols} onChange={(e) => setCols(clampNumber(e.target.value, 1, maxCols))} />
              </label>
            </div>

            {error && <div className="tool-status"><strong className="is-error">{error}</strong></div>}
          </aside>
        </div>

        <section
          className={`tool-panel tool-preview-panel${!source ? ' is-empty' : ''}`}
          style={!source && leftColumnHeight > 0 ? { minHeight: leftColumnHeight } : undefined}
        >
          <div className="tool-panel-title">
            <div>
              <h2>预览与下载</h2>
            </div>
            <div className="tool-preview-actions">
              <button type="button" className="btn btn-sm btn-outline" onClick={() => void refreshPreview()} disabled={!file || busy || previewBusy}>
                {busy || previewBusy ? <Loader2 size={13} className="animate-spin" /> : <Scissors size={13} />}
                刷新预览
              </button>
            </div>
          </div>

          {!source && <div className="tool-empty-state">先上传一张图片，右侧会实时展示拆分后的表格预览和下载列表。</div>}

          {previewBusy && (
            <div className="tool-preview-loading">
              <Loader2 size={16} className="animate-spin" />
              正在生成实时预览
            </div>
          )}

          {slices.length > 0 && (
            <>
              <div className="tool-preview-sheet-wrap">
                <div className="tool-preview-sheet">
                  <div className="tool-preview-corner" />
                  <div className="tool-preview-col-band" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                    {colHeaders.map((label) => <div key={`col-${label}`} className="tool-preview-col-head">{label}</div>)}
                  </div>
                  <div className="tool-preview-row-band" style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
                    {rowHeaders.map((label) => <div key={`row-${label}`} className="tool-preview-row-head">{label}</div>)}
                  </div>
                  <div
                    className="tool-preview-image-grid"
                    style={{
                      aspectRatio: `${previewAspect}`,
                      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
                    }}
                  >
                    {slices.map((slice) => (
                      <button
                        key={slice.filename}
                        type="button"
                        className="tool-preview-cell"
                        style={{ gridColumn: slice.col, gridRow: slice.row }}
                        onClick={() => openSliceLightbox(slice)}
                        aria-label={`预览 ${buildSliceLabel(slice.row, slice.col)}`}
                      >
                        <img src={slice.url} alt={buildSliceLabel(slice.row, slice.col)} />
                        <span>{buildSliceLabel(slice.row, slice.col)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <section className="tool-download-section">
                <div className="tool-download-head">
                  <div>
                    <h3>下载列表</h3>
                    <span>{rows} 行 × {cols} 列，共 {slices.length} 个切片</span>
                  </div>
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => void downloadAllAsync()} disabled={!file || busy || previewBusy}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    {rows * cols <= 1 ? '下载切片' : '下载全部'}
                  </button>
                </div>
                <div
                  className="tool-download-list"
                  style={{
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  }}
                >
                  {slices.map((slice) => (
                    <article
                      key={slice.filename}
                      className="tool-download-cell"
                      style={{
                        gridColumn: slice.col,
                        gridRow: slice.row,
                      }}
                      role="button"
                      tabIndex={0}
                      onClick={() => openSliceLightbox(slice)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openSliceLightbox(slice);
                        }
                      }}
                    >
                      <div>
                        <strong>{buildSliceLabel(slice.row, slice.col)}</strong>
                        <span>{slice.width} × {slice.height}px</span>
                        <span>{formatBytes(slice.blob.size)}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline"
                        onClick={(event) => {
                          event.stopPropagation();
                          downloadSlice(slice);
                        }}
                      >
                        <Download size={13} />
                        下载
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </section>
      </section>
      <ImageLightbox
        open={lightboxOpen}
        images={lightboxImages}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxOpen(false)}
      />
      <GalleryImagePicker
        open={galleryPickerOpen}
        onClose={() => setGalleryPickerOpen(false)}
        onSelect={(image) => void selectGalleryImage(image)}
      />
    </div>
  );
}

/** 为从图库载入的原图生成稳定文件名，优先保留原图 URL 中的扩展名。 */
function buildGalleryImageFileName(image: GalleryPickerImage, contentType?: string): string {
  const raw = image.imageUrl?.split('?')[0]?.split('/').pop() ?? '';
  const match = raw.match(/\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i);
  if (match) return raw;
  const ext = contentType?.includes('jpeg') ? 'jpg'
    : contentType?.includes('webp') ? 'webp'
      : contentType?.includes('gif') ? 'gif'
        : 'png';
  return `${image.id || 'gallery-image'}.${ext}`;
}

/** 把输入内容安全转成整数并限制范围。 */
function clampNumber(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

/** 格式化切片大小，下载列表展示用。 */
function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}
