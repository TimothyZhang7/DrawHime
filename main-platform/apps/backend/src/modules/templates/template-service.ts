/**
 * 本文件实现模板 CRUD 和收藏业务逻辑。
 *
 * 约束：
 * - 创建者才能编辑和删除自己的模板
 * - 封面图仅 1 张，只允许 /api/images/ 站内地址和 data URL（后端转存）
 * - 收藏是 toggle 操作，同一用户同一模板只能收藏一次
 * - 符合 specs/README.md TPL-001 到 TPL-007
 */
import type { Prisma } from '@prisma/client';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { TemplateError, type TemplateFavoriteResponse, type TemplateListResponse, type TemplateView } from './template-types.js';
import type { TemplateListQuery } from '@aiimage/shared-contracts';

/** 默认分页大小。 */
const DEFAULT_PAGE_SIZE = 20;
/** 最大分页大小。 */
const MAX_PAGE_SIZE = 50;
/** 模板名称最大长度，与数据库 varchar(128) 保持一致。 */
const MAX_TEMPLATE_NAME_LENGTH = 128;
/** 模板介绍最大长度，与数据库 varchar(2048) 保持一致。 */
const MAX_TEMPLATE_DESCRIPTION_LENGTH = 2048;
/** 模板提示词最大长度，低于 MySQL TEXT 上限，避免超长 AI 草稿触发数据库异常。 */
const MAX_TEMPLATE_PROMPT_LENGTH = 30000;
/** 模板默认值 JSON 最大长度，低于 MySQL TEXT 上限，避免保存时触发数据库异常。 */
const MAX_TEMPLATE_DEFAULT_VALUES_LENGTH = 30000;

/** 模板服务，负责模板和收藏的业务用例。 */
export class TemplateService {
  private readonly prisma = getPrismaClient();

  /**
   * 列出模板：公开模板 + 当前用户的私有模板。
   * @param userId 当前登录用户 ID
   * @param query 已归一化的筛选与分页参数
   */
  async listTemplates(userId: number, query: TemplateListQuery): Promise<TemplateListResponse> {
    const take = Number.isFinite(query.pageSize) ? Math.min(Math.max(Math.floor(query.pageSize), 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    const page = Number.isFinite(query.page) ? Math.max(1, Math.floor(query.page)) : 1;
    const skip = (page - 1) * take;

    // 使用 AND 数组避免 Prisma 泛型类型冲突
    const conditions: Prisma.TemplateWhereInput[] = [];
    if (query.myOnly) conditions.push({ userId });
    else conditions.push({ OR: [{ isPublic: true }, { userId }] });
    // 收藏筛选必须在数据库分页前完成，避免前端过滤导致页码和总数失真。
    if (query.favoriteOnly) conditions.push({ favorites: { some: { userId } } });
    if (query.source === 'copies') conditions.push({ sourceTemplateId: { not: null } });
    if (query.source === 'original') conditions.push({ sourceTemplateId: null });
    if (query.search) conditions.push({ OR: [{ name: { contains: query.search } }, { promptTemplate: { contains: query.search } }] });
    const where: Prisma.TemplateWhereInput = conditions.length === 1 ? conditions[0] : { AND: conditions };

    const [items, total] = await Promise.all([
      this.prisma.template.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: templateInclude,
      }),
      this.prisma.template.count({ where }),
    ]);

    return {
      items: await this.toTemplateViews(items, userId),
      total,
      page,
      pageSize: take,
    };
  }

  /** 查看单个模板详情。 */
  async getTemplate(templateId: number, userId: number): Promise<TemplateView> {
    const tpl = await this.prisma.template.findUnique({
      where: { id: templateId },
      include: templateInclude,
    });
    if (!tpl) throw new TemplateError('not_found', '模板不存在');
    // 非公开且非创建者不能查看
    if (!tpl.isPublic && tpl.userId !== userId) {
      throw new TemplateError('forbidden', '无权查看该模板');
    }
    const views = await this.toTemplateViews([tpl], userId);
    return views[0];
  }

