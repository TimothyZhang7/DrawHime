/**
 * 本文件验证历史打标快照只会在图片与 Caption 都完整匹配时恢复，避免错误复用失效阶段。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { findRecoverableCaptionStage } from "./training-caption-stage-recovery.js";

test("匹配当前图片的历史失效阶段恢复为待确认候选", () => {
  const stage = { id: "matching", status: "STALE", assetSnapshot: ["asset-a", "asset-b"], completedAssets: 2, totalAssets: 2 };
  assert.equal(findRecoverableCaptionStage([stage], ["asset-a", "asset-b"], true), stage);
});

test("快照不匹配或 Caption 未补全时不得恢复历史阶段", () => {
  const stage = { id: "obsolete", status: "STALE", assetSnapshot: ["asset-a", "asset-b"], completedAssets: 2, totalAssets: 2 };
  assert.equal(findRecoverableCaptionStage([stage], ["asset-a", "asset-c"], true), null);
  assert.equal(findRecoverableCaptionStage([stage], ["asset-a", "asset-b"], false), null);
});
