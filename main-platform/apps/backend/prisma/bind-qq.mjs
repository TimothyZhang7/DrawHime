import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
const p = new PrismaClient();
const user = await p.user.findFirst({ where: { username: 'admin' } });
if (!user) { console.log('Admin not found'); process.exit(1); }
let binding = await p.qqBinding.findUnique({ where: { userId: user.id } });
if (binding) {
  const qqNumber = BigInt(process.env.SEED_BIND_QQ || '100000001');
  await p.qqBinding.update({ where: { userId: user.id }, data: { qqNumber, verified: true } });
  console.log('Updated:', user.username, '->', qqNumber);
} else {
  const qqNumber = BigInt(process.env.SEED_BIND_QQ || '100000001');
  await p.qqBinding.create({ data: { userId: user.id, qqNumber, verified: true, verificationKey: randomBytes(16).toString('hex') } });
  console.log('Created:', user.username, '->', qqNumber);
}
await p.$disconnect();
