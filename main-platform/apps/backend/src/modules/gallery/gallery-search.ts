/**
 * 本文件负责构建公开图库搜索 SQL。
 *
 * 搜索只作用于公开成功且已有图片的图库查询，所有用户输入必须通过 Prisma 参数绑定；
 * 这里不读取余额、用户私密数据或任务私密结果，只提供 WHERE 子句片段。
 */
import { Prisma } from '@prisma/client';
import type { GalleryImageToImageKind, GalleryTagMatchMode } from '@aiimage/shared-contracts';

/** 图库搜索最大长度；过长输入会拖慢 LIKE/MATCH 条件，必须在服务端截断。 */
const MAX_SEARCH_LENGTH = 120;
/** 聚合搜索最多使用的分词数；每个词按 AND 约束，多字段 OR 命中。 */
const MAX_SEARCH_TERMS = 6;
/** 显式字段组合搜索最多识别的字段数，避免用户构造超长复杂 SQL。 */
const MAX_EXPLICIT_TERMS = 4;
/** 多标签筛选最多接受 8 个标签，避免公开图库组合查询被构造成过重 SQL。 */
const MAX_TAG_FILTER_COUNT = 8;
/** 图生图替换生成判断词，与前端卡片展示口径保持一致，只用于公开图库筛选。 */
const IMAGE_TO_IMAGE_REPLACE_PATTERN = '替换|换成|换为|改成|改为|改掉|修改为|变成|去掉|删除|移除|抹除|擦除|添加|增加|加上|把.+?(换|改|变|删|去|移除)|将.+?(换|改|变|删|去|移除)';

/** 图库搜索 SQL 的输入参数。 */
export type GallerySearchQuery = {
  mode?: string;
  source?: string;
  search?: string;
  tag?: string;
  tags?: string[];
  tagMatch?: GalleryTagMatchMode;
  i2iKind?: GalleryImageToImageKind;
};

/** 公开图库展示成功、公开且已有真实本地图片或视频文件名的任务；存储状态不绕过公开性和成功状态校验。 */
export function buildGalleryWhereSql(query: GallerySearchQuery, promptFulltextReady: boolean): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`t.status = 'success'`,
    Prisma.sql`t.is_private = false`,
    Prisma.sql`EXISTS (
      SELECT 1 FROM system_configs c
      WHERE c.\`key\` = CONCAT('task_image_', t.id)
        AND (
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.imageFilename')), '') <> ''
          OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.videoFilename')), '') <> ''
        )
    )`,
  ];

  if (query.i2iKind) {
    clauses.push(Prisma.sql`t.mode = 'image-to-image'`);
    clauses.push(buildImageToImageKindSql(query.i2iKind));
  } else if (query.mode) {
    clauses.push(Prisma.sql`t.mode = ${query.mode}`);
  }
  if (query.source) clauses.push(Prisma.sql`t.source = ${query.source}`);
  const tagSql = buildGalleryTagsSql(query);
  if (tagSql) clauses.push(tagSql);

  const searchSql = buildGallerySearchSql(query.search, promptFulltextReady);
  if (searchSql) clauses.push(searchSql);

  return joinSqlClauses(clauses, Prisma.sql` AND `);
}

/** 构建图库聚合搜索条件；显式字段和普通关键词可以组合，提升复杂搜索准确性。 */
function buildGallerySearchSql(rawSearch: string | undefined, promptFulltextReady: boolean): Prisma.Sql | null {
  const normalized = normalizeGallerySearch(rawSearch);
  if (!normalized) return null;

  const parsed = parseMixedGallerySearch(normalized, promptFulltextReady);
  if (parsed.length > 0) return joinSqlClauses(parsed, Prisma.sql` AND `);

  if (isKnownGenerationTaskId(normalized)) {
    return Prisma.sql`t.id = ${normalized}`;
  }
  if (/^[a-zA-Z0-9_.-]{6,128}$/.test(normalized) && /^(web|bot|b_|br_|w_|task_|lr_)/i.test(normalized)) {
    return buildIdentifierSql(normalized);
  }
  if (/^\d{5,20}$/.test(normalized)) {
    const qqNumber = safeBigInt(normalized);
    const numericLike = toLikePattern(normalized);
    const clauses: Prisma.Sql[] = [
      Prisma.sql`u.id = ${Number(normalized)}`,
      Prisma.sql`u.username LIKE ${numericLike}`,
      Prisma.sql`t.id LIKE ${numericLike}`,
      Prisma.sql`t.client_request_id LIKE ${numericLike}`,
    ];
    if (qqNumber) clauses.unshift(Prisma.sql`(t.qq_number = ${qqNumber} OR qb.qq_number = ${qqNumber})`);
    return joinSqlClauses(clauses, Prisma.sql` OR `);
  }

  const terms = splitGallerySearchTerms(normalized);
  if (terms.length === 0) return null;
  return joinSqlClauses(terms.map((term) => buildSingleGallerySearchTermSql(term, promptFulltextReady)), Prisma.sql` AND `);
}

