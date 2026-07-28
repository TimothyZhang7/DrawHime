/**
 * 本文件统一格式化推理与 LoRA 训练任务的队列数量和预计耗时。
 */
import type { JobQueueEstimateView } from "@drawhime/contracts";

/** 输出适合任务卡片的一行队列摘要。 */
export function formatQueueSummary(queue: JobQueueEstimateView): string {
  const wait = queue.estimatedWaitSeconds < 30 ? "即将开始" : `预计等待约 ${formatEstimatedDuration(queue.estimatedWaitSeconds)}`;
  return `队列 ${queue.total} 个任务 · 前方 ${queue.ahead} 个 · ${wait}`;
}

/** 输出适合详情卡片的预计完成时间。 */
export function formatQueueCompletion(queue: JobQueueEstimateView): string {
  return `第 ${queue.position} 位 · 预计约 ${formatEstimatedDuration(queue.estimatedCompletionSeconds)}完成`;
}

/** 把秒数转换为稳定、紧凑且明确为估算的中文时长。 */
function formatEstimatedDuration(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}
