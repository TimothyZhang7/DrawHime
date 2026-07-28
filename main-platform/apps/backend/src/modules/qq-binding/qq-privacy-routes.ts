/**
 * 本文件注册 QQ 图片隐私偏好的内部接口（Bot 调用）。
 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const prisma = getPrismaClient();

export function createQqPrivacyRoutes(): Route[] {
  return [
    { method: 'POST', path: '/internal/qq/privacy/toggle', handle: togglePrivacy },
  ];
}

/** Bot 命令 /隐私 触发：切换 QQ 用户的默认图片私密偏好。 */
async function togglePrivacy(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyServiceToken(req)) {
    return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
  }
  const body = await readJsonBody(req);
  const qqStr = String(body.qqNumber ?? '');
  if (!/^\d{5,}$/.test(qqStr)) {
    return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest, message: 'QQ 号格式不正确' });
  }
  const qqNumber = BigInt(qqStr);

  const existing = await prisma.qqImagePrivacyPref.findUnique({ where: { qqNumber } });
  const newPrivate = !(existing?.isPrivate ?? false);

  await prisma.qqImagePrivacyPref.upsert({
    where: { qqNumber },
    update: { isPrivate: newPrivate },
    create: { qqNumber, isPrivate: newPrivate },
  });

  return sendJson(res, 200, { ok: true, data: { isPrivate: newPrivate } });
}

function verifyServiceToken(req: IncomingMessage): boolean {
  const expectedToken = process.env.WS_PROXY_TOKEN?.trim();
  if (!expectedToken) return isMissingServiceTokenAllowed();
  const headerToken = String(req.headers['x-service-token'] ?? '').trim();
  return headerToken === expectedToken;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}
