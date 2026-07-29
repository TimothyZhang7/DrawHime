/**
 * 本文件从固定官方来源下载并校验 WD14 与 ONNX Runtime，构建可进入签名资源清单的 Windows Captioner ZIP。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const MODEL = {
  url: "https://huggingface.co/SmilingWolf/wd-vit-tagger-v3/resolve/main/model.onnx",
  mirror: "https://hf-mirror.com/SmilingWolf/wd-vit-tagger-v3/resolve/main/model.onnx",
  name: "model.onnx",
  size: 378_536_310,
  sha256: "35f23693620b668f4d53fd3c62bf65e40af739bc52c7eb0fbc49258b58d065b6",
};
const TAGS = {
  url: "https://huggingface.co/SmilingWolf/wd-vit-tagger-v3/resolve/main/selected_tags.csv",
  mirror: "https://hf-mirror.com/SmilingWolf/wd-vit-tagger-v3/resolve/main/selected_tags.csv",
  name: "selected_tags.csv",
  size: 308_468,
  sha256: "298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217",
};
const ONNX_RUNTIME = {
  url: "https://files.pythonhosted.org/packages/5d/54/7139d463bb0a312890c9a5db87d7815d4a8cce9e6f5f28d04f0b55fcb160/onnxruntime-1.22.1-cp312-cp312-win_amd64.whl",
  name: "onnxruntime-1.22.1-cp312-cp312-win_amd64.whl",
  size: 12_690_910,
  sha256: "6a64291d57ea966a245f749eb970f4fa05a64d26672e05a83fdb5db6b7d62f87",
};

const options = parseArguments(process.argv.slice(2));
const cache = resolve(options.get("cache") || ".private/desktop-captioner-cache");
const output = resolve(options.get("output") || ".private/desktop-resources/assets/drawhime-wd-vit-tagger-v3-win-x64.zip");
const root = resolve(options.get("staging") || ".private/desktop-captioner-build");
const component = join(root, "drawhime-wd-vit-tagger-v3");

await rm(root, { recursive: true, force: true });
await mkdir(cache, { recursive: true });
await mkdir(join(component, "site-packages"), { recursive: true });
for (const resource of [MODEL, TAGS, ONNX_RUNTIME]) await obtain(resource, join(cache, resource.name));
await cp(resolve("deploy/desktop-captioner/runner.py"), join(component, "runner.py"));
await cp(join(cache, MODEL.name), join(component, MODEL.name));
await cp(join(cache, TAGS.name), join(component, TAGS.name));
await run("tar.exe", ["-xf", join(cache, ONNX_RUNTIME.name), "-C", join(component, "site-packages")]);
await writeFile(join(component, "component-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  component: "captioner",
  version: "wd-vit-tagger-v3-2.0-ort-1.22.1",
  python: "3.12",
  model: { repository: "SmilingWolf/wd-vit-tagger-v3", license: "Apache-2.0", file: MODEL.name, sha256: MODEL.sha256 },
  runtime: { package: "onnxruntime", version: "1.22.1", license: "MIT" },
}, null, 2)}\n`, "utf8");
await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await run("tar.exe", ["-a", "-cf", output, "-C", root, "drawhime-wd-vit-tagger-v3"]);
const metadata = await stat(output);
process.stdout.write(`${JSON.stringify({ fileName: output, byteSize: metadata.size, installedSize: await directorySize(component), sha256: await sha256(output), rootDirectory: "drawhime-wd-vit-tagger-v3" }, null, 2)}\n`);

/** 解析无重复的 --key value 参数。 */
function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`参数格式不正确：${key || "空"}`);
    if (result.has(key.slice(2))) throw new Error(`参数重复：${key}`);
    result.set(key.slice(2), value);
  }
  return result;
}

/** 使用断点续传依次尝试官方和镜像来源，完成后执行大小与整体哈希校验。 */
async function obtain(resource, target) {
  if (await matches(target, resource)) return;
  const partial = `${target}.part`;
  for (const url of [resource.url, resource.mirror].filter(Boolean)) {
    try {
      await download(url, partial, resource.size);
      if (await matches(partial, resource)) {
        await rm(target, { force: true });
        await cp(partial, target);
        await rm(partial, { force: true });
        return;
      }
    } catch {}
  }
  throw new Error(`资源下载或校验失败：${resource.name}`);
}

/** 以固定 8MiB Range 下载，远端忽略 Range 时拒绝追加整文件。 */
async function download(url, target, total) {
  await mkdir(dirname(target), { recursive: true });
  let offset = await stat(target).then((value) => Math.min(value.size, total)).catch(() => 0);
  while (offset < total) {
    const end = Math.min(total - 1, offset + 8 * 1024 * 1024 - 1);
    const response = await fetch(url, { headers: { range: `bytes=${offset}-${end}`, "accept-encoding": "identity", "user-agent": "DrawHime-Desktop-Builder/1" }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
    const expected = end - offset + 1;
    const declaredLength = Number(response.headers.get("content-length") || 0);
    const fullResponse = offset === 0 && end === total - 1 && response.status === 200 && (declaredLength === 0 || declaredLength === total);
    const rangeResponse = response.status === 206 && (declaredLength === 0 || declaredLength === expected) && response.headers.get("content-range") === `bytes ${offset}-${end}/${total}`;
    if ((!fullResponse && !rangeResponse) || !response.body) throw new Error("上游 Range 响应不正确");
    await pipeline(response.body, createWriteStream(target, { flags: offset ? "a" : "w" }));
    offset = end + 1;
  }
}

/** 校验固定大小与 SHA-256，缓存不可信时重新下载。 */
async function matches(path, resource) { return stat(path).then(async (value) => value.isFile() && value.size === resource.size && await sha256(path) === resource.sha256).catch(() => false); }
/** 流式计算文件 SHA-256。 */
async function sha256(path) { const hash = createHash("sha256"); await pipeline(createReadStream(path), hash); return hash.digest("hex"); }
/** 递归统计安装后文件总字节数。 */
async function directorySize(path) { const { readdir } = await import("node:fs/promises"); let total = 0; for (const entry of await readdir(path, { withFileTypes: true })) total += entry.isDirectory() ? await directorySize(join(path, entry.name)) : (await stat(join(path, entry.name))).size; return total; }
/** 运行 Windows 自带归档工具并保留明确退出码。 */
async function run(command, args) { await new Promise((resolvePromise, reject) => { const child = spawn(command, args, { stdio: "inherit", windowsHide: true }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} 退出码 ${code}`))); }); }
