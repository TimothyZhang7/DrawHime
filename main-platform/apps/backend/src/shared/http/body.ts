import type { IncomingMessage } from 'node:http';

/** JSON 请求体超过路由声明上限时抛出，用于路由层返回 413 而不是进入 500 错误日志。 */
export class JsonBodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super('请求体过大');
    this.name = 'JsonBodyTooLargeError';
  }
}

/** 读取 JSON 请求体；limitBytes 必须由路由按真实业务负载显式放宽。 */
export async function readJsonBody<T>(req: IncomingMessage, limitBytes = 1024 * 64): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) throw new JsonBodyTooLargeError(limitBytes);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}
