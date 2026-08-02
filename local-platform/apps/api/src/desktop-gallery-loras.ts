/**
 * 本文件负责校验桌面任务 LoRA 快照、按文件哈希关联网站仓库，并生成图库实时展示元数据。
 */
import type { Prisma } from "@prisma/client";
import type { DesktopGalleryLoraSnapshot, GalleryLoraMetadataView } from "@drawhime/contracts";
import { database } from "@drawhime/database";

/** 主站图库需要的桌面 LoRA 固化信息；仓库字段为空时表示纯本地 LoRA。 */
export type DesktopGalleryLoraSelection = {
  localLoraId: string;
  repositoryVersionId: string | null;
  repositoryEntryId: string | null;
  repositoryAvailable: boolean;
  titleSnapshot: string;
  typeSnapshot: GalleryLoraMetadataView["type"];
  fileName: string | null;
  fileSha256: string | null;
  modelStrength: number | null;
  clipStrength: number | null;
  triggerWords: string[];
};

/** 按文件 SHA-256 关联当前账号可见仓库版本，并把完整 LoRA 快照写入发布参数。 */
export async function buildDesktopGalleryParameters(
  parameters: Record<string, unknown>,
  loras: DesktopGalleryLoraSnapshot[],
  identityId: string,
): Promise<Prisma.InputJsonObject> {
  const snapshots = loras.length > 0 ? loras.map(fromUploadSnapshot) : readDesktopGalleryLoraSelections(parameters);
  const hashes = [...new Set(snapshots.flatMap((item) => item.fileSha256 ? [item.fileSha256] : []))];
  const versions = hashes.length > 0 ? await database.loraVersion.findMany({
    where: {
      sha256: { in: hashes },
      status: "ACTIVE",
      loraEntry: {
        status: "ACTIVE",
        deletedAt: null,
        OR: [{ isPrivate: false }, { ownerIdentityId: identityId }],
      },
    },
    include: { loraEntry: { select: { id: true, ownerIdentityId: true } } },
    orderBy: { createdAt: "desc" },
  }) : [];
  // 同一文件可能被多个条目收录；优先绑定当前用户自己的条目，其余按最新版本稳定选择。
  versions.sort((left, right) => Number(right.loraEntry.ownerIdentityId === identityId) - Number(left.loraEntry.ownerIdentityId === identityId));
  const versionByHash = new Map<string, (typeof versions)[number]>();
  for (const version of versions) if (!versionByHash.has(version.sha256)) versionByHash.set(version.sha256, version);
  const enriched = snapshots.map((snapshot) => {
    const version = snapshot.fileSha256 ? versionByHash.get(snapshot.fileSha256) : undefined;
    return {
      ...snapshot,
      repositoryVersionId: version?.id ?? null,
      repositoryEntryId: version?.loraEntry.id ?? null,
      repositoryAvailable: Boolean(version),
    };
  });
  return {
    ...(parameters as Prisma.InputJsonObject),
    desktopLoraSelections: enriched as unknown as Prisma.InputJsonArray,
  };
}

/** 从新旧桌面发布参数中读取 LoRA；历史字段缺失时保留可确认信息而不猜仓库归属。 */
export function readDesktopGalleryLoraSelections(value: unknown): DesktopGalleryLoraSelection[] {
  const record = readRecord(value);
  const rawSelections = Array.isArray(record.desktopLoraSelections) ? record.desktopLoraSelections : [];
  return rawSelections.flatMap((raw, index) => {
    const item = readRecord(raw);
    const localLoraId = readText(item.localLoraId ?? item.id, 191);
    const repositoryVersionId = readNullableUuid(item.repositoryVersionId);
    const titleSnapshot = readText(item.titleSnapshot ?? item.title ?? item.name, 191) || `LoRA ${index + 1}`;
    if (!localLoraId) return [];
    return [{
      localLoraId,
      repositoryVersionId,
      repositoryEntryId: readNullableUuid(item.repositoryEntryId),
      repositoryAvailable: repositoryVersionId !== null && item.repositoryAvailable !== false,
      titleSnapshot,
      typeSnapshot: normalizeType(item.typeSnapshot ?? item.type ?? item.loraType),
      fileName: readText(item.fileName, 255) || null,
      fileSha256: readSha256(item.fileSha256 ?? item.sha256),
      modelStrength: readNumber(item.modelStrength ?? item.strength ?? item.weight),
      clipStrength: readNumber(item.clipStrength),
      triggerWords: readStringList(item.triggerWords, 50, 100),
    }];
  });
}

