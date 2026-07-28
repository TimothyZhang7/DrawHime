/**
 * 本文件验证 LoRA 分片同步会从真实偏移继续，并在响应丢失后复核服务端进度。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ensureComfyLora } from "./lora-sync.js";

const input = {
  baseUrl: "http://comfy.test",
  token: "service-token",
  objectKey: "loras/example.safetensors",
  fileName: `aiimage_lora_${"a".repeat(64)}.safetensors`,
  sha256: "a".repeat(64),
  sizeBytes: 6,
};

/** 构造符合断点接口统一响应格式的 JSON。 */
function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("已有分片时只读取并上传剩余对象范围", async () => {
  const ranges: Array<[number, number]> = [];
  const methods: string[] = [];
  const mockFetch: typeof fetch = async (_url, init) => {
    const method = init?.method || "GET";
    methods.push(method);
    if (methods.length === 1) return new Response(null, { status: 404 });
    if (method === "GET") return jsonResponse({ ok: true, data: { state: "uploading", offset: 3, totalBytes: 6, sha256: input.sha256 } });
    if (method === "PUT") return jsonResponse({ ok: true, data: { state: "uploading", offset: 6, totalBytes: 6, sha256: input.sha256 } });
    return jsonResponse({ ok: true, data: { state: "complete", offset: 6, totalBytes: 6, sha256: input.sha256 } });
  };

  await ensureComfyLora(input, {
    fetch: mockFetch,
    readObjectRange: async (_objectKey, start, endInclusive) => {
      ranges.push([start, endInclusive]);
      return Buffer.from([4, 5, 6]);
    },
    sleep: async () => undefined,
  });

  assert.deepEqual(ranges, [[3, 5]]);
  assert.deepEqual(methods, ["GET", "GET", "PUT", "POST"]);
});

test("分片响应丢失后按服务端已接收偏移继续完成", async () => {
  let uploadStatusReads = 0;
  let putAttempts = 0;
  const mockFetch: typeof fetch = async (_url, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && !String(_url).endsWith("/upload")) return new Response(null, { status: 404 });
    if (method === "GET") {
      uploadStatusReads += 1;
      const offset = uploadStatusReads === 1 ? 0 : 6;
      return jsonResponse({ ok: true, data: { state: "uploading", offset, totalBytes: 6, sha256: input.sha256 } });
    }
    if (method === "PUT") {
      putAttempts += 1;
      throw new Error("socket closed after upload");
    }
    return jsonResponse({ ok: true, data: { state: "complete", offset: 6, totalBytes: 6, sha256: input.sha256 } });
  };

  await ensureComfyLora(input, {
    fetch: mockFetch,
    readObjectRange: async () => Buffer.from([1, 2, 3, 4, 5, 6]),
    sleep: async () => undefined,
  });

  assert.equal(putAttempts, 1);
  assert.equal(uploadStatusReads, 2);
});
