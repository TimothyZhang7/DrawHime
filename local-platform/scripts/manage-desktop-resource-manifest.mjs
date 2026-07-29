/**
 * 本文件离线生成桌面资源 Ed25519 密钥并签署已通过共享契约校验的资源清单。
 */
import { desktopResourceManifestPayloadSchema } from "../packages/contracts/dist/index.js";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [command, ...rawArguments] = process.argv.slice(2);
const argumentsMap = parseArguments(rawArguments);

if (command === "generate") await generateSigningKey(argumentsMap);
else if (command === "sign") await signManifest(argumentsMap);
else if (command === "normalize") await normalizeManifest(argumentsMap);
else throw new Error("用法：generate --private-key PATH --public-key PATH；sign --payload PATH --private-key PATH --output PATH --key-id ID；或 normalize --payload PATH --output PATH");

/** 解析明确的 --key value 参数，拒绝遗漏值和重复键。 */
function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`参数格式不正确：${key || "空"}`);
    const normalized = key.slice(2);
    if (result.has(normalized)) throw new Error(`参数重复：${key}`);
    result.set(normalized, value);
  }
  return result;
}

/** 生成私钥 PEM 和桌面编译使用的 32 字节原始公钥 Base64，既有文件不会被覆盖。 */
async function generateSigningKey(options) {
  const privateKeyPath = requiredPath(options, "private-key");
  const publicKeyPath = requiredPath(options, "public-key");
  await ensureAbsent(privateKeyPath);
  await ensureAbsent(publicKeyPath);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const publicRaw = publicDer.subarray(publicDer.length - 32).toString("base64");
  await mkdir(dirname(privateKeyPath), { recursive: true });
  await mkdir(dirname(publicKeyPath), { recursive: true });
  await writeFile(privateKeyPath, privatePem, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(privateKeyPath, 0o600);
  await writeFile(publicKeyPath, `${publicRaw}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`已生成桌面资源签名密钥；公钥 ${publicRaw}\n`);
}

/** 校验、压缩并签署载荷，输出 API 可直接读取的签名信封。 */
async function signManifest(options) {
  const payloadPath = requiredPath(options, "payload");
  const privateKeyPath = requiredPath(options, "private-key");
  const outputPath = requiredPath(options, "output");
  const keyId = options.get("key-id")?.trim();
  if (!keyId || !/^[a-zA-Z0-9._-]{1,100}$/.test(keyId)) throw new Error("key-id 必须是 1–100 位字母、数字、点、下划线或短横线");
  const parsedPayload = desktopResourceManifestPayloadSchema.safeParse(JSON.parse(await readFile(payloadPath, "utf8")));
  if (!parsedPayload.success) throw new Error(`资源清单载荷未通过契约校验：${parsedPayload.error.issues[0]?.message || "未知字段错误"}`);
  const payload = JSON.stringify(parsedPayload.data);
  const privateKey = createPrivateKey(await readFile(privateKeyPath, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("资源签名私钥不是 Ed25519");
  const signature = sign(null, Buffer.from(payload), privateKey);
  const publicKey = createPublicKey(privateKey);
  if (!verify(null, Buffer.from(payload), publicKey, signature)) throw new Error("生成后的资源签名自检失败");
  const envelope = { keyId, payload, signature: signature.toString("base64") };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  process.stdout.write(`已签署资源清单：${outputPath}\n`);
}

/** 去除同一资源的重复来源 URL，优先保留镜像语义并刷新清单有效期。 */
async function normalizeManifest(options) {
  const payloadPath = requiredPath(options, "payload");
  const outputPath = requiredPath(options, "output");
  const raw = JSON.parse(await readFile(payloadPath, "utf8"));
  if (!Array.isArray(raw.resources)) throw new Error("资源清单缺少 resources 数组");
  const resources = raw.resources.map((resource) => {
    if (!Array.isArray(resource.sources)) return resource;
    const byUrl = new Map();
    for (const source of resource.sources) {
      const previous = byUrl.get(source.url);
      if (!previous || source.kind === "mirror") byUrl.set(source.url, source);
    }
    return { ...resource, sources: [...byUrl.values()] };
  });
  const minimumExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const currentExpiry = new Date(raw.expiresAt);
  const candidate = { ...raw, generatedAt: new Date().toISOString(), expiresAt: currentExpiry > minimumExpiry ? currentExpiry.toISOString() : minimumExpiry.toISOString(), resources };
  const parsed = desktopResourceManifestPayloadSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`规范化后的资源清单未通过契约校验：${parsed.error.issues[0]?.message || "未知字段错误"}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  process.stdout.write(`已规范化资源清单：${outputPath}\n`);
}

/** 读取必填路径参数并转换为绝对路径。 */
function requiredPath(options, key) {
  const value = options.get(key)?.trim();
  if (!value) throw new Error(`缺少 --${key}`);
  return resolve(value);
}

/** 密钥文件存在时停止，避免误覆盖仍在使用的发布密钥。 */
async function ensureAbsent(path) {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    return;
  }
  throw new Error(`文件已存在，未覆盖：${path}`);
}
