/** 本文件验证网站 LoRA 授权下载只接受可恢复的单段字节范围。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseDownloadRange } from "./lora-library.js";

test("LoRA 下载接受闭区间和开放结束范围", () => {
  assert.deepEqual(parseDownloadRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseDownloadRange("bytes=40-", 100), { start: 40, end: 99 });
  assert.equal(parseDownloadRange(undefined, 100), null);
});

test("LoRA 下载拒绝多段、后缀和越界范围", () => {
  assert.equal(parseDownloadRange("bytes=0-1,5-6", 100), "invalid");
  assert.equal(parseDownloadRange("bytes=-20", 100), "invalid");
  assert.equal(parseDownloadRange("bytes=99-100", 100), "invalid");
  assert.equal(parseDownloadRange("bytes=20-10", 100), "invalid");
});
