/** 本文件负责工具接口二进制请求体的限量读取，避免上传数据无上限占用内存。 */
import type { IncomingMessage } from 'node:http';

/** 读取二进制图片请求体，超过后台配置上限时立即中止。 */
export async function readBinaryBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.length;
    if (size > limitBytes) throw new BinaryBodyTooLargeError(limitBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 二进制请求体超过后台配置上限时抛出，路由层按具体工具返回稳定 413。 */
export class BinaryBodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super('请求体过大');
    this.name = 'BinaryBodyTooLargeError';
  }
}
