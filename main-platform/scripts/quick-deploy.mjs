#!/usr/bin/env node
/**
 * 快速部署脚本。
 *
 * 职责：
 * - 按 target 打最小源码包，只替换生产中受影响的 app/package/root 文件。
 * - 只构建、复制、重启被选中的服务或前端端点。
 * - 每次远端替换前创建备份，失败时保留日志用于回滚排查。
 * - 不覆盖生产私有 ecosystem.config.js、backend .env、数据库、媒体和 local 数据。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultHost = '';
const defaultPort = '22';
const defaultSshRetries = 5;
const defaultSshRetryDelayMs = 5000;
const defaultSshConnectTimeoutSec = 20;
const defaultSshServerAliveCountMax = 120;

const services = {
  backend: { app: 'backend', build: 'backend', pm2: 'v3-backend', port: 6369, dbGenerate: true },
  drawing: { app: 'drawing-service', build: 'drawing', pm2: 'v3-drawing', port: 3005 },
  'drawing-worker': { app: 'drawing-worker', build: 'drawing-worker', pm2: 'v3-worker', port: 3012 },
  media: { app: 'media-service', build: 'media', pm2: 'v3-media', port: 3013 },
  bot: { app: 'bot-service', build: 'bot', pm2: 'v3-bot', port: 3004 },
  'bot-renderer': { app: 'bot-renderer', build: 'bot-renderer', pm2: 'v3-renderer', port: 3014 },
  wsproxy: { app: 'wsproxy-service', build: 'wsproxy', pm2: 'v3-wsproxy', port: 3011 },
  notification: { app: 'notification-worker', build: 'notification', pm2: 'v3-notification', port: 3015 },
  ops: { app: 'ops-worker', build: 'ops', pm2: 'v3-ops', port: 3016 },
};

const frontends = {
  web: { app: 'web-frontend', build: 'web', dest: '/data/1panel/www/sites/xanime.ink/index', url: 'https://www.xanime.ink', rootSite: 'xanime.ink' },
  admin: { app: 'admin-portal', build: 'admin', dest: '/data/1panel/www/sites/admin.xanime.ink/index', url: 'https://admin.xanime.ink', rootSite: 'admin.xanime.ink' },
};

const sourceTarget = 'source';
const allTargets = [...Object.keys(services), ...Object.keys(frontends), sourceTarget];
const retiredWorkspaceApps = ['workflow-service', 'workflow-studio', 'local-inference-service'];
const args = parseArgs(process.argv.slice(2));
const targets = resolveTargets(args);
const deployHost = resolveDeployHost(args, targets);
const remoteRootPath = resolveRemoteRoot(targets);
const stamp = timestamp();
const logPath = resolve(rootDir, 'local', 'deploy-logs', `quick-deploy-${stamp}.log`);
mkdirSync(dirname(logPath), { recursive: true });

main().catch((error) => {
  log(`部署失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  log(`快速部署开始 target=${targets.join(',')}`);
  log(`日志文件 ${logPath}`);
  if (args.dryRun) {
    log('dry-run 模式，只打印计划，不执行命令');
    printPlan();
    return;
  }

  if (!args.skipLocalCheck) runLocalChecks();

  const packagePath = createSourcePackage();
  const remotePackage = remotePackagePath(packagePath);
  await uploadPackage(packagePath, remotePackage);
  const remoteStamp = stamp;

  await runRemote(remotePrepareScript(remotePackage, remoteStamp), { stepName: 'remote-prepare' });
  await runRemote(remoteBuildScript(), { stepName: 'remote-build' });
  await runRemote(remotePublishScript(remoteStamp), { stepName: 'remote-publish' });
  await runRemote(remoteRestartScript(), { stepName: 'remote-restart' });
  await runRemote(remoteVerifyScript(), { stepName: 'remote-verify' });

  if (!args.keepPackage) rmSync(packagePath, { force: true });
  log('快速部署完成');
}

function printPlan() {
  const serviceTargets = targets.filter((target) => services[target]);
  const frontendTargets = targets.filter((target) => frontends[target]);
  log(`SSH 主机：${deployHost}:${args.port}`);
  log(`SSH 重试：${normalizePositiveInteger(args.sshRetries, defaultSshRetries)} 次，连接超时 ${normalizePositiveInteger(args.sshConnectTimeoutSec, defaultSshConnectTimeoutSec)} 秒，保活失败上限 ${normalizePositiveInteger(args.sshServerAliveCountMax, defaultSshServerAliveCountMax)} 次`);
  log(`远端目录：${remoteRootPath}`);
  log(`服务端：${serviceTargets.length ? serviceTargets.join(', ') : '无'}`);
  log(`前端：${frontendTargets.length ? frontendTargets.join(', ') : '无'}`);
  log(`源码与部署工具：${targets.includes(sourceTarget) ? '同步' : '不单独同步'}`);
  log(`本地检查：${args.skipLocalCheck ? '跳过' : args.fullLocalCheck ? '全量 type-check' : '目标相关 type-check'}`);
  log(`远端检查：${args.fullRemoteCheck ? '全量 type-check 后构建' : '目标构建内置类型检查'}`);
  log(`远端会备份：${remoteRootPath}/backups/quick-${stamp}`);
}

function parseArgs(rawArgs) {
  const parsed = {
    host: process.env.AIIMAGE_DEPLOY_HOST || defaultHost,
    hostExplicit: Boolean(process.env.AIIMAGE_DEPLOY_HOST),
    port: process.env.AIIMAGE_DEPLOY_PORT || defaultPort,
    target: [],
    sshRetries: Number(process.env.AIIMAGE_DEPLOY_SSH_RETRIES || defaultSshRetries),
    sshRetryDelayMs: Number(process.env.AIIMAGE_DEPLOY_SSH_RETRY_DELAY_MS || defaultSshRetryDelayMs),
    sshConnectTimeoutSec: Number(process.env.AIIMAGE_DEPLOY_SSH_CONNECT_TIMEOUT_SEC || defaultSshConnectTimeoutSec),
    sshServerAliveCountMax: Number(process.env.AIIMAGE_DEPLOY_SSH_SERVER_ALIVE_COUNT_MAX || defaultSshServerAliveCountMax),
    dryRun: false,
    skipLocalCheck: false,
    skipInstall: false,
    fullRemoteCheck: false,
    fullLocalCheck: false,
    keepPackage: false,
    changed: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--target' || arg === '-t') parsed.target.push(...String(rawArgs[++index] ?? '').split(','));
    else if (arg.startsWith('--target=')) parsed.target.push(...arg.slice('--target='.length).split(','));
    else if (arg === '--all') parsed.target.push('all');
    else if (arg === '--changed') parsed.changed = true;
    else if (arg === '--host') {
      parsed.host = rawArgs[++index] ?? parsed.host;
      parsed.hostExplicit = true;
    } else if (arg.startsWith('--host=')) {
      parsed.host = arg.slice('--host='.length);
      parsed.hostExplicit = true;
    }
    else if (arg === '--port') parsed.port = rawArgs[++index] ?? parsed.port;
    else if (arg.startsWith('--port=')) parsed.port = arg.slice('--port='.length);
    else if (arg === '--ssh-retries') parsed.sshRetries = Number(rawArgs[++index] ?? parsed.sshRetries);
    else if (arg.startsWith('--ssh-retries=')) parsed.sshRetries = Number(arg.slice('--ssh-retries='.length));
    else if (arg === '--ssh-retry-delay-ms') parsed.sshRetryDelayMs = Number(rawArgs[++index] ?? parsed.sshRetryDelayMs);
    else if (arg.startsWith('--ssh-retry-delay-ms=')) parsed.sshRetryDelayMs = Number(arg.slice('--ssh-retry-delay-ms='.length));
    else if (arg === '--ssh-connect-timeout') parsed.sshConnectTimeoutSec = Number(rawArgs[++index] ?? parsed.sshConnectTimeoutSec);
    else if (arg.startsWith('--ssh-connect-timeout=')) parsed.sshConnectTimeoutSec = Number(arg.slice('--ssh-connect-timeout='.length));
    else if (arg === '--ssh-server-alive-count-max') parsed.sshServerAliveCountMax = Number(rawArgs[++index] ?? parsed.sshServerAliveCountMax);
    else if (arg.startsWith('--ssh-server-alive-count-max=')) parsed.sshServerAliveCountMax = Number(arg.slice('--ssh-server-alive-count-max='.length));
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--skip-local-check') parsed.skipLocalCheck = true;
    else if (arg === '--skip-install') parsed.skipInstall = true;
    else if (arg === '--full-remote-check') parsed.fullRemoteCheck = true;
    else if (arg === '--full-local-check') parsed.fullLocalCheck = true;
    else if (arg === '--keep-package') parsed.keepPackage = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`用法：
  node scripts/quick-deploy.mjs --target backend
  node scripts/quick-deploy.mjs --target web
  node scripts/quick-deploy.mjs --changed
  node scripts/quick-deploy.mjs --all

target 可选：
  ${allTargets.join(', ')}

常用参数：
  --dry-run           只显示计划
  --changed           根据当前已跟踪改动自动选择受影响端点
  --skip-local-check  跳过本地目标相关检查
  --skip-install      远端跳过 pnpm install --frozen-lockfile
  --full-local-check  本地恢复执行 db:generate 和全仓 pnpm run type-check
  --full-remote-check 远端额外执行 pnpm run type-check
  --keep-package      保留本地源码包
  --ssh-retries 3     SSH/SCP 连接失败自动重试次数
  --ssh-retry-delay-ms 2500
                     SSH/SCP 两次重试之间的等待毫秒数
  --ssh-connect-timeout 8
                     单次 SSH 连接超时秒数
  --ssh-server-alive-count-max 60
                     生产构建长时间无输出时允许的 SSH 保活失败次数
  --host root@ip      覆盖 SSH 主机
  --port 22           覆盖 SSH 端口`);
}

function resolveTargets(parsed) {
  const requested = parsed.target.map((item) => item.trim()).filter(Boolean);
  if (parsed.changed || requested.length === 0) requested.push(...detectChangedTargets());
  if (requested.length === 0) throw new Error('当前没有可部署的已跟踪改动，请指定 --target');
  if (requested.includes('all')) return allTargets.filter((target) => !services[target]?.isolated);
  const normalized = [...new Set(requested)];
  for (const target of normalized) {
    if (!services[target] && !frontends[target] && target !== sourceTarget) {
      throw new Error(`未知 target：${target}，可选：${allTargets.join(', ')}`);
    }
  }
  return normalized;
}

/** 根据 Git 已跟踪文件的未提交变化推导最小端点集合；未跟踪文件必须先纳入 Git 意图再自动部署。 */
function detectChangedTargets() {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: rootDir, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`读取 Git 改动失败：${result.stderr?.trim() || '未知错误'}`);
  const changed = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  const inferred = new Set();
  for (const path of changed) {
    const appTarget = Object.entries({ ...services, ...frontends }).find(([, definition]) => path.startsWith(`apps/${definition.app}/`))?.[0];
    if (appTarget) inferred.add(appTarget);
    else if (path.startsWith('packages/') || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', '.npmrc', 'docker-compose.yml', 'ecosystem.config.example.js'].includes(path)) allTargets.filter((target) => target !== sourceTarget).forEach((target) => inferred.add(target));
    else if (path.startsWith('apps/backend/prisma/')) inferred.add('backend');
    else inferred.add(sourceTarget);
  }
  return [...inferred];
}

