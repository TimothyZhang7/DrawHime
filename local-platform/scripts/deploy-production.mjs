/**
 * 本文件按目标增量部署独立本地模型平台，并保留 all 模式负责首次安装、基础设施、迁移和全平台验证。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadPrivateEnvironment, requirePrivateEnvironment } from "./private-environment.mjs";

const root = resolve(import.meta.dirname, "..");
loadPrivateEnvironment(resolve(root, ".private", "production.env"));
const host = requirePrivateEnvironment("LOCAL_PLATFORM_DEPLOY_HOST");
const port = process.env.LOCAL_PLATFORM_DEPLOY_PORT || "22";
const proxyJump = process.env.LOCAL_PLATFORM_DEPLOY_PROXY_JUMP?.trim();
const key = process.env.LOCAL_PLATFORM_DEPLOY_KEY || resolve(homedir(), ".ssh", "id_ed25519");
const comfyUiBaseUrl = requirePrivateEnvironment("COMFYUI_BASE_URL");
const trainingRuntimeBaseUrl = requirePrivateEnvironment("TRAINING_RUNTIME_BASE_URL");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const dryRun = process.argv.includes("--dry-run");
const target = readTargetArgument(process.argv.slice(2));
const serviceTargets = {
  api: { workspace: "@drawhime/api", app: "api", pm2: "local-api", port: 7102, prisma: true },
  scheduler: { workspace: "@drawhime/scheduler", app: "scheduler", pm2: "local-scheduler", port: 7103 },
  "gpu-agent": { workspace: "@drawhime/gpu-agent", app: "gpu-agent", pm2: "local-gpu-agent", port: 7110 },
  "inference-worker": { workspace: "@drawhime/inference-worker", app: "inference-worker", pm2: "local-inference-worker", port: 7111 },
  "training-worker": { workspace: "@drawhime/training-worker", app: "training-worker", pm2: "local-training-worker", port: 7112 },
  "artifact-service": { workspace: "@drawhime/artifact-service", app: "artifact-service", pm2: "local-artifact-service", port: 7113 },
};
const validTargets = new Set(["all", "web", "admin", "source", ...Object.keys(serviceTargets)]);
if (!validTargets.has(target)) throw new Error(`不支持的部署目标：${target}`);
const archive = resolve(root, `drawhime-local-${target}-${stamp}.tar.gz`);
const remoteArchive = `/tmp/drawhime-local-${target}-${stamp}.tar.gz`;

const sshArguments = [
  ...(existsSync(key) ? ["-i", key] : []),
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=20",
  "-o", "ServerAliveInterval=5",
  "-o", "ServerAliveCountMax=120",
  // 生产 SSH 直连不稳定时沿用受控跳板，scp 与 ssh 使用同一路由。
  ...(proxyJump ? ["-J", proxyJump] : []),
];

if (dryRun) {
  process.stdout.write(`部署模式：${describeTarget(target)}\n目标：${host}:${port}\n生产目录：/local-platform\n用户路径：https://www.xanime.ink/local-model/\n管理路径：https://admin.xanime.ink/local-model-admin/\n`);
  process.exit(0);
}

if (target === "web" || target === "admin") {
  deployFrontendOnly(target);
  process.exit(0);
}
if (target === "source") {
  deploySourceOnly();
  process.exit(0);
}
if (serviceTargets[target]) {
  deployServiceOnly(target, serviceTargets[target]);
  process.exit(0);
}

run("pnpm", ["run", "db:validate"], { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "mysql://local_platform:local_platform@127.0.0.1:3317/drawhime_local" } });
run("pnpm", ["run", "type-check"]);
run("pnpm", ["run", "test"]);
run("pnpm", ["run", "build"]);

try {
  run("tar", [
    "-czf", archive,
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=*.tsbuildinfo",
    "--exclude=.env",
    "-C", root,
    "AGENTS.md", "README.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".npmrc", ".gitignore",
    "apps", "configs", "deploy", "docs", "packages", "prisma", "scripts", "docker-compose.yml", "docker-compose.production.yml", "ecosystem.config.example.cjs",
  ]);
  // 经跳板的 SFTP 子系统可能长时间无进度，改用同一 SSH 通道流式写入小型源码包。
  run("ssh", [...sshArguments, "-p", port, host, `cat > '${remoteArchive}'`], { input: readFileSync(archive) });
  run("ssh", [...sshArguments, "-p", port, host, "bash", "-s"], { input: productionScript() });
} finally {
  rmSync(archive, { force: true });
}

/** 解析部署目标，同时兼容 --target web 与 --target=web 两种调用方式。 */
function readTargetArgument(arguments_) {
  const inline = arguments_.find((value) => value.startsWith("--target="));
  if (inline) return inline.slice("--target=".length);
  const index = arguments_.indexOf("--target");
  return index >= 0 ? arguments_[index + 1] : "all";
}

