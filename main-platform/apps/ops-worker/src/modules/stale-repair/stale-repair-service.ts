/**
 * 本文件实现超时任务修复服务：清理超过 30 分钟的 queued/running 状态主任务。
 *
 * 约束：
 * - 所有修复操作幂等，同一 taskId 的修复只执行一次
 * - 修复前检查 drawing-service 是否有对应活跃任务
 * - 如果有扣费记录且失败不扣费，调用 backend 退款
 * - 符合 specs/README.md OWK-001
 * - 符合 specs/15-worker-queue-semantics.md 4.2
 */

/** backend 内部地址，用于调用退款和状态更新。 */
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:6369';

/** 修复结果记录。 */
type StaleRepairResult = {
  /** 检查的任务数。 */
  checked: number;
  /** 修复的任务数。 */
  repaired: number;
  /** 失败的任务数。 */
  failed: number;
};

/**
 * 超时任务修复服务。
 * 每次执行通过 backend 扫描 queued/running 且 updatedAt 超过阈值的任务并标记为 failed。
 */
export class StaleRepairService {
  /**
   * 执行一轮超时修复。
   * 当前阶段通过 backend 内部接口间接操作，不直连数据库。
   */
  async repairStaleTasks(): Promise<StaleRepairResult> {
    const result: StaleRepairResult = { checked: 0, repaired: 0, failed: 0 };

    try {
      const response = await fetch(`${BACKEND_URL}/internal/ops/stale-tasks`, {
        method: 'GET',
        headers: { 'x-service-token': process.env.WS_PROXY_TOKEN ?? '' },
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 404) {
        return result; // 接口未实现，静默跳过
      }
      if (!response.ok) {
        throw new Error(`backend 返回错误：${response.status}`);
      }

      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; data?: { taskIds: string[] } };
      const taskIds = data.data?.taskIds ?? [];
      if (taskIds.length === 0) return result; // 无超时任务，静默

      result.checked = taskIds.length;

      for (const taskId of taskIds) {
        try {
          await fetch(`${BACKEND_URL}/internal/ops/repair-stale-task`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-service-token': process.env.WS_PROXY_TOKEN ?? '',
            },
            body: JSON.stringify({ taskId }),
            signal: AbortSignal.timeout(5000),
          });
          result.repaired++;
        } catch {
          result.failed++;
          console.warn(`[ops-worker] [stale-repair] 修复失败: ${taskId}`);
        }
      }

      if (result.repaired > 0 || result.failed > 0) {
        console.log(`[ops-worker] [stale-repair] 扫描完成: ${result.checked} 超时, ${result.repaired} 修复, ${result.failed} 失败`);
      }
    } catch (error) {
      console.warn('[ops-worker] [stale-repair] 扫描异常', error instanceof Error ? error.message : error);
    }

    return result;
  }
}
