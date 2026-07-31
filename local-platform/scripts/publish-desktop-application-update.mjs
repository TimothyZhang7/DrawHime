/**
 * 本文件负责生成、签署并原子发布 DrawHime Desktop NSIS 更新包，不接触模型、用户媒体或业务数据库。
 */
import { desktopResourceManifestPayloadSchema } from "../packages/contracts/dist/index.js";
import { createPrivateKey, createPublicKey, createHash, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPrivateEnvironment, requirePrivateEnvironment } from "./private-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const privateRoot = resolve(root, ".private", "desktop-resources");
const options = parseArguments(process.argv.slice(2));
const command = options.positionals[0];
const dryRun = options.flags.has("dry-run");

if (!new Set(["prepare", "deploy", "publish"]).has(command)) {
  throw new Error("用法：prepare|deploy|publish --installer EXE --version X.Y.Z --minimum-version X.Y.Z --release-notes TEXT [--mandatory true|false] [--dry-run]");
}

const paths = publicationPaths(options.values);
let prepared;
if (command === "prepare" || command === "publish") prepared = await preparePublication(paths, options.values, dryRun);
if (command === "deploy" || command === "publish") {
  const publication = prepared || await loadPublication(paths, options.values);
  if (dryRun) printSummary(publication, "dry-run");
  else await deployPublication(publication);
}

/** 解析位置参数、布尔标记和成对选项，拒绝重复键。 */
function parseArguments(arguments_) {
  const positionals = [];
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2);
    if (key === "dry-run") { flags.add(key); continue; }
    const next = arguments_[index + 1];
    if (!next || next.startsWith("--") || values.has(key)) throw new Error(`参数不正确或重复：--${key}`);
    values.set(key, next);
    index += 1;
  }
  return { positionals, values, flags };
}

/** 根据版本生成不含空格的稳定资源 ID 和私有发布文件路径。 */
function publicationPaths(values) {
  const version = requiredVersion(values, "version");
  const versionSlug = version.replaceAll(".", "-");
  const fileName = `drawhime-desktop-${version}-x64-setup.exe`;
  return {
    version,
    resourceId: `application.drawhime-desktop.${versionSlug}`,
    fileName,
    assetPath: resolve(values.get("asset-output") || resolve(privateRoot, "assets", fileName)),
    payloadPath: resolve(values.get("payload") || resolve(privateRoot, "manifest-payload.json")),
    envelopePath: resolve(values.get("envelope") || resolve(privateRoot, "manifest-envelope.json")),
    privateKeyPath: resolve(values.get("private-key") || resolve(privateRoot, "signing.pem")),
    publicKeyPath: resolve(values.get("public-key") || resolve(privateRoot, "public-key.txt")),
  };
}

