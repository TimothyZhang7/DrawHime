/** 本文件验证桌面大资源镜像的单段 Range 边界。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopResourceRange, validateDesktopResourceProxyResponse } from "./desktop-resources.js";

test("资源镜像接受闭区间与开放结束 Range", () => {
  assert.deepEqual(parseDesktopResourceRange("bytes=0-7", 10), { start: 0, end: 7 });
  assert.deepEqual(parseDesktopResourceRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.equal(parseDesktopResourceRange(undefined, 10), null);
});

test("资源镜像拒绝多段、越界和倒序 Range", () => {
  assert.equal(parseDesktopResourceRange("bytes=0-1,4-5", 10), "invalid");
  assert.equal(parseDesktopResourceRange("bytes=10-", 10), "invalid");
  assert.equal(parseDesktopResourceRange("bytes=8-7", 10), "invalid");
  assert.equal(parseDesktopResourceRange("bytes=-5", 10), "invalid");
});

test("官方代理只接受精确匹配的分片范围和总大小", () => {
  assert.equal(validateDesktopResourceProxyResponse(206, 8, "bytes 0-7/10", 10, { start: 0, end: 7 }), true);
  assert.equal(validateDesktopResourceProxyResponse(200, 10, null, 10, null), true);
  assert.equal(validateDesktopResourceProxyResponse(200, 10, null, 10, { start: 0, end: 7 }), false);
  assert.equal(validateDesktopResourceProxyResponse(206, 9, "bytes 0-8/10", 10, { start: 0, end: 7 }), false);
});
