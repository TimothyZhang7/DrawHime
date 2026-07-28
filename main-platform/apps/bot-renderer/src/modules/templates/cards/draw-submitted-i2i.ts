import { Icons } from '../icons.js';
/**
 * 图生图提交卡片 — 重导出 V2 版本，强制 image-to-image 模式
 */
import { render as v2Render, type Data as V2Data } from './draw-submitted-v2.js';

export type Data = V2Data;

export function render(d: Data): string {
  return v2Render({ ...d, mode: d.mode || 'image-to-image' });
}
