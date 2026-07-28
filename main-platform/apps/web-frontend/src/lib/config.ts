/** 前端配置 — 所有环境相关值从此文件读取，禁止硬编码 */
export const config = {
  /** 后端 API 地址 */
  /** 后端 API 地址 — 生产留空使用相对路径（nginx 代理），开发设 http://localhost:6369 */
  apiBase: import.meta.env.VITE_API_BASE ?? '',
  /** wsproxy 服务地址 — 生产留空使用相对路径 */
  wsproxyBase: import.meta.env.VITE_WSPROXY_BASE ?? '',
  /** 站点名称 */
  siteName: '绘图姬 DrawHime',
  /** 每日免费余额(元) */
  freeBalanceDaily: 1.2,
  /** 参考图最大数量 */
  maxReferenceImages: 8,
  /** 单张参考图最大大小(MB)，只限制每个单文件，不限制累计。 */
  maxImageSizeMb: 3,
  /** 单任务参考图原始大小合计上限(MB)，按本次参考图列表相加。 */
  maxReferenceImagesTotalSizeMb: 16,
  /** 头像等普通图片入口允许的格式。 */
  allowedImageTypes: ['image/png', 'image/jpeg', 'image/webp'] as string[],
  /** 参考图允许的 MIME；服务端会统一转成静态 PNG。 */
  referenceImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/tiff', 'image/svg+xml'] as string[],
  /** 参考图文件选择器格式；扩展名用于兼容浏览器未提供 File.type 的 TIFF/JFIF 文件。 */
  referenceImageAccept: 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/tiff,image/svg+xml,.jpg,.jpeg,.jfif,.tif,.tiff,.svg,.avif,.gif',
  /** 分页默认大小 */
  pageSize: 20,
  /** Bot 列表刷新间隔(ms) */
  botRefreshInterval: 10000,
  /** Toast 显示时长(ms) */
  toastDuration: 3000,
  /** 端点有效期(ms) */
  endpointTtl: 30 * 60 * 1000,
} as const;