/** 只发布指定前端静态产物，不触碰数据库、服务进程和 LoRA 数据。 */
function deployFrontendOnly(frontendTarget) {
  const definition = frontendTarget === "web"
    ? { workspace: "@drawhime/web", app: "web", publicRoot: "/data/1panel/www/sites/xanime.ink/local-model", url: "https://www.xanime.ink/local-model/", marker: "绘图姬" }
    : { workspace: "@drawhime/admin", app: "admin", publicRoot: "/data/1panel/www/sites/admin.xanime.ink/local-model-admin", url: "https://admin.xanime.ink/local-model-admin/", marker: "DrawHime Local" };
  run("pnpm", ["--filter", definition.workspace, "run", "type-check"]);
  run("pnpm", ["--filter", definition.workspace, "run", "build"]);
  const distribution = resolve(root, "apps", definition.app, "dist");
  if (!existsSync(resolve(distribution, "index.html"))) throw new Error("用户前端构建产物缺少 index.html");
  try {
    // 直接上传静态产物，避免远端重复安装依赖和全仓构建。
    run("tar", ["-czf", archive, "-C", distribution, "."]);
    run("ssh", [...sshArguments, "-p", port, host, `cat > '${remoteArchive}'`], { input: readFileSync(archive) });
    run("ssh", [...sshArguments, "-p", port, host, "bash", "-s"], { input: frontendOnlyProductionScript(frontendTarget, definition) });
  } finally {
    rmSync(archive, { force: true });
  }
}

/** 生成单个前端静态产物的远端校验、备份和兼容缓存发布脚本。 */
function frontendOnlyProductionScript(frontendTarget, definition) {
  return `set -euo pipefail
WEB_ROOT='${definition.publicRoot}'
TMP=/tmp/drawhime-local-${frontendTarget}-${stamp}
BACKUP=/local-platform/backups/${frontendTarget}-${stamp}
mkdir -p "$TMP" "$BACKUP" "$WEB_ROOT"
tar -xzf '${remoteArchive}' -C "$TMP"
test -f "$TMP/index.html"
if [ -n "$(find "$WEB_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  tar -C "$WEB_ROOT" -czf "$BACKUP/web-before.tar.gz" .
fi
# 保留旧指纹资源，避免边缘缓存中的旧 HTML 在刷新期间引用已经删除的 JS/CSS。
cp -a "$TMP"/. "$WEB_ROOT"/
chmod -R a+rX "$WEB_ROOT"
if id 1panel >/dev/null 2>&1; then chown -R 1panel:1panel "$WEB_ROOT"; fi
for attempt in $(seq 1 20); do
  if curl -kfsS '${definition.url}?deploy=${stamp}' 2>/dev/null | grep -q '${definition.marker}'; then
    rm -rf "$TMP" '${remoteArchive}'
    echo '${frontendTarget} 前端快速部署验证完成'
    exit 0
  fi
  sleep 1
done
echo '验证失败：${definition.url}' >&2
exit 1
`;
}

/** 返回 dry-run 使用的目标说明，明确本次不会全量重启。 */
function describeTarget(selectedTarget) {
  if (selectedTarget === "all") return "all（完整平台）";
  if (selectedTarget === "web") return "web（仅用户前端）";
  if (selectedTarget === "admin") return "admin（仅管理前端）";
  if (selectedTarget === "source") return "source（仅部署工具与文档）";
  return `${selectedTarget}（仅对应服务）`;
}

