/**
 * 本文件负责主站打标工具与独立本地模型平台之间的身份交换、训练集 JSON 请求和图片上传。
 */
import { localCaptioningArchiveMimeType, type LocalCaptioningSessionView } from '@aiimage/shared-contracts';
import { config } from '../../../lib/config';

const localSessionStorageKey = 'drawhime_local_session';

/** 交换或复用当前主站账号对应的独立平台会话。 */
export async function ensureLocalTrainingSession(): Promise<LocalCaptioningSessionView> {
  const mainToken = localStorage.getItem('token');
  if (!mainToken) throw new Error('请先登录绘图姬主站');
  const existingToken = localStorage.getItem(localSessionStorageKey);
  const existing = existingToken ? await requestSession('/v1/auth/me', existingToken, 'GET') : null;
  const exchanged = await requestSession('/v1/auth/session/exchange', mainToken, 'POST');
  if (!exchanged) throw new Error('独立本地模型平台登录状态交换失败');
  if (existingToken && existing && existing.identity.subject === exchanged.identity.subject) {
    await revokeLocalSession(exchanged.sessionToken);
    return existing;
  }
  localStorage.setItem(localSessionStorageKey, exchanged.sessionToken);
  if (existingToken && existingToken !== exchanged.sessionToken) await revokeLocalSession(existingToken);
  return exchanged;
}

/** 调用独立平台标准 JSON 接口。 */
export async function localTrainingJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.localPlatformApiBase}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers || {}) },
      cache: 'no-store',
    });
  } catch {
    throw new Error('独立本地模型平台暂时不可达');
  }
  const payload = await response.json().catch(() => null) as { ok?: boolean; data?: T; message?: string } | null;
  if (!response.ok || payload?.ok !== true || payload.data === undefined) throw new Error(payload?.message || `请求失败：HTTP ${response.status}`);
  return payload.data;
}

/** 上传一张训练图片；服务端负责转码、哈希去重和对象存储。 */
export async function uploadTrainingImage(datasetId: string, file: File, token: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${config.localPlatformApiBase}/v1/training/datasets/${encodeURIComponent(datasetId)}/assets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new Error('训练图片上传连接中断');
  }
  const payload = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.message || `上传失败：HTTP ${response.status}`);
}

/** 读取私有训练图片，由调用组件管理 Blob URL 生命周期。 */
export async function loadTrainingImage(datasetId: string, assetId: string, token: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(`${config.localPlatformApiBase}/v1/training/datasets/${encodeURIComponent(datasetId)}/assets/${encodeURIComponent(assetId)}/content`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error(`训练图片读取失败：HTTP ${response.status}`);
  return response.blob();
}

interface LocalFileSystemWritable extends WritableStream<Uint8Array> {
  abort(reason?: unknown): Promise<void>;
}

interface LocalSaveFileHandle {
  createWritable(): Promise<LocalFileSystemWritable>;
}

type LocalSaveFilePicker = (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<LocalSaveFileHandle>;

/** 鉴权下载训练集 ZIP；Chromium 优先流式写盘，其他浏览器回退为 Blob 下载。 */
export async function downloadTrainingDatasetArchive(datasetId: string, datasetTitle: string, token: string): Promise<string> {
  const suggestedName = createArchiveFileName(datasetTitle, datasetId);
  const picker = (window as Window & { showSaveFilePicker?: LocalSaveFilePicker }).showSaveFilePicker;
  let writable: LocalFileSystemWritable | null = null;
  if (picker) {
    try {
      const handle = await picker.call(window, { suggestedName, types: [{ description: 'ZIP 压缩包', accept: { [localCaptioningArchiveMimeType]: ['.zip'] } }] });
      writable = await handle.createWritable();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('已取消打包下载');
      throw error;
    }
  }
  let response: Response;
  try {
    response = await fetch(`${config.localPlatformApiBase}/v1/training/datasets/${encodeURIComponent(datasetId)}/archive`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    await writable?.abort().catch(() => undefined);
    throw new Error('训练集打包下载连接中断');
  }
  if (!response.ok) {
    await writable?.abort().catch(() => undefined);
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(payload?.message || `训练集打包失败：HTTP ${response.status}`);
  }
  const fileName = readDownloadFileName(response.headers.get('content-disposition')) || suggestedName;
  if (writable && response.body) {
    try {
      await response.body.pipeTo(writable);
      return fileName;
    } catch (error) {
      await writable.abort(error).catch(() => undefined);
      throw new Error('训练集压缩包写入失败');
    }
  }
  await writable?.abort().catch(() => undefined);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('训练集压缩包内容为空');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return fileName;
}

/** 生成与服务端一致的安全下载文件名。 */
function createArchiveFileName(title: string, datasetId: string): string {
  const safeTitle = [...title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()].slice(0, 80).join('');
  return `${safeTitle || 'training-dataset'}-${datasetId.slice(0, 8)}.zip`;
}

/** 优先解析 RFC 5987 UTF-8 文件名，并过滤可能影响浏览器下载路径的字符。 */
function readDownloadFileName(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const fallback = contentDisposition.match(/filename="?([^";]+)"?/i)?.[1];
  try {
    return (encoded ? decodeURIComponent(encoded) : fallback || '').replace(/[\\/\u0000-\u001f]/g, '_') || null;
  } catch {
    return fallback?.replace(/[\\/\u0000-\u001f]/g, '_') || null;
  }
}

/** 读取会话端点，认证失败时返回空值供交换逻辑处理。 */
async function requestSession(path: string, token: string, method: 'GET' | 'POST'): Promise<LocalCaptioningSessionView | null> {
  try {
    const response = await fetch(`${config.localPlatformApiBase}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined, cache: 'no-store' });
    const payload = await response.json() as { ok?: boolean; data?: LocalCaptioningSessionView };
    return response.ok && payload.ok === true && payload.data ? payload.data : null;
  } catch {
    return null;
  }
}

/** 撤销不再使用的独立会话，不影响主站 JWT。 */
async function revokeLocalSession(token: string): Promise<void> {
  await fetch(`${config.localPlatformApiBase}/v1/auth/session`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
}