/** 校验安装包，合并 application 条目并使用离线 Ed25519 私钥签署新信封。 */
async function preparePublication(paths, values, isDryRun) {
  const installerPath = resolve(requiredValue(values, "installer"));
  const installer = await stat(installerPath).catch(() => null);
  if (!installer?.isFile() || installer.size <= 0) throw new Error("NSIS 安装包不存在或为空");
  const minimumVersion = requiredVersion(values, "minimum-version");
  if (compareVersions(minimumVersion, paths.version) > 0) throw new Error("最低直接升级版本不得高于目标版本");
  const releaseNotes = requiredValue(values, "release-notes").trim();
  if (!releaseNotes || releaseNotes.length > 20_000) throw new Error("版本说明长度必须为 1–20000 字符");
  const mandatory = parseBoolean(values.get("mandatory") || "false", "mandatory");
  const sha256 = await sha256File(installerPath);
  const currentPayload = JSON.parse(await readFile(paths.payloadPath, "utf8"));
  const currentEnvelope = JSON.parse(await readFile(paths.envelopePath, "utf8"));
  await verifyEnvelope(currentPayload, currentEnvelope, paths);
  const generatedAt = new Date().toISOString();
  const currentExpiry = new Date(currentPayload.expiresAt);
  const minimumExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const expiresAt = currentExpiry > minimumExpiry ? currentExpiry.toISOString() : minimumExpiry.toISOString();
  const mirrorUrl = `https://www.xanime.ink/local-model-api/v1/desktop/resources/${paths.resourceId}/content`;
  // 应用更新与运行资源统一经主站镜像分发，避免第三方下载源导致版本和网络行为不一致。
  const sources = [{ kind: "mirror", url: mirrorUrl }];
  const item = {
    id: paths.resourceId,
    kind: "application",
    version: paths.version,
    os: "windows",
    arch: "x86_64",
    fileName: paths.fileName,
    byteSize: installer.size,
    installedSize: installer.size,
    sha256,
    archive: "raw",
    rootDirectory: null,
    installDirectory: null,
    modelRegistration: null,
    applicationUpdate: { minimumVersion, releaseNotes, mandatory },
    required: false,
    sources,
  };
  const existingItem = currentPayload.resources.find((resource) => resource.id === item.id);
  if (existingItem && JSON.stringify(existingItem) !== JSON.stringify(item)) {
    throw new Error(`版本 ${paths.version} 已登记为其他不可变内容；请提升版本号，禁止覆盖既有安装包或元数据`);
  }
  const resources = currentPayload.resources.filter((resource) => resource.id !== item.id);
  const parsedPayload = desktopResourceManifestPayloadSchema.safeParse({ ...currentPayload, channel: "stable", generatedAt, expiresAt, resources: [...resources, item] });
  if (!parsedPayload.success) throw new Error(`应用更新资源未通过共享契约：${parsedPayload.error.issues[0]?.message || "未知错误"}`);
  const signed = await signPayload(parsedPayload.data, paths, currentEnvelope.keyId);
  const publication = { ...paths, installerPath, item, payload: parsedPayload.data, envelope: signed };
  if (isDryRun) { printSummary(publication, "dry-run"); return publication; }
  await mkdir(dirname(paths.assetPath), { recursive: true });
  const temporaryAsset = `${paths.assetPath}.incoming`;
  await copyFile(installerPath, temporaryAsset);
  if (await sha256File(temporaryAsset) !== sha256) throw new Error("复制后的安装包 SHA-256 发生变化");
  await rename(temporaryAsset, paths.assetPath);
  await writeJsonAtomically(paths.payloadPath, parsedPayload.data);
  await writeJsonAtomically(paths.envelopePath, signed);
  printSummary(publication, "prepared");
  return publication;
}

/** 读取已经准备的私有发布文件，并再次校验契约、签名、大小和哈希。 */
async function loadPublication(paths, values) {
  const payload = desktopResourceManifestPayloadSchema.parse(JSON.parse(await readFile(paths.payloadPath, "utf8")));
  const envelope = JSON.parse(await readFile(paths.envelopePath, "utf8"));
  const item = payload.resources.find((resource) => resource.id === paths.resourceId && resource.kind === "application");
  if (!item) throw new Error("准备目录中不存在指定 application 资源");
  if (values.has("minimum-version") && item.applicationUpdate?.minimumVersion !== requiredVersion(values, "minimum-version")) throw new Error("准备资源的最低升级版本与命令参数不一致");
  await verifyEnvelope(payload, envelope, paths);
  const metadata = await stat(paths.assetPath).catch(() => null);
  if (!metadata?.isFile() || metadata.size !== item.byteSize || await sha256File(paths.assetPath) !== item.sha256) throw new Error("准备目录中的安装包大小或 SHA-256 不匹配");
  return { ...paths, installerPath: paths.assetPath, item, payload, envelope };
}

/** 使用私钥签名并确认私钥、公钥文件和桌面内置公钥属于同一密钥。 */
async function signPayload(payload, paths, keyId) {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(keyId || "")) throw new Error("现有清单 keyId 不正确");
  const privateKey = createPrivateKey(await readFile(paths.privateKeyPath, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("资源签名私钥不是 Ed25519");
  const publicKey = createPublicKey(privateKey);
  const publicRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  const expectedPublicRaw = (await readFile(paths.publicKeyPath, "utf8")).trim();
  const desktopSource = await readFile(resolve(root, "apps", "desktop", "src-tauri", "src", "resource.rs"), "utf8");
  if (publicRaw !== expectedPublicRaw || !desktopSource.includes(`const MANIFEST_PUBLIC_KEY: &str = "${publicRaw}";`)) throw new Error("签名公钥与桌面内置公钥不一致");
  const serialized = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(serialized), privateKey);
  if (!verify(null, Buffer.from(serialized), publicKey, signature)) throw new Error("应用更新签名自检失败");
  return { keyId, payload: serialized, signature: signature.toString("base64") };
}

