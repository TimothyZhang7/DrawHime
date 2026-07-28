#!/usr/bin/env node
/**
 * 一键开发启动脚本。职责：
 * 1. 确保数据库存在 + Schema 同步（自动接受变更，无需手动确认）
 * 2. 检查 Redis 连通性
 * 3. 清理旧进程 → 并行启动全部服务
 * 4. 全部服务使用 node --watch（后端）/ vite HMR（前端），修改代码自动重载，无需手动重启
 * 5. Schema 变更后自动重新生成 Prisma Client，node --watch 自动检测重启
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envExamplePath = resolve(rootDir, 'configs/env.example');
const localEnvPath = resolve(rootDir, 'local/private/.env');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const isWin32 = process.platform === 'win32';
const checkOnly = process.argv.includes('--check');

/** 检查 Win32 必需二进制，缺失时仅警告不阻塞（WSL 安装的 node_modules 可能缺少 Windows 原生模块）。 */
function checkWin32Binaries() {
  if (!isWin32) return;
  // 通过检查 esbuild 安装目录确认是否为 Windows 环境安装
  const esbuildDirs = resolve(rootDir, 'node_modules/.pnpm');
  const hasWinEsbuild = existsSync(resolve(rootDir, 'node_modules/.pnpm/@esbuild+win32-x64@0.28.0'));
  if (!hasWinEsbuild) {
    console.warn('[dev] ⚠ node_modules 可能来自 WSL 安装。如服务启动失败，请在 Windows 终端执行：');
    console.warn('[dev]    rm -r node_modules; pnpm install');
  }
}

/* ====== 服务定义 ====== */
const services = [
  { name: 'backend',              portKey: 'BACKEND_PORT',              fallback: 6369, path: '/health', desc: '核心业务 API' },
  { name: 'drawing-service',      portKey: 'DRAWING_PORT',              fallback: 3005, path: '/health', desc: '绘图 HTTP 接入' },
  { name: 'drawing-worker',       portKey: 'DRAWING_WORKER_PORT',       fallback: 3012, path: '/health', desc: '绘图执行 Worker' },
  { name: 'media-service',        portKey: 'MEDIA_PORT',                fallback: 3013, path: '/health', desc: '媒体服务' },
  { name: 'bot-service',          portKey: 'BOT_PORT',                  fallback: 3004, path: '/health', desc: 'QQ Bot 服务' },
  { name: 'bot-renderer',         portKey: 'BOT_RENDERER_PORT',         fallback: 3014, path: '/health', desc: 'Bot 渲染服务' },
  { name: 'wsproxy-service',      portKey: 'WSPROXY_PORT',              fallback: 3011, path: '/health', desc: 'OneBot 连接代理' },
  { name: 'notification-worker',  portKey: 'NOTIFICATION_WORKER_PORT',  fallback: 3015, path: '/health', desc: '通知 Worker' },
  { name: 'ops-worker',           portKey: 'OPS_WORKER_PORT',           fallback: 3016, path: '/health', desc: '运维 Worker' },
  { name: 'web-frontend',         portKey: 'WEB_PORT',                  fallback: 5173, path: '/',      desc: '用户前台' },
  { name: 'admin-portal',         portKey: 'ADMIN_PORT',                fallback: 5174, path: '/',      desc: '管理后台' },
];

/* ====== 工具函数 ====== */

/** 读取 dotenv 文件，后读文件覆盖先读文件；真实本地配置只允许放入 local/private/.env。 */
function readDotenvFile(filePath) {
  const fileEnv = {};
  if (!existsSync(filePath)) return fileEnv;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    fileEnv[key] = val;
  }
  return fileEnv;
}

function readEnv() {
  const fileEnv = { ...readDotenvFile(envExamplePath), ...readDotenvFile(localEnvPath) };
  return { ...process.env, ...fileEnv };
}

function getPort(env, key, fallback) {
  const raw = env[key];
  const port = raw ? Number(raw) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口配置无效：${key}=${raw}`);
  return port;
}

function getEndpoints(env) {
  return services.map(s => ({
    name: s.name,
    port: getPort(env, s.portKey, s.fallback),
    url: `http://localhost:${getPort(env, s.portKey, s.fallback)}${s.path}`,
    desc: s.desc,
  }));
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: rootDir, shell: process.platform === 'win32', stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    throw new Error(`命令执行失败：${cmd} ${args.join(' ')}`);
  }
  return result;
}

/* ====== 数据库 ====== */

/** 防止把开发脚本的自动 db push 误指向远端或生产数据库。 */
function assertSafeDatabaseUrl(dbUrl, env) {
  const host = dbUrl.hostname.toLowerCase();
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (localHosts.has(host)) return;
  if (env.AIIMAGE_ALLOW_REMOTE_DB_PUSH === 'true') return;
  throw new Error(`DATABASE_URL 指向非本地主机 ${dbUrl.hostname}，已拒绝自动建库和 db push。确认是开发库后设置 AIIMAGE_ALLOW_REMOTE_DB_PUSH=true 再执行。`);
}

