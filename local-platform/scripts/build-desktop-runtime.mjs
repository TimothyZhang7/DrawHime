/**
 * 本文件从固定版本和官方 SHA-256 的 ComfyUI Windows 便携包构建可签名的 DrawHime Runtime ZIP。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, link, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const RELEASE = Object.freeze({
  runtimeVersion: "comfyui-v0.28.0-nvidia-cu126",
  comfyUiVersion: "v0.28.0",
  fileName: "ComfyUI_windows_portable_nvidia_cu126.7z",
  byteSize: 2034160963,
  sha256: "6af1b60b6a1fad780b07871e4ff356ac04a1807755ee13c6050e3ec3a4157cc0",
  url: "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.28.0/ComfyUI_windows_portable_nvidia_cu126.7z",
});

const options = parseArguments(process.argv.slice(2));
const outputRoot = resolve(options.get("output") || join(tmpdir(), "drawhime-runtime-build"));
const cacheRoot = resolve(options.get("cache") || join(outputRoot, "cache"));
const sourceArchive = join(cacheRoot, RELEASE.fileName);
const outputArchive = join(outputRoot, `drawhime-runtime-${RELEASE.runtimeVersion}-x86_64.7z`);
const metadataPath = `${outputArchive}.json`;

await mkdir(outputRoot, { recursive: true });
await mkdir(cacheRoot, { recursive: true });
await downloadAndVerifySource(sourceArchive);
const staging = await mkdtemp(join(outputRoot, ".runtime-build-"));
try {
  run("C:\\Windows\\System32\\tar.exe", ["-xf", sourceArchive, "-C", staging]);
  const runtimeRoot = await locateRuntimeRoot(staging);
  await verifyRuntimeFiles(runtimeRoot);
  const installedSize = await directorySize(runtimeRoot);
  const temporaryArchive = `${outputArchive}.part`;
  await removeInside(outputRoot, temporaryArchive);
  try { await link(sourceArchive, temporaryArchive); } catch { await copyFile(sourceArchive, temporaryArchive); }
  const archiveMetadata = await stat(temporaryArchive);
  const archiveSha256 = await sha256File(temporaryArchive);
  await removeInside(outputRoot, outputArchive);
  await rename(temporaryArchive, outputArchive);
  const metadata = {
    id: "runtime.comfyui.nvidia-cu126",
    kind: "runtime",
    version: RELEASE.runtimeVersion,
    os: "windows",
    arch: "x86_64",
    fileName: basename(outputArchive),
    byteSize: archiveMetadata.size,
    installedSize,
    sha256: archiveSha256,
    archive: "7z",
    rootDirectory: "ComfyUI_windows_portable",
    required: true,
    upstream: RELEASE,
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  process.stdout.write(`Runtime 构建完成：${outputArchive}\nSHA-256：${archiveSha256}\n`);
} finally {
  await removeInside(outputRoot, staging);
}

/** 解析 --key value 参数。 */
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

/** 使用 curl 断点下载固定官方资产，并同时校验大小和 GitHub 发布摘要。 */
async function downloadAndVerifySource(path) {
  if (await fileMatches(path, RELEASE.byteSize, RELEASE.sha256)) return;
  run("C:\\Windows\\System32\\curl.exe", ["--location", "--fail", "--retry", "5", "--retry-delay", "3", "--continue-at", "-", "--output", path, RELEASE.url]);
  if (!await fileMatches(path, RELEASE.byteSize, RELEASE.sha256)) throw new Error("ComfyUI 官方资产大小或 SHA-256 校验失败");
}

/** 定位官方便携包内唯一的 Runtime 根目录。 */
async function locateRuntimeRoot(staging) {
  const expected = join(staging, "ComfyUI_windows_portable");
  if (await exists(join(expected, "ComfyUI", "main.py"))) return expected;
  const children = await readdir(staging, { withFileTypes: true });
  const candidates = children.filter((entry) => entry.isDirectory()).map((entry) => join(staging, entry.name));
  for (const candidate of candidates) if (await exists(join(candidate, "ComfyUI", "main.py"))) return candidate;
  throw new Error("官方便携包内未找到 ComfyUI Runtime 根目录");
}

/** 确认便携 Python 和 ComfyUI 入口真实存在。 */
async function verifyRuntimeFiles(root) {
  for (const path of [join(root, "python_embeded", "python.exe"), join(root, "ComfyUI", "main.py")]) {
    if (!await exists(path)) throw new Error(`Runtime 缺少必需文件：${relative(root, path)}`);
  }
}

/** 递归计算安装后真实文件字节数，不跟随目录链接。 */
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

/** 流式计算大文件 SHA-256。 */
function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

/** 检查既有缓存是否可以直接复用。 */
async function fileMatches(path, byteSize, sha256) {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size === byteSize && await sha256File(path) === sha256;
  } catch {
    return false;
  }
}

/** 执行受控外部工具并继承进度输出。 */
function run(command, argumentsList) {
  const result = spawnSync(command, argumentsList, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} 执行失败，退出码 ${result.status}`);
}

/** 仅删除明确位于构建目录内的临时或输出路径。 */
async function removeInside(root, path) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (normalizedPath === normalizedRoot || !normalizedPath.startsWith(`${normalizedRoot}${sep}`)) throw new Error(`拒绝清理构建目录外路径：${normalizedPath}`);
  await rm(normalizedPath, { recursive: true, force: true });
}

/** 判断文件是否存在。 */
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
