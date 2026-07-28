import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
await p.$executeRawUnsafe("ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS charged_source VARCHAR(8) DEFAULT NULL");
await p.$executeRawUnsafe("ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS charged_amount VARCHAR(16) DEFAULT NULL");
console.log('Charge columns added');
await p.$disconnect();
