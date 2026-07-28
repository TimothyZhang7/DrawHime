/**
 * 本文件验证动态触发词替换不会删除用户标签，且公共标签汇总必然包含用户设定触发词。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mergeCaptionWithTriggerWords, summarizeTrainingTriggerWords } from "@drawhime/contracts";

test("动态替换触发词保留用户标签", () => {
  assert.equal(mergeCaptionWithTriggerWords("old_token, blue hair, custom_tag", ["old_token"], ["new_token"]), "new_token, blue hair, custom_tag");
});

test("触发词总结合并所有图片共有标签和用户设定", () => {
  assert.deepEqual(summarizeTrainingTriggerWords(["myoc, blue hair, smile", "myoc, blue hair, standing"], ["myoc", "unique_token"]), {
    triggerWords: ["myoc", "unique_token"], commonTags: ["myoc", "blue hair"], consensusTags: ["blue hair"], summaryTags: ["myoc", "unique_token", "blue hair"],
  });
});

test("同义颜色和饰品写法可汇总为稳定角色共识", () => {
  const result = summarizeTrainingTriggerWords([
    "1girl, long aqua blue hair, pink hair streaks, heart-shaped ahoge, blue hair ribbons",
    "1girl, long light blue hair, pink hair streak, heart ahoge, blue ribbon hair ornaments",
    "1girl, long turquoise hair, pink hair tips, heart-shaped hair ornament, blue bows",
  ], []);
  assert.deepEqual(result.commonTags, ["1girl"]);
  assert.deepEqual(result.consensusTags, ["1girl", "blue hair", "blue hair ribbon", "heart hair feature", "pink-purple hair accent"]);
});
