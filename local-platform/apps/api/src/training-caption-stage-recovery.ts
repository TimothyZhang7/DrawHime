/**
 * 本文件负责从历史全量打标阶段中识别可安全恢复的图片快照，避免图片删回旧快照后错误停留在“需要重新打标”。
 */

/** 可用于恢复判断的全量打标阶段最小字段。 */
export type RecoverableCaptionStage = {
  id: string;
  status: string;
  assetSnapshot: unknown;
  completedAssets: number;
  totalAssets: number;
};

/**
 * 查找与当前图片集合完全一致、已完成且可重新等待用户确认的历史全量打标阶段。
 * 失败、排队和运行中的任务绝不参与恢复，避免覆盖真实的后台执行状态。
 */
export function findRecoverableCaptionStage<T extends RecoverableCaptionStage>(stages: readonly T[], assetIds: readonly string[], captionsComplete: boolean): T | null {
  if (!captionsComplete || assetIds.length === 0) return null;
  return stages.find((stage) => ["STALE", "AWAITING_CONFIRMATION", "CONFIRMED"].includes(stage.status)
    && stage.completedAssets === assetIds.length
    && stage.totalAssets === assetIds.length
    && sameAssetSnapshot(stage.assetSnapshot, assetIds)) ?? null;
}

/** 比较打标任务记录的顺序快照与当前训练集图片集合。 */
function sameAssetSnapshot(value: unknown, assetIds: readonly string[]): boolean {
  return Array.isArray(value) && value.length === assetIds.length && value.every((item, index) => item === assetIds[index]);
}
