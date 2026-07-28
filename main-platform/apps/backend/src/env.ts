/**
 * 本文件实现启动时环境变量校验：必须的环境变量缺失时立即退出，避免运行时才发现配置错误。
 * 在 main.ts 最顶部调用 validateEnv() 即可。
 */

/** 必需环境变量及其说明。 */
const REQUIRED_ENV_VARS: Record<string, string> = {
  DATABASE_URL: 'MySQL 连接字符串，格式 mysql://<user>:<password>@<host>:<port>/<database>',
  JWT_SECRET: 'JWT 签名密钥，至少 16 字符',
};

/** 生产环境额外必需的变量。 */
const PRODUCTION_ENV_VARS: Record<string, string> = {
  WS_PROXY_TOKEN: '服务间通信 token，生产环境必须设置',
};

/**
 * 校验环境变量。缺失任何必需变量时打印错误并退出进程。
 * 在服务启动前调用，fail-fast 原则。
 */
export function validateEnv(): void {
  const missing: string[] = [];
  const warnings: string[] = [];

  // 检查必需变量
  for (const [key, desc] of Object.entries(REQUIRED_ENV_VARS)) {
    if (!process.env[key]?.trim()) {
      missing.push(`  ${key}: ${desc}`);
    }
  }

  // 检查 URL 格式
  const dbUrl = process.env.DATABASE_URL ?? '';
  if (dbUrl && !dbUrl.startsWith('mysql://')) {
    warnings.push(`DATABASE_URL 格式可能不正确，当前值不以 mysql:// 开头`);
  }

  // 检查 JWT 密钥强度
  const jwtSecret = process.env.JWT_SECRET ?? '';
  if (jwtSecret && jwtSecret.length < 16) {
    warnings.push('JWT_SECRET 长度不足 16 字符，建议使用更长的随机密钥');
  }
  // 检查是否使用默认密钥
  if (jwtSecret === 'change-me-in-production') {
    warnings.push('JWT_SECRET 使用默认值，生产环境必须更换！');
  }
  if (process.env.SEED_ADMIN_PASSWORD === 'change-me-admin-password') {
    warnings.push('SEED_ADMIN_PASSWORD 使用示例默认值，生产环境必须更换！');
  }

  // 生产环境额外检查
  if (process.env.NODE_ENV === 'production') {
    for (const [key, desc] of Object.entries(PRODUCTION_ENV_VARS)) {
      if (!process.env[key]?.trim()) {
        missing.push(`  ${key}: ${desc}（生产环境必需）`);
      }
    }
  } else {
    if (!process.env.WS_PROXY_TOKEN?.trim()) {
      warnings.push('WS_PROXY_TOKEN 未设置，服务间 token 校验已跳过（仅开发环境允许）');
    }
  }

  if (missing.length > 0) {
    console.error('[env] 缺少必需环境变量，服务无法启动：');
    console.error(missing.join('\n'));
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('[env] 环境配置警告：');
    warnings.forEach((w) => console.warn(`  ⚠ ${w}`));
  }

  console.log('[env] 环境变量校验通过');
}
