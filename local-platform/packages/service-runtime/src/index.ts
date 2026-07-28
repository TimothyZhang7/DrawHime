/**
 * 本文件提供各后端程序共用的 HTTP 生命周期、统一响应和真实依赖就绪检查。
 */
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  DependencyStatus,
  ServiceHealthView,
  ServiceReadinessView,
} from "@drawhime/contracts";
import { database, disconnectDatabase } from "@drawhime/database";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createClient } from "redis";

/** 推理任务 Redis 队列名，队列只携带任务 ID。 */
export const INFERENCE_QUEUE_KEY = "drawhime:inference:ready";
/** 训练任务 Redis 队列名，队列同样只携带任务 ID。 */
export const TRAINING_QUEUE_KEY = "drawhime:training:ready";

/** 推理队列连接，API 与 Worker 通过同一实现投递和领取任务。 */
export class InferenceQueue {
  private readonly client = createClient({ url: requireEnvironment("REDIS_URL") });

  /** 每个队列连接只注册一次错误监听，避免循环 connect 累积监听器。 */
  public constructor() {
    this.client.on("error", () => undefined);
  }

  /** 建立 Redis 连接。 */
  public async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }

  /** 幂等任务状态由数据库保证，队列只负责唤醒 Worker。 */
  public async push(jobId: string): Promise<void> {
    await this.connect();
    await this.client.rPush(INFERENCE_QUEUE_KEY, jobId);
  }

  /** 阻塞领取一个任务，超时返回 null 以便 Worker 执行补偿扫描。 */
  public async pop(timeoutSeconds = 5): Promise<string | null> {
    await this.connect();
    const item = await this.client.blPop(INFERENCE_QUEUE_KEY, timeoutSeconds);
    return item?.element ?? null;
  }

  /** 关闭队列连接。 */
  public async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
}

/** 训练队列连接，与推理队列隔离以避免长任务阻塞绘图消费。 */
export class TrainingQueue {
  private readonly client = createClient({ url: requireEnvironment("REDIS_URL") });

  public constructor() { this.client.on("error", () => undefined); }
  /** 建立 Redis 连接。 */
  public async connect(): Promise<void> { if (!this.client.isOpen) await this.client.connect(); }
  /** 唤醒训练 Worker，任务幂等与状态仍由数据库保证。 */
  public async push(jobId: string): Promise<void> { await this.connect(); await this.client.rPush(TRAINING_QUEUE_KEY, jobId); }
  /** 阻塞领取一个训练任务。 */
  public async pop(timeoutSeconds = 5): Promise<string | null> { await this.connect(); const item = await this.client.blPop(TRAINING_QUEUE_KEY, timeoutSeconds); return item?.element ?? null; }
  /** 关闭训练队列连接。 */
  public async close(): Promise<void> { if (this.client.isOpen) await this.client.close(); }
}

/** 上传二进制产物到独立对象存储。 */
export async function putObjectBuffer(objectKey: string, body: Buffer, contentType: string): Promise<void> {
  const { client, bucket } = createObjectStorageClient();
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body, ContentType: contentType }));
  } finally {
    client.destroy();
  }
}

/** 从本地临时文件流式上传大对象，避免 LoRA 文件完整进入 Node 堆内存。 */
export async function putObjectFile(objectKey: string, filePath: string, contentType: string, byteSize: number): Promise<void> {
  const { client, bucket } = createObjectStorageClient();
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: createReadStream(filePath), ContentType: contentType, ContentLength: byteSize }));
  } finally {
    client.destroy();
  }
}

/** 从独立对象存储读取产物，调用方必须先完成业务权限校验。 */
export async function getObjectBuffer(objectKey: string): Promise<{ body: Buffer; contentType: string }> {
  const { client, bucket } = createObjectStorageClient();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (!result.Body) throw new Error("对象存储返回空内容");
    return {
      body: Buffer.from(await result.Body.transformToByteArray()),
      contentType: result.ContentType || "application/octet-stream",
    };
  } finally {
    client.destroy();
  }
}

/** 把独立对象存储中的大对象直接写入目标流，避免完整文件进入 Node 堆内存。 */
export async function streamObjectToWritable(objectKey: string, destination: Writable): Promise<void> {
  const { client, bucket } = createObjectStorageClient();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    if (!result.Body) throw new Error("对象存储返回空内容");
    await pipeline(result.Body as NodeJS.ReadableStream, destination);
  } finally {
    client.destroy();
  }
}

