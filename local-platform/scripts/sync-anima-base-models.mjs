/**
 * 本脚本经 SSH 将已登记的 Anima 底模原子同步到私有 GPU，并逐个校验官方 SHA-256 与 ComfyUI 可见性。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPrivateEnvironment, requirePrivateEnvironment } from "./private-environment.mjs";

const root = resolve(import.meta.dirname, "..");
loadPrivateEnvironment(resolve(root, ".private", "production.env"));
const host = requirePrivateEnvironment("TRAINING_GPU_DEPLOY_HOST");
const port = process.env.TRAINING_GPU_DEPLOY_PORT || "22";
const key = process.env.TRAINING_GPU_DEPLOY_KEY || resolve(homedir(), ".ssh", "id_ed25519");
const token = readCivitaiToken();
const checkOnly = process.argv.includes("--check");
const localProxyPort = readOptionalPort("CIVITAI_LOCAL_PROXY_PORT");
const remoteProxyPort = localProxyPort ? readOptionalPort("CIVITAI_REMOTE_PROXY_PORT", "17897") : null;
const models = [
  { versionId: 3047288, fileName: "animeBulldozer_anima.safetensors", sha256: "8e279f111ed7e7ea214ea61850e002f700cce55a8cd027675796773089b3c739", byteSize: 4182218504 },
  { versionId: 3071702, fileName: "miaomiaoRealskin_anima11.safetensors", sha256: "d33247d48a9c15a872aef963940fc87362f925e3e087365810ad747042fcc454", byteSize: 4182218328 },
  { versionId: 3074791, fileName: "miaomiao3DHarem_animaLH3D10.safetensors", sha256: "0707cbe8deed6c858a6ba8dfbcfe2006e3a4fd44c099aafd048400fdec1866dd", byteSize: 4182218328 },
  {
    versionId: 3125933,
    fileName: "miaomiaoHarem_anima8Step10.safetensors",
    sha256: "10760718321f82577f648893416655fb979a8026cdd8977fd74a9ac998e1314a",
    byteSize: 4182218328,
    // 该版本的官方端点已实测允许匿名 Range 下载，未配置令牌时仍使用同一 Civitai 官方对象并执行完整哈希校验。
    fallbackUrl: "https://civitai.com/api/download/models/3125933",
  },
  {
    versionId: 2983680,
    fileName: "waiANIMA_v10Base10.safetensors",
    sha256: "9d5a1e1393c2978d6a979fab38fb0dee00bc2a94e354196c9f3cf2f6f56d5fbf",
    byteSize: 4182233976,
    // 该公开镜像的 LFS OID 与 Civitai 官方 SHA-256 完全一致，供未配置登录令牌的 GPU 使用。
    fallbackUrl: "https://huggingface.co/diffusionmodels1254ani/waiANIMA/resolve/main/waiANIMA_v10Base10.safetensors",
  },
];

const remoteScript = buildRemoteScript();
const sshArguments = [
  ...(existsSync(key) ? ["-i", key] : []),
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=20",
  "-o", "ServerAliveInterval=5",
  "-o", "ServerAliveCountMax=120",
  // 可选反向隧道只承载本次 Civitai 下载，GPU 主机无需持久配置公网代理。
  ...(localProxyPort && remoteProxyPort ? ["-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${remoteProxyPort}:127.0.0.1:${localProxyPort}`] : []),
  "-p", port,
  host,
  "bash", "-s",
];
const result = spawnSync("ssh", sshArguments, { input: remoteScript, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"], timeout: 6 * 60 * 60_000 });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

/** 从私有环境变量或仅含令牌的本地文件读取 Civitai 凭证，不写入仓库和远端磁盘。 */
function readCivitaiToken() {
  const direct = process.env.CIVITAI_API_TOKEN?.trim();
  if (direct) return direct;
  const tokenFile = process.env.CIVITAI_API_TOKEN_FILE?.trim();
  return tokenFile && existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
}

/** 读取可选代理端口并拒绝歧义值，避免把 SSH 反向隧道绑定到非预期端口。 */
function readOptionalPort(name, fallback = "") {
  const value = (process.env[name] || fallback).trim();
  if (!value) return null;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`${name} 不是有效端口`);
  return port;
}

