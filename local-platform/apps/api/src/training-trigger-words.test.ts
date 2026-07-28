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
    triggerWords: ["myoc", "unique_token"], commonTags: ["myoc", "blue hair"], summaryTags: ["myoc", "unique_token", "blue hair"],
  });
});
