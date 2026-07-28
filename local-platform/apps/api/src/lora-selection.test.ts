/** 本文件验证 LoRA 选择不会重复加载相同内容或底模内置权重。 */
import assert from "node:assert/strict";
import test from "node:test";
import { findLoraSelectionConflict } from "./lora-selection.js";

const firstSha256 = "a".repeat(64);
const secondSha256 = "b".repeat(64);

test("不同 LoRA 内容允许同时选择", () => {
  assert.equal(findLoraSelectionConflict([firstSha256, secondSha256], []), null);
});

test("不同版本指向相同内容时判定为重复", () => {
  assert.deepEqual(findLoraSelectionConflict([firstSha256, firstSha256.toUpperCase()], []), { type: "duplicate_content", sha256: firstSha256 });
});

test("用户选择与底模内置 LoRA 相同时判定为重复", () => {
  assert.deepEqual(findLoraSelectionConflict([secondSha256], [firstSha256, secondSha256.toUpperCase()]), { type: "system_duplicate", sha256: secondSha256 });
});
