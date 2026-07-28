/**
 * 本文件实现公开图库标签查询服务。
 *
 * 职责：
 * - 只统计公开、成功、已有图片配置的图库代表任务，避免私密图标签外泄。
 * - 返回同名标签的固定配色和公开使用数，供前端构建热门标签入口。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { GalleryPopularTagView, GalleryTagView } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

/** 公开图库标签服务。 */
export class GalleryTagService {
  private readonly prisma: PrismaClient = getPrismaClient();

  /** 查询公开图库标签；limit 受控，筛选弹窗可拉取较完整列表但仍避免无边界聚合扫描。 */
  async listPopularTags(limitInput = 24): Promise<GalleryPopularTagView[]> {
    const limit = Math.min(Math.max(Math.floor(limitInput) || 24, 1), 500);
    const rows = await this.prisma.$queryRaw<Array<{
      name: string;
      slug: string;
      category: string;
      colorBg: string;
      colorText: string;
      colorBorder: string;
      count: bigint | number;
      weight: bigint | number;
    }>>(Prisma.sql`
      SELECT
        gt.name,
        gt.slug,
        gt.category,
        gt.color_bg AS colorBg,
        gt.color_text AS colorText,
        gt.color_border AS colorBorder,
        COUNT(DISTINCT gtt.task_id) AS count,
        ROUND(AVG(gtt.weight)) AS weight
      FROM gallery_tags gt
      INNER JOIN generation_task_tags gtt ON gtt.tag_id = gt.id
      INNER JOIN generation_tasks t ON t.id = gtt.task_id
      WHERE gt.disabled = false
        AND t.status = 'success'
        AND t.is_private = false
        AND EXISTS (
          SELECT 1 FROM system_configs c
          WHERE c.\`key\` = CONCAT('task_image_', t.id)
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.value, '$.imageFilename')), '') <> ''
        )
        AND (
          t.batch_id IS NULL
          OR COALESCE(t.batch_total, 1) <= 1
          OR t.id = (
            SELECT t2.id
            FROM generation_tasks t2
            WHERE t2.batch_id = t.batch_id
            ORDER BY COALESCE(t2.batch_index, 1) ASC, t2.created_at ASC, t2.id ASC
            LIMIT 1
          )
        )
      GROUP BY gt.id, gt.name, gt.slug, gt.category, gt.color_bg, gt.color_text, gt.color_border
      ORDER BY count DESC, weight DESC, gt.usage_count DESC, gt.name ASC
      LIMIT ${limit}
    `);
    return rows.map((row) => ({
      name: row.name,
      slug: row.slug,
      category: normalizeGalleryTagCategory(row.category),
      weight: Number(row.weight ?? 0),
      count: Number(row.count ?? 0),
      color: {
        bg: row.colorBg,
        text: row.colorText,
        border: row.colorBorder,
      },
    }));
  }
}

/** 归一化标签分类，防止历史脏值进入前端类型分支。 */
function normalizeGalleryTagCategory(value: string): GalleryTagView['category'] {
  if (value === 'subject' || value === 'feature' || value === 'scene' || value === 'style'
    || value === 'composition' || value === 'mood' || value === 'safety' || value === 'other') {
    return value;
  }
  return 'other';
}
