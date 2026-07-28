#!/usr/bin/env node
/**
 * 本脚本在独立子进程中创建 本地开发数据库，避免主 dev 脚本加载 Prisma Client 后锁住 Windows 查询引擎文件。
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromBackend = createRequire(resolve(rootDir, 'apps/backend/package.json'));

/** 读取并校验目标数据库名，只允许普通标识符，防止拼接 SQL 时引入风险。 */
function readTargetDatabaseName() {
  const databaseName = process.env.AIIMAGE_TARGET_DATABASE ?? process.env.V3_TARGET_DATABASE;
  if (!databaseName || !/^[a-zA-Z0-9_]+$/.test(databaseName)) {
    throw new Error(`本地数据库名不安全：${databaseName ?? ''}`);
  }
  return databaseName;
}

/** 使用 backend 包中的 Prisma Client 连接管理库并创建目标开发库。 */
async function main() {
  const databaseName = readTargetDatabaseName();
  const { PrismaClient } = requireFromBackend('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
