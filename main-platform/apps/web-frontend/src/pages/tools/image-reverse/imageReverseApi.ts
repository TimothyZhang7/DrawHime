/** 本文件封装图片反推私有源图的鉴权读取，避免在图片 URL 中暴露登录 token。 */
import { config } from '../../../lib/config';

/** 读取当前用户自己的反推源图或预览，返回浏览器 Blob。 */
export async function fetchImageReverseSource(path: string, signal?: AbortSignal): Promise<Blob> {
  const token = localStorage.getItem('token') ?? '';
  const response = await fetch(`${config.apiBase}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal,
  });
  if (response.status === 401) {
    localStorage.removeItem('token');
    window.dispatchEvent(new CustomEvent('aiimage:auth-expired'));
  }
  if (!response.ok) throw new Error('反推源图读取失败');
  return response.blob();
}
