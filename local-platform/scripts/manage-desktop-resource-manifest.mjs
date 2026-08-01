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
else if (command === "add-anima-models") await addAnimaModels(argumentsMap);
else if (command === "add-component") await addComponent(argumentsMap);
else if (command === "add-runtime") await addRuntime(argumentsMap);
else if (command === "legacy-compatible") await createLegacyCompatibleManifest(argumentsMap);
else throw new Error("用法：generate --private-key PATH --public-key PATH；sign --payload PATH --private-key PATH --output PATH --key-id ID；normalize --payload PATH --output PATH；add-anima-models --payload PATH --output PATH；legacy-compatible --payload PATH --output PATH；add-runtime --payload PATH --metadata PATH --output PATH；或 add-component --payload PATH --output PATH --id ID --kind KIND --version VERSION --file-name NAME --byte-size BYTES --installed-size BYTES --sha256 HASH --root-directory NAME --required true|false");

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

/** 清除全部第三方下载地址，只保留每项资源的主站镜像并刷新清单有效期。 */
async function normalizeManifest(options) {
  const payloadPath = requiredPath(options, "payload");
  const outputPath = requiredPath(options, "output");
  const raw = JSON.parse(await readFile(payloadPath, "utf8"));
  if (!Array.isArray(raw.resources)) throw new Error("资源清单缺少 resources 数组");
  const resources = raw.resources.map((resource) => {
    if (!Array.isArray(resource.sources)) return resource;
    const source = resource.sources.find((candidate) => {
      try { const url = new URL(candidate.url); return candidate.kind === "mirror" && url.protocol === "https:" && url.hostname === "www.xanime.ink"; }
      catch { return false; }
    });
    if (!source) throw new Error(`资源 ${resource.id || "未知"} 没有可保留的主站镜像`);
    return { ...resource, sources: [source] };
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

/** 签名依赖清单只保留初始化必需的 Anima Base；其他底模由在线仓库目录分发。 */
async function addAnimaModels(options) {
  const payloadPath = requiredPath(options, "payload");
  const outputPath = requiredPath(options, "output");
  const raw = JSON.parse(await readFile(payloadPath, "utf8"));
  if (!Array.isArray(raw.resources)) throw new Error("资源清单缺少 resources 数组");
  const groups = animaModelGroupIds();
  // 无论输入清单来自哪个历史版本，都先移除全部仓库底模资源组，再只加入初始化底模。
  const retained = raw.resources.filter((resource) => !groups.includes(resource.modelRegistration?.groupId));
  const resources = [...retained, ...animaModelDefinitions().flatMap(buildAnimaModelResources)];
  const minimumExpiry = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
  const currentExpiry = new Date(raw.expiresAt);
  const candidate = { ...raw, generatedAt: new Date().toISOString(), expiresAt: currentExpiry > minimumExpiry ? currentExpiry.toISOString() : minimumExpiry.toISOString(), resources };
  const parsed = desktopResourceManifestPayloadSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`补齐 Anima 模型后的资源清单未通过契约校验：${parsed.error.issues[0]?.message || "未知字段错误"}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  process.stdout.write(`已收缩桌面初始化底模：${animaModelDefinitions().length} 个模型组合 · ${parsed.data.resources.length} 项资源\n`);
}

/** 以真实归档摘要向签名清单增加或替换一个按需桌面组件。 */
async function addComponent(options) {
  const payloadPath = requiredPath(options, "payload");
  const outputPath = requiredPath(options, "output");
  const id = requiredText(options, "id", /^[a-z0-9._-]{1,191}$/);
  const kind = requiredText(options, "kind", /^(captioner|segmenter|trainer)$/);
  const version = requiredText(options, "version", /^[a-zA-Z0-9._-]{1,191}$/);
  const fileName = requiredText(options, "file-name", /^[^\\/:*?"<>|]{1,255}$/);
  const rootDirectory = requiredText(options, "root-directory", /^[^\\/:*?"<>|]{1,255}$/);
  const sha256 = requiredText(options, "sha256", /^[a-f0-9]{64}$/);
  const byteSize = requiredPositiveInteger(options, "byte-size");
  const installedSize = requiredPositiveInteger(options, "installed-size");
  const requiredValue = options.get("required");
  if (!/^(true|false)$/.test(requiredValue || "")) throw new Error("--required 必须是 true 或 false");
  const raw = JSON.parse(await readFile(payloadPath, "utf8"));
  if (!Array.isArray(raw.resources)) throw new Error("资源清单缺少 resources 数组");
  const component = {
    id,
    kind,
    version,
    os: "windows",
    arch: "x86_64",
    fileName,
    byteSize,
    installedSize,
    sha256,
    archive: "zip",
    rootDirectory,
    installDirectory: null,
    modelRegistration: null,
    applicationUpdate: null,
    required: requiredValue === "true",
    sources: [{ kind: "mirror", url: `https://www.xanime.ink/local-model-api/v1/desktop/resources/${id}/content` }],
  };
  const minimumExpiry = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
  const currentExpiry = new Date(raw.expiresAt);
  const candidate = {
    ...raw,
    generatedAt: new Date().toISOString(),
    expiresAt: currentExpiry > minimumExpiry ? currentExpiry.toISOString() : minimumExpiry.toISOString(),
    resources: [...raw.resources.filter((resource) => resource.id !== id), component],
  };
  const parsed = desktopResourceManifestPayloadSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`组件资源未通过契约校验：${parsed.error.issues[0]?.message || "未知字段错误"}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  process.stdout.write(`已登记可选组件 ${id}：${outputPath}\n`);
}

/** 使用真实构建摘要增加或替换一个后端专属 Runtime，不接受手工省略能力字段。 */
async function addRuntime(options) {
  const payloadPath = requiredPath(options, "payload");
  const metadataPath = requiredPath(options, "metadata");
  const outputPath = requiredPath(options, "output");
  const raw = JSON.parse(await readFile(payloadPath, "utf8"));
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (!Array.isArray(raw.resources)) throw new Error("资源清单缺少 resources 数组");
  if (metadata.kind !== "runtime" || !metadata.runtimeProfile || !Array.isArray(metadata.compatibleBackends)) throw new Error("Runtime 构建摘要缺少后端 profile");
  const { upstream: _upstream, sources: _sources, ...runtime } = metadata;
  const item = { ...runtime, installDirectory: null, modelRegistration: null, applicationUpdate: null, sources: [{ kind: "mirror", url: `https://www.xanime.ink/local-model-api/v1/desktop/resources/${runtime.id}/content` }] };
  const minimumExpiry = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
  const currentExpiry = new Date(raw.expiresAt);
  const candidate = { ...raw, generatedAt: new Date().toISOString(), expiresAt: currentExpiry > minimumExpiry ? currentExpiry.toISOString() : minimumExpiry.toISOString(), resources: [...raw.resources.filter((resource) => resource.id !== item.id), item] };
  const parsed = desktopResourceManifestPayloadSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`Runtime 资源未通过契约校验：${parsed.error.issues[0]?.message || "未知字段错误"}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  process.stdout.write(`已登记 ${item.runtimeProfile.backend} Runtime：${outputPath}\n`);
}

/** 为不认识 Segmenter 枚举的旧客户端生成独立签名兼容载荷，不修改扩展清单。 */
async function createLegacyCompatibleManifest(options) {
  const payloadPath = requiredPath(options, "payload");
  const outputPath = requiredPath(options, "output");
  const raw = JSON.parse(await readFile(payloadPath, "utf8"));
  if (!Array.isArray(raw.resources)) throw new Error("资源清单缺少 resources 数组");
  const candidate = {
    ...raw,
    generatedAt: new Date().toISOString(),
    resources: raw.resources.filter((resource) => resource.kind !== "segmenter" && (!Array.isArray(resource.compatibleBackends) || resource.compatibleBackends.includes("nvidia_cuda"))).map(({ compatibleBackends: _compatibleBackends, runtimeProfile: _runtimeProfile, ...resource }) => resource),
  };
  const parsed = desktopResourceManifestPayloadSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`旧客户端兼容清单未通过契约校验：${parsed.error.issues[0]?.message || "未知字段错误"}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  process.stdout.write(`已生成旧客户端兼容清单：${parsed.data.resources.length} 项\n`);
}

/** 返回所有曾进入签名清单的底模组，用于确定性移除旧的可选仓库资源。 */
function animaModelGroupIds() {
  return [
    "model.anima-base-v10",
    "model.wai-anima-v10",
    "model.anime-bulldozer-anima",
    "model.miaomiao-realskin-anima11",
    "model.miaomiao-3d-harem-anima-lh3d10",
    "model.miaomiao-harem-anima8step10",
  ];
}

/** 返回已完成大小和 SHA-256 校验、由主站镜像分发的初始化底模定义。 */
function animaModelDefinitions() {
  return [
    { groupId: "model.anima-base-v10", id: "anima-base-v10", displayName: "Anima Base v1.0", version: "anima-base-v1.0", fileName: "anima-base-v1.0.safetensors", byteSize: 4_182_218_328, sha256: "bd43b7cffe1ed1153d9c41e7beb2f18cb1273eafbaa3af3edd6a173dc90a006e", required: true },
  ];
}

/** 为一个底模构造主文件、共享文本编码器与共享 VAE 三个可独立断点安装的资源。 */
function buildAnimaModelResources(model) {
  const shared = [
    { role: "text_encoder", suffix: "text-encoder", version: "anima-qwen3-0.6b", fileName: "qwen_3_06b_base.safetensors", byteSize: 1_192_135_096, sha256: "cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba", installDirectory: "text_encoders" },
    { role: "vae", suffix: "vae", version: "anima-qwen-image-vae", fileName: "qwen_image_vae.safetensors", byteSize: 253_806_246, sha256: "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f", installDirectory: "vae" },
  ];
  const primary = { role: "primary", suffix: "primary", version: model.version, fileName: model.fileName, byteSize: model.byteSize, sha256: model.sha256, installDirectory: "diffusion_models" };
  return [primary, ...shared].map((component) => {
    const id = `${model.groupId}.${component.suffix}`;
    return {
      id, kind: "model", version: component.version, os: "windows", arch: "x86_64", fileName: component.fileName,
      byteSize: component.byteSize, installedSize: component.byteSize, sha256: component.sha256, archive: "raw", rootDirectory: null,
      installDirectory: component.installDirectory,
      modelRegistration: { groupId: model.groupId, displayName: model.displayName, family: "anima", workflowKind: "anima", role: component.role },
      required: model.required === true,
      // 初始化底模与共享组件只从主站镜像下载，其他底模不进入客户端依赖清单。
      sources: [{ kind: "mirror", url: `https://www.xanime.ink/local-model-api/v1/desktop/resources/${id}/content` }],
    };
  });
}

/** 读取必填路径参数并转换为绝对路径。 */
function requiredPath(options, key) {
  const value = options.get(key)?.trim();
  if (!value) throw new Error(`缺少 --${key}`);
  return resolve(value);
}

/** 读取受格式约束的必填文本，禁止把任意路径或控制字符写入清单。 */
function requiredText(options, key, pattern) {
  const value = options.get(key)?.trim();
  if (!value || !pattern.test(value)) throw new Error(`--${key} 格式不正确`);
  return value;
}

/** 读取 JavaScript 安全整数范围内的正整数资源大小。 */
function requiredPositiveInteger(options, key) {
  const value = Number(options.get(key));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${key} 必须是正整数`);
  return value;
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
