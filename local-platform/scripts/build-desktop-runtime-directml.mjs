/**
 * 本文件从固定官方 ComfyUI 归档构建隔离的 AMD DirectML Runtime，并输出真实可签名摘要。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SOURCE = Object.freeze({
  comfyUiVersion: "v0.28.0",
  fileName: "ComfyUI_windows_portable_nvidia_cu126.7z",
  byteSize: 2_034_160_963,
  sha256: "6af1b60b6a1fad780b07871e4ff356ac04a1807755ee13c6050e3ec3a4157cc0",
  url: "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.28.0/ComfyUI_windows_portable_nvidia_cu126.7z",
});
const RELEASE = Object.freeze({
  resourceId: "runtime.comfyui.amd-directml",
  runtimeVersion: "comfyui-v0.28.0-amd-directml-anima-fp32.1",
  torchVersion: "2.4.1",
  torchvisionVersion: "0.19.1",
  torchDirectMlVersion: "0.2.5.dev240914",
});
const WINDOWS_PYTHON_DEPENDENCIES = Object.freeze([
  "filelock==3.15.4",
  "typing-extensions==4.12.2",
  "sympy==1.13.1",
  "networkx==3.3",
  "jinja2==3.1.4",
  "fsspec==2024.6.1",
  "numpy==1.26.4",
  "pillow==10.4.0",
  "MarkupSafe==2.1.5",
  "mpmath==1.3.0",
]);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const options = parseArguments(process.argv.slice(2));
const windowsBuildHost = process.platform === "win32";
const outputRoot = resolve(options.get("output") || join(tmpdir(), "drawhime-runtime-directml-build"));
const cacheRoot = resolve(options.get("cache") || join(outputRoot, "cache"));
const sourceArchive = join(cacheRoot, SOURCE.fileName);
const outputArchive = join(outputRoot, `drawhime-runtime-${RELEASE.runtimeVersion}-x86_64.7z`);

await mkdir(outputRoot, { recursive: true });
await mkdir(cacheRoot, { recursive: true });
await downloadAndVerifySource(sourceArchive);
const sevenZip = locateSevenZip(options.get("seven-zip"));
const staging = await mkdtemp(join(outputRoot, ".directml-build-"));
try {
  run(sevenZip, ["x", "-y", `-o${staging}`, sourceArchive]);
  const runtimeRoot = await locateRuntimeRoot(staging);
  await removeCudaPythonPackages(runtimeRoot);
  await installDirectMlDependencies(runtimeRoot);
  await assertNoCudaPythonPackages(runtimeRoot);
  await cp(join(scriptRoot, "runtime", "directml_runner.py"), join(runtimeRoot, "directml_runner.py"));
  // 官方便携包中的 Python 源码使用 CRLF，Linux 构建机需忽略行尾空白差异再应用同一补丁。
  run(windowsBuildHost ? "git.exe" : "git", ["apply", "--ignore-space-change", "--unsafe-paths", join(scriptRoot, "runtime", "predict2-directml.patch")], runtimeRoot);
  await verifyRuntime(runtimeRoot);
  await writeFile(join(runtimeRoot, "directml-build-profile.json"), `${JSON.stringify({ schemaVersion: 1, ...RELEASE, source: SOURCE, launchProfile: ["--directml", "0", "--cpu-vae", "--fp32-unet", "--use-split-cross-attention"] }, null, 2)}\n`, "utf8");
  const temporaryArchive = `${outputArchive}.part`;
  await removeInside(outputRoot, temporaryArchive);
  run(sevenZip, ["a", "-t7z", "-mx=7", "-mmt=on", temporaryArchive, basename(runtimeRoot)], dirname(runtimeRoot));
  const archiveMetadata = await stat(temporaryArchive);
  const installedSize = await directorySize(runtimeRoot);
  const archiveSha256 = await sha256File(temporaryArchive);
  await removeInside(outputRoot, outputArchive);
  await rename(temporaryArchive, outputArchive);
  const metadata = {
    id: RELEASE.resourceId,
    kind: "runtime",
    version: RELEASE.runtimeVersion,
    os: "windows",
    arch: "x86_64",
    fileName: basename(outputArchive),
    byteSize: archiveMetadata.size,
    installedSize,
    sha256: archiveSha256,
    archive: "7z",
    rootDirectory: basename(runtimeRoot),
    compatibleBackends: ["amd_directml"],
    runtimeProfile: {
      backend: "amd_directml",
      launchProfile: "anima-directml-fp32",
      pythonExecutable: "python_embeded/python.exe",
      entrypoint: "directml_runner.py",
      capabilities: { inference: true, training: false, cpuVaeRequired: true, fp32UnetRequired: true, maxValidatedEdge: 512, maxValidatedBatch: 1, maxValidatedLoras: 1 },
    },
    required: true,
    upstream: { ...SOURCE, torch: RELEASE.torchVersion, torchvision: RELEASE.torchvisionVersion, torchDirectMl: RELEASE.torchDirectMlVersion },
  };
  await writeFile(`${outputArchive}.json`, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  process.stdout.write(`AMD DirectML Runtime 构建完成：${outputArchive}\nSHA-256：${archiveSha256}\n`);
} finally {
  await removeInside(outputRoot, staging);
}

/** 解析明确的构建参数。 */
function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`参数格式不正确：${key || "空"}`);
    result.set(key.slice(2), value);
  }
  return result;
}