  /** 创建模板。 */
  async createTemplate(userId: number, input: {
    name: string;
    description?: string;
    promptTemplate: string;
    size?: string;
    quality?: string;
    moderation?: string;
    coverImageUrls?: string[];
    isPublic?: boolean;
    sourceTemplateId?: number;
    defaultValues?: string;
  }): Promise<TemplateView> {
    const normalized = normalizeTemplateInput(input, true);

    const tpl = await this.prisma.template.create({
      data: {
        userId,
        name: normalized.name!,
        description: normalized.description ?? '',
        promptTemplate: normalized.promptTemplate!,
        size: normalized.size ?? 'auto',
        quality: normalized.quality ?? 'auto',
        moderation: normalized.moderation ?? 'auto',
        coverImageUrls: JSON.stringify(normalized.coverImageUrls ?? []),
        isPublic: normalized.isPublic ?? false,
        sourceTemplateId: normalized.sourceTemplateId ?? null,
        defaultValues: normalized.defaultValues ?? null,
      },
      include: templateInclude,
    });

    const views = await this.toTemplateViews([tpl], userId);
    return views[0];
  }

  /** 编辑模板（仅创建者）。 */
  async updateTemplate(templateId: number, userId: number, input: {
    name?: string;
    description?: string;
    promptTemplate?: string;
    defaultValues?: string;
    size?: string;
    quality?: string;
    moderation?: string;
    coverImageUrls?: string[];
    isPublic?: boolean;
  }): Promise<TemplateView> {
    const existing = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!existing) throw new TemplateError('not_found', '模板不存在');
    if (existing.userId !== userId) throw new TemplateError('forbidden', '只能编辑自己的模板');
    const normalized = normalizeTemplateInput(input, false);

    const tpl = await this.prisma.template.update({
      where: { id: templateId },
      data: {
        ...(normalized.name !== undefined ? { name: normalized.name } : {}),
        ...(normalized.description !== undefined ? { description: normalized.description } : {}),
        ...(normalized.promptTemplate !== undefined ? { promptTemplate: normalized.promptTemplate } : {}),
        ...(normalized.defaultValues !== undefined ? { defaultValues: normalized.defaultValues } : {}),
        ...(normalized.size !== undefined ? { size: normalized.size } : {}),
        ...(normalized.quality !== undefined ? { quality: normalized.quality } : {}),
        ...(normalized.moderation !== undefined ? { moderation: normalized.moderation } : {}),
        ...(normalized.coverImageUrls !== undefined ? { coverImageUrls: JSON.stringify(normalized.coverImageUrls) } : {}),
        ...(normalized.isPublic !== undefined ? { isPublic: normalized.isPublic } : {}),
      },
      include: templateInclude,
    });

    const views = await this.toTemplateViews([tpl], userId);
    return views[0];
  }

  /** 删除模板（仅创建者）。 */
  async deleteTemplate(templateId: number, userId: number): Promise<void> {
    const existing = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!existing) throw new TemplateError('not_found', '模板不存在');
    if (existing.userId !== userId) throw new TemplateError('forbidden', '只能删除自己的模板');
    await this.prisma.template.delete({ where: { id: templateId } });
  }

  /** POST 收藏：创建收藏（已存在则幂等返回）。 */
  async favorite(templateId: number, userId: number): Promise<TemplateFavoriteResponse> {
    const tpl = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!tpl) throw new TemplateError('not_found', '模板不存在');
    const existing = await this.prisma.templateFavorite.findUnique({
      where: { userId_templateId: { userId, templateId } },
    });
    if (!existing) {
      await this.prisma.templateFavorite.create({ data: { userId, templateId } });
    }
    const count = await this.prisma.templateFavorite.count({ where: { templateId } });
    return { favorited: true, favoriteCount: count };
  }

  /** DELETE 取消收藏：删除已有收藏，不存在时抛 404。 */
  async unfavorite(templateId: number, userId: number): Promise<TemplateFavoriteResponse> {
    const tpl = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!tpl) throw new TemplateError('not_found', '模板不存在');
    const existing = await this.prisma.templateFavorite.findUnique({
      where: { userId_templateId: { userId, templateId } },
    });
    if (!existing) throw new TemplateError('not_found', '未收藏该模板');
    await this.prisma.templateFavorite.delete({ where: { id: existing.id } });
    const count = await this.prisma.templateFavorite.count({ where: { templateId } });
    return { favorited: false, favoriteCount: count };
  }

  /** 收藏/取消收藏模板（toggle，保留用于 POST 兼容）。 */
  async toggleFavorite(templateId: number, userId: number): Promise<TemplateFavoriteResponse> {
    const tpl = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!tpl) throw new TemplateError('not_found', '模板不存在');

    const existing = await this.prisma.templateFavorite.findUnique({
      where: { userId_templateId: { userId, templateId } },
    });

    if (existing) {
      await this.prisma.templateFavorite.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.templateFavorite.create({ data: { userId, templateId } });
    }

    const count = await this.prisma.templateFavorite.count({ where: { templateId } });
    return { favorited: !existing, favoriteCount: count };
  }

  /** 将数据库记录转换为 API 视图。 */
  private async toTemplateViews(
    records: Awaited<ReturnType<typeof this.prisma.template.findMany<{ include: typeof templateInclude }>>>,
    userId: number,
  ): Promise<TemplateView[]> {
    // 批量查询收藏状态
    const templateIds = records.map((r) => r.id);
    const favorites = templateIds.length > 0
      ? await this.prisma.templateFavorite.findMany({
          where: { templateId: { in: templateIds }, userId },
          select: { templateId: true },
        })
      : [];
    const favoritedSet = new Set(favorites.map((f) => f.templateId));

    // 批量查询收藏数
    const counts = templateIds.length > 0
      ? await this.prisma.templateFavorite.groupBy({
          by: ['templateId'],
          where: { templateId: { in: templateIds } },
          _count: { templateId: true },
        })
      : [];
    const countMap = new Map(counts.map((c) => [c.templateId, c._count.templateId]));

    return records.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? '',
      promptTemplate: r.promptTemplate,
      defaultValues: r.defaultValues ?? undefined,
      sourceTemplateId: r.sourceTemplateId ?? undefined,
      size: r.size,
      quality: r.quality,
      moderation: r.moderation,
      coverImageUrls: parseCoverUrls(r.coverImageUrls),
      isPublic: r.isPublic,
      isFavorited: favoritedSet.has(r.id),
      favoriteCount: countMap.get(r.id) ?? 0,
      userId: r.userId,
      username: r.user?.username ?? '',
      createdAt: formatChinaDateTime(r.createdAt),
      updatedAt: formatChinaDateTime(r.updatedAt),
    }));
  }
}

