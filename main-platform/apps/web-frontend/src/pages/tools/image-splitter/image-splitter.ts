/** 本文件实现图片拆分工具的浏览器端核心逻辑：加载图片、裁切网格、触发下载。 */

/** 单张图片切片。 */
export interface ImageSlice {
  /** 切片顺序，从 1 开始。 */
  index: number;
  /** 所在行，从 1 开始。 */
  row: number;
  /** 所在列，从 1 开始。 */
  col: number;
  /** 切片宽度。 */
  width: number;
  /** 切片高度。 */
  height: number;
  /** PNG Blob。 */
  blob: Blob;
  /** 本地预览 URL。 */
  url: string;
  /** 下载文件名。 */
  filename: string;
}

/** 已加载图片信息。 */
export interface LoadedImageSource {
  /** 图片元素。 */
  image: HTMLImageElement;
  /** 图片本地预览 URL。 */
  objectUrl: string;
  /** 图片像素宽度。 */
  width: number;
  /** 图片像素高度。 */
  height: number;
}

/** 加载用户本地图片文件。 */
export async function loadImageFile(file: File): Promise<LoadedImageSource> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(url);
    return { image, objectUrl: url, width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** 按指定行列拆分图片，边缘使用像素边界补齐，避免漏裁。 */
export async function splitImageToSlices(
  source: LoadedImageSource,
  rows: number,
  cols: number,
  baseName: string,
): Promise<ImageSlice[]> {
  const slices: ImageSlice[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor((row * source.height) / rows);
    const y1 = Math.floor(((row + 1) * source.height) / rows);
    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.floor((col * source.width) / cols);
      const x1 = Math.floor(((col + 1) * source.width) / cols);
      const width = Math.max(1, x1 - x0);
      const height = Math.max(1, y1 - y0);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前浏览器不支持 Canvas 图片处理');
      context.drawImage(source.image, x0, y0, width, height, 0, 0, width, height);
      const blob = await canvasToPngBlob(canvas);
      const index = row * cols + col + 1;
      slices.push({
        index,
        row: row + 1,
        col: col + 1,
        width,
        height,
        blob,
        url: URL.createObjectURL(blob),
        filename: `${baseName}_r${row + 1}_c${col + 1}.png`,
      });
    }
  }
  return slices;
}

/** 释放切片预览 URL，避免用户多次操作后占用浏览器内存。 */
export function revokeSlices(slices: ImageSlice[]): void {
  for (const slice of slices) URL.revokeObjectURL(slice.url);
}

/** 触发浏览器下载 Blob。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 从文件名提取安全基础名。 */
export function buildSafeBaseName(filename: string): string {
  const name = filename.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
  return name || 'image_split';
}

/** 将 1 基数列号转成 Excel 风格列名，例如 1 -> A、27 -> AA。 */
export function toExcelColumnLabel(index: number): string {
  let value = Math.max(1, Math.floor(index));
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

/** 组合行列标识，便于预览和下载列表统一展示。 */
export function buildSliceLabel(row: number, col: number): string {
  return `${toExcelColumnLabel(row)}-${col}`;
}

/** 读取图片元素，确保 naturalWidth 可用。 */
function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片读取失败，请换一张图片重试'));
    image.src = url;
  });
}

/** Canvas 导出 PNG Blob。 */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('图片导出失败，请降低拆分数量后重试'));
    }, 'image/png');
  });
}
