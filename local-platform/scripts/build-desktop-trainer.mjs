/**
 * 本文件构建固定 sd-scripts 修订和 Windows CPython 3.12 依赖的签名 Trainer ZIP，用户端只需下载并安装。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const REVISION = "37a1cbbc5725ed2a3575506e7bd2001c9908ac92";
const SOURCE = {
  url: `https://github.com/kohya-ss/sd-scripts/archive/${REVISION}.zip`,
  mirror: `https://gh-proxy.com/https://github.com/kohya-ss/sd-scripts/archive/${REVISION}.zip`,
  name: `sd-scripts-${REVISION}.zip`,
  size: 6_494_388,
  sha256: "10673b1526b0b2854848fc9146439fc16ab77e6efcd74fddd867c08d2f0a511c",
};
const PACKAGES = [
  "accelerate==1.6.0", "transformers==4.54.1", "diffusers==0.32.1", "ftfy==6.3.1",
  "opencv-python==4.10.0.84", "einops==0.7.0", "bitsandbytes==0.45.5", "lion-pytorch==0.2.3",
  "schedulefree==1.4.1", "pytorch-optimizer==3.10.0", "prodigy-plus-schedule-free==1.9.2", "prodigyopt==1.1.2",
  "tensorboard==2.19.0", "toml==0.10.2", "voluptuous==0.15.2", "huggingface-hub==0.34.3",
  "imagesize==1.4.1", "rich==14.1.0", "sentencepiece==0.2.1", "safetensors==0.4.5",
  "psutil==7.0.0", "PyYAML==6.0.2", "filelock==3.18.0", "regex==2024.11.6", "requests==2.32.4",
  "packaging==25.0", "tokenizers==0.21.4", "tqdm==4.67.1", "pillow==11.3.0", "wcwidth==0.2.13",
  "absl-py==2.3.1", "grpcio==1.73.1", "Markdown==3.8.2", "protobuf==6.31.1",
  "tensorboard-data-server==0.7.2", "Werkzeug==3.1.3", "MarkupSafe==3.0.2", "markdown-it-py==4.0.0",
  "mdurl==0.1.2", "Pygments==2.19.2", "typing-extensions==4.14.1",
];

const options = parseArguments(process.argv.slice(2));
const python = options.get("python") || "python";
const cache = resolve(options.get("cache") || ".private/desktop-trainer-cache");
const output = resolve(options.get("output") || ".private/desktop-resources/assets/drawhime-anima-trainer-win-x64.zip");
const staging = resolve(options.get("staging") || ".private/desktop-trainer-build");
const component = join(staging, "drawhime-anima-trainer");
const packageRoot = join(component, "site-packages");

await rm(staging, { recursive: true, force: true });
await mkdir(cache, { recursive: true });
await mkdir(component, { recursive: true });
const sourceArchive = join(cache, SOURCE.name);
await obtain(SOURCE, sourceArchive);
const sourceExtract = join(staging, "source");
await mkdir(sourceExtract, { recursive: true });
await run("tar.exe", ["-xf", sourceArchive, "-C", sourceExtract]);
const sourceDirectories = (await readdir(sourceExtract, { withFileTypes: true })).filter((entry) => entry.isDirectory());
if (sourceDirectories.length !== 1) throw new Error("sd-scripts 归档根目录结构不正确");
await rename(join(sourceExtract, sourceDirectories[0].name), join(component, "sd-scripts"));
await rm(sourceExtract, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });
await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-compile", "--only-binary=:all:", "--platform", "win_amd64", "--implementation", "cp", "--python-version", "3.12", "--no-deps", "--target", packageRoot, ...PACKAGES]);
await cp(resolve("deploy/desktop-trainer/runner.py"), join(component, "runner.py"));
await writeFile(join(component, "component-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  component: "trainer",
  version: `anima-sd-scripts-${REVISION.slice(0, 12)}-py312-v1`,
  runtimePython: "3.12",
  source: { repository: "kohya-ss/sd-scripts", revision: REVISION, license: "Apache-2.0", sha256: SOURCE.sha256 },
  packages: PACKAGES,
}, null, 2)}\n`, "utf8");
await verifyComponent(component);
await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await run("tar.exe", ["-a", "-cf", output, "-C", staging, "drawhime-anima-trainer"]);
const metadata = await stat(output);
process.stdout.write(`${JSON.stringify({ fileName: output, byteSize: metadata.size, installedSize: await directorySize(component), sha256: await sha256(output), rootDirectory: "drawhime-anima-trainer" }, null, 2)}\n`);

/** 解析无重复的 --key value 参数。 */
function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`参数格式不正确：${key || "空"}`);
    if (result.has(key.slice(2))) throw new Error(`参数重复：${key}`);
    result.set(key.slice(2), value);
  }
  return result;
}