/** 模板查询包含字段，显式 select 避免返回大字段。 */
const templateInclude = {
  user: { select: { id: true, username: true } },
} as const;

/** 解析 coverImageUrls JSON 字符串为数组。 */
function parseCoverUrls(raw: unknown): string[] {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  return [];
}

/** 归一化并校验模板保存入参，所有长度限制必须先于数据库写入执行。 */
function normalizeTemplateInput(input: {
  name?: string;
  description?: string;
  promptTemplate?: string;
  size?: string;
  quality?: string;
  moderation?: string;
  coverImageUrls?: string[];
  isPublic?: boolean;
  sourceTemplateId?: number;
  defaultValues?: string;
}, requireRequiredFields: boolean) {
  const name = input.name !== undefined ? String(input.name).trim() : undefined;
  const promptTemplate = input.promptTemplate !== undefined ? String(input.promptTemplate).trim() : undefined;
  const description = input.description !== undefined ? String(input.description) : undefined;
  const defaultValues = input.defaultValues !== undefined ? String(input.defaultValues) : undefined;

  if (requireRequiredFields && !name) throw new TemplateError('invalid_request', '模板名称不能为空');
  if (requireRequiredFields && !promptTemplate) throw new TemplateError('invalid_request', 'Prompt 模板不能为空');
  if (name !== undefined && name.length > MAX_TEMPLATE_NAME_LENGTH) throw new TemplateError('invalid_request', `模板名称不能超过 ${MAX_TEMPLATE_NAME_LENGTH} 字`);
  if (description !== undefined && description.length > MAX_TEMPLATE_DESCRIPTION_LENGTH) throw new TemplateError('invalid_request', `模板介绍不能超过 ${MAX_TEMPLATE_DESCRIPTION_LENGTH} 字`);
  if (promptTemplate !== undefined && promptTemplate.length > MAX_TEMPLATE_PROMPT_LENGTH) throw new TemplateError('invalid_request', `Prompt 模板不能超过 ${MAX_TEMPLATE_PROMPT_LENGTH} 字`);
  if (defaultValues !== undefined && defaultValues.length > MAX_TEMPLATE_DEFAULT_VALUES_LENGTH) throw new TemplateError('invalid_request', '模板默认值过长，请减少变量数量或默认值长度');
  if (input.coverImageUrls && input.coverImageUrls.length > 1) throw new TemplateError('invalid_request', '封面图仅限 1 张');

  return {
    name,
    description,
    promptTemplate,
    size: input.size,
    quality: input.quality,
    moderation: input.moderation,
    coverImageUrls: input.coverImageUrls,
    isPublic: input.isPublic,
    sourceTemplateId: input.sourceTemplateId,
    defaultValues,
  };
}

/** 格式化中国时区时间。 */
function formatChinaDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}
