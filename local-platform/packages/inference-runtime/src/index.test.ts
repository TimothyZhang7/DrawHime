/** 本文件验证 Anima 工作流始终把正面与负面提示词映射到独立 conditioning。 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnimaWorkflow } from "./index.js";

test("正面与负面提示词分别进入节点 6 和节点 7", () => {
  const workflow = buildAnimaWorkflow({
    baseUrl: "http://127.0.0.1:8188",
    modelFileName: "anima-base-v1.0.safetensors",
    prompt: "positive_subject_token",
    negativePrompt: "negative_exclusion_token",
    width: 1024,
    height: 1024,
    clientId: "prompt-separation-test",
  }) as Record<string, { inputs?: { text?: string; positive?: [string, number]; negative?: [string, number] } }>;
  assert.match(workflow["6"]?.inputs?.text ?? "", /positive_subject_token/);
  assert.doesNotMatch(workflow["6"]?.inputs?.text ?? "", /negative_exclusion_token/);
  assert.equal(workflow["7"]?.inputs?.text, "negative_exclusion_token");
  assert.deepEqual(workflow["9"]?.inputs?.positive, ["6", 0]);
  assert.deepEqual(workflow["9"]?.inputs?.negative, ["7", 0]);
});

test("完整微调底模使用独立采样参数且不叠加系统美学 LoRA", () => {
  const workflow = buildAnimaWorkflow({
    baseUrl: "http://127.0.0.1:8188",
    modelFileName: "miaomiaoRealskin_anima11.safetensors",
    prompt: "portrait_subject_token",
    width: 920,
    height: 1536,
    clientId: "full-checkpoint-preset-test",
    steps: 30,
    cfg: 4.5,
    samplerName: "euler",
    scheduler: "normal",
    qualityPrefix: "best quality, score_9, photorealistic",
    defaultNegativePrompt: "model_default_negative_token",
    systemHighresLoraEnabled: false,
  }) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  assert.equal(workflow["5"], undefined);
  assert.equal((workflow["6"]?.inputs?.clip as [string, number] | undefined)?.[0], "2");
  assert.match(String(workflow["6"]?.inputs?.text), /photorealistic/);
  assert.equal(workflow["7"]?.inputs?.text, "model_default_negative_token");
  assert.equal(workflow["9"]?.inputs?.steps, 30);
  assert.equal(workflow["9"]?.inputs?.cfg, 4.5);
  assert.equal(workflow["9"]?.inputs?.sampler_name, "euler");
  assert.equal(workflow["9"]?.inputs?.scheduler, "normal");
  assert.deepEqual(workflow["9"]?.inputs?.model as [string, number], ["1", 0]);
});