/** 根据 target 解析 SSH 主机；公开源码不内置任何生产地址。 */
function resolveDeployHost(parsed, selectedTargets) {
  if (parsed.hostExplicit && parsed.host) return parsed.host;
  const onlyTarget = selectedTargets.length === 1 ? selectedTargets[0] : '';
  const host = services[onlyTarget]?.host ?? parsed.host;
  if (!host) throw new Error('缺少部署主机，请设置 AIIMAGE_DEPLOY_HOST 或传入 --host');
  return host;
}

/** 根据 target 解析远端项目目录；当前生产主站统一使用 /v3。 */
function resolveRemoteRoot(selectedTargets) {
  const onlyTarget = selectedTargets.length === 1 ? selectedTargets[0] : '';
  return services[onlyTarget]?.remoteRoot ?? '/v3';
}

/** 本地默认只检查本次 target 相关项目，避免每次前端部署都跑完整服务矩阵。 */
function runLocalChecks() {
  if (isSourceOnly()) {
    runLocal(process.execPath, ['--check', 'scripts/quick-deploy.mjs']);
    return;
  }
  if (args.fullLocalCheck) {
    runPnpm(['--prefix', 'apps/backend', 'run', 'db:generate'], { env: deployEnv() });
    runPnpm(['run', 'type-check'], { env: deployEnv() });
    return;
  }
  if (targets.includes('backend')) runPnpm(['--prefix', 'apps/backend', 'run', 'db:generate'], { env: deployEnv() });
  runPnpm(['run', 'build:packages'], { env: deployEnv() });
  for (const app of selectedApps()) {
    runPnpm(['--prefix', `apps/${app}`, 'run', 'type-check'], { env: deployEnv() });
  }
}

