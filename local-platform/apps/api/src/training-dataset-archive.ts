/**
 * 本文件负责把训练集图片和同名 Caption 以低内存方式流式写入 ZIP 下载响应。
 */
import { getObjectBuffer } from "@drawhime/service-runtime";
import { type Archiver, ZipArchive } from "archiver";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";

/** 归档所需的最小训练图片快照。 */
export interface TrainingDatasetArchiveAsset {
  caption: string | null;
  artifact: {
    objectKey: string;
  };
}

/** 归档所需的最小训练集快照。 */
export interface TrainingDatasetArchiveSource {
  id: string;
  title: string;
  assets: TrainingDatasetArchiveAsset[];
}

type ObjectLoader = (objectKey: string) => Promise<{ body: Buffer }>;

/** 生成兼容常见文件系统的训练集 ZIP 文件名。 */
export function trainingDatasetArchiveFileName(dataset: Pick<TrainingDatasetArchiveSource, "id" | "title">): string {
  const safeTitle = [...dataset.title.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim()].slice(0, 80).join("");
  return `${safeTitle || "training-dataset"}-${dataset.id.slice(0, 8)}.zip`;
}

/** 生成同时兼容 ASCII 回退与 RFC 5987 UTF-8 文件名的下载响应头。 */
export function trainingDatasetArchiveContentDisposition(dataset: Pick<TrainingDatasetArchiveSource, "id" | "title">): string {
  const fileName = trainingDatasetArchiveFileName(dataset);
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="training-dataset-${dataset.id.slice(0, 8)}.zip"; filename*=UTF-8''${encoded}`;
}

/**
 * 顺序读取对象并等待每个条目写入后再读取下一张，避免大型训练集完整进入 Node 堆内存。
 */
export async function streamTrainingDatasetArchive(destination: Writable, dataset: TrainingDatasetArchiveSource, loadObject: ObjectLoader = getObjectBuffer): Promise<void> {
  const archive = new ZipArchive({ store: true });
  archive.pipe(destination);
  try {
    for (let index = 0; index < dataset.assets.length; index += 1) {
      if (destination.destroyed) throw new Error("训练集下载连接已中断");
      const asset = dataset.assets[index];
      if (!asset) throw new Error("训练集归档图片快照不完整");
      const stem = String(index + 1).padStart(4, "0");
      const object = await loadObject(asset.artifact.objectKey);
      await appendArchiveEntry(archive, object.body, `${stem}.webp`);
      await appendArchiveEntry(archive, Buffer.from(asset.caption?.trim() || "", "utf8"), `${stem}.txt`);
    }
    await archive.finalize();
    await finished(destination);
  } catch (error) {
    archive.abort();
    throw error;
  }
}

/** 等待单个条目真正写入归档，保证循环内只持有当前图片缓冲区。 */
function appendArchiveEntry(archive: Archiver, body: Buffer, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
    archive.append(body, { name });
  });
}
