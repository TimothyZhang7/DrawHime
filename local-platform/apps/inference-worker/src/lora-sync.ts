/**
 * 本文件负责把独立对象存储中的 LoRA 按分片断点同步到受保护的 ComfyUI 节点。
 */
import { getObjectRange } from "@drawhime/service-runtime";

const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_ATTEMPTS = 3;
const STATUS_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 120_000;

type InstalledStatus = { sha256?: string; sizeBytes?: number };
type UploadStatus = { state?: string; offset?: number; totalBytes?: number; sha256?: string };
type ApiEnvelope<T> = { ok?: boolean; data?: T; code?: string; message?: string; offset?: number };

interface LoraSyncDependencies {
  fetch: typeof fetch;
  readObjectRange: typeof getObjectRange;
  sleep: (milliseconds: number) => Promise<void>;
}

const defaultDependencies: LoraSyncDependencies = {
  fetch,
  readObjectRange: getObjectRange,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** 校验已安装文件并按真实服务端偏移同步缺失分片，完成后才允许提交 Runtime。 */
export async function ensureComfyLora(
  input: { baseUrl: string; token: string; objectKey: string; fileName: string; sha256: string; sizeBytes: number },
  dependencyOverrides: Partial<LoraSyncDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const fileUrl = `${input.baseUrl.replace(/\/$/, "")}/aiimage/loras/${encodeURIComponent(input.fileName)}`;
  const installed = await readInstalledStatus(fileUrl, input.token, dependencies);
  if (installed.status === 200 && matchesInstalledFile(installed.data, input.sha256, input.sizeBytes)) return;
  if (installed.status !== 404 && installed.status !== 200) throw new Error(`ComfyUI LoRA 检查失败：HTTP ${installed.status}`);

  const uploadUrl = `${fileUrl}/upload`;
  let status = await readUploadStatus(uploadUrl, input, dependencies);
  if (status.state === "complete" && status.offset === input.sizeBytes) return;
  let offset = normalizeOffset(status.offset, input.sizeBytes);

  while (offset < input.sizeBytes) {
    const endInclusive = Math.min(input.sizeBytes, offset + UPLOAD_CHUNK_BYTES) - 1;
    const chunk = await dependencies.readObjectRange(input.objectKey, offset, endInclusive);
    const nextOffset = await uploadChunkWithRetry(uploadUrl, input, offset, chunk, dependencies);
    if (nextOffset === offset) throw new Error("ComfyUI LoRA 分片同步未取得进展");
    offset = normalizeOffset(nextOffset, input.sizeBytes);
  }

  try {
    const response = await dependencies.fetch(uploadUrl, {
      method: "POST",
      headers: uploadHeaders(input),
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });
    const result = await readEnvelope<UploadStatus>(response);
    if (!response.ok || result?.ok !== true || result.data?.state !== "complete" || result.data.offset !== input.sizeBytes || result.data.sha256 !== input.sha256) {
      throw new Error(result?.message || `ComfyUI LoRA 完成同步失败：HTTP ${response.status}`);
    }
  } catch (error) {
    // 完成响应丢失时以 GPU 已安装文件的最终哈希为准，避免重复生成和错误退款。
    const verified = await readInstalledStatus(fileUrl, input.token, dependencies).catch(() => null);
    if (!verified || !matchesInstalledFile(verified.data, input.sha256, input.sizeBytes)) throw error;
  }
}

/** 上传单个分片；连接中断时先读取服务端偏移，再决定是否重传。 */
async function uploadChunkWithRetry(
  uploadUrl: string,
  input: { token: string; sha256: string; sizeBytes: number },
  offset: number,
  chunk: Buffer,
  dependencies: LoraSyncDependencies,
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    try {
      const response = await dependencies.fetch(uploadUrl, {
        method: "PUT",
        headers: {
          ...uploadHeaders(input),
          "content-type": "application/octet-stream",
          "content-length": String(chunk.length),
          "x-aiimage-offset": String(offset),
        },
        body: new Blob([new Uint8Array(chunk)]),
        signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
      const result = await readEnvelope<UploadStatus>(response);
      const returnedOffset = normalizeOffset(result?.data?.offset ?? result?.offset, input.sizeBytes);
      if (response.ok && result?.ok === true && returnedOffset >= offset + chunk.length) return returnedOffset;
      lastError = new Error(result?.message || `ComfyUI LoRA 分片同步失败：HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    const current = await readUploadStatus(uploadUrl, input, dependencies).catch(() => null);
    if (current) {
      const currentOffset = normalizeOffset(current.offset, input.sizeBytes);
      if (currentOffset !== offset) return currentOffset;
    }
    if (attempt < MAX_CHUNK_ATTEMPTS) await dependencies.sleep(attempt * 750);
  }
  throw lastError;
}

/** 查询断点临时文件状态，短请求按上限重试。 */
async function readUploadStatus(
  uploadUrl: string,
  input: { token: string; sha256: string; sizeBytes: number },
  dependencies: LoraSyncDependencies,
): Promise<UploadStatus> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await dependencies.fetch(uploadUrl, {
        headers: uploadHeaders(input),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      const result = await readEnvelope<UploadStatus>(response);
      if (!response.ok || result?.ok !== true || !result.data) throw new Error(result?.message || `ComfyUI LoRA 续传状态失败：HTTP ${response.status}`);
      return result.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await dependencies.sleep(attempt * 500);
    }
  }
  throw lastError;
}

/** 查询最终安装文件状态，兼容既有顶层响应结构。 */
async function readInstalledStatus(
  fileUrl: string,
  token: string,
  dependencies: LoraSyncDependencies,
): Promise<{ status: number; data: InstalledStatus | null }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await dependencies.fetch(fileUrl, { headers: { "x-service-token": token }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      return { status: response.status, data: response.ok ? await response.json().catch(() => null) as InstalledStatus | null : null };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await dependencies.sleep(attempt * 500);
    }
  }
  throw lastError;
}

/** 构造不含对象存储信息的受保护上传头。 */
function uploadHeaders(input: { token: string; sha256: string; sizeBytes: number }): Record<string, string> {
  return {
    "x-service-token": input.token,
    "x-aiimage-sha256": input.sha256,
    "x-aiimage-total-bytes": String(input.sizeBytes),
  };
}

/** 解析有限尺寸 JSON；错误页只保留 HTTP 状态，不扩散上游正文。 */
async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T> | null> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  return await response.json().catch(() => null) as ApiEnvelope<T> | null;
}

/** 防止异常服务端偏移越界或产生非整数 Range。 */
function normalizeOffset(value: unknown, totalBytes: number): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) throw new Error("ComfyUI LoRA 续传偏移不正确");
  return offset;
}

/** 判断最终文件的哈希和大小是否都与不可变版本一致。 */
function matchesInstalledFile(data: InstalledStatus | null, sha256: string, sizeBytes: number): boolean {
  return data?.sha256 === sha256 && Number(data.sizeBytes) === sizeBytes;
}
