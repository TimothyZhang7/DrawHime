import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const p = new PrismaClient();
const user = await p.user.findFirst({ where: { username: 'admin' } });
console.log('User found:', !!user);
console.log('Hash:', user?.passwordHash?.substring(0, 20) + '...');
const password = process.env.SEED_ADMIN_PASSWORD || 'change-me-admin-password';
const match = await bcrypt.compare(password, user.passwordHash);
console.log('Match:', match);
if (!match) {
  const newHash = await bcrypt.hash(password, 10);
  await p.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
  console.log('Password reset to configured SEED_ADMIN_PASSWORD, new hash:', newHash.substring(0, 20) + '...');
}
await p.$disconnect();
