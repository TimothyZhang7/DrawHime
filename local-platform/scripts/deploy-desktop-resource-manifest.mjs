/**
 * 本文件验签并原子发布桌面资源清单信封，生产失败时恢复上一信封且不触碰资源文件或数据库。
 */
import { desktopResourceManifestEnvelopeSchema, desktopResourceManifestPayloadSchema } from "../packages/contracts/dist/index.js";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPrivateEnvironment, requirePrivateEnvironment } from "./private-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const options = parseArguments(process.argv.slice(2));
const envelopePath = resolve(requiredValue("envelope"));
const publicKeyPath = resolve(options.get("public-key") || ".private/desktop-resources/public-key.txt");
const dryRun = options.has("dry-run");
const envelope = desktopResourceManifestEnvelopeSchema.parse(JSON.parse(await readFile(envelopePath, "utf8")));
const payload = desktopResourceManifestPayloadSchema.parse(JSON.parse(envelope.payload));
await verifyEnvelope(envelope, publicKeyPath);
verifyDesktopKeyBinding(envelope, publicKeyPath);

if (dryRun) printSummary("dry-run");
else {
  await deployEnvelope();
  await promoteLocalState();
  printSummary("published");
}

/** 解析严格的成对参数和无值 dry-run 标记。 */
function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) throw new Error(`未知位置参数：${argument}`);
    const key = argument.slice(2);
    if (key === "dry-run") { values.set(key, "true"); continue; }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--") || values.has(key)) throw new Error(`参数不正确或重复：--${key}`);
    values.set(key, value);
    index += 1;
  }
  return values;
}

/** 使用桌面固定原始公钥验证 Ed25519 信封。 */
async function verifyEnvelope(candidate, keyPath) {
  const raw = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
  if (raw.length !== 32) throw new Error("桌面资源公钥长度不正确");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  if (!verify(null, Buffer.from(candidate.payload), publicKey, Buffer.from(candidate.signature, "base64"))) throw new Error("桌面资源信封签名验证失败");
}

/** 确认信封密钥与桌面二进制源码固定值一致。 */
function verifyDesktopKeyBinding(candidate, keyPath) {
  const publicRaw = readFileSync(keyPath, "utf8").trim();
  const source = readFileSync(resolve(root, "apps", "desktop", "src-tauri", "src", "resource.rs"), "utf8");
  if (!source.includes(`const MANIFEST_KEY_ID: &str = "${candidate.keyId}";`) || !source.includes(`const MANIFEST_PUBLIC_KEY: &str = "${publicRaw}";`)) throw new Error("信封密钥与桌面固定公钥配置不一致");
}

/** 上传临时信封并在生产回环 API 验证后原子切换。 */
async function deployEnvelope() {
  loadPrivateEnvironment(resolve(root, ".private", "production.env"));
  const host = requirePrivateEnvironment("LOCAL_PLATFORM_DEPLOY_HOST");
  const port = process.env.LOCAL_PLATFORM_DEPLOY_PORT || "22";
  const key = process.env.LOCAL_PLATFORM_DEPLOY_KEY || resolve(homedir(), ".ssh", "id_ed25519");
  const proxyJump = process.env.LOCAL_PLATFORM_DEPLOY_PROXY_JUMP?.trim();
  const ssh = [...(existsSync(key) ? ["-i", key] : []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=120", ...(proxyJump ? ["-J", proxyJump] : []), "-p", port, host];
  const remoteEnvelope = `/tmp/drawhime-resource-manifest-${Date.now()}-${process.pid}.json`;
  run("ssh", [...ssh, `cat > '${remoteEnvelope}'`], readFileSync(envelopePath), 3);
  run("ssh", [...ssh, "bash", "-s", "--", remoteEnvelope, payload.generatedAt], remoteScript(), 1);
  let verified = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch("https://www.xanime.ink/local-model-api/v1/desktop/resources/manifest", { signal: AbortSignal.timeout(20_000) });
      const wrapper = await response.json();
      verified = response.ok && wrapper.data?.keyId === envelope.keyId && wrapper.data?.payload === envelope.payload && wrapper.data?.signature === envelope.signature;
      if (verified) break;
    } catch {
      // 公网边缘瞬时失败只进行有界重试，生产回环 API 已完成同一信封验证。
    }
    if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 2_000);
  }
  if (!verified) throw new Error("公网资源清单未收敛到本次签名信封");
}

/** 生产脚本备份旧信封；新信封未被 API 读取时立即恢复。 */
function remoteScript() {
  return `set -euo pipefail
UPLOADED_ENVELOPE="$1"
EXPECTED_GENERATED_AT="$2"
cd /local-platform
set -a
. ./.env
set +a
: "\${DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE:?缺少资源清单路径}"
case "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE" in /*) ;; *) echo '资源清单路径必须是绝对路径' >&2; exit 1;; esac
STAMP=$(date +%Y%m%d%H%M%S)
BACKUP="/local-platform/backups/desktop-manifest-$STAMP"
mkdir -p "$BACKUP" "$(dirname "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE")"
if [ -f "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE" ]; then cp -a "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE" "$BACKUP/manifest-envelope.json"; fi
TARGET_TMP="$(dirname "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE")/.manifest-envelope.incoming-$STAMP"
cp "$UPLOADED_ENVELOPE" "$TARGET_TMP"
chmod 0644 "$TARGET_TMP"
mv -f "$TARGET_TMP" "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE"
verified=0
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:7102/v1/desktop/resources/manifest 2>/dev/null | grep -q "$EXPECTED_GENERATED_AT"; then verified=1; break; fi
  sleep 1
done
if [ "$verified" != 1 ]; then
  if [ -f "$BACKUP/manifest-envelope.json" ]; then cp -a "$BACKUP/manifest-envelope.json" "$DESKTOP_RESOURCE_MANIFEST_ENVELOPE_FILE"; fi
  echo '资源清单发布验证失败，已恢复上一信封' >&2
  exit 1
fi
rm -f "$UPLOADED_ENVELOPE"
echo '桌面资源清单原子发布完成'
`;
}

/** 公网验证完成后才更新本机私有发布状态。 */
async function promoteLocalState() {
  const payloadTarget = options.get("state-payload");
  const envelopeTarget = options.get("state-envelope");
  if (!payloadTarget && !envelopeTarget) return;
  if (!payloadTarget || !envelopeTarget) throw new Error("state-payload 与 state-envelope 必须同时提供");
  await writeAtomically(resolve(payloadTarget), `${JSON.stringify(payload, null, 2)}\n`);
  await writeAtomically(resolve(envelopeTarget), `${JSON.stringify(envelope, null, 2)}\n`);
}

async function writeAtomically(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.incoming`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function run(command, arguments_, input, maximumAttempts) {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = spawnSync(command, arguments_, { cwd: root, input, stdio: ["pipe", "inherit", "inherit"] });
    if (result.status === 0) return;
    if (attempt < maximumAttempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5_000);
  }
  throw new Error(`${command} 执行失败`);
}

function requiredValue(key) {
  const value = options.get(key)?.trim();
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}

function printSummary(status) {
  process.stdout.write(`资源清单 ${status}：${payload.channel} · ${payload.resources.length} 项 · ${payload.generatedAt}\n`);
}
