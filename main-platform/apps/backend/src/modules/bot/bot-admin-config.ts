/** 本文件负责读取 QQ 端 Bot 管理员配置，供内部 Bot 接口和余额调整兜底鉴权复用。 */
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';

const prisma = getPrismaClient();

/** 读取 QQ 端管理员列表；后台显式白名单 + 已绑定 Web 管理员账号都可执行 Bot 管理命令。 */
export async function readBotAdminQqNumbers(): Promise<string[]> {
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: ['bot_admin_qq_numbers'] } },
    select: { value: true },
  });
  const configured = rows.flatMap((row) => parseQqNumberList(row.value));
  const adminBindings = await prisma.qqBinding.findMany({
    where: {
      verified: true,
      qqNumber: { not: null },
      user: { role: 'admin' },
    },
    select: { qqNumber: true },
  });
  return [...new Set([...configured, ...adminBindings.map((item) => item.qqNumber?.toString() ?? '')].filter(Boolean))];
}

/** 判断指定 QQ 是否具备 Bot 管理命令权限。 */
export async function isBotAdminQqNumber(qqNumber: string): Promise<boolean> {
  if (!/^\d{5,20}$/.test(qqNumber)) return false;
  const adminQqNumbers = await readBotAdminQqNumbers();
  return adminQqNumbers.includes(qqNumber);
}

/** 解析后台输入的 QQ 白名单，支持换行、逗号、空格和中文分隔符。 */
function parseQqNumberList(value: string): string[] {
  return value
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter((item) => /^\d{5,20}$/.test(item));
}
