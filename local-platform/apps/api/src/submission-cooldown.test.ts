/**
 * 本文件验证用户提交冷却的默认配置、关闭开关、边界和剩余时间取整。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS, inferenceSubmissionCooldownRemainingSeconds, normalizeInferenceSubmissionCooldownSeconds } from "./submission-cooldown.js";

test("缺失或异常配置回退三分钟", () => {
  assert.equal(normalizeInferenceSubmissionCooldownSeconds(undefined), DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS);
  assert.equal(normalizeInferenceSubmissionCooldownSeconds("invalid"), DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS);
  assert.equal(normalizeInferenceSubmissionCooldownSeconds(3601), DEFAULT_INFERENCE_SUBMISSION_COOLDOWN_SECONDS);
});

test("管理员可关闭冷却并设置一小时上限", () => {
  assert.equal(normalizeInferenceSubmissionCooldownSeconds(0), 0);
  assert.equal(normalizeInferenceSubmissionCooldownSeconds(180), 180);
  assert.equal(normalizeInferenceSubmissionCooldownSeconds(3600), 3600);
});

test("剩余时间向上取整且到截止点立即放行", () => {
  const lastSubmittedAt = new Date("2026-07-28T00:00:00.000Z");
  assert.equal(inferenceSubmissionCooldownRemainingSeconds(lastSubmittedAt, 180, new Date("2026-07-28T00:02:59.001Z")), 1);
  assert.equal(inferenceSubmissionCooldownRemainingSeconds(lastSubmittedAt, 180, new Date("2026-07-28T00:03:00.000Z")), 0);
  assert.equal(inferenceSubmissionCooldownRemainingSeconds(lastSubmittedAt, 0, lastSubmittedAt), 0);
});