function ensureDatabase(env) {
  const dbUrl = new URL(env.DATABASE_URL);
  assertSafeDatabaseUrl(dbUrl, env);
  const dbName = dbUrl.pathname.replace(/^\//, '');
  dbUrl.pathname = '/mysql';
  console.log(`[dev] 确保数据库 ${dbName} 存在`);
  run(pnpm, ['exec', 'node', 'scripts/create-dev-database.mjs'], {
    env: { ...env, DATABASE_URL: dbUrl.toString(), AIIMAGE_TARGET_DATABASE: dbName },
  });

  console.log('[dev] 同步 Prisma Schema（自动接受变更）');
  // 使用 --accept-data-loss 避免交互式确认，开发环境数据可重建
  run(pnpm, ['--prefix', 'apps/backend', 'exec', 'prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'], { env });

  console.log('[dev] 重新生成 Prisma Client');
  run(pnpm, ['--prefix', 'apps/backend', 'exec', 'prisma', 'generate'], { env });
}

/* ====== Redis 检查 ====== */

function checkRedis(redisUrl) {
  const url = new URL(redisUrl);
  const host = url.hostname || 'localhost';
  const port = Number(url.port || 6379);
  const password = decodeURIComponent(url.password || '');
  console.log(`[dev] 检查 Redis ${host}:${port}`);
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error('Redis PING 超时')); }, 3000);
    let step = password ? 'auth' : 'ping';
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      if (password) { sock.write(`*2\r\n\$4\r\nAUTH\r\n\$${Buffer.byteLength(password)}\r\n${password}\r\n`); }
      else { sock.write('*1\r\n\$4\r\nPING\r\n'); }
    });
    sock.on('data', (chunk) => {
      if (chunk.startsWith('-')) { clearTimeout(t); sock.destroy(); reject(new Error(`Redis 错误: ${chunk.trim()}`)); return; }
      if (step === 'auth') { step = 'ping'; sock.write('*1\r\n\$4\r\nPING\r\n'); return; }
      clearTimeout(t); sock.end(); resolve();
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/* ====== 端口清理 ====== */

function getPortOwners(ports) {
  if (process.platform === 'win32') {
    const portLiteral = '@(' + ports.map(port => Number(port)).join(',') + ')';
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `$ports=${portLiteral}; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress`], { encoding: 'utf8' });
    if (ps.status !== 0 || !ps.stdout.trim()) return [];
    try { const arr = JSON.parse(ps.stdout); return (Array.isArray(arr)?arr:[arr]).map(i=>({port:i.LocalPort,pid:i.OwningProcess})).filter(i=>i.pid!==process.pid); } catch { return []; }
  }
  return []; // Unix: lsof fallback 保持简洁
}

function killOldProcesses(endpoints) {
  const ports = endpoints.map(e => e.port);
  const owners = getPortOwners(ports);
  if (owners.length === 0) { console.log('[dev] 端口未发现旧进程'); return; }
  const seenPids = new Set();
  for (const o of owners) {
    if (seenPids.has(o.pid)) continue;
    seenPids.add(o.pid);
    const ps = owners.filter(x => x.pid === o.pid).map(x => x.port).join(',');
    console.log(`[dev] 清理旧进程 pid=${o.pid} ports=${ps}`);
    try { process.kill(o.pid, 'SIGTERM'); } catch {}
  }
}

/* ====== 端口等待 ====== */

function canConnect(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: 'localhost', port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 500);
    s.on('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

async function waitForAll(endpoints, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Map(endpoints.map(e => [e.name, e]));
  while (pending.size > 0 && Date.now() < deadline) {
    for (const [name, ep] of [...pending]) {
      if (await canConnect(ep.port)) pending.delete(name);
    }
    if (pending.size > 0) await sleep(500);
  }
  if (pending.size > 0) {
    const missing = [...pending.values()].map(e => `${e.name}:${e.port}`).join(', ');
    console.warn(`[dev] ⚠ 以下服务未就绪（可能仍需初始化）：${missing}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ====== 启动全部服务 ====== */

function startAll(env) {
  const filters = services.flatMap((service) => ['--filter', `./apps/${service.name}`]);
  const child = spawn(pnpm, ['-r', '--parallel', '--stream', ...filters, 'run', 'dev'], {
    cwd: rootDir, env, shell: process.platform === 'win32', stdio: 'inherit',
  });
  const stop = () => child.kill('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', code => process.exit(code ?? 0));
}

function printSummary(endpoints) {
  console.log('\n[dev] 全部 app 已启动：');
  for (const e of endpoints) console.log(`[dev]   ${e.name.padEnd(22)} ${e.url.padEnd(34)} ${e.desc}`);
  console.log('');
}

/* ====== 主流程 ====== */

async function main() {
  checkWin32Binaries();
  const env = readEnv();
  const endpoints = getEndpoints(env);

  // 1. 数据库
  ensureDatabase(env);

  // 2. Redis
  await checkRedis(env.REDIS_URL);

  if (checkOnly) {
    console.log('[dev] 检查完成：数据库、Prisma Schema、Prisma Client 和 Redis 均已通过。');
    return;
  }

  // 3. 清理旧进程
  killOldProcesses(endpoints);
  await sleep(1000); // 等待端口释放

  // 4. 启动
  console.log('[dev] 启动全部 app（node --watch / Vite HMR，修改代码即时生效）');
  startAll(env);

  // 5. 等待就绪
  await waitForAll(endpoints);
  printSummary(endpoints);
}

main().catch(e => { console.error(`[dev] ${e.message}`); process.exit(1); });
