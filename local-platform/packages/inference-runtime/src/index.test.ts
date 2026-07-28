/** 本文件验证 Anima 工作流始终把正面与负面提示词映射到独立 conditioning。 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnimaWorkflow, fitAnimaSamplingSize, resolveAnimaSamplingWorkload } from "./index.js";

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
    steps: 12,
    cfg: 4,
    samplerName: "euler_ancestral",
    scheduler: "normal",
    qualityPrefix: "best quality, score_9, photorealistic",
    defaultNegativePrompt: "model_default_negative_token",
    systemHighresLoraEnabled: false,
  }) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  assert.equal(workflow["5"], undefined);
  assert.equal((workflow["6"]?.inputs?.clip as [string, number] | undefined)?.[0], "2");
  assert.match(String(workflow["6"]?.inputs?.text), /photorealistic/);
  assert.equal(workflow["7"]?.inputs?.text, "model_default_negative_token");
  assert.equal(workflow["9"]?.inputs?.steps, 12);
  assert.equal(workflow["9"]?.inputs?.cfg, 4);
  assert.equal(workflow["9"]?.inputs?.sampler_name, "euler_ancestral");
  assert.equal(workflow["9"]?.inputs?.scheduler, "normal");
  assert.deepEqual(workflow["9"]?.inputs?.model as [string, number], ["1", 0]);
});

test("完整微调底模按顺序应用用户 LoRA 并恢复最终输出尺寸", () => {
  const workflow = buildAnimaWorkflow({
    baseUrl: "http://127.0.0.1:8188",
    modelFileName: "animeBulldozer_anima.safetensors",
    prompt: "character_trigger",
    width: 1024,
    height: 680,
    outputWidth: 1536,
    outputHeight: 1024,
    clientId: "full-checkpoint-lora-chain-test",
    steps: 12,
    cfg: 4,
    samplerName: "er_sde",
    scheduler: "simple",
    systemHighresLoraEnabled: false,
    loras: [
      { fileName: "character.safetensors", strength: 1 },
      { fileName: "style.safetensors", strength: 0.8 },
    ],
  }) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  assert.deepEqual(workflow["12"]?.inputs?.model as [string, number], ["1", 0]);
  assert.deepEqual(workflow["12"]?.inputs?.clip as [string, number], ["2", 0]);
  assert.deepEqual(workflow["13"]?.inputs?.model as [string, number], ["12", 0]);
  assert.deepEqual(workflow["13"]?.inputs?.clip as [string, number], ["12", 1]);
  assert.deepEqual(workflow["9"]?.inputs?.model as [string, number], ["13", 0]);
  assert.deepEqual(workflow["6"]?.inputs?.clip as [string, number], ["13", 1]);
  assert.equal(workflow["90"]?.class_type, "ImageScale");
  assert.equal(workflow["90"]?.inputs?.width, 1536);
  assert.equal(workflow["90"]?.inputs?.height, 1024);
  assert.deepEqual(workflow["11"]?.inputs?.["🖼️ 图像"] as [string, number], ["90", 0]);
});

test("Anima Base 关闭系统 LoRA 后只串联用户选择的 LoRA", () => {
  const workflow = buildAnimaWorkflow({
    baseUrl: "http://127.0.0.1:8188",
    modelFileName: "anima-base-v1.0.safetensors",
    prompt: "base_user_lora_token",
    width: 1024,
    height: 1024,
    clientId: "base-user-lora-only-test",
    systemTurboLoraEnabled: false,
    systemHighresLoraEnabled: false,
    loras: [{ fileName: "user-selected.safetensors", strength: 0.9 }],
  }) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  assert.equal(workflow["4"], undefined);
  assert.equal(workflow["5"], undefined);
  assert.deepEqual(workflow["12"]?.inputs?.model as [string, number], ["1", 0]);
  assert.deepEqual(workflow["12"]?.inputs?.clip as [string, number], ["2", 0]);
  assert.equal(workflow["12"]?.inputs?.lora_name, "user-selected.safetensors");
  assert.deepEqual(workflow["9"]?.inputs?.model as [string, number], ["12", 0]);
});

test("模型级像素预算按画幅统一采样工作量并允许内部超采样", () => {
  assert.deepEqual(fitAnimaSamplingSize(1536, 1536, 1536, 900000, 130000), [952, 952]);
  assert.deepEqual(fitAnimaSamplingSize(1536, 864, 1536, 900000, 130000), [1336, 752]);
  assert.deepEqual(fitAnimaSamplingSize(1024, 1024, 2048, 2359296, 0), [1536, 1536]);
  const baseSmall = buildAnimaWorkflow({ baseUrl: "http://runtime", modelFileName: "anima-base-v1.0.safetensors", prompt: "small", width: 1536, height: 1536, outputWidth: 1024, outputHeight: 1024, clientId: "small", steps: 12 }) as Record<string, { inputs?: Record<string, unknown> }>;
  assert.deepEqual(baseSmall["90"]?.inputs, { image: ["10", 0], upscale_method: "lanczos", width: 1024, height: 1024, crop: "disabled" });
});

test("不同 LoRA 文件参数量保持相同模型级采样质量", () => {
  const base = {
    baseUrl: "http://runtime",
    modelFileName: "anima-base-v1.0.safetensors",
    prompt: "subject",
    width: 1536,
    height: 1536,
    clientId: "adaptive-workload-test",
    steps: 37,
    aspectStepThreshold: 1.5,
    aspectAdjustedSteps: 34,
    samplingPixelBudget: 1_350_000,
    samplingPixelBudgetAspectSlope: 0,
  };
  assert.deepEqual(resolveAnimaSamplingWorkload(base), { steps: 37, pixelBudget: 1_350_000, aspectSlope: 0, loraBytes: 0, computeScale: 1, aspect: 1 });
  assert.deepEqual(resolveAnimaSamplingWorkload({ ...base, width: 1536, height: 864, loras: [{ fileName: "rank64.safetensors", strength: 1, byteSize: 183_600_000 }] }), { steps: 34, pixelBudget: 1_350_000, aspectSlope: 0, loraBytes: 183_600_000, computeScale: 1, aspect: 1.778 });
  assert.deepEqual(resolveAnimaSamplingWorkload({ ...base, loras: [{ fileName: "first.safetensors", strength: 1, byteSize: 183_600_000 }, { fileName: "second.safetensors", strength: 0.8, byteSize: 183_600_000 }] }), { steps: 37, pixelBudget: 1_350_000, aspectSlope: 0, loraBytes: 367_200_000, computeScale: 1, aspect: 1 });
});
