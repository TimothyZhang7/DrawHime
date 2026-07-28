import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const SQLS = [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned TINYINT(1) DEFAULT 0",
  "ALTER TABLE bot_connections ADD COLUMN IF NOT EXISTS qq_number VARCHAR(32) DEFAULT NULL",
  "ALTER TABLE bot_connections ADD COLUMN IF NOT EXISTS self_id VARCHAR(32) DEFAULT NULL",
  "ALTER TABLE bot_connections ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
  "ALTER TABLE qq_bindings ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
  "ALTER TABLE api_sites ADD COLUMN IF NOT EXISTS updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
];
for (const sql of SQLS) {
  try { await p.$executeRawUnsafe(sql); console.log('OK'); } catch(e) { console.log(e.message.substring(0,80)); }
}
await p.$disconnect();
