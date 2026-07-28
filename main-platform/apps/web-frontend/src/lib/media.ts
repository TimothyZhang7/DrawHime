/** 本文件提供前端媒体地址规范化，兼容站内代理、data URL 和历史远端直链。 */
import { config } from './config';

/** 将后端返回的图片地址转换为浏览器可访问地址。 */
export function resolveMediaUrl(url?: string | null): string {
  const value = String(url ?? '').trim();
  if (!value) return '';
  if (value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return `${config.apiBase}${value.startsWith('/') ? value : `/images/${value}`}`;
}

/** 生成浏览器视频播放地址；稳定查询标识用于避开旧版无 Range 响应的长期缓存。 */
export function resolvePlayableVideoUrl(url?: string | null): string {
  const resolved = resolveMediaUrl(url);
  if (!resolved) return '';
  return `${resolved}${resolved.includes('?') ? '&' : '?'}media=video-v2`;
}