/** 处理 `qq:123 模型:gpt 角色` 这类组合搜索；普通词继续走聚合字段。 */
function parseMixedGallerySearch(search: string, promptFulltextReady: boolean): Prisma.Sql[] {
  const explicitSql: Prisma.Sql[] = [];
  const plainTerms: string[] = [];
  for (const token of splitGallerySearchTerms(search, MAX_SEARCH_TERMS + MAX_EXPLICIT_TERMS)) {
    const match = token.match(/^([a-zA-Z\u4e00-\u9fa5_-]{1,16})[:：](.+)$/);
    if (!match) {
      plainTerms.push(token);
      continue;
    }
    const key = normalizeSearchPrefix(match[1]);
    const value = normalizeGallerySearch(match[2]);
    if (!value) continue;
    const sql = buildExplicitGallerySearchSql(key, value, promptFulltextReady);
    if (sql && explicitSql.length < MAX_EXPLICIT_TERMS) explicitSql.push(sql);
    else plainTerms.push(token);
  }
  if (explicitSql.length === 0) return [];
  return [
    ...explicitSql,
    ...plainTerms.slice(0, MAX_SEARCH_TERMS).map((term) => buildSingleGallerySearchTermSql(term, promptFulltextReady)),
  ];
}

/** 支持中英文前缀，值非法时返回 FALSE，避免错误输入扩大结果范围。 */
function buildExplicitGallerySearchSql(key: string, value: string, promptFulltextReady: boolean): Prisma.Sql | null {
  const like = toLikePattern(value);
  if (key === 'qq') {
    const qq = parseQqSearch(value);
    return qq ? Prisma.sql`(t.qq_number = ${qq} OR qb.qq_number = ${qq})` : Prisma.sql`FALSE`;
  }
  if (key === 'user') return Prisma.sql`(u.username LIKE ${like} OR u.email LIKE ${like})`;
  if (key === 'uid') {
    const id = parsePositiveInt(value);
    return id ? Prisma.sql`u.id = ${id}` : Prisma.sql`FALSE`;
  }
  if (key === 'id' || key === 'task') return buildIdentifierSql(value);
  if (key === 'prompt') return buildPromptSearchSql(value, promptFulltextReady);
  if (key === 'model') return buildUpstreamSearchSql('model', like);
  if (key === 'site') return buildUpstreamSearchSql('site_name', like);
  if (key === 'source') return buildSourceSearchSql(value, like);
  if (key === 'mode') return buildModeSearchSql(value, like);
  if (key === 'tag' || key === '标签') return buildGalleryTagsSql({ tag: value }) ?? Prisma.sql`FALSE`;
  return null;
}

/** 单个搜索词在多字段中 OR 命中；多个搜索词之间使用 AND 提高结果相关性。 */
function buildSingleGallerySearchTermSql(term: string, promptFulltextReady: boolean): Prisma.Sql {
  const like = toLikePattern(term);
  const qq = /^\d{5,20}$/.test(term) ? safeBigInt(term) : null;
  const clauses: Prisma.Sql[] = [
    buildPromptSearchSql(term, promptFulltextReady),
    Prisma.sql`t.id LIKE ${like}`,
    Prisma.sql`t.client_request_id LIKE ${like}`,
    buildSourceSearchSql(term, like),
    buildModeSearchSql(term, like),
    Prisma.sql`u.username LIKE ${like}`,
    Prisma.sql`u.email LIKE ${like}`,
    Prisma.sql`EXISTS (
      SELECT 1 FROM generation_sub_tasks st
      WHERE st.task_id = t.id
        AND st.kind = 'upstream_attempt'
        AND (st.site_name LIKE ${like} OR st.model LIKE ${like})
    )`,
    Prisma.sql`EXISTS (
      SELECT 1
      FROM generation_task_tags gtt
      INNER JOIN gallery_tags gt ON gt.id = gtt.tag_id
      WHERE gtt.task_id = t.id
        AND gt.disabled = false
        AND (gt.name LIKE ${like} OR gt.slug LIKE ${like})
    )`,
  ];
  if (qq) clauses.unshift(Prisma.sql`(t.qq_number = ${qq} OR qb.qq_number = ${qq})`);
  return Prisma.sql`(${joinSqlClauses(clauses, Prisma.sql` OR `)})`;
}

