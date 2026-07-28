/** 本文件负责前端暂存邀请短码；真实邀请关系必须以 backend 数据库为准。 */

const STORAGE_KEY = 'drawhime.pendingInviteCode';
const EXPIRES_KEY = 'drawhime.pendingInviteCodeExpiresAt';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 从 URL 或用户输入中提取邀请码短码，完整邀请链接也会解析 query。 */
export function extractInviteCode(value: string | null | undefined) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const fromQuery = parsed.searchParams.get('invite') || parsed.searchParams.get('ref') || parsed.searchParams.get('code');
    if (fromQuery) return normalizeInviteCode(fromQuery);
  } catch {
    // 普通短码不是 URL，继续按短码处理。
  }
  return normalizeInviteCode(raw);
}

/** 保存待注册的邀请码；仅用于自动填充，不作为奖励发放依据。 */
export function savePendingInviteCode(code: string) {
  const normalized = normalizeInviteCode(code);
  if (!normalized) return '';
  localStorage.setItem(STORAGE_KEY, normalized);
  localStorage.setItem(EXPIRES_KEY, String(Date.now() + TTL_MS));
  return normalized;
}

/** 读取未过期的邀请码。 */
export function readPendingInviteCode() {
  const expiresAt = Number(localStorage.getItem(EXPIRES_KEY) ?? '0');
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    clearPendingInviteCode();
    return '';
  }
  return normalizeInviteCode(localStorage.getItem(STORAGE_KEY) ?? '');
}

/** 清除前端暂存的邀请码；后端已落库或用户主动清空后调用。 */
export function clearPendingInviteCode() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(EXPIRES_KEY);
}

function normalizeInviteCode(value: string) {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(code) ? code : '';
}
