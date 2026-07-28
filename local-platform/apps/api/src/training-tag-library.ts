/**
 * 本文件维护 LoRA 训练标签翻译集、常用标签种子、稳定唯一颜色和使用次数。
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { TrainingTagTranslationView } from "@drawhime/contracts";
import { database } from "@drawhime/database";

const commonTranslations = [
  ["1girl", "一名女性"], ["1boy", "一名男性"], ["2girls", "两名女性"], ["2boys", "两名男性"], ["multiple girls", "多名女性"], ["multiple boys", "多名男性"], ["solo", "单人"],
  ["looking at viewer", "看向观众"], ["looking away", "看向别处"], ["looking back", "回头看"], ["eye contact", "视线接触"], ["closed eyes", "闭眼"], ["one eye closed", "单眼闭合"],
  ["smile", "微笑"], ["open mouth", "张嘴"], ["closed mouth", "闭嘴"], ["blush", "脸红"], ["tears", "眼泪"], ["crying", "哭泣"], ["angry", "生气"], ["surprised", "惊讶"], ["expressionless", "面无表情"],
  ["long hair", "长发"], ["short hair", "短发"], ["medium hair", "中长发"], ["very long hair", "超长发"], ["straight hair", "直发"], ["wavy hair", "波浪发"], ["curly hair", "卷发"], ["ponytail", "马尾"], ["twintails", "双马尾"], ["braid", "辫子"], ["bangs", "刘海"], ["hair over one eye", "头发遮住一只眼"],
  ["black hair", "黑发"], ["brown hair", "棕发"], ["blonde hair", "金发"], ["white hair", "白发"], ["grey hair", "灰发"], ["red hair", "红发"], ["blue hair", "蓝发"], ["green hair", "绿发"], ["purple hair", "紫发"], ["pink hair", "粉发"], ["multicolored hair", "多色头发"],
  ["blue eyes", "蓝眼"], ["red eyes", "红眼"], ["green eyes", "绿眼"], ["brown eyes", "棕眼"], ["purple eyes", "紫眼"], ["yellow eyes", "黄眼"], ["heterochromia", "异色瞳"],
  ["large breasts", "大胸"], ["medium breasts", "中等胸部"], ["small breasts", "小胸"], ["flat chest", "平胸"], ["wide hips", "宽胯"], ["thick thighs", "粗腿"], ["slim", "苗条"], ["muscular", "肌肉感"],
  ["standing", "站立"], ["sitting", "坐着"], ["kneeling", "跪姿"], ["squatting", "蹲姿"], ["lying", "躺着"], ["walking", "行走"], ["running", "奔跑"], ["jumping", "跳跃"], ["arms up", "举起双臂"], ["arms behind back", "双手背后"], ["crossed arms", "交叉双臂"], ["hand on hip", "手叉腰"], ["peace sign", "比出胜利手势"], ["dynamic pose", "动态姿势"],
  ["school uniform", "校服"], ["dress", "连衣裙"], ["skirt", "裙子"], ["pleated skirt", "百褶裙"], ["shirt", "衬衫"], ["t-shirt", "T恤"], ["jacket", "夹克"], ["hoodie", "连帽衫"], ["coat", "外套"], ["sweater", "毛衣"], ["shorts", "短裤"], ["pants", "长裤"], ["jeans", "牛仔裤"], ["swimsuit", "泳装"], ["bikini", "比基尼"], ["underwear", "内衣"], ["lingerie", "情趣内衣"], ["thighhighs", "过膝袜"], ["stockings", "长筒袜"], ["pantyhose", "连裤袜"], ["boots", "靴子"], ["high heels", "高跟鞋"], ["sneakers", "运动鞋"], ["gloves", "手套"], ["hat", "帽子"], ["hair ribbon", "发带"], ["bow", "蝴蝶结"], ["glasses", "眼镜"], ["jewelry", "珠宝首饰"],
  ["indoors", "室内"], ["outdoors", "室外"], ["bedroom", "卧室"], ["classroom", "教室"], ["city", "城市"], ["street", "街道"], ["forest", "森林"], ["beach", "海滩"], ["sky", "天空"], ["clouds", "云朵"], ["night", "夜晚"], ["sunset", "日落"], ["sunrise", "日出"], ["rain", "雨"], ["snow", "雪"], ["flower", "花"], ["nature", "自然环境"], ["simple background", "简洁背景"], ["white background", "白色背景"], ["black background", "黑色背景"], ["transparent background", "透明背景"],
  ["portrait", "肖像"], ["close-up", "特写"], ["upper body", "上半身"], ["cowboy shot", "牛仔镜头"], ["full body", "全身"], ["from above", "俯视"], ["from below", "仰视"], ["from side", "侧面视角"], ["dutch angle", "倾斜镜头"], ["wide shot", "广角全景"], ["depth of field", "景深"], ["blurry background", "背景虚化"], ["foreshortening", "透视缩短"],
  ["soft lighting", "柔和光照"], ["dramatic lighting", "戏剧性光照"], ["backlighting", "逆光"], ["rim light", "轮廓光"], ["sunlight", "阳光"], ["neon lights", "霓虹灯"], ["volumetric lighting", "体积光"], ["lens flare", "镜头光晕"], ["high contrast", "高对比度"], ["low contrast", "低对比度"], ["vibrant colors", "鲜艳色彩"], ["pastel colors", "粉彩色调"], ["monochrome", "单色"],
  ["anime style", "动漫风格"], ["manga", "漫画风格"], ["realistic", "写实"], ["photorealistic", "照片级写实"], ["3d", "三维渲染"], ["pixel art", "像素艺术"], ["watercolor", "水彩"], ["oil painting", "油画"], ["sketch", "素描"], ["lineart", "线稿"], ["cel shading", "赛璐璐上色"], ["thick lineart", "粗线稿"], ["thin lineart", "细线稿"], ["detailed background", "精细背景"],
  ["masterpiece", "杰作质量"], ["best quality", "最佳质量"], ["high quality", "高质量"], ["highly detailed", "高度精细"], ["absurdres", "超高分辨率"], ["official art", "官方艺术风格"], ["no humans", "无人物"], ["animal ears", "兽耳"], ["cat ears", "猫耳"], ["tail", "尾巴"], ["wings", "翅膀"], ["halo", "光环"],
] as const;

let seedPromise: Promise<number> | null = null;

/** 幂等写入平台维护的常用训练标签，返回当前已存在的种子数量。 */
export async function ensureCommonTagTranslations(): Promise<number> {
  if (!seedPromise) seedPromise = seedCommonTagTranslations().catch((error) => { seedPromise = null; throw error; });
  return seedPromise;
}

