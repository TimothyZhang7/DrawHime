/** 本文件封装图片放大私有源图的鉴权读取，避免在图片地址中暴露登录凭证。 */
import { config } from '../../../lib/config';

/** 读取当前用户自己的图片放大源图或预览。 */
export async function fetchImageUpscaleSource(path: string, signal?: AbortSignal): Promise<Blob> {
  const token = localStorage.getItem('token') ?? '';
  const response = await fetch(`${config.apiBase}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal,
  });
  if (response.status === 401) {
    localStorage.removeItem('token');
    window.dispatchEvent(new CustomEvent('aiimage:auth-expired'));
  }
  if (!response.ok) throw new Error('图片放大源图读取失败');
  return response.blob();
}
