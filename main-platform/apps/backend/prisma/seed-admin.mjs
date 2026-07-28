import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const p = new PrismaClient();
const password = process.env.SEED_ADMIN_PASSWORD || 'change-me-admin-password';
const hash = await bcrypt.hash(password, 10);
let admin = await p.user.findFirst({ where: { username: 'admin' } });
if (admin) {
  await p.user.update({ where: { id: admin.id }, data: { passwordHash: hash } });
  console.log('Admin password reset');
} else {
  admin = await p.user.create({
    data: { username: 'admin', email: 'admin@aiimage.local', passwordHash: hash, role: 'admin', emailVerified: true }
  });
  console.log('Admin created:', admin.id);
}
await p.$disconnect();
