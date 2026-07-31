/** 本文件验证各入口共用的 LoRA 训练强度不会因数据集规模变化而退回欠拟合参数。 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrainingCycles } from "@drawhime/contracts";

for (const assetCount of [5, 6, 20, 31, 36, 80]) {
  test(`${assetCount} 张训练图达到至少 320 次遍历`, () => {
    const cycles = resolveTrainingCycles(assetCount, 320);
    assert.ok(cycles.passes >= 320);
    assert.equal(cycles.passes, assetCount * cycles.epochs * cycles.repeats);
    assert.ok(cycles.epochs >= 1 && cycles.epochs <= 20);
    assert.ok(cycles.repeats >= 1 && cycles.repeats <= 50);
    assert.ok(cycles.passes < 320 + assetCount * 4);
  });
}