/** 验证准备好的信封确实覆盖当前载荷，避免发布旧信封或错误密钥。 */
async function verifyEnvelope(payload, envelope, paths) {
  if (envelope.payload !== JSON.stringify(payload)) throw new Error("签名信封与当前资源载荷不一致");
  const privateKey = createPrivateKey(await readFile(paths.privateKeyPath, "utf8"));
  const publicKey = createPublicKey(privateKey);
  if (!verify(null, Buffer.from(envelope.payload), publicKey, Buffer.from(envelope.signature, "base64"))) throw new Error("签名信封验证失败");
}

/** 先上传临时文件，再由远端脚本核验并原子切换资源和信封。 */
async function deployPublication(publication) {
  loadPrivateEnvironment(resolve(root, ".private", "production.env"));
  const host = requirePrivateEnvironment("LOCAL_PLATFORM_DEPLOY_HOST");
  const port = process.env.LOCAL_PLATFORM_DEPLOY_PORT || "22";
  const key = process.env.LOCAL_PLATFORM_DEPLOY_KEY || resolve(homedir(), ".ssh", "id_ed25519");
  const proxyJump = process.env.LOCAL_PLATFORM_DEPLOY_PROXY_JUMP?.trim();
  const sshArguments = [
    ...(existsSync(key) ? ["-i", key] : []),
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=120",
    ...(proxyJump ? ["-J", proxyJump] : []), "-p", port, host,
  ];
  const nonce = `${Date.now()}-${process.pid}`;
  const remoteAsset = `/tmp/drawhime-application-${nonce}.exe`;
  const remoteEnvelope = `/tmp/drawhime-application-${nonce}.json`;
  run("ssh", [...sshArguments, `cat > '${remoteAsset}'`], readFileSync(publication.assetPath));
  run("ssh", [...sshArguments, `cat > '${remoteEnvelope}'`], readFileSync(publication.envelopePath));
  run("ssh", [...sshArguments, "bash", "-s", "--", publication.resourceId, publication.fileName, publication.item.sha256, String(publication.item.byteSize), remoteAsset, remoteEnvelope], remotePublishScript(), 1);
  let publicVerified = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch("https://www.xanime.ink/local-model-api/v1/desktop/resources/manifest", { signal: AbortSignal.timeout(20_000) });
      const wrapper = await response.json();
      const livePayload = desktopResourceManifestPayloadSchema.parse(JSON.parse(wrapper.data?.payload || "null"));
      publicVerified = response.ok && livePayload.resources.some((resource) => resource.id === publication.resourceId && resource.sha256 === publication.item.sha256);
      if (publicVerified) break;
    } catch {
      // 公网边缘的短暂失败只进行有界重试；远端已经通过回环 API 验证。
    }
    if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 2_000);
  }
  if (!publicVerified) throw new Error("公网签名清单未收敛到本次应用更新");
  printSummary(publication, "published");
}