/** 删除独立对象存储中的指定对象，只供已完成数据库归属校验的业务调用。 */
export async function deleteObject(objectKey: string): Promise<void> {
  const { client, bucket } = createObjectStorageClient();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  } finally {
    client.destroy();
  }
}

/** 创建使用私有配置的 S3 客户端。 */
function createObjectStorageClient(): { client: S3Client; bucket: string } {
  const endpoint = requireEnvironment("S3_ENDPOINT");
  const bucket = requireEnvironment("S3_BUCKET");
  const accessKeyId = requireEnvironment("S3_ACCESS_KEY");
  const secretAccessKey = requireEnvironment("S3_SECRET_KEY");
  return {
    bucket,
    client: new S3Client({
      endpoint,
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

/** 读取必填环境变量，缺失时直接阻止真实任务运行。 */
function requireEnvironment(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`缺少必填配置：${key}`);
  return value;
}

/** 运行时版本号。 */
export const PLATFORM_VERSION = "0.1.0";

/** 就绪检查函数。 */
export type DependencyCheck = () => Promise<DependencyStatus>;

/** 自定义 HTTP 路由上下文。 */
export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

/** 服务创建参数。 */
export interface ServiceOptions {
  name: string;
  port: number;
  checks: DependencyCheck[];
  registerRoutes?: (router: ServiceRouter, getReadiness: () => Promise<ServiceReadinessView>) => void;
}

type RouteHandler = (context: RouteContext) => Promise<void> | void;

/** 简单且明确的服务端路由器，仅注册实际可工作的端点。 */
export class ServiceRouter {
  private readonly routes: Array<{ method: string; path: string; handler: RouteHandler }> = [];

  /** 注册 GET 路由。 */
  public get(path: string, handler: RouteHandler): void {
    this.register("GET", path, handler);
  }

  /** 注册 POST 路由。 */
  public post(path: string, handler: RouteHandler): void {
    this.register("POST", path, handler);
  }

  /** 注册 DELETE 路由。 */
  public delete(path: string, handler: RouteHandler): void {
    this.register("DELETE", path, handler);
  }

  /** 注册明确方法的路由。 */
  public register(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), path, handler });
  }

  /** 根据请求方法与路径执行处理器。 */
  public async dispatch(context: RouteContext): Promise<boolean> {
    const method = context.request.method ?? "GET";
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchRoutePath(route.path, context.url.pathname);
      if (!params) continue;
      await route.handler({ ...context, params });
      return true;
    }
    return false;
  }
}

/** 匹配静态或冒号参数路由，参数值统一做 URL 解码。 */
function matchRoutePath(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index];
    const value = actual[index];
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(value);
    else if (part !== value) return null;
  }
  return params;
}

/** 读取并限制 JSON 请求体，所有写接口必须经过运行时校验后再使用。 */
export async function readJsonBody<T>(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("请求体超过大小限制");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

/** 输出 JSON 响应。 */
export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(body));
}

/** 输出统一成功响应。 */
export function sendSuccess(response: ServerResponse, data: unknown, statusCode = 200): void {
  sendJson(response, statusCode, { ok: true, data });
}

/** 输出统一失败响应。 */
export function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  sendJson(response, statusCode, { ok: false, code, message });
}

