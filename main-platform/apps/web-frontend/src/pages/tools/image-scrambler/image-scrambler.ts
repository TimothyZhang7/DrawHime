/** 本文件实现图片混淆工具的浏览器端核心算法：Gilbert 空间填充曲线像素混淆、解混淆、还原和下载。 */
import { buildSafeBaseName, downloadBlob, loadImageFile, type LoadedImageSource } from '../image-splitter/image-splitter';

/** 图片混淆处理模式。 */
export type ScramblerMode = 'scramble' | 'restore';

/** 图片混淆处理结果。 */
export interface ImageScrambleResult {
  /** 导出图片 Blob。 */
  blob: Blob;
  /** 本地预览 URL。 */
  url: string;
  /** 导出文件名。 */
  filename: string;
  /** 图片像素宽度。 */
  width: number;
  /** 图片像素高度。 */
  height: number;
}

/** 当前画布图片来源，允许上传原图或上一次处理结果继续作为输入。 */
export interface ScramblerImageState {
  /** 图片元素。 */
  image: HTMLImageElement;
  /** 本地预览 URL。 */
  url: string;
  /** 图片像素宽度。 */
  width: number;
  /** 图片像素高度。 */
  height: number;
}

/** 加载本地图片文件，复用图片拆分工具的真实浏览器解码链路。 */
export { loadImageFile, downloadBlob, buildSafeBaseName };
export type { LoadedImageSource };

/** 将上传后的图片源转换为当前工具可反复处理的图片状态。 */
export function createImageStateFromLoaded(source: LoadedImageSource): ScramblerImageState {
  return {
    image: source.image,
    url: source.objectUrl,
    width: source.width,
    height: source.height,
  };
}

/** 基于当前显示图片执行混淆或解混淆；仅在浏览器本地 Canvas 处理，不上传图片。 */
export async function processGilbertScramble(
  current: ScramblerImageState,
  fileName: string,
  mode: ScramblerMode,
): Promise<ImageScrambleResult> {
  if (current.width < 1 || current.height < 1) throw new Error('图片尺寸无效，无法处理');
  const canvas = document.createElement('canvas');
  canvas.width = current.width;
  canvas.height = current.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持 Canvas 图片处理');
  context.drawImage(current.image, 0, 0, current.width, current.height);
  const input = context.getImageData(0, 0, current.width, current.height);
  const output = context.createImageData(current.width, current.height);
  const curve = buildGilbertCurve(current.width, current.height);
  const pixelCount = current.width * current.height;
  const offset = Math.round(((Math.sqrt(5) - 1) / 2) * pixelCount);

  // 参考实现使用固定黄金比例偏移；混淆时把原曲线位置写到偏移后的位置，解混淆时反向写回。
  for (let i = 0; i < pixelCount; i += 1) {
    const oldPosition = curve[i];
    const newPosition = curve[(i + offset) % pixelCount];
    const oldPointer = 4 * (oldPosition.x + oldPosition.y * current.width);
    const newPointer = 4 * (newPosition.x + newPosition.y * current.width);
    const sourcePointer = mode === 'scramble' ? oldPointer : newPointer;
    const targetPointer = mode === 'scramble' ? newPointer : oldPointer;
    output.data[targetPointer] = input.data[sourcePointer];
    output.data[targetPointer + 1] = input.data[sourcePointer + 1];
    output.data[targetPointer + 2] = input.data[sourcePointer + 2];
    output.data[targetPointer + 3] = input.data[sourcePointer + 3];
  }

  context.putImageData(output, 0, 0);
  const blob = await canvasToJpegBlob(canvas);
  const suffix = mode === 'scramble' ? 'scrambled' : 'restored';
  return {
    blob,
    url: URL.createObjectURL(blob),
    filename: `${buildSafeBaseName(fileName)}_${suffix}.jpg`,
    width: current.width,
    height: current.height,
  };
}

/** 从处理结果生成新的当前图片状态，保证用户可连续混淆或解混淆。 */
export async function createImageStateFromResult(result: ImageScrambleResult): Promise<ScramblerImageState> {
  const image = await loadImageElement(result.url);
  return {
    image,
    url: result.url,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}

/** 释放混淆结果预览 URL。 */
export function revokeScrambleResult(result: ImageScrambleResult | null): void {
  if (result?.url) URL.revokeObjectURL(result.url);
}

/** 生成任意矩形尺寸可用的 Gilbert 空间填充曲线坐标。 */
function buildGilbertCurve(width: number, height: number): Array<{ x: number; y: number }> {
  const coordinates: Array<{ x: number; y: number }> = [];
  if (width >= height) {
    generateGilbert2d(0, 0, width, 0, 0, height, coordinates);
  } else {
    generateGilbert2d(0, 0, 0, height, width, 0, coordinates);
  }
  if (coordinates.length !== width * height) throw new Error('空间填充曲线生成失败，请换一张图片重试');
  return coordinates;
}

/** 递归生成 Gilbert 曲线坐标，算法来源为公开通用矩形 Hilbert/Gilbert 曲线写法。 */
function generateGilbert2d(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  coordinates: Array<{ x: number; y: number }>,
): void {
  const w = Math.abs(ax + ay);
  const h = Math.abs(bx + by);
  const dax = Math.sign(ax);
  const day = Math.sign(ay);
  const dbx = Math.sign(bx);
  const dby = Math.sign(by);

  if (h === 1) {
    for (let i = 0; i < w; i += 1) {
      coordinates.push({ x, y });
      x += dax;
      y += day;
    }
    return;
  }

  if (w === 1) {
    for (let i = 0; i < h; i += 1) {
      coordinates.push({ x, y });
      x += dbx;
      y += dby;
    }
    return;
  }

  let ax2 = Math.floor(ax / 2);
  let ay2 = Math.floor(ay / 2);
  let bx2 = Math.floor(bx / 2);
  let by2 = Math.floor(by / 2);
  const w2 = Math.abs(ax2 + ay2);
  const h2 = Math.abs(bx2 + by2);

  if (2 * w > 3 * h) {
    if ((w2 % 2) && w > 2) {
      ax2 += dax;
      ay2 += day;
    }
    generateGilbert2d(x, y, ax2, ay2, bx, by, coordinates);
    generateGilbert2d(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, coordinates);
    return;
  }

  if ((h2 % 2) && h > 2) {
    bx2 += dbx;
    by2 += dby;
  }
  generateGilbert2d(x, y, bx2, by2, ax2, ay2, coordinates);
  generateGilbert2d(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, coordinates);
  generateGilbert2d(
    x + (ax - dax) + (bx2 - dbx),
    y + (ay - day) + (by2 - dby),
    -bx2,
    -by2,
    -(ax - ax2),
    -(ay - ay2),
    coordinates,
  );
}

/** Canvas 导出 JPEG Blob，质量 1 与参考页保持一致。 */
function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('图片导出失败，请换一张图片重试'));
    }, 'image/jpeg', 1);
  });
}

/** 读取图片元素，确保处理结果可继续作为下一次输入。 */
function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('处理结果读取失败，请重新上传图片'));
    image.src = url;
  });
}