/** 远端脚本只读取生产私有路径，切换失败时恢复上一签名信封。 */
function remotePublishScript() {
  return `set -euo pipefail
RESOURCE_ID="$1"
FILE_NAME="$2"
EXPECTED_SHA256="$3"
EXPECTED_SIZE="$4"
UPLOADED_ASSET="$5"
UPLOADED_ENVELOPE="$6"
cd /local-platform
set -a
. ./.env
set +a
: "\${DESKTOP_RESOURCE_STORAGE_ROOT:?缺少资源存储目录}"
: "\${DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE:?缺少资源清单路径}"
case "$DESKTOP_RESOURCE_STORAGE_ROOT" in /data/*) ;; *) echo '资源存储目录必须位于 data 盘' >&2; exit 1;; esac
case "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE" in /*) ;; *) echo '资源清单路径必须是绝对路径' >&2; exit 1;; esac
test "$(stat -c %s "$UPLOADED_ASSET")" = "$EXPECTED_SIZE"
test "$(sha256sum "$UPLOADED_ASSET" | awk '{print $1}')" = "$EXPECTED_SHA256"
node - "$UPLOADED_ENVELOPE" "$RESOURCE_ID" "$FILE_NAME" "$EXPECTED_SHA256" "$EXPECTED_SIZE" <<'NODE'
const fs = require('node:fs');
const [envelopePath, resourceId, fileName, sha256, byteSize] = process.argv.slice(2);
const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
const payload = JSON.parse(envelope.payload);
const item = payload.resources.find((resource) => resource.id === resourceId);
if (!item || item.kind !== 'application' || item.fileName !== fileName || item.sha256 !== sha256 || item.byteSize !== Number(byteSize)) process.exit(1);
NODE
STAMP=$(date +%Y%m%d%H%M%S)
BACKUP="/local-platform/backups/desktop-application-$STAMP"
mkdir -p "$BACKUP" "$DESKTOP_RESOURCE_STORAGE_ROOT" "$(dirname "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE")"
if [ -f "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE" ]; then cp -a "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE" "$BACKUP/manifest-envelope.json"; fi
ASSET_TARGET="$DESKTOP_RESOURCE_STORAGE_ROOT/$FILE_NAME"
ASSET_TMP="$DESKTOP_RESOURCE_STORAGE_ROOT/.$FILE_NAME.incoming-$STAMP"
ENVELOPE_TMP="$(dirname "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE")/.manifest-envelope.incoming-$STAMP"
if [ -f "$ASSET_TARGET" ]; then
  test "$(stat -c %s "$ASSET_TARGET")" = "$EXPECTED_SIZE"
  test "$(sha256sum "$ASSET_TARGET" | awk '{print $1}')" = "$EXPECTED_SHA256"
else
  cp "$UPLOADED_ASSET" "$ASSET_TMP"
  chmod 0644 "$ASSET_TMP"
  mv "$ASSET_TMP" "$ASSET_TARGET"
fi
cp "$UPLOADED_ENVELOPE" "$ENVELOPE_TMP"
chmod 0644 "$ENVELOPE_TMP"
mv -f "$ENVELOPE_TMP" "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE"
verified=0
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:7102/v1/desktop/resources/manifest 2>/dev/null | grep -q "$RESOURCE_ID"; then verified=1; break; fi
  sleep 1
done
if [ "$verified" != 1 ]; then
  if [ -f "$BACKUP/manifest-envelope.json" ]; then cp -a "$BACKUP/manifest-envelope.json" "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE"; fi
  echo '应用更新清单发布验证失败，已恢复上一信封' >&2
  exit 1
fi
rm -f "$UPLOADED_ASSET" "$UPLOADED_ENVELOPE"
echo '桌面应用更新资源原子发布完成'
`;
}

/** 对私有 JSON 使用同目录临时文件原子替换，避免签署中断损坏上一清单。 */
async function writeJsonAtomically(path, value) {
  const temporary = `${path}.incoming`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** 流式计算大安装包 SHA-256，不把完整文件复制到 JavaScript 字符串。 */
async function sha256File(path) {
  const { createReadStream } = await import("node:fs");
  const hasher = createHash("sha256");
  await new Promise((resolvePromise, reject) => createReadStream(path).on("data", (chunk) => hasher.update(chunk)).on("end", resolvePromise).on("error", reject));
  return hasher.digest("hex");
}

/** 执行 SSH 并对瞬时链路错误最多重试三次。 */
function run(command, arguments_, input, maximumAttempts = 3) {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = spawnSync(command, arguments_, { cwd: root, input, stdio: ["pipe", "inherit", "inherit"] });
    if (result.status === 0) return;
    if (attempt < maximumAttempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5_000);
  }
  throw new Error(`${command} 执行失败`);
}

/** 输出不包含私钥、服务器路径或下载地址的发布摘要。 */
function printSummary(publication, state) {
  process.stdout.write(`应用更新 ${state}：${publication.item.id} · ${publication.item.version} · ${publication.item.byteSize} bytes · ${publication.item.sha256.slice(0, 12)}…\n`);
}

function requiredValue(values, key) {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}

function requiredVersion(values, key) {
  const value = requiredValue(values, key);
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`--${key} 必须是三段数字版本`);
  return value;
}

function parseBoolean(value, key) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${key} 只能是 true 或 false`);
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  return 0;
}
