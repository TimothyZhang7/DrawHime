/**
 * CORS 中间件：允许的源从后台 system_configs.cors_allowed_origins 读取。
 * 环境变量只作为兜底，避免后台面板保存后不生效。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONFIG_KEYS, getString } from '../config/config-service.js';

/** 从环境变量读取允许的源（逗号分隔），未配置时允许所有源 */
async function getAllowedOrigins(): Promise<string[]> {
  const raw = (await getString(CONFIG_KEYS.corsAllowedOrigins.key, process.env.CORS_ALLOWED_ORIGINS ?? '')).trim();
  if (!raw) return []; // 空 = 允许所有（开发模式）
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** CORS 中间件：对 OPTIONS 预检请求直接返回 204，对普通请求添加 CORS 头。 */
export async function corsMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const origin = req.headers.origin ?? '';
  const allowed = await getAllowedOrigins();

  // 允许所有或匹配白名单
  if (allowed.length === 0 || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Service-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  // OPTIONS 预检请求直接返回
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  next();
}