/** 固定官方归档必须同时匹配大小和 SHA-256。 */
async function downloadAndVerifySource(path) {
  if (await fileMatches(path, SOURCE.byteSize, SOURCE.sha256)) return;
  run(windowsBuildHost ? "C:\\Windows\\System32\\curl.exe" : "curl", ["--location", "--fail", "--retry", "5", "--retry-delay", "3", "--continue-at", "-", "--output", path, SOURCE.url]);
  if (!await fileMatches(path, SOURCE.byteSize, SOURCE.sha256)) throw new Error("ComfyUI 官方资产大小或 SHA-256 校验失败");
}

/** 定位官方便携 Runtime 根目录。 */
async function locateRuntimeRoot(staging) {
  const expected = join(staging, "ComfyUI_windows_portable");
  if (await exists(join(expected, "ComfyUI", "main.py"))) return expected;
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    const candidate = join(staging, entry.name);
    if (entry.isDirectory() && await exists(join(candidate, "ComfyUI", "main.py"))) return candidate;
  }
  throw new Error("官方便携包内未找到 ComfyUI Runtime 根目录");
}

/** 删除基础归档中的 CUDA torch 包，DirectML 依赖保持完全隔离。 */
async function removeCudaPythonPackages(runtimeRoot) {
  const sitePackages = join(runtimeRoot, "python_embeded", "Lib", "site-packages");
  for (const entry of await readdir(sitePackages, { withFileTypes: true })) {
    const lower = entry.name.toLowerCase();
    if (isCudaPythonPackage(lower) || ["torch", "torchvision", "torchaudio"].some((name) => lower === name || lower.startsWith(`${name}-`))) {
      await rm(join(sitePackages, entry.name), { recursive: true, force: true });
    }
  }
}

/** 构建后拒绝基础 CUDA 便携包残留的 NVIDIA、Triton 或 xFormers Python 组件。 */
async function assertNoCudaPythonPackages(runtimeRoot) {
  const sitePackages = join(runtimeRoot, "python_embeded", "Lib", "site-packages");
  const leftovers = (await readdir(sitePackages)).filter((name) => isCudaPythonPackage(name.toLowerCase()));
  if (leftovers.length) throw new Error(`DirectML Runtime 仍包含 CUDA 专用 Python 组件：${leftovers.join(", ")}`);
}

