/** 本文件验证统一就绪检查聚合逻辑。 */
import assert from "node:assert/strict";
import test from "node:test";
import { collectReadiness } from "./index.js";

test("全部依赖可用时服务就绪", async () => {
  const result = await collectReadiness("test-service", [async () => ({
    name: "dependency",
    ready: true,
    latencyMs: 1,
    message: "可用",
  })]);
  assert.equal(result.ready, true);
});

test("任一依赖失效时服务未就绪", async () => {
  const result = await collectReadiness("test-service", [async () => ({
    name: "dependency",
    ready: false,
    latencyMs: 1,
    message: "失效",
  })]);
  assert.equal(result.ready, false);
});
