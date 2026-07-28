/** 本文件启动 GPU 主机代理控制面，真实检查 ComfyUI 并持续回写 GPU 心跳与显存。 */
import { database } from "@drawhime/database";
import {
  createConfigCheck,
  createDatabaseCheck,
  type DependencyCheck,
  startService,
} from "@drawhime/service-runtime";

let stopping = false;

/** 检查 ComfyUI system_stats 端点是否可达且返回 JSON。 */
const comfyUiCheck: DependencyCheck = async () => {
  const startedAt = performance.now();
  const baseUrl = process.env.COMFYUI_BASE_URL?.trim();
  if (!baseUrl) return { name: "comfyui", ready: false, latencyMs: 0, message: "COMFYUI_BASE_URL 未配置" };
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/system_stats`, {
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    return {
      name: "comfyui",
      ready: true,
      latencyMs: Math.round(performance.now() - startedAt),
      message: "ComfyUI Runtime 可用",
    };
  } catch (error) {
    return {
      name: "comfyui",
      ready: false,
      latencyMs: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : "ComfyUI Runtime 不可达",
    };
  }
};

startService({
  name: "gpu-agent",
  port: Number(process.env.LOCAL_GPU_AGENT_PORT || 7110),
  checks: [createDatabaseCheck(), createConfigCheck("gpu-agent-auth", ["GPU_AGENT_TOKEN"]), comfyUiCheck],
});

void runHeartbeatLoop();
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

/** 定时读取 ComfyUI 真实设备信息并幂等登记主机与 GPU。 */
async function runHeartbeatLoop(): Promise<void> {
  while (!stopping) {
    try { await synchronizeGpuHeartbeat(); }
    catch (error) { process.stderr.write(`GPU 心跳同步异常：${errorMessage(error)}\n`); }
    await sleep(10000);
  }
}

/** 把 system_stats 中的设备状态写入独立数据库，调度器只使用新鲜心跳。 */
async function synchronizeGpuHeartbeat(): Promise<void> {
  const baseUrl = process.env.COMFYUI_BASE_URL?.trim();
  if (!baseUrl) throw new Error("COMFYUI_BASE_URL 未配置");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/system_stats`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`ComfyUI system_stats 返回 HTTP ${response.status}`);
  const payload = await response.json() as {
    system?: { comfyui_version?: string };
    devices?: Array<{ name?: string; type?: string; index?: number; vram_total?: number; vram_free?: number }>;
  };
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  if (devices.length === 0) throw new Error("ComfyUI 未返回 GPU 设备");
  const realMetrics = await fetchRealGpuMetrics();
  const now = new Date();
  const agentKey = process.env.GPU_AGENT_KEY?.trim() || "primary-comfyui";
  const host = await database.gpuHost.upsert({
    where: { agentKey },
    update: { displayName: process.env.GPU_AGENT_DISPLAY_NAME?.trim() || "主绘图 GPU", address: baseUrl, agentVersion: payload.system?.comfyui_version || "unknown", status: "ACTIVE", lastHeartbeatAt: now },
    create: { agentKey, displayName: process.env.GPU_AGENT_DISPLAY_NAME?.trim() || "主绘图 GPU", address: baseUrl, agentVersion: payload.system?.comfyui_version || "unknown", status: "ACTIVE", labels: ["comfyui", "anima"], lastHeartbeatAt: now },
  });
  for (const item of devices) {
    const index = Number(item.index ?? 0);
    const metrics = realMetrics.get(index);
    const totalVramBytes = BigInt(Math.max(1, Math.trunc(metrics?.totalVramBytes ?? Number(item.vram_total ?? 0))));
    const freeVramBytes = BigInt(Math.max(0, Math.trunc(metrics?.freeVramBytes ?? Number(item.vram_free ?? 0))));
    const utilizationPercent = metrics?.utilizationPercent ?? (Number(totalVramBytes) > 0 ? Math.max(0, Math.min(100, (1 - Number(freeVramBytes) / Number(totalVramBytes)) * 100)) : 0);
    await database.gpuDevice.upsert({
      where: { hostId_deviceKey: { hostId: host.id, deviceKey: `${item.type || "gpu"}:${index}` } },
      update: { name: metrics?.name || item.name || `GPU ${index}`, totalVramBytes, freeVramBytes, utilizationPercent, temperatureCelsius: metrics?.temperatureCelsius ?? null, status: "ACTIVE", lastHeartbeatAt: now },
      create: { hostId: host.id, deviceKey: `${item.type || "gpu"}:${index}`, name: metrics?.name || item.name || `GPU ${index}`, totalVramBytes, freeVramBytes, utilizationPercent, temperatureCelsius: metrics?.temperatureCelsius ?? null, status: "ACTIVE", lastHeartbeatAt: now },
    });
  }
}

/** 从 GPU 私有 Runtime 读取 nvidia-smi 指标；端点异常时保留 ComfyUI 显存数据。 */
async function fetchRealGpuMetrics(): Promise<Map<number, { name: string; totalVramBytes: number; freeVramBytes: number; utilizationPercent: number; temperatureCelsius: number }>> {
  const result = new Map<number, { name: string; totalVramBytes: number; freeVramBytes: number; utilizationPercent: number; temperatureCelsius: number }>();
  const baseUrl = process.env.TRAINING_RUNTIME_BASE_URL?.trim(); const token = process.env.TRAINING_RUNTIME_TOKEN?.trim();
  if (!baseUrl || !token) return result;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/system/gpus`, { headers: { "x-training-runtime-token": token }, signal: AbortSignal.timeout(5000) });
    const payload = await response.json() as { ok?: boolean; data?: { devices?: Array<{ index: number; name: string; totalVramBytes: number; freeVramBytes: number; utilizationPercent: number; temperatureCelsius: number }> } };
    if (response.ok && payload.ok === true) for (const device of payload.data?.devices || []) result.set(device.index, device);
  } catch { /* 真实指标端点短暂异常不阻断已有 ComfyUI 心跳。 */ }
  return result;
}

/** 限制 GPU Agent 日志错误长度。 */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** 心跳循环等待。 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
