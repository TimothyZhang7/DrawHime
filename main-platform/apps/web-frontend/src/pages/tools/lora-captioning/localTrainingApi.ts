/**
 * 本文件负责主站打标工具与独立本地模型平台之间的身份交换、训练集 JSON 请求和图片上传。
 */
import type { LocalCaptioningSessionView } from '@aiimage/shared-contracts';
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