/** 使用断点续传依次尝试官方和镜像，并执行固定大小与 SHA-256 校验。 */
async function obtain(resource, target) {
  if (await matches(target, resource)) return;
  const partial = `${target}.part`;
  for (const url of [resource.url, resource.mirror]) {
    try {
      await download(url, partial, resource.size);
      if (await matches(partial, resource)) { await rm(target, { force: true }); await cp(partial, target); await rm(partial, { force: true }); return; }
    } catch { /* 当前来源失败后按用户可理解的同一镜像策略切换。 */ }
  }
  throw new Error(`资源下载或校验失败：${resource.name}`);
}

/** 以固定 8MiB Range 下载，远端忽略 Range 时拒绝错误追加。 */
async function download(url, target, total) {
  await mkdir(dirname(target), { recursive: true });
  let offset = await stat(target).then((value) => Math.min(value.size, total)).catch(() => 0);
  while (offset < total) {
    const end = Math.min(total - 1, offset + 8 * 1024 * 1024 - 1);
    const response = await fetch(url, { headers: { range: `bytes=${offset}-${end}`, "accept-encoding": "identity", "user-agent": "DrawHime-Desktop-Trainer-Builder/1" }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
    const expected = end - offset + 1; const declaredLength = Number(response.headers.get("content-length") || 0);
    const full = offset === 0 && end === total - 1 && response.status === 200 && (!declaredLength || declaredLength === total);
    const ranged = response.status === 206 && (!declaredLength || declaredLength === expected) && response.headers.get("content-range") === `bytes ${offset}-${end}/${total}`;
    if ((!full && !ranged) || !response.body) throw new Error("上游 Range 响应不正确");
    await pipeline(response.body, createWriteStream(target, { flags: offset ? "a" : "w" })); offset = end + 1;
  }
}

/** 确认 Trainer 关键入口和 Anima 网络模块真实存在。 */
async function verifyComponent(root) {
  for (const path of [join(root, "runner.py"), join(root, "sd-scripts/anima_train_network.py"), join(root, "sd-scripts/networks/lora_anima.py"), join(root, "site-packages/accelerate/__init__.py"), join(root, "site-packages/bitsandbytes/__init__.py")]) {
    if (!(await stat(path).then((value) => value.isFile()).catch(() => false))) throw new Error(`Trainer 缺少必需文件：${path}`);
  }
  const source = await readFile(join(root, "sd-scripts/anima_train_network.py"), "utf8");
  if (!source.includes("AnimaNetworkTrainer")) throw new Error("Trainer 的 Anima 入口结构不正确");
}

/** 校验缓存固定大小与哈希。 */
async function matches(path, resource) { return stat(path).then(async (value) => value.isFile() && value.size === resource.size && await sha256(path) === resource.sha256).catch(() => false); }
/** 流式计算文件 SHA-256。 */
async function sha256(path) { const hash = createHash("sha256"); await pipeline(createReadStream(path), hash); return hash.digest("hex"); }
/** 递归统计安装后字节数。 */
async function directorySize(path) { let total = 0; for (const entry of await readdir(path, { withFileTypes: true })) total += entry.isDirectory() ? await directorySize(join(path, entry.name)) : (await stat(join(path, entry.name))).size; return total; }
/** 运行受控构建命令并保留真实退出码。 */
async function run(command, args) { await new Promise((resolvePromise, reject) => { const child = spawn(command, args, { stdio: "inherit", windowsHide: true }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} 退出码 ${code}`))); }); }
