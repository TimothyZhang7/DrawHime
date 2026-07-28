/**
 * 本文件提供独立数据库客户端的单例生命周期，避免开发热重载重复建立连接池。
 */
import { PrismaClient } from "@prisma/client";

const globalDatabase = globalThis as typeof globalThis & {
  drawhimeDatabase?: PrismaClient;
};

/** 本地模型平台数据库客户端。 */
export const database =
  globalDatabase.drawhimeDatabase ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalDatabase.drawhimeDatabase = database;
}

/** 主动关闭数据库连接，供服务优雅退出使用。 */
export async function disconnectDatabase(): Promise<void> {
  await database.$disconnect();
}

export * from "@prisma/client";