/** 返回仓库实时元数据；仓库已删除时仍返回本地任务快照并明确标记不可用。 */
export async function resolveDesktopGalleryLoraMetadata(parameters: unknown, identityId: string): Promise<GalleryLoraMetadataView[]> {
  const selections = readDesktopGalleryLoraSelections(parameters);
  const versionIds = [...new Set(selections.flatMap((item) => item.repositoryVersionId ? [item.repositoryVersionId] : []))];
  const versions = versionIds.length > 0 ? await database.loraVersion.findMany({
    where: { id: { in: versionIds }, status: "ACTIVE", loraEntry: { status: "ACTIVE", deletedAt: null } },
    include: { loraEntry: { select: { id: true, title: true, type: true } } },
  }) : [];
  const versionMap = new Map(versions.map((version) => [version.id, version]));
  const unresolved = selections.filter((selection) => !selection.repositoryVersionId);
  const legacyEntries = unresolved.length > 0 ? await database.loraEntry.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      OR: [{ isPrivate: false }, { ownerIdentityId: identityId }],
      versions: { some: { status: "ACTIVE" } },
      AND: [{ OR: unresolved.map((selection) => ({
        title: selection.titleSnapshot,
        type: databaseLoraType(selection.typeSnapshot),
      })) }],
    },
    include: { versions: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 1 } },
  }) : [];
  const legacyEntryMap = new Map<string, typeof legacyEntries>();
  for (const entry of legacyEntries) {
    const key = legacyMatchKey(entry.title, normalizeType(entry.type));
    legacyEntryMap.set(key, [...(legacyEntryMap.get(key) ?? []), entry]);
  }
  return selections.map((selection) => {
    const version = selection.repositoryVersionId ? versionMap.get(selection.repositoryVersionId) : undefined;
    // 旧客户端没有文件哈希和仓库 ID；仅在标题与类型恰好唯一时兼容关联，避免同名 LoRA 误绑。
    const legacyMatches = !selection.repositoryVersionId
      ? legacyEntryMap.get(legacyMatchKey(selection.titleSnapshot, selection.typeSnapshot)) ?? []
      : [];
    const legacyEntry = legacyMatches.length === 1 ? legacyMatches[0] : undefined;
    const legacyVersion = legacyEntry?.versions[0];
    const repositoryVersionId = version?.id ?? legacyVersion?.id ?? selection.repositoryVersionId;
    const repositoryEntryId = version?.loraEntry.id ?? legacyEntry?.id ?? null;
    return {
      loraVersionId: selection.repositoryVersionId ?? selection.localLoraId,
      repositoryVersionId,
      loraEntryId: repositoryEntryId,
      title: version?.loraEntry.title ?? legacyEntry?.title ?? selection.titleSnapshot,
      type: version ? normalizeType(version.loraEntry.type) : legacyEntry ? normalizeType(legacyEntry.type) : selection.typeSnapshot,
      repositoryAvailable: Boolean(repositoryVersionId && repositoryEntryId),
    };
  });
}

/** 把桌面上传契约转换为统一图库快照。 */
function fromUploadSnapshot(snapshot: DesktopGalleryLoraSnapshot): DesktopGalleryLoraSelection {
  return {
    localLoraId: snapshot.localLoraId,
    repositoryVersionId: null,
    repositoryEntryId: null,
    repositoryAvailable: false,
    titleSnapshot: snapshot.titleSnapshot,
    typeSnapshot: snapshot.typeSnapshot,
    fileName: snapshot.fileName,
    fileSha256: snapshot.fileSha256,
    modelStrength: snapshot.modelStrength,
    clipStrength: snapshot.clipStrength,
    triggerWords: snapshot.triggerWords,
  };
}

/** 读取普通 JSON 对象。 */
function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 读取有界文本。 */
function readText(value: unknown, maximumLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

/** 只接受真实 UUID 仓库标识。 */
function readNullableUuid(value: unknown): string | null {
  const text = readText(value, 36);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text.toLowerCase() : null;
}

/** 只接受十六进制 SHA-256。 */
function readSha256(value: unknown): string | null {
  const text = readText(value, 64).toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

/** 读取有限权重。 */
function readNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

/** 读取去重后的短文本数组。 */
function readStringList(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const text = readText(item, maximumLength);
    return text ? [text] : [];
  }))].slice(0, maximumItems);
}

/** 归一化 LoRA 类型，防止历史值污染对外契约。 */
function normalizeType(value: unknown): GalleryLoraMetadataView["type"] {
  const type = typeof value === "string" ? value.toLowerCase() : "";
  if (type === "style" || type === "character" || type === "concept" || type === "clothing" || type === "pose") return type;
  return "other";
}

/** 转换为 Prisma LoRA 枚举值。 */
function databaseLoraType(value: GalleryLoraMetadataView["type"]): "STYLE" | "CHARACTER" | "CONCEPT" | "CLOTHING" | "POSE" | "OTHER" {
  if (value === "style") return "STYLE";
  if (value === "character") return "CHARACTER";
  if (value === "concept") return "CONCEPT";
  if (value === "clothing") return "CLOTHING";
  if (value === "pose") return "POSE";
  return "OTHER";
}

/** 历史兼容匹配键只使用规范化后的精确标题和类型。 */
function legacyMatchKey(title: string, type: GalleryLoraMetadataView["type"]): string {
  return `${title.trim()}\u0000${type}`;
}
