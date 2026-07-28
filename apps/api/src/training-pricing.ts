/**
 * 本文件集中计算 LoRA 训练工作量与动态价格，试算和正式资金预留必须调用同一实现。
 */
import type { TrainingParameters, TrainingPriceQuoteView } from "@drawhime/contracts";

const standardWorkloadPerUnit = 800;

/** 根据真实图片遍历量、像素量和网络容量计算主站计价单位。 */
export function calculateTrainingPrice(assetCount: number, parameters: TrainingParameters, baseUnitPrice: number): TrainingPriceQuoteView {
  if (!Number.isSafeInteger(assetCount) || assetCount < 5 || assetCount > 200) throw new Error("训练图片数量必须为 5 到 200");
  if (!Number.isFinite(baseUnitPrice) || baseUnitPrice <= 0) throw new Error("训练模型单价配置不正确");
  const imagePasses = assetCount * parameters.repeats * parameters.epochs;
  const resolutionFactor = Math.pow(parameters.resolution / 1024, 2);
  const rankFactor = 0.75 + parameters.rank / 64;
  const workload = imagePasses * resolutionFactor * rankFactor;
  const priceUnits = Math.max(1, Math.min(32, Math.ceil(workload / standardWorkloadPerUnit)));
  return {
    assetCount,
    imagePasses,
    estimatedOptimizerSteps: Math.max(1, Math.ceil(imagePasses / parameters.gradientAccumulationSteps)),
    priceUnits,
    baseUnitPrice: baseUnitPrice.toFixed(2),
    estimatedPrice: (baseUnitPrice * priceUnits).toFixed(2),
    currency: "CNY",
  };
}
