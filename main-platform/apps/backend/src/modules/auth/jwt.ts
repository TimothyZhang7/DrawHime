import jwt, { type SignOptions } from 'jsonwebtoken';
import { readStringEnv } from '@aiimage/core-utils';
import type { UserRole } from '@aiimage/shared-contracts';
import { CONFIG_KEYS, getString } from '../../shared/config/config-service.js';

export type AccessTokenPayload = {
  sub: number;
  role: UserRole;
};

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  // JWT 有效期是后台可配置项，签发新 token 时读取最新 system_configs。
  const expiresIn = await getString(CONFIG_KEYS.authJwtExpiresIn.key, CONFIG_KEYS.authJwtExpiresIn.default);
  return jwt.sign(payload, readStringEnv('JWT_SECRET'), { expiresIn: expiresIn as SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, readStringEnv('JWT_SECRET'));
  if (typeof payload !== 'object' || typeof payload.sub !== 'number') {
    throw new Error('无效登录状态');
  }
  const role = payload.role === 'admin' ? 'admin' : 'user';
  return { sub: payload.sub, role };
}
