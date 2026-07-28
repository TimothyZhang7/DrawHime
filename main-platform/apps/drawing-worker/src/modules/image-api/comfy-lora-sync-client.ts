/** 本文件负责把 backend 已校验的 LoRA 文件按 SHA-256 流式同步到受保护的 ComfyUI 节点。 */
import type { DrawingLoraSnapshot } from '@aiimage/shared-contracts';
import { UpstreamApiCallError } from './upstream-error.js';

const BACKEND_URL = (process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369').replace(/\/+$/, '');
const SERVICE_TOKEN = process.env.WS_PROXY_TOKEN?.trim() ?? '';
const synchronizedLoras = new Map<string, Promise<string>>();

/** 确保指定内容哈希的 LoRA 已存在于当前 ComfyUI，并返回工作流可用文件名。 */
export async function ensureComfyLoraAvailable(baseUrl: string, lora: DrawingLoraSnapshot, signal: AbortSignal): Promise<string> {
  const key = `${baseUrl.replace(/\/+$/, '')}|${lora.sha256}`;
  const existing = synchronizedLoras.get(key);
  if (existing) return existing;
  const pending = synchronizeComfyLora(baseUrl, lora, signal).catch((error) => {
    synchronizedLoras.delete(key);
    throw error;
  });
  synchronizedLoras.set(key, pending);
  return pending;
}

/** 先检查 GPU 内容哈希，缺失时从 backend 到 GPU 端到端流式传输并再次校验。 */
async function synchronizeComfyLora(baseUrl: string, lora: DrawingLoraSnapshot, signal: AbortSignal): Promise<string> {
  if (!SERVICE_TOKEN) throw new UpstreamApiCallError('LoRA 同步服务未配置', 'missing_worker_service_token', false);
  const comfyBaseUrl = baseUrl.replace(/\/+$/, '');
  const gpuUrl = `${comfyBaseUrl}/aiimage/loras/${encodeURIComponent(lora.gpuFileName)}`;
  const statusResponse = await fetch(gpuUrl, { headers: { 'x-service-token': SERVICE_TOKEN }, signal });
  if (statusResponse.ok) {
    const status = await statusResponse.json().catch(() => ({})) as { sha256?: string; sizeBytes?: number };
    if (status.sha256 === lora.sha256 && Number(status.sizeBytes) === lora.sizeBytes) return lora.gpuFileName;
  } else if (statusResponse.status !== 404) {
    throw new UpstreamApiCallError('ComfyUI LoRA 同步检查失败', `comfy_lora_status_http_${statusResponse.status}`, true, statusResponse.status);
  }

  const downloadUrl = `${BACKEND_URL}/internal/loras/${lora.id}/file?sha256=${encodeURIComponent(lora.sha256)}`;
  const downloadResponse = await fetch(downloadUrl, { headers: { 'x-service-token': SERVICE_TOKEN }, signal });
  if (!downloadResponse.ok || !downloadResponse.body) {
    throw new UpstreamApiCallError('LoRA 文件读取失败', `backend_lora_download_http_${downloadResponse.status}`, downloadResponse.status >= 500, downloadResponse.status);
  }
  const uploadInit = {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(lora.sizeBytes),
      'x-service-token': SERVICE_TOKEN,
      'x-aiimage-sha256': lora.sha256,
    },
    body: downloadResponse.body,
    signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' };
  const uploadResponse = await fetch(gpuUrl, uploadInit);
  const result = await uploadResponse.json().catch(() => ({})) as { ok?: boolean; sha256?: string; sizeBytes?: number; message?: string };
  if (!uploadResponse.ok || result.ok !== true || result.sha256 !== lora.sha256 || Number(result.sizeBytes) !== lora.sizeBytes) {
    throw new UpstreamApiCallError('ComfyUI LoRA 同步失败', result.message || `comfy_lora_upload_http_${uploadResponse.status}`, uploadResponse.status >= 500, uploadResponse.status);
  }
  return lora.gpuFileName;
}
