/** 本文件提供 backend 唯一 Prisma Client 单例，所有数据库访问必须复用该连接池。 */
import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | undefined;

/** 获取 Prisma Client 单例，避免在请求内重复创建数据库连接池。 */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    // Prisma 会从 DATABASE_URL 读取连接池参数，本地配置必须包含 connection_limit/pool_timeout/connect_timeout。
    prisma = new PrismaClient();
  }
  return prisma;
}
