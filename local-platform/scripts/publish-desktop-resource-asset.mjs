/**
 * 本文件按签名清单把单个桌面资源原子发布到主站 data 盘，支持主站拉取或运维机上传两种一次性入库方式。
 */
import { desktopResourceManifestEnvelopeSchema, desktopResourceManifestPayloadSchema } from "../packages/contracts/dist/index.js";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadPrivateEnvironment, requirePrivateEnvironment } from "./private-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const options = parseArguments(process.argv.slice(2));
const resourceId = requiredValue("resource-id");
const fileOption = options.get("file")?.trim();
const urlOption = options.get("url")?.trim();
if (Boolean(fileOption) === Boolean(urlOption)) throw new Error("--file 与 --url 必须且只能提供一个");
const envelopePath = resolve(options.get("envelope") || ".private/desktop-resources/manifest-envelope.json");
const envelope = desktopResourceManifestEnvelopeSchema.parse(JSON.parse(await readFile(envelopePath, "utf8")));
const payload = desktopResourceManifestPayloadSchema.parse(JSON.parse(envelope.payload));
const resource = payload.resources.find((item) => item.id === resourceId);
if (!resource) throw new Error(`签名清单不存在资源：${resourceId}`);
if (basename(resource.fileName) !== resource.fileName) throw new Error("签名清单资源文件名不安全");
if (resource.sources.length !== 1 || resource.sources[0]?.kind !== "mirror") throw new Error("客户端资源必须只登记主站镜像");

loadPrivateEnvironment(resolve(root, ".private", "production.env"));
const connection = deploymentConnection();
const storageRoot = readRemoteStorageRoot(connection);
const temporaryPath = `${storageRoot}/.${resource.fileName}.incoming`;

if (fileOption) {
  const filePath = resolve(fileOption);
  await verifyLocalFile(filePath, resource.byteSize, resource.sha256);
  await uploadFile(connection, filePath, temporaryPath);
} else {
  const url = new URL(urlOption);
  if (url.protocol !== "https:") throw new Error("主站拉取地址必须使用 HTTPS");
  runRemote(connection, remoteDownloadScript(), [temporaryPath, url.href], 8 * 60 * 60_000);
}
runRemote(connection, remotePublishScript(), [temporaryPath, resource.fileName, String(resource.byteSize), resource.sha256], 30 * 60_000);
await verifyPublicMirror(resource.id, resource.byteSize, resource.sha256);
process.stdout.write(`桌面资源主站发布完成：${resource.id} · ${resource.byteSize} bytes\n`);

/** 解析成对参数并拒绝重复键。 */
function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || parsed.has(key.slice(2))) throw new Error(`参数不正确或重复：${key || "空"}`);
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

function requiredValue(key) {
  const value = options.get(key)?.trim();
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}

/** 构造不回显私有主机和密钥的 SSH/SCP 参数。 */
function deploymentConnection() {
  const host = requirePrivateEnvironment("LOCAL_PLATFORM_DEPLOY_HOST");
  const port = process.env.LOCAL_PLATFORM_DEPLOY_PORT || "22";
  const key = process.env.LOCAL_PLATFORM_DEPLOY_KEY || resolve(homedir(), ".ssh", "id_ed25519");
  const proxyJump = process.env.LOCAL_PLATFORM_DEPLOY_PROXY_JUMP?.trim();
  const common = [...(existsSync(key) ? ["-i", key] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=240", ...(proxyJump ? ["-J", proxyJump] : [])];
  return { host, port, common };
}

/** 读取生产资源根目录并强制要求位于 data 盘。 */
function readRemoteStorageRoot(connection) {
  const command = "cd /local-platform && set -a && . ./.env && set +a && printf '%s' \"$DESKTOP_RESOURCE_STORAGE_ROOT\"";
  const result = spawnSync("ssh", [...connection.common, "-p", connection.port, connection.host, command], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error("读取主站资源目录失败");
  const value = result.stdout.trim();
  if (!/^\/data\/[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("主站桌面资源目录未配置到 data 盘");
  return value.replace(/\/$/, "");
}

/** 本地上传前流式校验大小和 SHA-256，禁止把错误权重写入主站。 */
async function verifyLocalFile(filePath, expectedBytes, expectedSha256) {
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.size !== expectedBytes) throw new Error("本地资源文件不存在或大小不正确");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if (hash.digest("hex") !== expectedSha256) throw new Error("本地资源 SHA-256 与签名清单不一致");
}

/** 使用 SCP 把大文件直接流入主站 data 盘临时路径。 */
async function uploadFile(connection, localPath, remotePath) {
  const child = spawn("scp", [...connection.common, "-P", connection.port, localPath, `${connection.host}:${remotePath}`], { stdio: "inherit" });
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", resolvePromise);
  });
  if (exitCode !== 0) throw new Error(`资源上传失败：退出码 ${exitCode}`);
}

/** 主站 URL 拉取只写临时文件并支持断点，不在客户端保存来源。 */
function remoteDownloadScript() {
  return `set -euo pipefail
temporary_path="$1"
source_url="$2"
mkdir -p "$(dirname "$temporary_path")"
curl --fail --location --silent --show-error --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 20 --continue-at - --output "$temporary_path" "$source_url"
`;
}

/** 在主站核对临时文件并原子替换正式资源。 */
function remotePublishScript() {
  return `set -euo pipefail
temporary_path="$1"
file_name="$2"
expected_bytes="$3"
expected_sha256="$4"
cd /local-platform
set -a
. ./.env
set +a
: "\${DESKTOP_RESOURCE_STORAGE_ROOT:?缺少资源存储目录}"
case "$DESKTOP_RESOURCE_STORAGE_ROOT" in /data/*) ;; *) echo '资源目录不在 data 盘' >&2; exit 1;; esac
target="$DESKTOP_RESOURCE_STORAGE_ROOT/$file_name"
actual_bytes=$(stat -c %s "$temporary_path")
[ "$actual_bytes" = "$expected_bytes" ] || { echo "资源大小不正确：$actual_bytes" >&2; exit 1; }
actual_sha256=$(sha256sum "$temporary_path" | awk '{print $1}')
[ "$actual_sha256" = "$expected_sha256" ] || { echo "资源 SHA-256 不正确：$actual_sha256" >&2; exit 1; }
chmod 0644 "$temporary_path"
mv -f "$temporary_path" "$target"
`;
}

/** 通过标准输入发送远端脚本，参数独立传递避免多层 Shell 插值。 */
function runRemote(connection, script, arguments_, timeout) {
  const result = spawnSync("ssh", [...connection.common, "-p", connection.port, connection.host, "bash", "-s", "--", ...arguments_], { input: script, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"], timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`主站资源操作失败：退出码 ${result.status ?? "未知"}`);
}

/** 读取一个字节确认公网主站已按签名大小和 ETag 提供资源。 */
async function verifyPublicMirror(id, byteSize, sha256) {
  const response = await fetch(`https://www.xanime.ink/local-model-api/v1/desktop/resources/${id}/content`, { headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(60_000) });
  if (response.status !== 206 || response.headers.get("content-range") !== `bytes 0-0/${byteSize}` || response.headers.get("etag") !== `"${sha256}"`) throw new Error(`公网主站资源验收失败：HTTP ${response.status}`);
}