function createSourcePackage() {
  const appPaths = (isSourceOnly() ? [] : selectedApps()).map((app) => `apps/${app}`);
  const rootFiles = [
    ...(!isSourceOnly() ? ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', '.npmrc', '.gitignore', 'docker-compose.yml', 'ecosystem.config.example.js'] : []),
    ...(!isSourceOnly() ? ['packages'] : []),
    ...(targets.includes(sourceTarget) ? ['AGENTS.md', 'AI_INDEX.md', 'DEPLOY.md', 'README.md', 'TASKS.md', 'codex-skills', 'configs', 'deploy', 'docs', 'scripts', 'specs', 'standards'] : []),
    ...appPaths,
  ].filter((item, index, array) => array.indexOf(item) === index && existsSync(resolve(rootDir, item)));
  const output = resolve(rootDir, `aiimage-quick-${stamp}.tar.gz`);
  const manifestPath = resolve(rootDir, 'local', 'deploy-logs', `quick-deploy-files-${stamp}.txt`);
  const trackedFiles = runLocal('git', ['ls-files', '--', ...rootFiles], { logOutput: false })
    .split(/\r?\n/)
    .map((file) => file.trim())
    // git ls-files 仍会列出工作树中待提交删除的文件，打包前必须过滤不存在条目。
    .filter((file) => Boolean(file) && existsSync(resolve(rootDir, file)));
  if (!trackedFiles.length) throw new Error('未找到可部署的 Git 已跟踪文件');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${trackedFiles.join('\n')}\n`, 'utf8');
  const tarArgs = [
    '-czf',
    output,
    '--exclude=**/node_modules',
    '--exclude=**/dist',
    '--exclude=**/*.tsbuildinfo',
    '--exclude=apps/backend/.env',
    '--exclude=apps/backend/.env.production',
    '--exclude=ecosystem.config.js',
    '--exclude=local',
    '--exclude=backup',
    '--exclude=backups',
    '--exclude=media-storage',
    '--exclude=bot-logs',
    '--exclude=*.tar.gz',
    '-C',
    rootDir,
    '-T',
    manifestPath,
  ];
  try {
    runLocal('tar', tarArgs);
  } finally {
    rmSync(manifestPath, { force: true });
  }
  log(`源码包 ${output}`);
  return output;
}

async function uploadPackage(packagePath, remotePackage) {
  const ssh = sshArgs();
  await runRemote(`set -euo pipefail\nmkdir -p ${sh(dirname(remotePackage))}`, { stepName: 'mkdir-remote-package-dir' });
  await runRetriedLocal('scp', [...ssh.keyArgs, '-P', args.port, packagePath, `${deployHost}:${remotePackage}`], { stepName: 'scp-upload-package' });
}

/** 源码包上传到远端临时目录，正式替换前会在 /v3/backups 留备份。 */
function remotePackagePath(packagePath) {
  const name = packageName(packagePath);
  return `/tmp/${name}`;
}

function remotePrepareScript(remotePackage, remoteStamp) {
  const apps = selectedApps();
  const supportApps = [];
  const sharedPaths = [
    ...(!isSourceOnly() ? ['packages'] : []),
    ...(targets.includes(sourceTarget) ? ['codex-skills', 'configs', 'deploy', 'docs', 'scripts', 'specs', 'standards'] : []),
  ];
  const rootFiles = [
    ...(!isSourceOnly() ? ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', '.npmrc', '.gitignore', 'docker-compose.yml', 'ecosystem.config.example.js'] : []),
    ...(targets.includes(sourceTarget) ? ['AGENTS.md', 'AI_INDEX.md', 'DEPLOY.md', 'README.md', 'TASKS.md'] : []),
  ];
  const tempDir = `/tmp/aiimage-quick-${remoteStamp}`;
  return `set -euo pipefail
ROOT=${sh(remoteRootPath)}
LOG="$ROOT/backups/quick-${remoteStamp}.remote.log"
mkdir -p "$ROOT/backups/quick-${remoteStamp}"
exec > >(tee -a "$LOG") 2>&1
echo "[quick-deploy] prepare ${remoteStamp}"
rm -rf ${sh(tempDir)}
mkdir -p ${sh(tempDir)}
tar -xzf ${sh(remotePackage)} -C ${sh(tempDir)}
BK="$ROOT/backups/quick-${remoteStamp}"
mkdir -p "$ROOT"
test -f "$ROOT/ecosystem.config.js" || { echo "缺少 $ROOT/ecosystem.config.js，请先在目标服务器创建包含私有 env 的 PM2 配置"; exit 2; }
tar -C "$ROOT" -czf "$BK/selected-before.tar.gz" --ignore-failed-read \\
  ${rootFiles.map(sh).join(' ')} ${sharedPaths.map(sh).join(' ')} ${[...apps, ...supportApps].map((app) => sh(`apps/${app}`)).join(' ')} || true
cp -a "$ROOT/ecosystem.config.js" "$BK/ecosystem.config.js"
cp -a "$ROOT/apps/backend/.env" "$BK/backend.env" 2>/dev/null || true
cp -a "$ROOT/apps/backend/.env.production" "$BK/backend.env.production" 2>/dev/null || true
for item in ${sharedPaths.map(sh).join(' ')}; do
  if [ -e ${sh(`${tempDir}/`)}"$item" ]; then
    rm -rf "$ROOT/$item"
    cp -a ${sh(`${tempDir}/`)}"$item" "$ROOT/$item"
  fi
done
for item in ${rootFiles.map(sh).join(' ')}; do
  if [ -e ${sh(`${tempDir}/`)}"$item" ]; then
    cp -a ${sh(`${tempDir}/`)}"$item" "$ROOT/$item"
  fi
done
for app in ${apps.map(sh).join(' ')}; do
  rm -rf "$ROOT/apps/$app"
  mkdir -p "$ROOT/apps"
  cp -a ${sh(`${tempDir}/apps/`)}"$app" "$ROOT/apps/"
done
for app in ${supportApps.map(sh).join(' ')}; do
  # 支撑型 workspace 只同步源码参与 pnpm 安装和独立部署脚本，不加入 PM2 重启清单。
  if [ -d ${sh(`${tempDir}/apps/`)}"$app" ]; then
    rm -rf "$ROOT/apps/$app"
    mkdir -p "$ROOT/apps"
    cp -a ${sh(`${tempDir}/apps/`)}"$app" "$ROOT/apps/"
  fi
done
for app in ${retiredWorkspaceApps.map(sh).join(' ')}; do
  rm -rf "$ROOT/apps/$app"
done
if [ -f "$BK/backend.env" ] && [ -d "$ROOT/apps/backend" ]; then cp -a "$BK/backend.env" "$ROOT/apps/backend/.env"; fi
if [ -f "$BK/backend.env.production" ] && [ -d "$ROOT/apps/backend" ]; then cp -a "$BK/backend.env.production" "$ROOT/apps/backend/.env.production"; fi
cp -a "$BK/ecosystem.config.js" "$ROOT/ecosystem.config.js"
chown -R 1panel:1panel "$ROOT" 2>/dev/null || true
echo "[quick-deploy] prepare done backup=$BK"`;
}

function remoteBuildScript() {
  if (isSourceOnly()) return 'set -euo pipefail\necho "[quick-deploy] source-only build skipped"';
  const buildCommands = [];
  buildCommands.push(`cd ${sh(remoteRootPath)}`);
  buildCommands.push('export PUPPETEER_SKIP_DOWNLOAD=true');
  if (!args.skipInstall) buildCommands.push('pnpm install --frozen-lockfile');
  // bot-renderer 依赖本地字体资产；部署时幂等安装到 /v3/local，避免截图阶段访问外部字体服务。
  if (targets.includes('bot-renderer')) buildCommands.push('pnpm run assets:bot-renderer');
  if (targets.includes('backend')) buildCommands.push('pnpm --prefix apps/backend run db:generate');
  // backend 启动前幂等补齐用户背景图显示偏好，默认开启以便后台全局开关统一控制。
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/user-site-background-migration.mjs --apply');
  // backend 启动前幂等补齐渠道亲和键开关，默认关闭以避免影响不识别该字段的既有上游。
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/api-site-prompt-cache-key-migration.mjs --apply');
  // backend 启动前先幂等补齐 response_format 发送开关，默认开启以保持所有既有站点行为。
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/api-site-response-format-migration.mjs --apply');
  // backend 启动前先幂等补齐站点 Auto 尺寸兼容列，避免新 Prisma Client 读取缺失字段。
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/api-site-auto-size-migration.mjs --apply');
  // 模型定价迁移必须先于 backend 重启完成，确保 Web 与 Bot 首次请求即使用模型级价格。
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/model-pricing-migration.mjs --apply');
  // 提示词格式迁移必须先于 backend 启动，保证 Anima 模型首次增强即走单行标签链路。
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/model-prompt-format-migration.mjs --apply');
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/image-upscale-jobs-migration.mjs --apply');
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/image-reverse-jobs-migration.mjs --apply');
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/lora-repository-migration.mjs --apply');
  // 独立本地模型平台计费表必须在 backend 重启前幂等创建，迁移本身不改动任何既有余额。
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/local-platform-billing-migration.mjs --apply');
  // Bot 本地模型使用 QQ 钱包主体；迁移只新增 QQ 列并保留全部既有用户预留和图库镜像。
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/local-platform-bot-wallet-migration.mjs --apply');
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/status-performance-indexes.mjs --apply');
  if (targets.includes('backend')) buildCommands.push('node apps/backend/prisma/workbench-conversations-migration.mjs --apply');
  buildCommands.push('pnpm run build:packages');
  if (args.fullRemoteCheck) buildCommands.push('pnpm run type-check');
  // 各 target 的 build 脚本已通过 tsc 或 tsc -b 完成类型校验，默认不再重复执行同一 app 的 noEmit 检查。
  for (const target of targets) {
    const def = services[target] ?? frontends[target];
    if (!def) continue;
    buildCommands.push(`pnpm run build:${def.build}`);
  }
  return `set -euo pipefail
echo "[quick-deploy] build"
${buildCommands.join('\n')}
echo "[quick-deploy] build done"`;
}

function remotePublishScript(remoteStamp) {
  const frontendTargets = targets.filter((target) => frontends[target]);
  if (frontendTargets.length === 0) return 'set -euo pipefail\necho "[quick-deploy] publish skipped"';
  const commands = [
    'set -euo pipefail',
    `FRONT_BK=/v3/backups/frontend-quick-${remoteStamp}`,
    'mkdir -p "$FRONT_BK"',
    'echo "[quick-deploy] publish frontends backup=$FRONT_BK"',
  ];
  for (const target of frontendTargets) {
    const def = frontends[target];
    commands.push(`mkdir -p ${sh(def.dest)}`);
    commands.push(`tar -C ${sh(def.dest)} -czf "$FRONT_BK/${target}.tar.gz" . || true`);
    commands.push(`find ${sh(def.dest)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`);
    commands.push(`cp -a /v3/apps/${def.app}/dist/. ${sh(def.dest)}/`);
    commands.push(remotePrecompressStaticAssetsCommand(def.dest));
    // 新生产机可能没有 1panel 系统用户；仅在用户存在时修正属主，避免静态发布因属主策略差异失败。
    commands.push(`if id 1panel >/dev/null 2>&1; then chown -R 1panel:1panel ${sh(def.dest)}; fi`);
  }
  // 前端 index.html 覆盖后主动 reload OpenResty，避免 open_file_cache 短时间继续返回旧入口文件。
  commands.push(`if command -v docker >/dev/null 2>&1; then OPENRESTY_CONTAINER=$(docker ps --format '{{.Names}}' | grep -m1 '^1Panel-openresty-' || true); if [ -n "$OPENRESTY_CONTAINER" ]; then docker exec "$OPENRESTY_CONTAINER" openresty -s reload; fi; fi`);
  commands.push('echo "[quick-deploy] publish done"');
  return commands.join('\n');
}

/** 预压缩前端静态资源；OpenResty gzip_static 命中后可减少源站直连访问的 CPU 和传输体积。 */
function remotePrecompressStaticAssetsCommand(dest) {
  return `if command -v gzip >/dev/null 2>&1; then find ${sh(dest)} -type f \\( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.xml' -o -name '*.txt' -o -name '*.svg' -o -name '*.json' -o -name '*.wasm' \\) -print0 | xargs -0 -r -n 200 gzip -6 -k -f; fi`;
}

function remoteRestartScript() {
  const serviceTargets = targets.filter((target) => services[target]);
  if (serviceTargets.length === 0) return 'set -euo pipefail\necho "[quick-deploy] restart skipped"';
  const commands = ['set -euo pipefail', `cd ${sh(remoteRootPath)}`, 'echo "[quick-deploy] restart services"'];
  for (const target of serviceTargets) {
    const pm2 = services[target].pm2;
    // 始终通过 ecosystem 重启，确保生产私有 env（SMTP/token 等）不会被当前 shell 环境覆盖或丢失。
    commands.push(`pm2 restart ecosystem.config.js --only ${sh(pm2)} --update-env`);
  }
  commands.push('pm2 save');
  commands.push('pm2 list');
  return commands.join('\n');
}

function remoteVerifyScript() {
  const commands = ['set -euo pipefail', 'echo "[quick-deploy] verify"'];
  if (isSourceOnly()) commands.push(`test -f ${sh(`${remoteRootPath}/scripts/quick-deploy.mjs`)}`, 'echo "source-sync:ok"');
  for (const target of targets.filter((item) => services[item])) {
    const port = services[target].port;
    commands.push(`code="000"; body=""; for attempt in 1 2 3 4 5 6; do code=$(curl -s -o /tmp/quick-health-${port}.txt -w '%{http_code}' http://127.0.0.1:${port}/health || true); body=$(head -c 160 /tmp/quick-health-${port}.txt 2>/dev/null || true); echo "${target}:${port}:attempt=$attempt:$code $body"; [ "$code" = "200" ] && break; sleep 2; done; test "$code" = "200"`);
  }
  if (targets.includes('backend')) {
    commands.push('db_code="000"; for attempt in 1 2 3 4 5; do db_code=$(curl -s -o /tmp/quick-db-health.txt -w \'%{http_code}\' http://127.0.0.1:6369/health/db || true); db_body=$(head -c 160 /tmp/quick-db-health.txt 2>/dev/null || true); echo "backend-db:attempt=$attempt:$db_code $db_body"; [ "$db_code" = "200" ] && grep -q \'"db":"connected"\' /tmp/quick-db-health.txt && break; sleep 2; done; test "$db_code" = "200"; grep -q \'"db":"connected"\' /tmp/quick-db-health.txt');
  }
  for (const target of targets.filter((item) => frontends[item])) {
    const url = frontends[target].url;
    commands.push(`code="000"; for attempt in 1 2 3 4 5; do code=$(curl -k -L -s -o /tmp/quick-public-${target}.txt -w '%{http_code}' ${sh(url)} || true); echo "${target}:${url}:attempt=$attempt:$code"; [ "$code" = "200" ] && break; sleep 2; done; test "$code" = "200"`);
  }
  commands.push('echo "[quick-deploy] verify done"');
  return commands.join('\n');
}

function selectedApps() {
  return targets
    .map((target) => services[target]?.app ?? frontends[target]?.app)
    .filter((item, index, array) => Boolean(item) && array.indexOf(item) === index);
}

/** 判断本次只同步部署工具与文档，不构建或重启运行端点。 */
function isSourceOnly() {
  return targets.length === 1 && targets[0] === sourceTarget;
}

async function runRemote(script, options = {}) {
  const ssh = sshArgs();
  await runRetriedLocal('ssh', [...ssh.keyArgs, '-p', args.port, deployHost, 'bash', '-s'], { input: script, stepName: options.stepName ?? 'remote-script' });
}

/** 在 Windows 下通过 cmd 启动 pnpm，避免 Node 直接 spawn .cmd 时出现 EINVAL。 */
function runPnpm(commandArgs, options = {}) {
  if (process.platform === 'win32') {
    return runLocal('cmd.exe', ['/d', '/s', '/c', 'pnpm', ...commandArgs], options);
  }
  return runLocal('pnpm', commandArgs, options);
}

function runLocal(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.map(displayArg).join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
    input: options.input,
    env: options.env ?? process.env,
  });
  if (result.stdout && options.logOutput !== false) log(result.stdout.trimEnd());
  if (result.stderr && options.logOutput !== false) log(result.stderr.trimEnd());
  if (result.status !== 0) {
    const error = new Error(`命令失败：${command} ${commandArgs.join(' ')}`);
    error.command = command;
    error.commandArgs = commandArgs;
    error.result = result;
    throw error;
  }
  return result.stdout ?? '';
}

function sshArgs() {
  const key = resolveSshKey();
  return {
    keyArgs: [
      ...(existsSync(key) ? ['-i', key] : []),
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${normalizePositiveInteger(args.sshConnectTimeoutSec, defaultSshConnectTimeoutSec)}`,
      '-o', 'ConnectionAttempts=1',
      '-o', 'ServerAliveInterval=5',
      // 生产前端构建会生成静态路由，CPU 忙时短保活窗口容易误断开部署通道。
      '-o', `ServerAliveCountMax=${normalizePositiveInteger(args.sshServerAliveCountMax, defaultSshServerAliveCountMax)}`,
      '-o', 'TCPKeepAlive=yes',
    ],
  };
}

/** 选择部署 SSH 密钥；优先尊重显式环境变量，其次兼容当前开发机的 mny_root。 */
function resolveSshKey() {
  if (process.env.AIIMAGE_DEPLOY_KEY) return resolveHome(process.env.AIIMAGE_DEPLOY_KEY);
  const defaultKey = resolveHome('~/.ssh/id_ed25519');
  if (existsSync(defaultKey)) return defaultKey;
  const migrationKey = resolveHome('~/.ssh/mny_root');
  return existsSync(migrationKey) ? migrationKey : defaultKey;
}

function deployEnv() {
  return { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' };
}

function packageName(path) {
  return path.split(/[\\/]/).pop();
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function resolveHome(path) {
  if (!path.startsWith('~/')) return path;
  return resolve(process.env.USERPROFILE || process.env.HOME || '.', path.slice(2));
}

function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function displayArg(value) {
  return String(value).includes(' ') ? JSON.stringify(value) : String(value);
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${line}\n`, 'utf8');
}

/** 仅对 SSH/SCP 这类传输型命令做重试，避免生产机瞬时连通抖动直接打断整个部署流程。 */
async function runRetriedLocal(command, commandArgs, options = {}) {
  const maxAttempts = normalizePositiveInteger(args.sshRetries, defaultSshRetries);
  const retryDelayMs = normalizePositiveInteger(args.sshRetryDelayMs, defaultSshRetryDelayMs);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return runLocal(command, commandArgs, options);
    } catch (error) {
      const output = readCommandErrorOutput(error);
      const retryable = isRetryableTransportFailure(command, output);
      if (!retryable || attempt >= maxAttempts) throw error;
      log(`[retry] ${options.stepName ?? command} 第 ${attempt} 次失败，${Math.round(retryDelayMs / 1000)} 秒后重试`);
      await sleep(retryDelayMs);
    }
  }
  throw new Error(`命令重试失败：${command}`);
}

/** 只把明显的 SSH/SCP 连接层故障识别为可重试，避免把真实业务脚本错误误重试。 */
function isRetryableTransportFailure(command, output) {
  if (command !== 'ssh' && command !== 'scp') return false;
  return [
    /connection timed out/i,
    /operation timed out/i,
    /kex_exchange_identification/i,
    /banner exchange/i,
    /connection reset/i,
    /broken pipe/i,
    /connection closed/i,
    /connection refused/i,
    /no route to host/i,
    /network is unreachable/i,
    /resource temporarily unavailable/i,
  ].some((pattern) => pattern.test(output));
}

/** 从 spawn 失败对象中提取 stdout/stderr，供重试判定使用。 */
function readCommandErrorOutput(error) {
  const result = error?.result;
  return [result?.stdout ?? '', result?.stderr ?? '', error?.message ?? ''].join('\n');
}

/** 简单异步等待，供 SSH 重试退避使用。 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
