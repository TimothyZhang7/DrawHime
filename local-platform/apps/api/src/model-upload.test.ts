/** 本文件验证用户底模下载 Range 与 Anima safetensors 结构门禁。 */
import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { parseModelDownloadRange, resolveModelStorageRoot, validateAnimaSafetensors } from "./model-upload.js";

test("用户底模下载接受单段与开放结束范围", () => {
  assert.deepEqual(parseModelDownloadRange("bytes=0-7", 10), { start: 0, end: 7 });
  assert.deepEqual(parseModelDownloadRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.equal(parseModelDownloadRange(undefined, 10), null);
  assert.equal(parseModelDownloadRange("bytes=0-1,4-5", 10), "invalid");
  assert.equal(parseModelDownloadRange("bytes=10-", 10), "invalid");
});

test("Linux 用户底模和上传断点必须共用 data 盘资源根目录", () => {
  assert.equal(resolveModelStorageRoot("/data/local-platform/desktop-resources", "linux"), "/data/local-platform/desktop-resources");
  assert.throws(() => resolveModelStorageRoot("/opt/local-platform/resources", "linux"), /data 盘/);
  assert.throws(() => resolveModelStorageRoot(undefined, "linux"), /未配置/);
});

test("Anima 门禁接受完整 UNet 张量结构并拒绝普通 LoRA", async () => {
  const validPath = join(tmpdir(), `drawhime-anima-valid-${randomUUID()}.safetensors`);
  const invalidPath = join(tmpdir(), `drawhime-anima-invalid-${randomUUID()}.safetensors`);
  try {
    const validHeader: Record<string, unknown> = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`net.blocks.${index}.weight`, { dtype: "F16", shape: [1], data_offsets: [0, 2] }]));
    validHeader["net.blocks.0.self_attn.q_proj.weight"] = { dtype: "F16", shape: [1], data_offsets: [0, 2] };
    validHeader["net.llm_adapter.embed.weight"] = { dtype: "F16", shape: [1], data_offsets: [0, 2] };
    validHeader["net.x_embedder.proj.1.weight"] = { dtype: "F16", shape: [1], data_offsets: [0, 2] };
    await writeSafetensors(validPath, validHeader);
    await writeSafetensors(invalidPath, { "lora_unet_down.weight": { dtype: "F16", shape: [1], data_offsets: [0, 2] } });
    await validateAnimaSafetensors(validPath, (await stat(validPath)).size);
    const invalidSize = (await stat(invalidPath)).size;
    await assert.rejects(() => validateAnimaSafetensors(invalidPath, invalidSize), /Anima/);
  } finally {
    await Promise.all([rm(validPath, { force: true }), rm(invalidPath, { force: true })]);
  }
});

/** 写入只用于结构测试的最小 safetensors 文件。 */
async function writeSafetensors(path: string, header: Record<string, unknown>): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(encoded.length));
  await writeFile(path, Buffer.concat([prefix, encoded, Buffer.alloc(2)]));
}
