import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const p = new PrismaClient();
const password = process.env.SEED_ADMIN_PASSWORD || 'change-me-admin-password';
const hash = await bcrypt.hash(password, 10);
await p.user.update({ where: { username: 'admin' }, data: { passwordHash: hash } });
console.log('Password reset OK');
await p.$disconnect();
