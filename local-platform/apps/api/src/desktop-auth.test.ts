/** 本文件验证桌面设备用户码的容错规范化与输入拒绝边界。 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDesktopUserCode } from "./desktop-auth.js";

test("桌面设备码允许省略短横线和使用小写", () => {
  assert.equal(normalizeDesktopUserCode("abcd-2345"), "ABCD-2345");
  assert.equal(normalizeDesktopUserCode("ABCD 2345"), "ABCD-2345");
});

test("桌面设备码拒绝易混淆字符和错误长度", () => {
  assert.throws(() => normalizeDesktopUserCode("ABCI-2345"));
  assert.throws(() => normalizeDesktopUserCode("ABC-2345"));
});
