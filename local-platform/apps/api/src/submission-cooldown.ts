/**
 * 本文件定义用户提交冷却的默认值、配置归一化和剩余秒数计算，供 API 事务与测试共同使用。
 */
export const DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS = 180;
export const MAX_INFERENCE_SUBMISSION_COOLDOWN_SECONDS = 3600;

/** 把数据库配置限制为 0–3600 整数秒，缺失或异常时回退三分钟。 */
export function normalizeInferenceSubmissionCooldownSeconds(value: unknown): number {
  const seconds = Number(value ?? DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_INFERENCE_SUBMISSION_COOLDOWN_SECONDS ? seconds : DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS;
}

/** 根据用户最后一次成功提交时间计算仍需等待的完整秒数。 */
export function inferenceSubmissionCooldownRemainingSeconds(lastSubmittedAt: Date, cooldownSeconds: number, now = new Date()): number {
  const remainingMilliseconds = lastSubmittedAt.getTime() + cooldownSeconds * 1000 - now.getTime();
  return Math.max(0, Math.ceil(remainingMilliseconds / 1000));
}