/** 查询翻译条目；最终返回用户时才累计一次使用次数。 */
export async function readTagTranslations(tags: string[], trackUsage = true): Promise<TrainingTagTranslationView["translations"]> {
  await ensureCommonTagTranslations();
  const normalized = normalizeTags(tags);
  const rows = await database.trainingTagTranslation.findMany({ where: { tag: { in: normalized } } });
  if (trackUsage && rows.length > 0) await database.trainingTagTranslation.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { usageCount: { increment: 1 } } });
  const map = new Map(rows.map((row) => [row.tag, row]));
  return normalized.flatMap((tag) => {
    const row = map.get(tag);
    return row ? [{ tag: row.tag, translated: row.translated, color: row.color, source: normalizeSource(row.source) }] : [];
  });
}

/** 持久化一个 AI 补全标签；并发写入和颜色碰撞都收敛到同一条记录。 */
export async function saveAiTagTranslation(tag: string, translated: string): Promise<void> {
  const normalizedTag = normalizeTag(tag);
  const normalizedTranslation = translated.trim().slice(0, 500);
  if (!normalizedTag || !normalizedTranslation) throw new Error("标签翻译内容为空");
  const existing = await database.trainingTagTranslation.findUnique({ where: { tag: normalizedTag } });
  if (existing) return;
  for (let nonce = 0; nonce < 64; nonce += 1) {
    try {
      await database.trainingTagTranslation.create({ data: { tag: normalizedTag, translated: normalizedTranslation, color: colorForTag(normalizedTag, nonce), source: "ai" } });
      return;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const raced = await database.trainingTagTranslation.findUnique({ where: { tag: normalizedTag } });
      if (raced) return;
    }
  }
  throw new Error("标签唯一颜色分配失败");
}

/** 返回去重且可安全写入索引列的规范化标签。 */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))].slice(0, 200);
}

/** 批量插入常用词；极少数颜色碰撞项再逐条换盐补齐。 */
async function seedCommonTagTranslations(): Promise<number> {
  const seeds = buildCommonSeeds();
  await database.trainingTagTranslation.createMany({ data: seeds, skipDuplicates: true });
  const existing = await database.trainingTagTranslation.findMany({ where: { tag: { in: seeds.map((seed) => seed.tag) } }, select: { tag: true } });
  const existingTags = new Set(existing.map((row) => row.tag));
  for (const seed of seeds) {
    if (!existingTags.has(seed.tag)) await saveCommonTagTranslation(seed.tag, seed.translated);
  }
  return database.trainingTagTranslation.count({ where: { source: "common" } });
}

/** 构造种子并确保本批内部颜色不重复。 */
function buildCommonSeeds(): Array<{ tag: string; translated: string; color: string; source: string }> {
  const colors = new Set<string>();
  return commonTranslations.map(([tag, translated]) => {
    let nonce = 0; let color = colorForTag(tag, nonce);
    while (colors.has(color)) color = colorForTag(tag, ++nonce);
    colors.add(color);
    return { tag, translated, color, source: "common" };
  });
}

/** 补写一个发生颜色冲突的常用标签。 */
async function saveCommonTagTranslation(tag: string, translated: string): Promise<void> {
  for (let nonce = 0; nonce < 64; nonce += 1) {
    try { await database.trainingTagTranslation.create({ data: { tag, translated, color: colorForTag(tag, nonce), source: "common" } }); return; }
    catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      if (await database.trainingTagTranslation.findUnique({ where: { tag } })) return;
    }
  }
  throw new Error("常用标签唯一颜色分配失败");
}

/** 从标签哈希生成可读的中等明度颜色；nonce 只在唯一索引碰撞时变化。 */
export function colorForTag(tag: string, nonce: number): string {
  const digest = createHash("sha256").update(`${tag}:${nonce}`).digest();
  const hue = digest.readUInt16BE(0) % 360;
  const saturation = 48 + digest[2]! % 21;
  const lightness = 38 + digest[3]! % 13;
  return hslToHex(hue, saturation, lightness);
}

/** 把 HSL 转为前端可直接使用的十六进制色值。 */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100; const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const part = hue / 60; const x = chroma * (1 - Math.abs(part % 2 - 1));
  const [red, green, blue] = part < 1 ? [chroma, x, 0] : part < 2 ? [x, chroma, 0] : part < 3 ? [0, chroma, x] : part < 4 ? [0, x, chroma] : part < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const match = l - chroma / 2;
  return `#${[red, green, blue].map((value) => Math.round((value + match) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** 统一标签大小写、下划线和空白。 */
export function normalizeTag(value: string): string {
  return value.trim().replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase().slice(0, 191);
}

/** 历史异常来源统一回退 AI，响应契约保持有限枚举。 */
function normalizeSource(value: string): "common" | "ai" {
  return value === "common" ? "common" : "ai";
}
