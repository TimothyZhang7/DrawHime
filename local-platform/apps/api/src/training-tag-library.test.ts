/**
 * 本文件验证 LoRA 标签规范化和稳定色分配的纯函数行为。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { colorForTag, normalizeTag, normalizeTags } from "./training-tag-library.js";

test("标签规范化统一下划线、大小写并去重", () => {
  assert.equal(normalizeTag(" Blue_Hair  "), "blue hair");
  assert.deepEqual(normalizeTags(["Blue_Hair", "blue hair", "  SOLO "]), ["blue hair", "solo"]);
});

test("相同标签颜色稳定且常见标签颜色互异", () => {
  assert.equal(colorForTag("blue hair", 0), colorForTag("blue hair", 0));
  const colors = ["1girl", "solo", "blue hair", "thighhighs"].map((tag) => colorForTag(tag, 0));
  assert.equal(new Set(colors).size, colors.length);
  for (const color of colors) assert.match(color, /^#[0-9a-f]{6}$/);
});
