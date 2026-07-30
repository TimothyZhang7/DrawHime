/**
 * 本文件在真实 Windows 安装中通过 Tauri IPC 完成在线检查、断点下载、静默更新和重启终态验收。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const options = parseArguments(process.argv.slice(2));
const fromVersion = requiredOption(options, "from-version");
const toVersion = requiredOption(options, "to-version");
const evidencePath = path.resolve(options.get("evidence") || `.private/desktop-update-e2e-${fromVersion}-to-${toVersion}.json`);
const beforeInstallation = readInstallation();
if (beforeInstallation.version !== fromVersion) throw new Error(`更新前安装版本不正确：${beforeInstallation.version} != ${fromVersion}`);
const beforeProtectedData = await protectedDataSnapshot(beforeInstallation.dataRoot);

const first = await launchAndConnect(beforeInstallation.executable);
let available;
let downloaded;
let applying;
let applyRequested = false;
try {
  available = await invoke(first.client, "desktop_software_update_status");
  if (available.currentVersion !== fromVersion || available.latestVersion !== toVersion || available.status !== "available") throw new Error(`稳定通道未返回目标更新：${JSON.stringify(available)}`);
  downloaded = await invoke(first.client, "desktop_download_software_update");
  if (downloaded.currentVersion !== fromVersion || downloaded.latestVersion !== toVersion || downloaded.status !== "downloaded" || downloaded.downloadedBytes !== downloaded.byteSize) throw new Error(`在线更新下载未完成：${JSON.stringify(downloaded)}`);
  applying = await invoke(first.client, "desktop_apply_software_update");
  if (applying.status !== "applying" || applying.latestVersion !== toVersion) throw new Error(`更新没有进入应用状态：${JSON.stringify(applying)}`);
  applyRequested = true;
} finally {
  first.client.close();
  if (!applyRequested) terminateProcessTree(first.child.pid);
}
await waitForExit(first.child, 30_000);
const updatedInstallation = await waitForInstalledVersion(toVersion, 300_000);
const afterProtectedData = await protectedDataSnapshot(updatedInstallation.dataRoot);
if (JSON.stringify(afterProtectedData) !== JSON.stringify(beforeProtectedData)) throw new Error("在线更新改变了模型、Runtime、作品或训练数据目录");

const second = await launchAndConnect(updatedInstallation.executable);
let finalStatus;
try {
  finalStatus = await invoke(second.client, "desktop_software_update_status");
  if (finalStatus.currentVersion !== toVersion || finalStatus.latestVersion !== toVersion || finalStatus.status !== "up_to_date") throw new Error(`更新后状态未收敛：${JSON.stringify(finalStatus)}`);
} finally {
  second.client.close();
  terminateProcessTree(second.child.pid);
}

const evidence = {
  checkedAt: new Date().toISOString(),
  fromVersion,
  toVersion,
  channelState: { before: available.status, downloaded: downloaded.status, applying: applying.status, after: finalStatus.status },
  package: { byteSize: downloaded.byteSize, downloadedBytes: downloaded.downloadedBytes },
  protectedData: beforeProtectedData,
  gates: { signedChannelDetected: true, fullDownloadVerified: true, silentInstallerApplied: true, runningVersionConverged: true, protectedDataPreserved: true },
};
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`桌面在线更新端到端验收通过：${evidencePath}\n`);

/** 解析严格的成对命令行参数。 */
function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || parsed.has(key.slice(2))) throw new Error(`参数不正确：${key || "空"}`);
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

/** 返回必填版本参数并限制为三段数字。 */
function requiredOption(optionsMap, key) {
  const value = optionsMap.get(key)?.trim();
  if (!value || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`--${key} 必须是三段数字版本`);
  return value;
}

