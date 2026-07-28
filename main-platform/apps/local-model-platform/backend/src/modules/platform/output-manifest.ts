/** 本文件负责校验本地脚本写出的真实产物清单。 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** 生成脚本输出清单。 */
export type GenerationOutputManifest = {
  /** 输出图片路径。 */
  images: string[];
};

/** 训练脚本输出清单。 */
export type TrainingOutputManifest = {
  /** 输出 LoRA 文件路径。 */
  modelPath: string;
};

/** 读取并校验生成输出清单。 */
export async function readGenerationOutputManifest(manifestPath: string): Promise<GenerationOutputManifest> {
  const parsed = await readJsonManifest(manifestPath);
  const images = Array.isArray(parsed.images) ? parsed.images.map((item) => normalizePath(item)).filter(Boolean) : [];
  if (images.length === 0) {
    throw new Error('生成脚本未在输出清单中写入 images');
  }
  for (const imagePath of images) {
    if (!(await fileExists(imagePath))) {
      throw new Error(`生成输出图片不存在：${imagePath}`);
    }
  }
  return { images };
}

/** 读取并校验训练输出清单。 */
export async function readTrainingOutputManifest(manifestPath: string): Promise<TrainingOutputManifest> {
  const parsed = await readJsonManifest(manifestPath);
  const modelPath = normalizePath(parsed.modelPath);
  if (!modelPath) {
    throw new Error('训练脚本未在输出清单中写入 modelPath');
  }
  if (!(await fileExists(modelPath))) {
    throw new Error(`训练输出 LoRA 文件不存在：${modelPath}`);
  }
  return { modelPath };
}

/** 读取 JSON 清单。 */
async function readJsonManifest(manifestPath: string) {
  if (!existsSync(manifestPath)) {
    throw new Error(`输出清单不存在：${manifestPath}`);
  }
  return JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
}

/** 规范化路径。 */
function normalizePath(value: unknown) {
  return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : '';
}

/** 检查文件是否存在。 */
async function fileExists(filePath: string) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}
