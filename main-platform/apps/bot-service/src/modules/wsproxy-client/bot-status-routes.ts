/** 本文件定义 bot-service 的基础状态查询接口。 */
import { type ApiDataResponse, type BotServiceStatusData } from '@aiimage/shared-contracts';
import { sendJson, type Route } from '@aiimage/core-utils';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readWsproxyEventStats, supportedBotCommands, messageLog } from './wsproxy-event-service.js';

const startedAt = Date.now();

/** 创建 bot-service 状态路由，返回运行时内存和事件处理计数。 */
export function createBotStatusRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/bot/status',
      handle: (_req, res) => {
        const memory = process.memoryUsage();
        const data: BotServiceStatusData = {
          service: 'bot-service',
          version: '3.0.0',
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
          },
          eventStats: readWsproxyEventStats(),
          supportedCommands: supportedBotCommands,
        };
        const response: ApiDataResponse<BotServiceStatusData> = { ok: true, data };
        sendJson(res, 200, response);
      },
    },
    {
      method: 'GET',
      path: '/api/bot/logs',
      handle: (_req, res) => {
        return sendJson(res, 200, { ok: true, data: { logs: messageLog, total: messageLog.length } });
      },
    },
    {
      method: 'GET',
      path: '/api/bot/logs/files',
      handle: (_req, res) => {
        const logDir = process.env.BOT_LOG_DIR ?? join(process.cwd(), 'bot-logs');
        try {
          if (!existsSync(logDir)) return sendJson(res, 200, { ok: true, data: { files: [] } });
          const files = readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
          return sendJson(res, 200, { ok: true, data: { files } });
        } catch { return sendJson(res, 200, { ok: true, data: { files: [] } }); }
      },
    },
  ];
}