/** 提示词搜索优先走 MySQL FULLTEXT；中文/短词用 LIKE 兜底保证准确性。 */
function buildPromptSearchSql(term: string, promptFulltextReady: boolean): Prisma.Sql {
  const like = toLikePattern(term);
  const booleanQuery = buildBooleanFulltextQuery(term);
  if (!promptFulltextReady || !booleanQuery) return Prisma.sql`t.prompt LIKE ${like}`;
  return Prisma.sql`(MATCH(t.prompt) AGAINST (${booleanQuery} IN BOOLEAN MODE) OR t.prompt LIKE ${like})`;
}

/** 搜索任务 ID 和幂等键；图片文件名反查配置表代价高，不能进入公开图库热路径。 */
function buildIdentifierSql(value: string): Prisma.Sql {
  const like = toLikePattern(value);
  return Prisma.sql`(
    t.id = ${value}
    OR t.id LIKE ${like}
    OR t.client_request_id = ${value}
    OR t.client_request_id LIKE ${like}
  )`;
}

/** 根据用户输入的中文来源词映射到数据库枚举，同时保留模糊匹配。 */
function buildSourceSearchSql(value: string, like: string): Prisma.Sql {
  const mapped = normalizeSourceValue(value);
  return mapped
    ? Prisma.sql`(t.source = ${mapped} OR t.source LIKE ${like})`
    : Prisma.sql`t.source LIKE ${like}`;
}

/** 根据用户输入的中文模式词映射到数据库枚举，同时保留模糊匹配。 */
function buildModeSearchSql(value: string, like: string): Prisma.Sql {
  const mapped = normalizeModeValue(value);
  return mapped
    ? Prisma.sql`(t.mode = ${mapped} OR t.mode LIKE ${like})`
    : Prisma.sql`t.mode LIKE ${like}`;
}

/** 构建图生图描述/替换生成筛选；替换词口径与卡片展示一致，避免前后端标签不一致。 */
function buildImageToImageKindSql(kind: GalleryImageToImageKind): Prisma.Sql {
  return kind === 'replace'
    ? Prisma.sql`t.prompt REGEXP ${IMAGE_TO_IMAGE_REPLACE_PATTERN}`
    : Prisma.sql`t.prompt NOT REGEXP ${IMAGE_TO_IMAGE_REPLACE_PATTERN}`;
}

/** 搜索成功或最近上游尝试中的模型/站点字段。 */
function buildUpstreamSearchSql(column: 'model' | 'site_name', like: string): Prisma.Sql {
  const columnSql = column === 'model' ? Prisma.sql`st.model` : Prisma.sql`st.site_name`;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM generation_sub_tasks st
    WHERE st.task_id = t.id AND st.kind = 'upstream_attempt' AND ${columnSql} LIKE ${like}
  )`;
}

/** 构建图库标签筛选条件；标签筛选必须精确匹配中文名或 slug，避免误扩大结果。 */
function buildGalleryTagsSql(query: GallerySearchQuery): Prisma.Sql | null {
  const tags = normalizeGalleryTagFilters([...(query.tags ?? []), query.tag].filter(Boolean) as string[]);
  if (tags.length === 0) return null;
  if (tags.length === 1) return buildSingleGalleryTagSql(tags[0]);
  const sqlList = tags.map((tag) => buildSingleGalleryTagSql(tag));
  return query.tagMatch === 'all'
    ? joinSqlClauses(sqlList, Prisma.sql` AND `)
    : Prisma.sql`EXISTS (
      SELECT 1
      FROM generation_task_tags gtt
      INNER JOIN gallery_tags gt ON gt.id = gtt.tag_id
      WHERE gtt.task_id = t.id
        AND gt.disabled = false
        AND ${joinSqlClauses(tags.map((tag) => Prisma.sql`(gt.name = ${tag} OR gt.slug = ${tag})`), Prisma.sql` OR `)}
    )`;
}

/** 构建单个标签的精确匹配 SQL；显式字段搜索和多标签 all 模式都会复用。 */
function buildSingleGalleryTagSql(tag: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM generation_task_tags gtt
    INNER JOIN gallery_tags gt ON gt.id = gtt.tag_id
    WHERE gtt.task_id = t.id
      AND gt.disabled = false
      AND (gt.name = ${tag} OR gt.slug = ${tag})
  )`;
}

