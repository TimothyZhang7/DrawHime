/** 本文件定义局部抖动工具的公开参数、真实预设、图片解码和录制格式。 */
import type { WobblePhysicsParameters } from './image-wobble-physics';

export { WobbleRenderer } from './image-wobble-renderer';
export type { WobbleAutoMotion, WobbleRenderParameters } from './image-wobble-renderer';
export type { WobbleGravityDirection, WobblePhysicsParameters } from './image-wobble-physics';
export { buildWobbleFilename, selectWobbleMp4MimeType, startWobbleGifRecording } from './image-wobble-export';
export type { WobbleExportFormat, WobbleGifProgress, WobbleGifRecordingSession } from './image-wobble-export';

/** 已解码并限制到安全工作尺寸的图片。 */
export interface LoadedWobbleImage {
  /** 浏览器解码后的位图；页面卸载或换图时必须 close。 */
  bitmap: ImageBitmap;
  /** 工作画布宽度。 */
  width: number;
  /** 工作画布高度。 */
  height: number;
  /** 原图宽度。 */
  sourceWidth: number;
  /** 原图高度。 */
  sourceHeight: number;
  /** 原始文件名。 */
  filename: string;
}

/** 原版四种动作预设。 */
export interface WobblePreset {
  /** 稳定标识。 */
  id: 'purupuru' | 'sloshing' | 'trembling' | 'floating';
  /** 用户可见名称。 */
  label: string;
  /** 简短效果说明。 */
  description: string;
  /** 真实软体物理参数。 */
  parameters: WobblePhysicsParameters;
}

/** 四个预设使用原版实际参与求解的完整参数。 */
export const WOBBLE_PRESETS: WobblePreset[] = [
  {
    id: 'purupuru',
    label: '柔软晃动',
    description: '像布丁一样柔软地晃动',
    parameters: { inputStrength: 82, stretch: 90, bounce: 28, damping: 8, cohesion: 8, gravityDirection: 'down', gravityStrength: 1, variation: 5, maxStretch: 100 },
  },
  {
    id: 'sloshing',
    label: '弹簧跳跳',
    description: '像弹簧一样弹跳摇晃',
    parameters: { inputStrength: 72, stretch: 55, bounce: 95, damping: 20, cohesion: 50, gravityDirection: 'down', gravityStrength: 0.8, variation: 0, maxStretch: 85 },
  },
  {
    id: 'trembling',
    label: '快速颤动',
    description: '小幅快速地颤动',
    parameters: { inputStrength: 55, stretch: 70, bounce: 88, damping: 30, cohesion: 50, gravityDirection: 'down', gravityStrength: 0.9, variation: 30, maxStretch: 40 },
  },
  {
    id: 'floating',
    label: '无重力漂浮',
    description: '没有重力，缓慢漂浮',
    parameters: { inputStrength: 46, stretch: 100, bounce: 15, damping: 0, cohesion: 0, gravityDirection: 'none', gravityStrength: 0, variation: 50, maxStretch: 100 },
  },
];

/** 原版预览最长边为 960，保持同样的网格像素密度和运动观感。 */
const MAX_WORKING_EDGE = 960;

/** 解码静态图片并按最长边缩小到真实预览工作尺寸；不会修改原文件。 */
export async function loadWobbleImage(file: File): Promise<LoadedWobbleImage> {
  const bitmap = await createImageBitmap(file);
  if (bitmap.width < 1 || bitmap.height < 1) {
    bitmap.close();
    throw new Error('图片尺寸无效');
  }
  const scale = Math.min(1, MAX_WORKING_EDGE / Math.max(bitmap.width, bitmap.height));
  return {
    bitmap,
    width: Math.max(2, Math.round(bitmap.width * scale)),
    height: Math.max(2, Math.round(bitmap.height * scale)),
    sourceWidth: bitmap.width,
    sourceHeight: bitmap.height,
    filename: file.name,
  };
}
