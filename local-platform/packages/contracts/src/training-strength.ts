/**
 * 本文件集中计算网页、桌面与运维迁移共用的 LoRA 训练遍历强度，避免三个入口产生不同默认参数。
 */

/** 训练周期组合及其实际图片遍历量。 */
export interface TrainingCycles {
  epochs: number;
  repeats: number;
  passes: number;
}

/**
 * 在契约允许范围内选择不低于目标且浪费最少的 Epoch/Repeat 组合。
 * 同等遍历量优先接近 4 个 Epoch，保留可读的训练进度并减少过多 Epoch 切换。
 */
export function resolveTrainingCycles(assetCount: number, targetPasses: number): TrainingCycles {
  const safeAssetCount = Math.max(1, Math.floor(assetCount));
  const safeTargetPasses = Math.max(safeAssetCount, Math.floor(targetPasses));
  let best: TrainingCycles | null = null;
  for (let epochs = 1; epochs <= 20; epochs += 1) {
    for (let repeats = 1; repeats <= 50; repeats += 1) {
      const passes = safeAssetCount * epochs * repeats;
      if (passes < safeTargetPasses) continue;
      if (!best || passes < best.passes || (passes === best.passes && Math.abs(epochs - 4) < Math.abs(best.epochs - 4))) {
        best = { epochs, repeats, passes };
      }
    }
  }
  // 契约上限不足以达到异常大的目标时，使用最大强度而不是静默退回最低参数。
  return best ?? { epochs: 20, repeats: 50, passes: safeAssetCount * 20 * 50 };
}