/** 从当前用户 NSIS 登记读取真实版本与安装目录。 */
function readInstallation() {
  const registryPath = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DrawHime Desktop";
  const result = spawnSync("reg.exe", ["query", registryPath], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("未找到 DrawHime Desktop 当前用户安装登记");
  const version = result.stdout.match(/DisplayVersion\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  const installRoot = result.stdout.match(/InstallLocation\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim().replace(/^"|"$/g, "");
  if (!version || !installRoot) throw new Error("DrawHime Desktop 安装登记不完整");
  return { version, installRoot, executable: path.join(installRoot, "drawhime-desktop.exe"), dataRoot: path.join(installRoot, "data") };
}

/** 对更新不应触碰的业务目录只统计文件数和字节数，不读取用户内容。 */
async function protectedDataSnapshot(dataRoot) {
  const result = {};
  for (const name of ["models", "runtime", "outputs", "datasets"]) result[name] = await directorySummary(path.join(dataRoot, name));
  return result;
}

/** 递归统计一个受保护目录，目录缺失时使用稳定零值。 */
async function directorySummary(root) {
  const rootState = await stat(root).catch(() => null);
  if (!rootState?.isDirectory()) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const metadata = await stat(path.join(entry.parentPath, entry.name));
    files += 1;
    bytes += metadata.size;
  }
  return { files, bytes };
}

/** 使用独立 WebView2 调试目录启动已安装客户端并连接真实页面。 */
async function launchAndConnect(executable) {
  const port = await reservePort();
  const browserData = path.join(process.env.TEMP || process.cwd(), `drawhime-update-e2e-${process.pid}-${port}`);
  const child = spawn(executable, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*`, WEBVIEW2_USER_DATA_FOLDER: browserData }, stdio: "ignore", windowsHide: true });
  try {
    const target = await waitForWebViewTarget(port, child);
    const client = await connectCdp(target.webSocketDebuggerUrl);
    await waitForTauriReady(client);
    return { child, client };
  } catch (error) {
    terminateProcessTree(child.pid);
    throw error;
  }
}

/** 页面导航完成后再开放 IPC，避免 WebView 初始重载期间取得空上下文。 */
async function waitForTauriReady(client) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate("typeof window.__TAURI_INTERNALS__?.invoke === 'function' && Boolean(document.querySelector('.desktop-shell'))")) return;
    } catch {
      // 首次 WebView 导航销毁执行上下文时继续等待新页面。
    }
    await delay(500);
  }
  throw new Error("45 秒内桌面 IPC 未就绪");
}

/** 通过页面内 Tauri IPC 调用真实桌面命令。 */
async function invoke(client, command) {
  return client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})`);
}

/** 临时分配本机调试端口。 */
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!address || typeof address === "string") throw new Error("未取得 WebView2 调试端口");
  return address.port;
}

/** 等待 WebView2 页面并同步监控桌面进程。 */
async function waitForWebViewTarget(port, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`桌面进程提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      const targets = response.ok ? await response.json() : [];
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // WebView2 尚未监听时继续有限轮询。
    }
    await delay(500);
  }
  throw new Error("60 秒内未取得 WebView2 调试目标");
}

/** 建立支持长时间更新下载的最小 CDP 客户端。 */
async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("连接 WebView2 调试通道超时")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolvePromise(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("连接 WebView2 调试通道失败")); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : await event.data.text());
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const command = (method, params) => new Promise((resolvePromise, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolvePromise, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(expression) {
      const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "桌面更新调用异常");
      return response.result.value;
    },
    close() { socket.close(); },
  };
}

/** 等待旧客户端主动退出，超时则终止并判定更新失败。 */
async function waitForExit(child, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (child.exitCode === null && Date.now() < deadline) await delay(250);
  if (child.exitCode === null) { terminateProcessTree(child.pid); throw new Error("应用更新后旧客户端未按时退出"); }
}

/** 等待 NSIS 原子替换完成并返回新安装登记。 */
async function waitForInstalledVersion(version, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const installation = readInstallation();
    if (installation.version === version) return installation;
    await delay(1000);
  }
  throw new Error(`安装登记在截止时间内未更新到 ${version}`);
}

/** Windows 下终止完整客户端进程树。 */
function terminateProcessTree(processId) {
  if (processId) spawnSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/** 统一低频轮询等待。 */
function delay(milliseconds) { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }
