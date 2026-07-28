/**
 * 本文件校验推理任务选择的 LoRA 内容哈希，阻止同一权重或底模内置权重被重复加载。
 */

/** LoRA 内容冲突类型。 */
export type LoraSelectionConflictType = "duplicate_content" | "system_duplicate";

/** LoRA 内容冲突结果。 */
export interface LoraSelectionConflict {
  type: LoraSelectionConflictType;
  sha256: string;
}

/** 检查已选择 LoRA 是否内容重复，或与当前底模内置 LoRA 重复。 */
export function findLoraSelectionConflict(selectedSha256: string[], configuredSystemSha256: unknown): LoraSelectionConflict | null {
  const selected = selectedSha256.map(normalizeSha256).filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  for (const sha256 of selected) {
    if (seen.has(sha256)) return { type: "duplicate_content", sha256 };
    seen.add(sha256);
  }
  const system = new Set(Array.isArray(configuredSystemSha256) ? configuredSystemSha256.map(normalizeSha256).filter((value): value is string => Boolean(value)) : []);
  const duplicate = selected.find((sha256) => system.has(sha256));
  return duplicate ? { type: "system_duplicate", sha256: duplicate } : null;
}

/** 将数据库或请求中的哈希归一为小写 SHA-256。 */
function normalizeSha256(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}