/** 只构建、上传、重启和验证一个后端服务，数据库迁移仅由 API 目标执行。 */
function deployServiceOnly(serviceTarget, definition) {
  const validationEnvironment = { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "mysql://local_platform:local_platform@127.0.0.1:3317/drawhime_local" };
  if (definition.prisma) {
    run("pnpm", ["run", "db:validate"], { env: validationEnvironment });
    run("pnpm", ["run", "db:generate"], { env: validationEnvironment });
  }
  run("pnpm", ["run", "build:packages"]);
  run("pnpm", ["--filter", definition.workspace, "run", "type-check"]);
  run("pnpm", ["--filter", definition.workspace, "run", "build"]);
  if (serviceTarget === "api") run("pnpm", ["--filter", definition.workspace, "run", "test"]);
  const packageItems = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".npmrc", "packages", `apps/${definition.app}`, ...(definition.prisma ? ["prisma"] : [])];
  try {
    run("tar", ["-czf", archive, "--exclude=node_modules", "--exclude=dist", "--exclude=*.tsbuildinfo", "--exclude=.env", "-C", root, ...packageItems]);
    run("ssh", [...sshArguments, "-p", port, host, `cat > '${remoteArchive}'`], { input: readFileSync(archive) });
    run("ssh", [...sshArguments, "-p", port, host, "bash", "-s"], { input: serviceOnlyProductionScript(serviceTarget, definition) });
  } finally {
    rmSync(archive, { force: true });
  }
}

/** 生成单服务增量发布脚本；保留其他服务源码、静态站点、对象存储和全部数据库数据。 */
function serviceOnlyProductionScript(serviceTarget, definition) {
  const prismaCommands = definition.prisma
    ? "pnpm run db:generate\npnpm run db:migrate:deploy"
    : "";
  const postBuildCommands = definition.prisma ? "pnpm run bootstrap:tag-translations" : "";
  return `set -euo pipefail
ROOT=/local-platform
TMP=/tmp/drawhime-local-${serviceTarget}-${stamp}
BACKUP="$ROOT/backups/${serviceTarget}-${stamp}"
mkdir -p "$TMP" "$BACKUP"
tar -xzf '${remoteArchive}' -C "$TMP"
tar -C "$ROOT" -czf "$BACKUP/source-before.tar.gz" --ignore-failed-read packages apps/${definition.app} ${definition.prisma ? "prisma" : ""} package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json || true
rm -rf "$ROOT/packages" "$ROOT/apps/${definition.app}"
cp -a "$TMP/packages" "$ROOT/packages"
mkdir -p "$ROOT/apps"
cp -a "$TMP/apps/${definition.app}" "$ROOT/apps/"
${definition.prisma ? 'rm -rf "$ROOT/prisma"\ncp -a "$TMP/prisma" "$ROOT/prisma"' : ""}
for item in package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc; do cp -a "$TMP/$item" "$ROOT/$item"; done
cd "$ROOT"
export PUPPETEER_SKIP_DOWNLOAD=true
pnpm install --frozen-lockfile
pnpm run build:packages
${prismaCommands}
pnpm --filter ${definition.workspace} run build
${postBuildCommands}
pm2 restart ecosystem.config.cjs --only ${definition.pm2} --update-env
pm2 save
code=000
for attempt in $(seq 1 20); do
  code=$(curl -sS -o /tmp/local-${serviceTarget}-health.json -w '%{http_code}' http://127.0.0.1:${definition.port}/health || true)
  [ "$code" = 200 ] && break
  sleep 1
done
test "$code" = 200
${serviceTarget === "api" ? "curl -kfsS https://www.xanime.ink/local-model-api/health | grep -q '\"service\":\"api\"'" : ""}
rm -rf "$TMP" '${remoteArchive}'
echo '${serviceTarget} 增量部署验证完成'
`;
}

/** 只同步部署脚本、配置样例和文档，不安装依赖、不构建也不重启服务。 */
function deploySourceOnly() {
  run(process.execPath, ["--check", "scripts/deploy-production.mjs"]);
  const items = ["AGENTS.md", "README.md", "configs", "deploy", "docs", "scripts", "ecosystem.config.example.cjs"];
  try {
    run("tar", ["-czf", archive, "--exclude=.env", "--exclude=.private", "-C", root, ...items]);
    run("ssh", [...sshArguments, "-p", port, host, `cat > '${remoteArchive}'`], { input: readFileSync(archive) });
    run("ssh", [...sshArguments, "-p", port, host, "bash", "-s"], { input: sourceOnlyProductionScript() });
  } finally {
    rmSync(archive, { force: true });
  }
}

