/**
 * Backend 入口：环境校验、HTTP 启动、卡死任务清理、每日免费余额重置调度。
 */
import { validateEnv } from './env.js';
import { createBackendApp } from './app/backend-app.js';
import { getPrismaClient } from './infrastructure/database/prisma-client.js';
import { GenerationsService } from './modules/generations/generations-service.js';
import { WalletService } from './modules/wallet/wallet-service.js';

const DAILY_FREE_RESET_KEY = 'free_balance_last_daily_reset_date';
const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_RESET_STARTUP_GRACE_MINUTES = 10;

validateEnv();
const app = createBackendApp();

app.start().then(async () => {
  console.log('[backend] started');
  void resumePendingPromptAssistTasks();
  scheduleStaleTaskCleanup();
  scheduleDailyFreeReset();
}).catch((error) => {
  console.error('[backend] startup failed', error);
  process.exit(1);
});

/** 启动后恢复已持久化但尚未进入绘图调度的 AI 提示增强任务。 */
async function resumePendingPromptAssistTasks() {
  try {
    const resumed = await new GenerationsService().resumePendingPromptAssistTasks();
    if (resumed > 0) console.log(`[backend] [prompt-assist] 已恢复 ${resumed} 个任务`);
  } catch (error) {
    console.error('[backend] [prompt-assist] 恢复失败', error instanceof Error ? error.message : String(error));
  }
}

/** 每 5 分钟清理卡死任务；任务状态最终写入必须通过业务服务处理退款和子任务状态。 */
function scheduleStaleTaskCleanup() {
  const cleanup = async () => {
    try {
      const prisma = getPrismaClient();
      const cutoff = new Date(Date.now() - 10 * 60 * 1000);
      const stale = await prisma.generationTask.findMany({
        where: { status: 'running', updatedAt: { lt: cutoff } },
        select: { id: true },
      });
      if (stale.length === 0) return;

      const generationsService = new GenerationsService();
      for (const task of stale) {
        await generationsService.updateTaskStatus({ taskId: task.id, status: 'failed', error: '任务超时自动清理' });
      }
      await prisma.$transaction(async (tx) => {
        await tx.generationSubTask.updateMany({
          where: { taskId: { in: stale.map((task) => task.id) }, status: 'running' },
          data: { status: 'failed', error: '任务超时', finishedAt: new Date() },
        });
      });
      console.log(`[backend] [cleanup] 已清理 ${stale.length} 个卡死任务并退款`);
    } catch (error) {
      console.error('[backend] [cleanup] 清理失败', error instanceof Error ? error.message : String(error));
    }
  };

  const timer = setInterval(cleanup, 5 * 60 * 1000);
  timer.unref?.();
  // 启动 30 秒后首次执行，避免和 Worker 抢占刚启动的运行中任务。
  setTimeout(cleanup, 30_000).unref?.();
}

/** 按中国时间每日 00:00 调度免费余额重置，并用日期标记保证同一天只执行一次。 */
function scheduleDailyFreeReset() {
  void runDailyFreeResetDuringStartupWindow();

  const scheduleNext = () => {
    const delayMs = getMsUntilNextChinaMidnight(new Date());
    const timer = setTimeout(async () => {
      await runDailyFreeResetOnce(new Date(), 'cron');
      scheduleNext();
    }, delayMs);
    timer.unref?.();
    console.log(`[cron] 下一次免费余额重置将在 ${Math.round(delayMs / 1000)} 秒后触发`);
  };

  scheduleNext();
}

/** 启动时若正好处于中国时间 00:00 后短窗口内，则补一次当日重置，防止重启错过零点。 */
async function runDailyFreeResetDuringStartupWindow(): Promise<void> {
  const now = new Date();
  const china = getChinaTimeParts(now);
  if (china.hour !== 0 || china.minute >= DAILY_RESET_STARTUP_GRACE_MINUTES) return;
  await runDailyFreeResetOnce(now, 'startup');
}

/** 每日免费余额重置入口；只重置免费余额，不清空付费余额。 */
async function runDailyFreeResetOnce(now: Date, source: 'cron' | 'startup'): Promise<number> {
  const prisma = getPrismaClient();
  const today = getChinaDateString(now);
  const lastReset = await prisma.systemConfig.findUnique({
    where: { key: DAILY_FREE_RESET_KEY },
    select: { value: true },
  });
  if (lastReset?.value === today) {
    console.log(`[cron] ${today} 免费余额已重置，跳过 ${source} 触发`);
    return 0;
  }

  console.log(`[cron] 开始每日免费余额重置：${today} (${source})`);
  const count = await resetAllFreeBalances();
  await prisma.systemConfig.upsert({
    where: { key: DAILY_FREE_RESET_KEY },
    update: { value: today },
    create: { key: DAILY_FREE_RESET_KEY, value: today },
  });
  console.log(`[cron] 已重置 ${count} 个身份钱包的免费余额`);
  return count;
}

/** 读取配置并重置所有已知身份钱包免费余额；Web/QQ 钱包各取每日总额的一半。 */
async function resetAllFreeBalances(): Promise<number> {
  const prisma = getPrismaClient();
  const row = await prisma.systemConfig.findUnique({ where: { key: 'free_balance_daily' }, select: { value: true } });
  const daily = Math.max(0, Number(row?.value ?? '1.2'));
  return new WalletService().resetAllKnownFreeBalances(daily);
}

/** 获取中国日期字符串，用作每日重置幂等键。 */
function getChinaDateString(date: Date): string {
  return new Date(date.getTime() + CHINA_TIME_OFFSET_MS).toISOString().slice(0, 10);
}

/** 获取中国时间的小时和分钟，用于启动补偿窗口判断。 */
function getChinaTimeParts(date: Date): { hour: number; minute: number } {
  const china = new Date(date.getTime() + CHINA_TIME_OFFSET_MS);
  return {
    hour: china.getUTCHours(),
    minute: china.getUTCMinutes(),
  };
}

/** 计算距离下一个中国时间零点的毫秒数，触发点向后偏 5 秒避免边界抖动。 */
function getMsUntilNextChinaMidnight(now: Date): number {
  const china = new Date(now.getTime() + CHINA_TIME_OFFSET_MS);
  const nextMidnightUtcMs = Date.UTC(
    china.getUTCFullYear(),
    china.getUTCMonth(),
    china.getUTCDate() + 1,
    -8,
    0,
    5,
  );
  return Math.max(1_000, nextMidnightUtcMs - now.getTime());
}

/** 优雅关闭：SIGTERM/SIGINT 时退出，node --watch 自动重启实现零闪断更新。 */
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[backend] 收到 ${signal}，正在关闭...`);
  setTimeout(() => process.exit(0), 500).unref?.();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
