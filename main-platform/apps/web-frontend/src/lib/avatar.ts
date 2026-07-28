/** 本文件集中处理 Web 用户头像外显优先级：网页头像 > QQ 头像 > 首字符。 */

/** 可用于头像展示的最小用户字段。 */
export type AvatarDisplayUser = {
  username: string;
  avatarUrl?: string | null;
  qqNumber?: string | null;
};

/** 构建 QQ 头像地址；仅用于用户明确要求的头像回退展示，不写入 Web 头像字段。 */
export function buildQqAvatarUrl(qqNumber?: string | null, size = 640): string | null {
  const qq = String(qqNumber ?? '').trim();
  return qq ? `https://q.qlogo.cn/headimg_dl?dst_uin=${encodeURIComponent(qq)}&spec=${size}` : null;
}

/** 解析当前实际外显头像；没有网页头像时才回退 QQ 头像。 */
export function resolveDisplayAvatar(user: AvatarDisplayUser): { url: string | null; source: 'web' | 'qq' | 'initial' } {
  if (user.avatarUrl) return { url: user.avatarUrl, source: 'web' };
  const qqAvatarUrl = buildQqAvatarUrl(user.qqNumber);
  if (qqAvatarUrl) return { url: qqAvatarUrl, source: 'qq' };
  return { url: null, source: 'initial' };
}

/** 用户名首字符兜底，支持中文和 emoji 这类多字节字符。 */
export function getAvatarInitial(username?: string | null): string {
  const text = String(username ?? '').trim();
  return (Array.from(text)[0] ?? 'U').toUpperCase();
}