/** 在截止时间内执行异步操作，防止 readiness 自身挂起。 */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} 检查超时`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** 将异常转换为不包含凭证的简短消息。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "未知错误";
}

/** 创建必填配置检查。 */
export function createConfigCheck(name: string, keys: string[]): DependencyCheck {
  return async () => {
    const missing = keys.filter((key) => {
      const value = process.env[key]?.trim();
      return !value || value.startsWith("<") || value.includes("change_me");
    });
    return {
      name,
      ready: missing.length === 0,
      latencyMs: 0,
      message: missing.length === 0 ? "配置完整" : `缺少有效配置：${missing.join(", ")}`,
    };
  };
}

/** 创建独立数据库连通性检查。 */
export function createDatabaseCheck(): DependencyCheck {
  return async () => {
    const startedAt = performance.now();
    try {
      await withTimeout(database.$queryRaw`SELECT 1`, 3000, "database");
      return {
        name: "database",
        ready: true,
        latencyMs: Math.round(performance.now() - startedAt),
        message: "独立数据库可用",
      };
    } catch (error) {
      return {
        name: "database",
        ready: false,
        latencyMs: Math.round(performance.now() - startedAt),
        message: errorMessage(error),
      };
    }
  };
}

/** 创建 Redis PING 检查。 */
export function createRedisCheck(): DependencyCheck {
  return async () => {
    const startedAt = performance.now();
    const redisUrl = process.env.REDIS_URL?.trim();
    if (!redisUrl) {
      return { name: "redis", ready: false, latencyMs: 0, message: "REDIS_URL 未配置" };
    }
    const client = createClient({ url: redisUrl, socket: { connectTimeout: 2500 } });
    client.on("error", () => undefined);
    try {
      await withTimeout(client.connect(), 3000, "redis");
      const result = await withTimeout(client.ping(), 1500, "redis ping");
      return {
        name: "redis",
        ready: result === "PONG",
        latencyMs: Math.round(performance.now() - startedAt),
        message: result === "PONG" ? "Redis 可用" : `Redis 返回 ${result}`,
      };
    } catch (error) {
      return {
        name: "redis",
        ready: false,
        latencyMs: Math.round(performance.now() - startedAt),
        message: errorMessage(error),
      };
    } finally {
      if (client.isOpen) await client.close();
    }
  };
}

/** 创建 S3/MinIO Bucket 检查。 */
export function createObjectStorageCheck(): DependencyCheck {
  return async () => {
    const startedAt = performance.now();
    const endpoint = process.env.S3_ENDPOINT?.trim();
    const bucket = process.env.S3_BUCKET?.trim();
    const accessKeyId = process.env.S3_ACCESS_KEY?.trim();
    const secretAccessKey = process.env.S3_SECRET_KEY?.trim();
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || accessKeyId.startsWith("<")) {
      return { name: "object-storage", ready: false, latencyMs: 0, message: "对象存储配置不完整" };
    }
    const client = new S3Client({
      endpoint,
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    try {
      await withTimeout(client.send(new HeadBucketCommand({ Bucket: bucket })), 3500, "object storage");
      return {
        name: "object-storage",
        ready: true,
        latencyMs: Math.round(performance.now() - startedAt),
        message: `Bucket ${bucket} 可用`,
      };
    } catch (error) {
      return {
        name: "object-storage",
        ready: false,
        latencyMs: Math.round(performance.now() - startedAt),
        message: errorMessage(error),
      };
    } finally {
      client.destroy();
    }
  };
}

/** 创建 HTTP JSON 端点检查。 */
export function createHttpCheck(name: string, urlProvider: () => string | undefined): DependencyCheck {
  return async () => {
    const startedAt = performance.now();
    const url = urlProvider()?.trim();
    if (!url) return { name, ready: false, latencyMs: 0, message: `${name} 地址未配置` };
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
      const body = (await response.json()) as { ok?: boolean; data?: { ready?: boolean } };
      const ready = response.ok && body.ok === true && body.data?.ready !== false;
      return {
        name,
        ready,
        latencyMs: Math.round(performance.now() - startedAt),
        message: ready ? "端点可用" : `端点返回 HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        name,
        ready: false,
        latencyMs: Math.round(performance.now() - startedAt),
        message: errorMessage(error),
      };
    }
  };
}

/** 执行服务全部就绪检查。 */
export async function collectReadiness(name: string, checks: DependencyCheck[]): Promise<ServiceReadinessView> {
  const dependencies = await Promise.all(checks.map((check) => check()));
  return {
    service: name,
    ready: dependencies.every((dependency) => dependency.ready),
    timestamp: new Date().toISOString(),
    dependencies,
  };
}

/** 启动具备健康、就绪和优雅退出能力的 HTTP 服务。 */
export function startService(options: ServiceOptions): void {
  const router = new ServiceRouter();
  const startedAt = Date.now();
  const getReadiness = () => collectReadiness(options.name, options.checks);
  options.registerRoutes?.(router, getReadiness);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,authorization,x-dataset-caption,x-upload-offset",
      });
      response.end();
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const data: ServiceHealthView = {
          service: options.name,
          status: "alive",
          version: PLATFORM_VERSION,
          timestamp: new Date().toISOString(),
          uptimeSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
        };
        sendSuccess(response, data);
        return;
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        const data = await getReadiness();
        sendSuccess(response, data, data.ready ? 200 : 503);
        return;
      }
      const handled = await router.dispatch({ request, response, url, params: {} });
      if (!handled) sendError(response, 404, "route_not_found", "请求的端点不存在");
    } catch (error) {
      sendError(response, 500, "internal_error", errorMessage(error));
    }
  });

  server.listen(options.port, "0.0.0.0", () => {
    process.stdout.write(`${options.name} 已监听 0.0.0.0:${options.port}\n`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`${options.name} 收到 ${signal}，开始优雅退出\n`);
    server.close();
    await disconnectDatabase().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
