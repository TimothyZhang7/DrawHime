import type { ServerResponse } from 'node:http';

/** JSON 响应统一处理 BigInt，避免数据库原样返回的整数标识直接导致序列化失败。 */
function stringifyJson(body: unknown): string {
  return JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(stringifyJson(body));
}
