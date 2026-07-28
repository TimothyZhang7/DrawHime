import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { sendJson } from './json.js';

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) => void | Promise<void>;

export type Route = {
  method: string;
  path: string;
  handle: RouteHandler;
};

/** 路由匹配结果，包含处理器和路径参数。 */
type RouteMatch = { route: Route; params: Record<string, string> };

export function createRouter(routes: Route[]): RouteHandler {
  return async (req, res) => {
    const method = req.method || 'GET';
    const urlPath = new URL(req.url || '/', 'http://localhost').pathname;
    const match = findRoute(routes, method, urlPath);
    if (!match) {
      sendJson(res, 404, {
        ok: false,
        code: ApiErrorCode.NotFound,
        message: '接口不存在',
      });
      return;
    }
    await match.route.handle(req, res, match.params);
  };
}

/** 在路由表中匹配请求，支持 :paramName 路径参数。 */
function findRoute(routes: Route[], method: string, urlPath: string): RouteMatch | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, urlPath);
    if (params !== null) return { route, params };
  }
  return null;
}

/** 匹配静态路径或带 :paramName 的动态路径，返回参数或 null。 */
function matchPath(routePath: string, urlPath: string): Record<string, string> | null {
  if (!routePath.includes(':')) {
    return routePath === urlPath ? {} : null;
  }
  const routeParts = routePath.split('/');
  const urlParts = urlPath.split('/');
  if (routeParts.length !== urlParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i++) {
    const routePart = routeParts[i];
    const urlPart = urlParts[i];
    if (routePart.startsWith(':')) {
      params[routePart.slice(1)] = decodeURIComponent(urlPart);
    } else if (routePart !== urlPart) {
      return null;
    }
  }
  return params;
}
