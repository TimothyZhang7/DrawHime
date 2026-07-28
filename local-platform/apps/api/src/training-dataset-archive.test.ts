/**
 * 本文件验证训练集 ZIP 会完整写入图片与同名 UTF-8 Caption，并生成安全文件名。
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { streamTrainingDatasetArchive, trainingDatasetArchiveContentDisposition, trainingDatasetArchiveFileName } from "./training-dataset-archive.js";

test("训练集归档包含全部图片与同名标签", async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const objects = new Map([
    ["first", Buffer.from("first-image")],
    ["second", Buffer.from("second-image")],
  ]);
  await streamTrainingDatasetArchive(output, {
    id: "12345678-0000-0000-0000-000000000000",
    title: "角色训练集",
    assets: [
      { caption: "1girl, solo", artifact: { objectKey: "first" } },
      { caption: "blue hair, smile", artifact: { objectKey: "second" } },
    ],
  }, async (objectKey) => ({ body: objects.get(objectKey) ?? Buffer.alloc(0) }));
  const archive = Buffer.concat(chunks);
  assert.equal(archive.subarray(0, 4).toString("hex"), "504b0304");
  for (const value of ["0001.webp", "0001.txt", "0002.webp", "0002.txt", "1girl, solo", "blue hair, smile"]) {
    assert.ok(archive.includes(Buffer.from(value)), `归档缺少 ${value}`);
  }
});

test("训练集归档文件名会移除文件系统保留字符", () => {
  assert.equal(trainingDatasetArchiveFileName({ id: "12345678-rest", title: "角色:/训练集. " }), "角色__训练集-12345678.zip");
  assert.match(trainingDatasetArchiveContentDisposition({ id: "12345678-rest", title: "角色's" }), /filename\*=UTF-8''[^']+%27s-12345678\.zip$/);
});