/** 生成远端原子下载和校验脚本；令牌只在本次加密 SSH 标准输入内存在。 */
function buildRemoteScript() {
  const rows = models.map((model) => `${model.versionId}|${model.fileName}|${model.sha256}|${model.byteSize}|${model.fallbackUrl || ""}`).join("\n");
  return `set -euo pipefail
MODEL_ROOT=/data/ComfyUI-master/models/diffusion_models
COMFY_URL=\${GPU_COMFYUI_URL:-http://127.0.0.1:8189}
CHECK_ONLY=${checkOnly ? "1" : "0"}
CIVITAI_API_TOKEN=${shellQuote(token)}
CIVITAI_PROXY_PORT=${remoteProxyPort || 0}
CURL_PROXY_ARGS=()
[ "$CIVITAI_PROXY_PORT" = 0 ] || CURL_PROXY_ARGS=(--proxy "http://127.0.0.1:$CIVITAI_PROXY_PORT")
mkdir -p "$MODEL_ROOT"
while IFS='|' read -r VERSION_ID FILE_NAME EXPECTED_SHA EXPECTED_SIZE FALLBACK_URL; do
  [ -n "$VERSION_ID" ] || continue
  TARGET="$MODEL_ROOT/$FILE_NAME"
  VALID=0
  if [ -f "$TARGET" ]; then
    ACTUAL_SIZE=$(stat -c %s "$TARGET")
    if [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ]; then
      ACTUAL_SHA=$(sha256sum "$TARGET" | awk '{print $1}')
      [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] && VALID=1
    fi
  fi
  if [ "$VALID" = 1 ]; then
    echo "[model-sync] verified $FILE_NAME"
    continue
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    echo "[model-sync] missing-or-invalid $FILE_NAME" >&2
    exit 2
  fi
  if [ -z "$CIVITAI_API_TOKEN" ] && [ -z "$FALLBACK_URL" ]; then
    echo "[model-sync] Civitai 登录令牌未配置，且该文件没有已校验的公开镜像：$FILE_NAME" >&2
    exit 3
  fi
  if [ -f "$TARGET" ]; then mv "$TARGET" "$TARGET.invalid.$(date +%Y%m%d%H%M%S)"; fi
  PART="$TARGET.part"
  if [ -n "$CIVITAI_API_TOKEN" ]; then
    DOWNLOAD_URL="https://civitai.com/api/download/models/$VERSION_ID"
    curl "\${CURL_PROXY_ARGS[@]}" --fail --location --connect-timeout 20 --retry 12 --retry-delay 5 --retry-all-errors --continue-at - \
      --header "Authorization: Bearer $CIVITAI_API_TOKEN" --output "$PART" "$DOWNLOAD_URL"
  else
    curl "\${CURL_PROXY_ARGS[@]}" --fail --location --connect-timeout 20 --retry 12 --retry-delay 5 --retry-all-errors --continue-at - \
      --output "$PART" "$FALLBACK_URL"
  fi
  ACTUAL_SIZE=$(stat -c %s "$PART")
  [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] || { echo "[model-sync] size mismatch $FILE_NAME expected=$EXPECTED_SIZE actual=$ACTUAL_SIZE" >&2; exit 4; }
  ACTUAL_SHA=$(sha256sum "$PART" | awk '{print $1}')
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || { echo "[model-sync] sha256 mismatch $FILE_NAME" >&2; exit 5; }
  chmod 0644 "$PART"
  mv "$PART" "$TARGET"
  echo "[model-sync] installed $FILE_NAME"
done <<'MODEL_ROWS'
${rows}
MODEL_ROWS
OBJECT_INFO=$(curl --fail --silent --show-error "$COMFY_URL/object_info/UNETLoader")
while IFS='|' read -r _ FILE_NAME _ _ _; do
  [ -z "$FILE_NAME" ] || grep -Fq "$FILE_NAME" <<<"$OBJECT_INFO" || { echo "[model-sync] ComfyUI 未识别 $FILE_NAME" >&2; exit 6; }
done <<'MODEL_ROWS'
${rows}
MODEL_ROWS
echo "[model-sync] all models ready"
`;
}

/** 将敏感值安全嵌入一次性 Bash 输入，避免命令注入。 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
