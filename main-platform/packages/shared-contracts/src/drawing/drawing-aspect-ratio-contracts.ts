/** 本文件定义跨前端、后端与绘图服务共用的画幅比例及 4K 长边尺寸契约。 */

/** 网页端可选择的画幅比例；auto 表示沿用模型或站点默认尺寸。 */
export const DRAWING_ASPECT_RATIO_OPTIONS = [
  { value: 'auto', label: '自动', description: '模型默认', width: null, height: null },
  { value: '1:1', label: '正方形', description: '头像与通用构图', width: 4096, height: 4096 },
  { value: '4:5', label: '竖版', description: '社交媒体人像', width: 3264, height: 4080 },
  { value: '5:4', label: '横版', description: '经典横向画幅', width: 4080, height: 3264 },
  { value: '3:4', label: '竖版', description: '传统人像画幅', width: 3072, height: 4096 },
  { value: '4:3', label: '横版', description: '传统风景画幅', width: 4096, height: 3072 },
  { value: '2:3', label: '竖版', description: '海报与全身人像', width: 2720, height: 4080 },
  { value: '3:2', label: '横版', description: '摄影与场景构图', width: 4080, height: 2720 },
  { value: '9:16', label: '手机竖屏', description: '短视频与壁纸', width: 2304, height: 4096 },
  { value: '16:9', label: '宽屏', description: '视频封面与壁纸', width: 4096, height: 2304 },
  { value: '9:21', label: '超长竖屏', description: '长屏海报与壁纸', width: 1728, height: 4032 },
  { value: '21:9', label: '超宽屏', description: '电影感全景构图', width: 4032, height: 1728 },
] as const;

/** 生成任务统一画幅比例。 */
export type DrawingAspectRatio = typeof DRAWING_ASPECT_RATIO_OPTIONS[number]['value'];

const DRAWING_ASPECT_RATIO_VALUES = new Set<string>(DRAWING_ASPECT_RATIO_OPTIONS.map((option) => option.value));

/** 判断接口输入是否为受支持的统一画幅比例。 */
export function isDrawingAspectRatio(value: unknown): value is DrawingAspectRatio {
  return typeof value === 'string' && DRAWING_ASPECT_RATIO_VALUES.has(value);
}

/** 按统一比例读取 4K 长边尺寸；auto 没有固定像素尺寸。 */
export function getDrawingAspectRatioOption(value: DrawingAspectRatio) {
  return DRAWING_ASPECT_RATIO_OPTIONS.find((option) => option.value === value) ?? DRAWING_ASPECT_RATIO_OPTIONS[0];
}
