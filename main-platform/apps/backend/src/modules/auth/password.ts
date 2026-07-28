/** 密码哈希工具：bcrypt 轮数从系统配置读取，管理后台可调整安全强度。 */
import bcrypt from 'bcryptjs';
import { getString, CONFIG_KEYS } from '../../shared/config/config-service.js';

/** 读取并限制 bcrypt 轮数，避免后台误填导致注册或改密把 CPU 打满。 */
async function readSaltRounds(): Promise<number> {
  const raw = await getString(CONFIG_KEYS.authSaltRounds.key, CONFIG_KEYS.authSaltRounds.default);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return Number(CONFIG_KEYS.authSaltRounds.default);
  return Math.min(16, Math.max(8, value));
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, await readSaltRounds());
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