/** 生成部署工具源码同步脚本，保留生产私有配置并验证远端脚本语法。 */
function sourceOnlyProductionScript() {
  return `set -euo pipefail
ROOT=/local-platform
TMP=/tmp/drawhime-local-source-${stamp}
BACKUP="$ROOT/backups/source-${stamp}"
mkdir -p "$TMP" "$BACKUP"
tar -xzf '${remoteArchive}' -C "$TMP"
tar -C "$ROOT" -czf "$BACKUP/source-before.tar.gz" --ignore-failed-read AGENTS.md README.md configs deploy docs scripts ecosystem.config.example.cjs || true
for item in AGENTS.md README.md configs deploy docs scripts ecosystem.config.example.cjs; do
  if [ -e "$TMP/$item" ]; then rm -rf "$ROOT/$item"; cp -a "$TMP/$item" "$ROOT/$item"; fi
done
node --check "$ROOT/scripts/deploy-production.mjs"
rm -rf "$TMP" '${remoteArchive}'
echo '部署工具与文档增量同步完成'
`;
}

/** 生成不回显生产凭证的远端安装脚本。 */
function productionScript() {
  return `set -euo pipefail
ROOT=/local-platform
TMP=/tmp/drawhime-local-platform-${stamp}
BACKUP="$ROOT/backups/deploy-${stamp}"
mkdir -p "$TMP" "$BACKUP" "$ROOT"
tar -xzf '${remoteArchive}' -C "$TMP"
if [ -d "$ROOT/apps" ]; then
  tar -C "$ROOT" -czf "$BACKUP/source-before.tar.gz" --ignore-failed-read apps packages prisma scripts configs docs package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json docker-compose.production.yml ecosystem.config.cjs || true
fi
if [ -d /data/1panel/www/sites/xanime.ink/local-model ]; then tar -C /data/1panel/www/sites/xanime.ink/local-model -czf "$BACKUP/web-before.tar.gz" . || true; fi
if [ -d /data/1panel/www/sites/admin.xanime.ink/local-model-admin ]; then tar -C /data/1panel/www/sites/admin.xanime.ink/local-model-admin -czf "$BACKUP/admin-before.tar.gz" . || true; fi
cp -a "$TMP"/. "$ROOT"/
cd "$ROOT"
if [ ! -f .env ]; then
  umask 077
  DB_PASSWORD=$(openssl rand -hex 24)
  DB_ROOT_PASSWORD=$(openssl rand -hex 24)
  REDIS_PASSWORD=$(openssl rand -hex 24)
  S3_ACCESS="lp$(openssl rand -hex 10)"
  S3_SECRET=$(openssl rand -hex 32)
  GPU_TOKEN=$(openssl rand -hex 32)
  TRAINING_TOKEN=$(openssl rand -hex 32)
  cat > .env <<EOF
NODE_ENV=production
LOCAL_DB_PASSWORD=$DB_PASSWORD
LOCAL_DB_ROOT_PASSWORD=$DB_ROOT_PASSWORD
LOCAL_REDIS_PASSWORD=$REDIS_PASSWORD
DATABASE_URL=mysql://local_platform:$DB_PASSWORD@127.0.0.1:3317/drawhime_local
REDIS_URL=redis://:$REDIS_PASSWORD@127.0.0.1:6390
S3_ENDPOINT=http://127.0.0.1:9010
S3_REGION=us-east-1
S3_BUCKET=drawhime-local
S3_ACCESS_KEY=$S3_ACCESS
S3_SECRET_KEY=$S3_SECRET
MAIN_PLATFORM_BASE_URL=https://www.xanime.ink
MAIN_PLATFORM_INTERNAL_URL=http://127.0.0.1:6369
MAIN_PLATFORM_AUDIENCE=drawhime-local-platform
LOCAL_API_BASE_URL=http://127.0.0.1:7102
LOCAL_SCHEDULER_BASE_URL=http://127.0.0.1:7103
LOCAL_GPU_AGENT_BASE_URL=http://127.0.0.1:7110
LOCAL_INFERENCE_WORKER_BASE_URL=http://127.0.0.1:7111
LOCAL_TRAINING_WORKER_BASE_URL=http://127.0.0.1:7112
LOCAL_ARTIFACT_SERVICE_BASE_URL=http://127.0.0.1:7113
GPU_AGENT_TOKEN=$GPU_TOKEN
GPU_WORKLOADS_SHARE_DEVICE=false
TRAINING_RUNTIME_TOKEN=$TRAINING_TOKEN
TRAINING_RUNTIME_BASE_URL=${trainingRuntimeBaseUrl}
LOCAL_PUBLIC_API_BASE_URL=https://www.xanime.ink/local-model-api
EOF
fi
# 已存在的生产私有环境文件只幂等补齐真实 ComfyUI 地址，不覆盖任何既有凭证。
grep -q '^COMFYUI_BASE_URL=' .env || echo 'COMFYUI_BASE_URL=${comfyUiBaseUrl}' >> .env
# 生产推理固定 GPU 0、训练固定 GPU 1，两个工作负载使用独立显卡并允许并行。
grep -q '^GPU_WORKLOADS_SHARE_DEVICE=' .env || echo 'GPU_WORKLOADS_SHARE_DEVICE=false' >> .env
# 既有生产环境幂等补齐训练链路配置，随机令牌只写入私有环境文件。
grep -q '^TRAINING_RUNTIME_TOKEN=' .env || echo "TRAINING_RUNTIME_TOKEN=$(openssl rand -hex 32)" >> .env
grep -q '^TRAINING_RUNTIME_BASE_URL=' .env || echo 'TRAINING_RUNTIME_BASE_URL=${trainingRuntimeBaseUrl}' >> .env
# 训练产物弱网链路使用可恢复小分片，避免下载异常触发重复训练。
# 旧生产默认值升级到 1MB；管理员自定义的其他值保持不变。
if grep -q '^TRAINING_OUTPUT_CHUNK_BYTES=65536$' .env; then sed -i 's/^TRAINING_OUTPUT_CHUNK_BYTES=65536$/TRAINING_OUTPUT_CHUNK_BYTES=1048576/' .env; else grep -q '^TRAINING_OUTPUT_CHUNK_BYTES=' .env || echo 'TRAINING_OUTPUT_CHUNK_BYTES=1048576' >> .env; fi
grep -q '^TRAINING_OUTPUT_CONCURRENCY=' .env || echo 'TRAINING_OUTPUT_CONCURRENCY=8' >> .env
grep -q '^LOCAL_PUBLIC_API_BASE_URL=' .env || echo 'LOCAL_PUBLIC_API_BASE_URL=https://www.xanime.ink/local-model-api' >> .env
# LoRA 同步端点沿用当前 ComfyUI 已配置的服务 token；只从本机 PM2 进程环境读取并写入独立私有环境文件。
if ! grep -q '^COMFYUI_SERVICE_TOKEN=' .env; then
  MAIN_WORKER_PID=$(pm2 pid v3-worker 2>/dev/null || true)
  if [ -n "$MAIN_WORKER_PID" ] && [ -r "/proc/$MAIN_WORKER_PID/environ" ]; then
    COMFY_TOKEN=$(tr '\0' '\n' < "/proc/$MAIN_WORKER_PID/environ" | sed -n 's/^WS_PROXY_TOKEN=//p' | head -n 1)
  fi
  # 部分 PM2 环境不会出现在 /proc 快照中，回退读取 PM2 自身的受控环境输出。
  [ -n "\${COMFY_TOKEN:-}" ] || COMFY_TOKEN=$(pm2 env 2 2>/dev/null | sed -n 's/^WS_PROXY_TOKEN: //p' | head -n 1)
  [ -z "\${COMFY_TOKEN:-}" ] || echo "COMFYUI_SERVICE_TOKEN=$COMFY_TOKEN" >> .env
fi
umask 022
docker compose --env-file .env -f docker-compose.production.yml up -d mariadb redis minio minio-init
for attempt in $(seq 1 40); do
  DB_STATE=$(docker inspect --format '{{.State.Health.Status}}' drawhime-local-platform-mariadb-1 2>/dev/null || true)
  REDIS_STATE=$(docker inspect --format '{{.State.Health.Status}}' drawhime-local-platform-redis-1 2>/dev/null || true)
  MINIO_STATE=$(docker inspect --format '{{.State.Health.Status}}' drawhime-local-platform-minio-1 2>/dev/null || true)
  [ "$DB_STATE" = healthy ] && [ "$REDIS_STATE" = healthy ] && [ "$MINIO_STATE" = healthy ] && break
  sleep 3
done
test "$DB_STATE" = healthy
test "$REDIS_STATE" = healthy
test "$MINIO_STATE" = healthy
export PUPPETEER_SKIP_DOWNLOAD=true
pnpm install --frozen-lockfile
set -a
. ./.env
set +a
pnpm run db:generate
pnpm run db:migrate:deploy
pnpm run build
pnpm run bootstrap:tag-translations
pnpm run bootstrap:anima
pnpm run migrate:main-loras
test -f ecosystem.config.cjs || cp ecosystem.config.example.cjs ecosystem.config.cjs
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
mkdir -p /data/1panel/www/sites/xanime.ink/local-model /data/1panel/www/sites/admin.xanime.ink/local-model-admin
find /data/1panel/www/sites/xanime.ink/local-model -mindepth 1 -maxdepth 1 -exec rm -rf {} +
find /data/1panel/www/sites/admin.xanime.ink/local-model-admin -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a apps/web/dist/. /data/1panel/www/sites/xanime.ink/local-model/
cp -a apps/admin/dist/. /data/1panel/www/sites/admin.xanime.ink/local-model-admin/
chmod -R a+rX /data/1panel/www/sites/xanime.ink/local-model /data/1panel/www/sites/admin.xanime.ink/local-model-admin
if id 1panel >/dev/null 2>&1; then
  chown -R 1panel:1panel /data/1panel/www/sites/xanime.ink/local-model /data/1panel/www/sites/admin.xanime.ink/local-model-admin
fi
node scripts/install-production-nginx-paths.mjs
# PM2 reload 后 Node 与公网代理存在短暂启动窗口，统一重试而不是把瞬时拒绝误判为部署失败。
verify_contains() {
  URL="$1"
  EXPECTED="$2"
  for attempt in $(seq 1 30); do
    if curl -kfsS "$URL" 2>/dev/null | grep -q "$EXPECTED"; then return 0; fi
    sleep 1
  done
  echo "验证失败：$URL" >&2
  return 1
}
verify_contains http://127.0.0.1:7102/health '"service":"api"'
verify_contains https://www.xanime.ink/local-model/ '绘图姬'
verify_contains https://admin.xanime.ink/local-model-admin/ 'DrawHime Local'
verify_contains https://www.xanime.ink/local-model-api/health '"service":"api"'
rm -rf "$TMP" '${remoteArchive}'
echo '本地模型独立路径生产部署验证完成'
`;
}

/** 执行本地命令并保留输出，任何失败立即终止部署。 */
function run(command, arguments_, options = {}) {
  const executable = process.platform === "win32" && command === "pnpm" ? "cmd.exe" : command;
  const actualArguments = executable === "cmd.exe" ? ["/d", "/s", "/c", "pnpm", ...arguments_] : arguments_;
  process.stdout.write(`$ ${command} ${arguments_.join(" ")}\n`);
  const maximumAttempts = command === "ssh" || command === "scp" ? 3 : 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = spawnSync(executable, actualArguments, {
      cwd: root,
      stdio: options.input ? ["pipe", "inherit", "inherit"] : "inherit",
      input: options.input,
      encoding: typeof options.input === "string" ? "utf8" : undefined,
      env: options.env || process.env,
      shell: false,
    });
    if (result.status === 0) return;
    if (attempt < maximumAttempts) {
      process.stderr.write(`${command} 第 ${attempt} 次执行失败，5 秒后重试\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
  }
  throw new Error(`命令执行失败：${command}`);
}
