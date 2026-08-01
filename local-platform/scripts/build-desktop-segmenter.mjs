/**
 * 本文件构建固定 rembg U2Net 与 ONNX Runtime 的按需离线抠图组件，产物需发布到主站镜像后才能进入签名清单。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const MODEL = {
  url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx",
  mirror: "https://gh-proxy.com/https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx",
  name: "u2net.onnx",
  size: 175_997_641,
  md5: "60024c5c889badc19c04ad937298a77b",
};
const ONNX_RUNTIME = {
  url: "https://files.pythonhosted.org/packages/5d/54/7139d463bb0a312890c9a5db87d7815d4a8cce9e6f5f28d04f0b55fcb160/onnxruntime-1.22.1-cp312-cp312-win_amd64.whl",
  name: "onnxruntime-1.22.1-cp312-cp312-win_amd64.whl",
  size: 12_690_910,
  sha256: "6a64291d57ea966a245f749eb970f4fa05a64d26672e05a83fdb5db6b7d62f87",
};

const options = parseArguments(process.argv.slice(2));
const cache = resolve(options.get("cache") || ".private/desktop-segmenter-cache");
const output = resolve(options.get("output") || ".private/desktop-resources/assets/drawhime-u2net-segmenter-win-x64.zip");
const root = resolve(options.get("staging") || ".private/desktop-segmenter-build");
const component = join(root, "drawhime-u2net-segmenter");
await rm(root, { recursive: true, force: true });
await mkdir(cache, { recursive: true });
await mkdir(join(component, "site-packages"), { recursive: true });
await obtain(MODEL, join(cache, MODEL.name), "md5");
await obtain(ONNX_RUNTIME, join(cache, ONNX_RUNTIME.name), "sha256");
await cp(resolve("deploy/desktop-segmenter/runner.py"), join(component, "runner.py"));
await cp(join(cache, MODEL.name), join(component, MODEL.name));
await run("tar.exe", ["-xf", join(cache, ONNX_RUNTIME.name), "-C", join(component, "site-packages")]);
await writeFile(join(component, "component-manifest.json"), `${JSON.stringify({ schemaVersion: 1, component: "segmenter", version: "u2net-rembg-1.0-ort-1.22.1", python: "3.12", model: { repository: "danielgatis/rembg", license: "MIT", file: MODEL.name, md5: MODEL.md5 }, runtime: { package: "onnxruntime", version: "1.22.1", license: "MIT" } }, null, 2)}\n`, "utf8");
await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await run("tar.exe", ["-a", "-cf", output, "-C", root, "drawhime-u2net-segmenter"]);
const metadata = await stat(output);
process.stdout.write(`${JSON.stringify({ fileName: output, byteSize: metadata.size, installedSize: await directorySize(component), sha256: await hashFile(output, "sha256"), rootDirectory: "drawhime-u2net-segmenter" }, null, 2)}\n`);

/** 解析无重复的 --key value 参数。 */
function parseArguments(values) { const result = new Map(); for (let index = 0; index < values.length; index += 2) { const key = values[index]; const value = values[index + 1]; if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`参数格式不正确：${key || "空"}`); if (result.has(key.slice(2))) throw new Error(`参数重复：${key}`); result.set(key.slice(2), value); } return result; }
/** 使用已验证镜像和官方地址断点获取固定资源，最终始终按上游公开摘要复核。 */
async function obtain(resource, target, algorithm) {
  if (await matches(target, resource, algorithm)) return;
  const partial = `${target}.part`;
  for (const url of [resource.mirror, resource.url].filter(Boolean)) {
    try {
      await download(url, partial, resource.size);
      if (await matches(partial, resource, algorithm)) {
        await rm(target, { force: true });
        await cp(partial, target);
        await rm(partial, { force: true });
        return;
      }
    } catch {}
  }
  throw new Error(`资源下载或校验失败：${resource.name}`);
}
/** 以 8MiB Range 下载，远端忽略续传范围时拒绝错误追加。 */
async function download(url, target, total) { await mkdir(dirname(target), { recursive: true }); let offset = await stat(target).then((value) => Math.min(value.size, total)).catch(() => 0); while (offset < total) { const end = Math.min(total - 1, offset + 8 * 1024 * 1024 - 1); const response = await fetch(url, { headers: { range: `bytes=${offset}-${end}`, "accept-encoding": "identity", "user-agent": "DrawHime-Desktop-Segmenter-Builder/1" }, redirect: "follow", signal: AbortSignal.timeout(60_000) }); const expected = end - offset + 1; const length = Number(response.headers.get("content-length") || 0); const full = offset === 0 && end === total - 1 && response.status === 200 && (!length || length === total); const ranged = response.status === 206 && (!length || length === expected) && response.headers.get("content-range") === `bytes ${offset}-${end}/${total}`; if ((!full && !ranged) || !response.body) throw new Error("上游 Range 响应不正确"); await pipeline(response.body, createWriteStream(target, { flags: offset ? "a" : "w" })); offset = end + 1; } }
/** 校验固定大小与指定摘要。 */
async function matches(path, resource, algorithm) { return stat(path).then(async (value) => value.isFile() && value.size === resource.size && await hashFile(path, algorithm) === resource[algorithm]).catch(() => false); }
/** 流式计算模型或归档摘要。 */
async function hashFile(path, algorithm) { const hash = createHash(algorithm); await pipeline(createReadStream(path), hash); return hash.digest("hex"); }
/** 递归统计安装体积。 */
async function directorySize(path) { const { readdir } = await import("node:fs/promises"); let total = 0; for (const entry of await readdir(path, { withFileTypes: true })) total += entry.isDirectory() ? await directorySize(join(path, entry.name)) : (await stat(join(path, entry.name))).size; return total; }
/** 运行受控本机构建命令并检查退出码。 */
async function run(command, args) { await new Promise((resolvePromise, reject) => { const child = spawn(command, args, { stdio: "inherit", windowsHide: true }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} 退出码 ${code}`))); }); }
