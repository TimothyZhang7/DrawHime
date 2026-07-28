/**
 * 本文件统一服务间 token 缺失时的运行环境策略，避免生产内部入口因配置缺失而放行。
 */

/** 仅在明确的开发或测试环境允许缺少服务间 token，其他环境默认拒绝。 */
export function isMissingServiceTokenAllowed(): boolean {
  const runtimeEnv = String(process.env.NODE_ENV || process.env.APP_ENV || '').trim().toLowerCase();
  return runtimeEnv === 'development' || runtimeEnv === 'test';
}