function isCudaPythonPackage(name) {
  return ["nvidia", "nvidia_", "nvidia-", "triton", "triton_", "triton-", "pytorch_triton", "xformers", "xformers-", "flash_attn", "flash-attn"].some((prefix) => name === prefix || name.startsWith(prefix));
}

/** 使用便携 Python 安装与实测一致的 DirectML 依赖版本。 */
async function installDirectMlDependencies(runtimeRoot) {
  const target = join(runtimeRoot, "directml-site");
  await mkdir(target, { recursive: true });
  const packages = [`torch==${RELEASE.torchVersion}`, `torchvision==${RELEASE.torchvisionVersion}`, `torch-directml==${RELEASE.torchDirectMlVersion}`];
  if (windowsBuildHost) {
    const python = join(runtimeRoot, "python_embeded", "python.exe");
    run(python, ["-s", "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--timeout", "120", "--retries", "10", "--target", target, ...packages], runtimeRoot);
    return;
  }
  // Linux 构建机只解析并展开 Windows CPython 3.12 二进制轮子，不执行目标平台代码。
  run(options.get("host-python") || "python3", ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-compile", "--timeout", "120", "--retries", "10", "--no-deps", "--only-binary=:all:", "--platform", "win_amd64", "--implementation", "cp", "--python-version", "3.12", "--abi", "cp312", "--target", target, ...packages, ...WINDOWS_PYTHON_DEPENDENCIES], runtimeRoot);
}

/** 构建后确认入口、隔离 torch 和两处 Anima 补丁真实存在。 */
async function verifyRuntime(runtimeRoot) {
  for (const path of [join(runtimeRoot, "python_embeded", "python.exe"), join(runtimeRoot, "directml_runner.py"), join(runtimeRoot, "directml-site", "torch", "__init__.py"), join(runtimeRoot, "directml-site", "torch_directml", "__init__.py"), join(runtimeRoot, "ComfyUI", "main.py")]) {
    if (!await exists(path)) throw new Error(`DirectML Runtime 缺少必需文件：${relative(runtimeRoot, path)}`);
  }
  const predict = await readFile(join(runtimeRoot, "ComfyUI", "comfy", "ldm", "cosmos", "predict2.py"), "utf8");
  if (!predict.includes("directml_apply_rope_split_half1") || !predict.includes("padding_mask.repeat(1, x_B_C_T_H_W.shape[2], 1, 1).unsqueeze(1)")) throw new Error("Anima DirectML 补丁未正确应用");
}

/** 优先使用显式 7-Zip，其次使用标准安装目录。 */
function locateSevenZip(configured) {
  const candidates = windowsBuildHost
    ? [configured, "C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe"]
    : [configured, "7zz", "7z"];
  const selected = candidates.find((candidate) => spawnSync(candidate, ["i"], { stdio: "ignore", windowsHide: true }).status === 0);
  if (!selected) throw new Error("构建机缺少 7-Zip；请安装后通过 --seven-zip 指定 7z.exe");
  return selected;
}

/** 执行受控构建命令并继承进度。 */
function run(command, argumentsList, cwd) {
  const result = spawnSync(command, argumentsList, { cwd, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} 执行失败，退出码 ${result.status}`);
}

/** 递归计算安装后真实大小，不跟随链接。 */
async function directorySize(root) {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime 包含链接：${relative(root, path)}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) total += (await stat(path)).size;
    }
  }
  return total;
}

/** 流式计算文件 SHA-256。 */
function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function fileMatches(path, byteSize, sha256) {
  try { const metadata = await stat(path); return metadata.isFile() && metadata.size === byteSize && await sha256File(path) === sha256; }
  catch { return false; }
}

/** 仅清理明确位于构建目录内的临时内容。 */
async function removeInside(root, path) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath === normalizedRoot || !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) throw new Error(`拒绝清理构建目录外路径：${normalizedPath}`);
  await rm(normalizedPath, { recursive: true, force: true });
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }
