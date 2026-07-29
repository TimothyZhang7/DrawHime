/**
 * 本文件通过本机 WebView2 调试协议验证桌面环境横幅、能力锁定和核心提交门禁，不读取用户业务数据。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const argumentsMap = parseArguments(process.argv.slice(2));
const executable = requiredArgument(argumentsMap, "executable");
const evidencePath = argumentsMap.get("evidence") || null;
const expectNoGpu = argumentsMap.has("expect-no-gpu");
const port = await reservePort();
const userDataDirectory = path.join(process.env.TEMP || process.cwd(), `drawhime-webview-probe-${process.pid}-${port}`);
const additionalArguments = [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"].join(" ");
const child = spawn(executable, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: additionalArguments, WEBVIEW2_USER_DATA_FOLDER: userDataDirectory },
  stdio: "ignore",
  windowsHide: false,
});

try {
  const target = await waitForWebViewTarget(port, child);
  const client = await connectCdp(target.webSocketDebuggerUrl);
  try {
    const result = await evaluateAfterInitialReload(client, buildProbeExpression());
    validateProbe(result, expectNoGpu);
    const evidence = {
      checkedAt: new Date().toISOString(),
      targetTitle: result.documentTitle,
      environmentStatus: result.environmentStatus,
      inferenceReady: result.inferenceReady,
      trainingReady: result.trainingReady,
      bannerText: result.bannerText,
      navigationPages: result.navigationPages,
      coreSubmissionBlocked: result.coreSubmissionError.includes("本地生成当前不可用"),
    };
    if (evidencePath) {
      await mkdir(path.dirname(path.resolve(evidencePath)), { recursive: true });
      await writeFile(path.resolve(evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`桌面 WebView UI 验收通过：${JSON.stringify(evidence)}\n`);
  } finally {
    client.close();
  }
} finally {
  terminateProcessTree(child.pid);
  await removeUserDataDirectory(userDataDirectory);
}

/** 解析严格的 --key value 与布尔参数，未知位置参数直接拒绝。 */
function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`无法识别参数：${value}`);
    const key = value.slice(2);
    if (key === "expect-no-gpu") parsed.set(key, "true");
    else {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`参数 --${key} 缺少值`);
      parsed.set(key, next);
      index += 1;
    }
  }
  return parsed;
}

/** 返回必填参数，避免探针静默使用错误程序。 */
function requiredArgument(argumentsMap, key) {
  const value = argumentsMap.get(key);
  if (!value) throw new Error(`缺少 --${key}`);
  return value;
}

/** 临时绑定回环端口后立即释放，减少与其他 Runner 进程冲突。 */
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("未取得 WebView2 调试端口");
  return address.port;
}

/** 等待真实 WebView 页面发布 CDP 地址，同时监控桌面进程是否提前退出。 */
async function waitForWebViewTarget(port, childProcess) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (childProcess.exitCode !== null) throw new Error(`桌面进程提前退出，退出码 ${childProcess.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (target) return target;
      }
    } catch {
      // WebView2 启动期间端口尚未监听属于预期状态，持续到总截止时间。
    }
    await delay(500);
  }
  throw new Error("45 秒内未取得 WebView2 调试目标");
}

/** 建立最小 CDP 客户端，只开放本次 UI 验收需要的 Runtime.evaluate。 */
async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("连接 WebView2 调试通道超时")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("连接 WebView2 调试通道失败")); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", async (event) => {
    const text = typeof event.data === "string" ? event.data : await event.data.text();
    const message = JSON.parse(text);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const command = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(expression) {
      const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "WebView 探针执行异常");
      return response.result.value;
    },
    close() { socket.close(); },
  };
}

/** 在真实 React 页面中遍历全部导航，检查横幅与只读能力状态，并验证核心提交门禁。 */
function buildProbeExpression() {
  return String.raw`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const deadline = Date.now() + 30000;
    while (!document.querySelector('.desktop-shell') && Date.now() < deadline) await delay(250);
    const shell = document.querySelector('.desktop-shell');
    if (!shell) throw new Error('桌面工作区未完成加载');
    const navigationPages = [];
    for (const button of document.querySelectorAll('.desktop-sidebar nav button')) {
      button.click();
      await delay(50);
      const banner = document.querySelector('.environment-banner');
      navigationPages.push({ label: button.textContent.trim(), bannerVisible: Boolean(banner && banner.getClientRects().length) });
    }
    let coreSubmissionError = '';
    try {
      await window.__TAURI_INTERNALS__.invoke('desktop_create_local_job', { input: {
        modelId: 'ui-no-gpu-probe', prompt: 'ui gate probe', negativePrompt: null,
        width: 1024, height: 1024, steps: 1, cfg: 1, samplerName: 'euler',
        schedulerName: 'normal', seed: 1, loras: [], privacy: 'private'
      }});
    } catch (error) { coreSubmissionError = String(error); }
    const banner = document.querySelector('.environment-banner');
    return {
      environmentStatus: shell.dataset.environmentStatus || '',
      documentTitle: document.title,
      inferenceReady: shell.dataset.inferenceReady === 'true',
      trainingReady: shell.dataset.trainingReady === 'true',
      bannerText: banner?.textContent?.trim() || '',
      navigationPages,
      coreSubmissionError,
    };
  })()`;
}

/** WebView2 首次建立独立用户目录时可能发生一次页面重载，只对该瞬态错误进行有限重试。 */
async function evaluateAfterInitialReload(client, expression) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { return await client.evaluate(expression); }
    catch (error) {
      lastError = error;
      if (!String(error).includes("Execution context was destroyed")) throw error;
      await delay(500);
    }
  }
  throw lastError || new Error("WebView 初始页面未稳定");
}

/** 对无 GPU Runner 执行强门禁；其他硬件仍至少要求导航横幅状态一致。 */
function validateProbe(result, expectNoGpu) {
  if (!result || !Array.isArray(result.navigationPages) || result.navigationPages.length !== 12) throw new Error("桌面导航页数量或探针结果异常");
  if (result.environmentStatus !== "ready" && result.navigationPages.some((item) => !item.bannerVisible)) throw new Error("环境异常横幅未在全部导航页持续显示");
  if (expectNoGpu) {
    if (result.environmentStatus !== "blocked") throw new Error(`无 GPU 环境状态应为 blocked，实际为 ${result.environmentStatus}`);
    if (result.inferenceReady || result.trainingReady) throw new Error("无 GPU 环境错误开放了生成或训练能力");
    if (!result.bannerText.includes("NVIDIA GPU")) throw new Error("无 GPU 横幅缺少 NVIDIA GPU 原因");
    if (!result.coreSubmissionError.includes("本地生成当前不可用")) throw new Error(`核心未拒绝无 GPU 生成提交：${result.coreSubmissionError || "无错误"}`);
  }
}

/** 统一异步等待，避免高频轮询占用 Runner。 */
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/** WebView2 子进程终止后锁文件可能短暂存活，有限退避清理且不覆盖已经通过的 UI 结论。 */
async function removeUserDataDirectory(directory) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(directory, { recursive: true, force: true }); return; }
    catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      await delay(250);
    }
  }
  process.stderr.write(`WebView2 临时目录将在 Runner 退出时清理：${lastError?.code || "UNKNOWN"}\n`);
}

/** Windows 下终止完整桌面进程树，避免 WebView2 子进程污染后续安装任务。 */
function terminateProcessTree(processId) {
  if (!processId) return;
  if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { stdio: "ignore" });
  else {
    try { process.kill(processId, "SIGKILL"); } catch { /* 进程已经退出时无需处理。 */ }
  }
}
