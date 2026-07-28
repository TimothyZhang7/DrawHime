/** 本文件提供 各服务共享的 HTTP 服务启动工厂，支持中间件链和 WebSocket upgrade。 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { sendJson } from './json.js';
import type { RouteHandler } from './router.js';

/** HTTP 中间件函数签名；允许中间件异步读取配置后再决定是否进入下一环。 */
export type HttpMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void | Promise<void>;

/** HTTP 服务配置，支持中间件链和 WebSocket upgrade。 */
export type HttpServiceOptions = {
  name: string;
  port: number;
  handler: RouteHandler;
  /** 中间件链，按数组顺序依次执行。 */
  middlewares?: HttpMiddleware[];
  configureServer?: (server: http.Server) => void;
};

/** 创建标准 HTTP 服务，统一处理中间件链、未捕获异常和启动日志。 */
export function createHttpService(options: HttpServiceOptions) {
  const middlewares = options.middlewares ?? [];

  const server = http.createServer((req, res) => {
    // 执行中间件链，然后执行路由处理器
    let idx = 0;
    const next = () => {
      if (idx < middlewares.length) {
        const mw = middlewares[idx++];
        try {
          Promise.resolve(mw(req, res, next)).catch((error) => {
            console.error(`[${options.name}] middleware error`, error);
            sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '服务内部错误' });
          });
        } catch (error) {
          console.error(`[${options.name}] middleware error`, error);
          sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError, message: '服务内部错误' });
        }
      } else {
        // 所有中间件执行完毕，进入路由处理
        Promise.resolve(options.handler(req, res)).catch((error) => {
          console.error(`[${options.name}] request failed`, error);
          sendJson(res, 500, {
            ok: false,
            code: ApiErrorCode.InternalError,
            message: '服务内部错误',
          });
        });
      }
    };
    next();
  });

  // WebSocket 服务需要复用同一个端口时，通过该钩子注册 upgrade 监听。
  options.configureServer?.(server);

  return {
    /** 启动 HTTP 服务；长期运行进程由各 app 的 main.ts 负责托管。 */
    async start() {
      await new Promise<void>((resolve) => server.listen(options.port, resolve));
      console.log(`[${options.name}] listening on ${options.port}`);
    },
  };
}
