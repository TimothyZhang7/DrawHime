/** 本文件负责扫描独立本地模型平台的模型资产目录。 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** 资产扫描结果。 */
export type LocalModelAssetScanView = {
  /** 模型键。 */
  modelKey: string;
  /** 文件名。 */
  fileName: string;
  /** 绝对路径。 */
  absolutePath: string;
  /** 是否存在。 */
  exists: boolean;
  /** 文件大小。 */
  sizeBytes: string | null;
  /** 最近修改时间。 */
  lastModifiedAt: string | null;
};

/** 资产目录扫描结果。 */
export type LocalModelAssetScanResponse = {
  /** 扫描根目录。 */
  rootDir: string;
  /** 扫描到的资产。 */
  assets: LocalModelAssetScanView[];
};

/** 规范化相对目录并生成兼容候选路径。 */
function getLocalModelRelativeDirCandidates(relativeDir: string) {
  const normalized = relativeDir.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
  const candidates = new Set<string>();

  if (normalized) {
    candidates.add(normalized);
    if (normalized.startsWith('models/')) {
      candidates.add(normalized.slice('models/'.length));
    } else {
      candidates.add(`models/${normalized}`);
    }
  }

  return [...candidates];
}

/** 解析本地模型目录的候选绝对路径。 */
export function getLocalModelDirectoryCandidates(rootDir: string, relativeDir: string) {
  const candidates = getLocalModelRelativeDirCandidates(relativeDir);
  return candidates
    .sort((left, right) => {
      const leftStartsWithModels = left.startsWith('models/');
      const rightStartsWithModels = right.startsWith('models/');
      if (leftStartsWithModels === rightStartsWithModels) return 0;
      return leftStartsWithModels ? 1 : -1;
    })
    .map((item) => path.resolve(rootDir, item));
}

/** 解析本地模型文件的候选绝对路径。 */
export function getLocalModelFileCandidates(rootDir: string, relativeDir: string, fileName: string) {
  return getLocalModelDirectoryCandidates(rootDir, relativeDir).map((directoryPath) => path.join(directoryPath, fileName));
}

/** 扫描本地模型目录下是否存在目标文件。 */
export async function scanLocalModelAssetFiles(rootDir: string, relativeDirs: string[], modelKeys: readonly string[]) {
  const result: LocalModelAssetScanView[] = [];

  for (const modelKey of modelKeys) {
    let foundPath: string | null = null;
    let foundStats: Awaited<ReturnType<typeof stat>> | null = null;

    for (const relativeDir of relativeDirs) {
      for (const absolutePath of getLocalModelFileCandidates(rootDir, relativeDir, modelKey)) {
        try {
          const fileStat = await stat(absolutePath);
          if (fileStat.isFile()) {
            foundPath = absolutePath;
            foundStats = fileStat;
            break;
          }
        } catch {
          // 文件不存在时继续尝试下一个候选目录；这是资产扫描的正常分支。
        }
      }
      if (foundPath) {
        break;
      }
    }

    result.push({
      modelKey,
      fileName: modelKey,
      absolutePath: foundPath ?? getLocalModelFileCandidates(rootDir, relativeDirs[0] ?? '', modelKey)[0] ?? path.join(rootDir, modelKey),
      exists: Boolean(foundPath),
      sizeBytes: foundStats ? foundStats.size.toString() : null,
      lastModifiedAt: foundStats ? foundStats.mtime.toISOString() : null,
    });
  }

  return result;
}

/** 读取目录中可见文件名，用于资产目录排查。 */
export async function listVisibleFileNames(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
