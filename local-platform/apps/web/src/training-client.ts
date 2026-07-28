/**
 * 本文件统一封装 LoRA 训练页面的鉴权 JSON、图片上传与私有训练图片读取请求。
 */
const apiBase = import.meta.env.VITE_LOCAL_API_BASE || "/local-model-api";

/** 调用训练 JSON 接口并只接受标准成功响应。 */
export async function trainingJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers || {}) }, cache: "no-store" });
  const payload = await response.json() as { ok?: boolean; data?: T; message?: string };
  if (!response.ok || payload.ok !== true || payload.data === undefined) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload.data;
}

/** 上传训练图片二进制，服务端负责转码、去重和对象存储。 */
export async function trainingBinary<T>(path: string, token: string, body: Blob, method: "POST"): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": body.type || "application/octet-stream" }, body });
  const payload = await response.json() as { ok?: boolean; data?: T; message?: string };
  if (!response.ok || payload.ok !== true || payload.data === undefined) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload.data;
}

/** 读取当前账号有权访问的私有训练图片。 */
export async function loadTrainingImage(datasetId: string, assetId: string, token: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${apiBase}/v1/training/datasets/${datasetId}/assets/${assetId}/content`, { headers: { authorization: `Bearer ${token}` }, signal, cache: "force-cache" });
  if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
  return response.blob();
}