/** 规范化多标签筛选，去重并限制数量；空白或过长标签不会进入 SQL。 */
function normalizeGalleryTagFilters(rawTags: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of rawTags) {
    const tag = normalizeGallerySearch(rawTag);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_TAG_FILTER_COUNT) break;
  }
  return result;
}

/** 规范化图库搜索输入，去掉控制字符并限制长度。 */
function normalizeGallerySearch(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);
}

function splitGallerySearchTerms(value: string, limit = MAX_SEARCH_TERMS): string[] {
  return value
    .split(/[\s,，;；]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, limit);
}

function normalizeSearchPrefix(value: string): string {
  const text = value.trim().toLowerCase();
  if (text === 'qq' || text === 'q' || text === 'qq号') return 'qq';
  if (text === '用户名' || text === '用户' || text === 'user' || text === 'name') return 'user';
  if (text === 'uid' || text === '用户id') return 'uid';
  if (text === '任务' || text === '任务id' || text === 'task' || text === 'id') return text === 'id' ? 'id' : 'task';
  if (text === '提示词' || text === '关键词' || text === '描述' || text === 'prompt') return 'prompt';
  if (text === '模型' || text === 'model') return 'model';
  if (text === '站点' || text === '线路' || text === '渠道' || text === 'site') return 'site';
  if (text === '来源' || text === '端' || text === 'source') return 'source';
  if (text === '模式' || text === '类型' || text === 'mode') return 'mode';
  if (text === '标签' || text === 'tag') return 'tag';
  return text;
}

function normalizeSourceValue(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (['网页', 'web', '网站', '前台'].includes(text)) return 'web';
  if (['bot', 'qq', '机器人', '群聊'].includes(text)) return 'bot';
  return null;
}

function normalizeModeValue(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (['文生图', '文字生图', 'text-to-image', 'txt2img', 't2i'].includes(text)) return 'text-to-image';
  if (['图生图', '图片生图', 'image-to-image', 'img2img', 'i2i'].includes(text)) return 'image-to-image';
  return null;
}

function toLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function buildBooleanFulltextQuery(value: string): string | null {
  const terms = splitGallerySearchTerms(value)
    .filter((term) => /[a-zA-Z0-9]/.test(term) && term.length >= 2)
    .map((term) => `+${term.replace(/[+\-<>()~*"@]/g, ' ').trim()}*`)
    .filter((term) => term.length > 2);
  return terms.length > 0 ? terms.join(' ') : null;
}

function safeBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** 安全解析 QQ 搜索值，非法输入返回 null，避免 BigInt 抛错打断图库加载。 */
function parseQqSearch(value: string): bigint | null {
  const text = value.trim();
  return /^\d{5,20}$/.test(text) ? safeBigInt(text) : null;
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 判断是否为当前系统会生成的任务 ID 前缀；文件名 img_/thumb_/ref_ 不会进入该分支。 */
function isKnownGenerationTaskId(identifier: string): boolean {
  return /^(b_|br_|w_|web_|web_retry_|task_)[a-zA-Z0-9_-]{1,80}$/.test(identifier);
}

/** 拼接 Prisma SQL 条件，所有用户输入仍通过 Prisma 参数绑定。 */
function joinSqlClauses(clauses: Prisma.Sql[], separator: Prisma.Sql): Prisma.Sql {
  return clauses.reduce((sql, clause, index) => (
    index === 0 ? clause : Prisma.sql`${sql}${separator}${clause}`
  ), Prisma.empty);
}
