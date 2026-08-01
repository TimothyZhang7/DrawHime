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
const screenshotDirectory = argumentsMap.get("screenshot-directory") || null;
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
    const workflowEvidence = screenshotDirectory ? await captureGenerationAndTrainingPages(client, screenshotDirectory) : null;
    const fontSettingsEvidence = screenshotDirectory ? await captureFontSettings(client, screenshotDirectory) : null;
    const repositoryEvidence = screenshotDirectory ? await captureRepositoryPages(client, screenshotDirectory) : null;
    const galleryEvidence = screenshotDirectory ? await captureGalleryPage(client, screenshotDirectory) : null;
    const resourceEvidence = screenshotDirectory ? await captureResourceCenter(client, screenshotDirectory) : null;
    const evidence = {
      checkedAt: new Date().toISOString(),
      targetTitle: result.documentTitle,
      environmentStatus: result.environmentStatus,
      inferenceReady: result.inferenceReady,
      trainingReady: result.trainingReady,
      fontScale: result.fontScale,
      bannerText: result.bannerText,
      coreStatusText: result.coreStatusText,
      navigationPages: result.navigationPages,
      pageIsolation: result.pageIsolation,
      coreSubmissionBlocked: isCoreSubmissionBlocked(result.coreSubmissionError),
      workflowEvidence,
      fontSettingsEvidence,
      repositoryEvidence,
      galleryEvidence,
      resourceEvidence,
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

/** 通过真实 IPC 逐档验证字体比例，确认设置、全宽布局与 SQLite 持久链路一致。 */
async function captureFontSettings(client, directory) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const result = await client.evaluate(String.raw`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '设置');
    navigation?.click();
    await delay(180);
    const basicTab = [...document.querySelectorAll('.workspace-tabs button')].find((button) => button.textContent.includes('基础设置'));
    basicTab?.click();
    await delay(120);
    const label = [...document.querySelectorAll('.settings-grid label')].find((item) => item.querySelector(':scope > span')?.textContent.trim() === '字体大小');
    const select = label?.querySelector('select');
    const save = [...document.querySelectorAll('.settings-card footer button')].find((button) => button.textContent.includes('保存本地设置'));
    if (!select || !save) throw new Error('未找到字体大小设置');
    const original = Number(select.value);
    const scales = [1, 1.1, 1.2, 1.3];
    const samples = [];
    const applyScale = async (scale) => {
      select.value = String(scale);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await delay(80);
      save.click();
      await delay(350);
    };
    try {
      for (const scale of scales) {
        await applyScale(scale);
        const viewportWidth = document.documentElement.clientWidth;
        // 页面已固定预留滚动条槽位，根节点应覆盖的是 body 可用内容宽度，而不是包含槽位的 HTML 宽度。
        const availableWidth = document.body.clientWidth || viewportWidth;
        const rootBounds = document.querySelector('#root')?.getBoundingClientRect();
        const mainBounds = document.querySelector('.desktop-main')?.getBoundingClientRect();
        const pageBounds = document.querySelector('.desktop-main > .workspace-page:not([hidden])')?.getBoundingClientRect();
        samples.push({
          target: scale,
          applied: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-font-scale')),
          rootWidthCoverage: rootBounds ? rootBounds.width / availableWidth : 0,
          horizontalOverflow: document.documentElement.scrollWidth > viewportWidth,
          mainInsideViewport: !mainBounds || (mainBounds.left >= -1 && mainBounds.right <= viewportWidth + 1),
          pageInsideViewport: !pageBounds || (pageBounds.left >= -1 && pageBounds.right <= viewportWidth + 1),
        });
      }
    } finally {
      await applyScale(original);
    }
    const restored = Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-font-scale'));
    const notice = document.querySelector('.desktop-notice');
    const noticePosition = notice ? getComputedStyle(notice).position : null;
    await delay(4_300);
    const noticeCleared = !document.querySelector('.desktop-notice');
    return { original, restored, samples, optionValues: [...select.options].map((option) => Number(option.value)), noticePosition, noticeCleared };
  })()`);
  const invalidSample = result.samples.find((sample) => sample.applied !== sample.target || sample.rootWidthCoverage < 0.99 || sample.horizontalOverflow || !sample.mainInsideViewport || !sample.pageInsideViewport);
  if (invalidSample || result.restored !== result.original || JSON.stringify(result.optionValues) !== JSON.stringify([1, 1.1, 1.2, 1.3]) || result.noticePosition !== 'fixed' || !result.noticeCleared) throw new Error(`字体与瞬时提示验收失败：${JSON.stringify(result)}`);
  const screenshot = "font-settings.png";
  await writeFile(path.join(targetDirectory, screenshot), Buffer.from(await client.captureScreenshot(), "base64"));
  return { ...result, screenshot };
}

/** 验证生成单栏、独立原生预览、三栏参数、根级悬浮帮助、训练集列表和分步骤训练入口。 */
async function captureGenerationAndTrainingPages(client, directory) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const generation = await client.evaluate(String.raw`(async () => {
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '本地生成');
    if (!navigation) throw new Error('未找到本地生成导航');
    navigation.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const layout = document.querySelector('.generate-layout');
    const preview = layout?.querySelector('.generation-preview');
    const previewButton = [...(layout?.querySelectorAll('.generation-heading-actions button') || [])].find((button) => button.textContent.includes('预览窗口'));
    const fields = [...(layout?.querySelectorAll('.generation-parameter') || [])];
    const controlsFit = fields.every((field) => { const control = field.querySelector('input, select'); return !control || control.getBoundingClientRect().right <= field.getBoundingClientRect().right + 1; });
    const firstRow = fields.slice(0, 3).map((field) => Math.round(field.getBoundingClientRect().top));
    const help = layout?.querySelector('.parameter-help');
    help?.focus();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const tooltip = document.querySelector('.parameter-tooltip');
    const tooltipVisible = !help || Boolean(tooltip?.getClientRects().length && Number(getComputedStyle(tooltip).zIndex) >= 13000);
    help?.blur();
    return {
      layoutVisible: Boolean(layout?.getClientRects().length),
      singleColumn: getComputedStyle(layout).gridTemplateColumns.split(' ').length === 1,
      threeParameterColumns: fields.length < 3 || new Set(firstRow).size === 1,
      parameterFields: fields.length,
      helpIcons: layout?.querySelectorAll('.parameter-help').length || 0,
      tooltipVisible,
      emptyState: Boolean(layout?.querySelector('.resource-unconfigured')),
      embeddedPreviewAbsent: !preview,
      previewButtonVisible: Boolean(previewButton?.getClientRects().length),
      sidebarThemeControls: document.querySelectorAll('.sidebar-theme-switch button').length,
      topbarRecheckVisible: Boolean(document.querySelector('.desktop-topbar .recheck-button')),
      controlsFit,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  const parameterHelpReady = generation.parameterFields > 0 ? generation.helpIcons >= generation.parameterFields : generation.emptyState;
  if (!generation.layoutVisible || !generation.singleColumn || !generation.threeParameterColumns || !parameterHelpReady || !generation.tooltipVisible || !generation.embeddedPreviewAbsent || !generation.previewButtonVisible || generation.sidebarThemeControls !== 3 || generation.topbarRecheckVisible || !generation.controlsFit || generation.horizontalOverflow) throw new Error(`本地生成布局验收失败：${JSON.stringify(generation)}`);
  // 真实点击主窗口按钮，并通过只读 Tauri 命令确认原生窗口表完成创建和销毁。
  await client.evaluate("[...document.querySelectorAll('.generation-heading-actions button')].find((button) => button.textContent.includes('预览窗口'))?.click()");
  generation.previewWindowOpened = await waitForNativePreviewState(client, true);
  await client.evaluate("[...document.querySelectorAll('.generation-heading-actions button')].find((button) => button.textContent.includes('预览窗口'))?.click()");
  generation.previewWindowClosed = await waitForNativePreviewState(client, false);
  if (!generation.previewWindowOpened || !generation.previewWindowClosed) throw new Error(`独立生成预览窗口验收失败：${JSON.stringify(generation)}`);
  const generationFile = "generation-workspace.png";
  await writeFile(path.join(targetDirectory, generationFile), Buffer.from(await client.captureScreenshot(), "base64"));

  const captioning = await client.evaluate(String.raw`(async () => {
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '训练集打标');
    if (!navigation) throw new Error('未找到训练集打标导航');
    navigation.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const page = document.querySelector('.captioning-page');
    return { visible: Boolean(page?.getClientRects().length), datasetLibrary: Boolean(page?.querySelector('.caption-dataset-library')), splitWorkspaceLeaked: Boolean(page?.querySelector('.training-workspace')), trainingParametersLeaked: Boolean(page?.querySelector('.desktop-training-parameters')), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);
  if (!captioning.visible || !captioning.datasetLibrary || captioning.splitWorkspaceLeaked || captioning.trainingParametersLeaked || captioning.horizontalOverflow) throw new Error(`训练集列表页面验收失败：${JSON.stringify(captioning)}`);
  const captioningFile = "captioning-workspace.png";
  await writeFile(path.join(targetDirectory, captioningFile), Buffer.from(await client.captureScreenshot(), "base64"));

  const training = await client.evaluate(String.raw`(async () => {
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === 'LoRA 训练');
    if (!navigation) throw new Error('未找到 LoRA 训练导航');
    navigation.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const page = document.querySelector('.lora-training-page');
    return { visible: Boolean(page?.getClientRects().length), steps: page?.querySelectorAll('.training-stepper button').length || 0, captionControlsLeaked: Boolean(page?.querySelector('.caption-control')), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);
  if (!training.visible || training.steps !== 3 || training.captionControlsLeaked || training.horizontalOverflow) throw new Error(`LoRA 分步骤训练页面验收失败：${JSON.stringify(training)}`);
  const trainingFile = "training-workflow.png";
  await writeFile(path.join(targetDirectory, trainingFile), Buffer.from(await client.captureScreenshot(), "base64"));
  return { generation: { ...generation, screenshot: generationFile }, captioning: { ...captioning, screenshot: captioningFile }, training: { ...training, screenshot: trainingFile } };
}

/** 原生 WebView 创建和销毁均为异步过程，以真实窗口表和有界轮询确认收敛。 */
async function waitForNativePreviewState(client, expectedOpen) {
  const deadline = Date.now() + 3_000;
  do {
    const open = await client.evaluate("window.__TAURI_INTERNALS__.invoke('desktop_generation_preview_open')");
    if (open === expectedOpen) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return false;
}

/** 验证图库作品子页面和全宽记录列表；存在真实数据时继续验证任务详情弹窗。 */
async function captureGalleryPage(client, directory) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const result = await client.evaluate(String.raw`(async () => {
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '图库 / 记录');
    if (!navigation) throw new Error('未找到图库 / 记录导航');
    navigation.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tabs = [...document.querySelectorAll('.desktop-main > .workspace-page:not([hidden]) > .workspace-tabs button')];
    const galleryTab = tabs.find((button) => button.textContent.includes('图库'));
    const recordTab = tabs.find((button) => button.textContent.includes('记录'));
    if (!galleryTab || !recordTab) throw new Error('图库二级入口状态不正确');
    galleryTab.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (galleryTab.getAttribute('aria-selected') !== 'true') throw new Error('图库二级入口未切换为选中状态');
    const selectedStyle = getComputedStyle(galleryTab);
    const idleStyle = getComputedStyle(recordTab);
    return { tabCount: tabs.length, selectedBackground: selectedStyle.backgroundColor, idleBackground: idleStyle.backgroundColor, sourceCards: document.querySelectorAll('.gallery-card').length, redundantLocalTags: document.querySelectorAll('.gallery-card .gallery-source, .gallery-detail-tags > b').length, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);
  if (result.tabCount !== 2 || result.redundantLocalTags !== 0 || result.horizontalOverflow || result.selectedBackground === result.idleBackground) throw new Error(`图库分页样式验收失败：${JSON.stringify(result)}`);
  const galleryFile = 'gallery-list.png';
  await writeFile(path.join(targetDirectory, galleryFile), Buffer.from(await client.captureScreenshot(), 'base64'));
  let galleryDetail = null;
  let galleryDetailFile = null;
  if (result.sourceCards > 0) {
    galleryDetail = await client.evaluate(String.raw`(async () => { document.querySelector('.gallery-card')?.click(); await new Promise((resolve) => setTimeout(resolve, 180)); return { visible: Boolean(document.querySelector('.gallery-detail')), loraSection: Boolean(document.querySelector('.job-lora-gallery, .gallery-detail-section .empty-block')), parameterSection: Boolean(document.querySelector('.job-parameter-panel')) }; })()`);
    if (!galleryDetail.visible || !galleryDetail.loraSection || !galleryDetail.parameterSection) throw new Error(`图库作品详情验收失败：${JSON.stringify(galleryDetail)}`);
    galleryDetailFile = 'gallery-detail.png';
    await writeFile(path.join(targetDirectory, galleryDetailFile), Buffer.from(await client.captureScreenshot(), 'base64'));
    await client.evaluate("document.querySelector('.gallery-detail-back')?.click()");
  }
  await client.evaluate(String.raw`(async () => { const tab = [...document.querySelectorAll('.desktop-main > .workspace-page:not([hidden]) > .workspace-tabs button')].find((button) => button.textContent.includes('记录')); tab?.click(); await new Promise((resolve) => setTimeout(resolve, 180)); })()`);
  const recordLayout = await client.evaluate(String.raw`(() => { const rows = [...document.querySelectorAll('.local-record-list > article')]; return { rowCount: rows.length, singleColumn: rows.length < 2 || Math.abs(rows[0].getBoundingClientRect().left - rows[1].getBoundingClientRect().left) < 2, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`);
  if (!recordLayout.singleColumn || recordLayout.horizontalOverflow) throw new Error(`任务记录布局验收失败：${JSON.stringify(recordLayout)}`);
  const recordsFile = 'gallery-records.png';
  await writeFile(path.join(targetDirectory, recordsFile), Buffer.from(await client.captureScreenshot(), 'base64'));
  let recordDialog = null;
  let recordDialogFile = null;
  if (recordLayout.rowCount > 0) {
    recordDialog = await client.evaluate(String.raw`(async () => { document.querySelector('.local-record-list > article')?.click(); await new Promise((resolve) => setTimeout(resolve, 180)); return { visible: Boolean(document.querySelector('.job-detail-dialog')), parameters: Boolean(document.querySelector('.job-parameter-panel')), attempts: Boolean(document.querySelector('.job-attempt-list')) }; })()`);
    if (!recordDialog.visible || !recordDialog.parameters || !recordDialog.attempts) throw new Error(`任务详情弹窗验收失败：${JSON.stringify(recordDialog)}`);
    recordDialogFile = 'gallery-record-detail.png';
    await writeFile(path.join(targetDirectory, recordDialogFile), Buffer.from(await client.captureScreenshot(), 'base64'));
    await client.evaluate("document.querySelector('.job-detail-dialog > header > button')?.click()");
  }
  return { ...result, galleryDetail, recordLayout, recordDialog, screenshots: [galleryFile, galleryDetailFile, recordsFile, recordDialogFile].filter(Boolean) };
}

/** 验证概览仅展示必需依赖，并确认左下角按钮可独立打开下载队列弹窗。 */
async function captureResourceCenter(client, directory) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const result = await client.evaluate(String.raw`(async () => {
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '启动 / 账号');
    if (!navigation) throw new Error('未找到启动 / 账号导航');
    navigation.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const startupTab = [...document.querySelectorAll('.desktop-main > .workspace-page:not([hidden]) > .workspace-tabs button')].find((button) => button.textContent.includes('启动'));
    if (!startupTab) throw new Error('未找到启动入口');
    startupTab.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    // 直接读取已验签目录，确认能力分流返回真实 Segmenter，而不是只验证静态启动卡片。
    const catalog = await window.__TAURI_INTERNALS__.invoke('desktop_load_resource_catalog');
    const dependencyCards = [...document.querySelectorAll('.startup-dependency-list > article')];
    const dependencyText = dependencyCards.map((card) => card.textContent.trim()).join('\n');
    const summaryCount = document.querySelectorAll('.startup-stages > article').length;
    return {
      dependencyCards: dependencyCards.length,
      segmenterResources: catalog.resources.filter((resource) => resource.kind === 'segmenter').length,
      summaryCount,
      primaryLabel: document.querySelector('.startup-primary > span')?.textContent || '',
      optionalModelVisible: ['Anime Bulldozer', 'MiaoMiao RealSkin', 'MiaoMiao 3D Harem', 'MiaoMiao Harem'].some((name) => dependencyText.includes(name)),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  if (result.dependencyCards < 4 || result.segmenterResources !== 1 || result.summaryCount !== 3 || !['初始化', '启动', '启动中', '运行中', '正在检测', '正在初始化', '正在自检'].includes(result.primaryLabel) || result.optionalModelVisible || result.horizontalOverflow) throw new Error(`启动页验收失败：${JSON.stringify(result)}`);
  const listFile = 'dependencies-list.png';
  await writeFile(path.join(targetDirectory, listFile), Buffer.from(await client.captureScreenshot(), 'base64'));
  const dialog = await client.evaluate(String.raw`(async () => {
    const trigger = document.querySelector('.desktop-sidebar > .core-status');
    if (!trigger) throw new Error('未找到本地核心下载队列按钮');
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const modal = document.querySelector('.resource-dialog');
    return { visible: Boolean(modal), title: modal?.querySelector('h2')?.textContent || '', emptyOrQueueVisible: Boolean(modal?.querySelector('.empty-block, .queue-resource')) };
  })()`);
  if (!dialog.visible || dialog.title !== '下载队列与进度' || !dialog.emptyOrQueueVisible) throw new Error(`下载队列弹窗验收失败：${JSON.stringify(dialog)}`);
  const dialogFile = 'download-queue.png';
  await writeFile(path.join(targetDirectory, dialogFile), Buffer.from(await client.captureScreenshot(), 'base64'));
  await client.evaluate(`document.querySelector('.resource-dialog-close')?.click()`);
  return { ...result, dialog, screenshots: [listFile, dialogFile] };
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

/** 建立最小 CDP 客户端，只开放本次 UI 验收需要的页面求值与截图命令。 */
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
    async captureScreenshot() {
      const response = await command("Page.captureScreenshot", { format: "png", fromSurface: true });
      return response.data;
    },
    async setViewport(width, height) { await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height }); },
    async clearViewport() { await command("Emulation.clearDeviceMetricsOverride", {}); },
    close() { socket.close(); },
  };
}

/** 逐页验证仓库筛选、卡片或空状态和详情返回逻辑，并保存 WebView 内容截图。 */
async function captureRepositoryPages(client, directory) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const results = [];
  for (const pageLabel of ["模型仓库", "LoRA 仓库"]) {
    const page = await client.evaluate(String.raw`(async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === ${JSON.stringify(pageLabel)});
      if (!navigation) throw new Error('未找到仓库导航');
      navigation.click();
      await delay(400);
      const pageRoot = [...document.querySelectorAll('.desktop-main > div')].find((element) => !element.hidden && element.querySelector('.repository-page'));
      const toolbar = pageRoot?.querySelector('.repository-toolbar');
      const cards = [...(pageRoot?.querySelectorAll('.repository-card') || [])];
      const empty = pageRoot?.querySelector('.repository-empty');
      if (!toolbar || (!cards.length && !empty)) throw new Error('仓库页面缺少筛选栏、卡片或空状态');
      return { cardCount: cards.length, emptyVisible: Boolean(empty), localCoverTags: cards.filter((card) => [...card.querySelectorAll('.repository-card-tags b, .repository-card-tags i')].some((tag) => tag.textContent.trim() === '本地')).length, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    if (page.horizontalOverflow || page.localCoverTags > 0) throw new Error(`${pageLabel} 列表布局或本地标签状态异常：${JSON.stringify(page)}`);
    const baseName = pageLabel === "模型仓库" ? "models" : "loras";
    const listFile = `${baseName}-list.png`;
    await writeFile(path.join(targetDirectory, listFile), Buffer.from(await client.captureScreenshot(), "base64"));
    let detailVisible = false;
    let detailFile = null;
    if (page.cardCount > 0) {
      const detailState = await client.evaluate(String.raw`(async () => {
        const pageRoot = [...document.querySelectorAll('.desktop-main > div')].find((element) => !element.hidden && element.querySelector('.repository-page'));
        pageRoot?.querySelector('.repository-card')?.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { visible: Boolean(pageRoot?.querySelector('.repository-detail-hero')), examples: Boolean(pageRoot?.querySelector('.repository-detail-media')), relatedJobs: Boolean(pageRoot?.querySelector('.repository-related-jobs')) };
      })()`);
      detailVisible = detailState.visible;
      if (!detailState.visible || !detailState.examples || !detailState.relatedJobs) throw new Error(`${pageLabel} 详情结构不完整：${JSON.stringify(detailState)}`);
      detailFile = `${baseName}-detail.png`;
      await writeFile(path.join(targetDirectory, detailFile), Buffer.from(await client.captureScreenshot(), "base64"));
      await client.evaluate("[...document.querySelectorAll('.desktop-main > div')].find((element) => !element.hidden && element.querySelector('.repository-page'))?.querySelector('.repository-back')?.click()");
    }
    results.push({ page: pageLabel, ...page, detailVisible, screenshots: [listFile, detailFile].filter(Boolean) });
  }
  // 仓库列表在应用允许的最小窗口中也必须保留筛选、卡片与返回路径。
  await client.setViewport(720, 560);
  try {
    for (const result of results) {
      const compact = await client.evaluate(String.raw`(async () => {
        const label = ${JSON.stringify(result.page)};
        const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === label);
        navigation?.click();
        await new Promise((resolve) => setTimeout(resolve, 180));
        let pageRoot = [...document.querySelectorAll('.desktop-main > div')].find((element) => !element.hidden && element.querySelector('.repository-page, .repository-detail'));
        const back = pageRoot?.querySelector('.repository-back');
        if (back) back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 500));
        pageRoot = [...document.querySelectorAll('.desktop-main > div')].find((element) => !element.hidden && element.querySelector('.repository-page, .repository-detail'));
        const toolbar = pageRoot?.querySelector('.repository-toolbar');
        const card = pageRoot?.querySelector('.repository-card');
        return { backFound: Boolean(back), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, toolbarVisible: Boolean(toolbar?.getClientRects().length), cardOrEmptyVisible: Boolean(card?.getClientRects().length || pageRoot?.querySelector('.repository-empty')?.getClientRects().length) };
      })()`);
      const compactFile = result.page === "模型仓库" ? "models-compact.png" : "loras-compact.png";
      await writeFile(path.join(targetDirectory, compactFile), Buffer.from(await client.captureScreenshot(), "base64"));
      if (compact.horizontalOverflow || !compact.toolbarVisible || !compact.cardOrEmptyVisible) throw new Error(`${result.page} 在 720×560 下布局不可用：${JSON.stringify(compact)}`);
      result.compact = { ...compact, screenshot: compactFile };
    }
  } finally {
    await client.clearViewport();
  }
  return results;
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
    const pageIsolation = [];
    for (const button of document.querySelectorAll('.desktop-sidebar nav button')) {
      button.click();
      await delay(50);
      const banner = document.querySelector('.environment-banner');
      navigationPages.push({ label: button.textContent.trim(), bannerVisible: Boolean(banner && banner.getClientRects().length) });
      const visibleMainPanels = Array.from(document.querySelectorAll('.desktop-main > div')).filter((panel) => panel.getClientRects().length && panel.querySelector(':scope > .desktop-page, :scope > .workspace-tabs')).length;
      const activeWorkspace = document.querySelector('.desktop-main > .workspace-page:not([hidden])');
      const secondaryCounts = [];
      for (const secondaryButton of activeWorkspace?.querySelectorAll(':scope > .workspace-tabs button') || []) {
        secondaryButton.click();
        await delay(30);
        secondaryCounts.push(Array.from(activeWorkspace.children).filter((child) => child.matches('div:not([hidden])') && child.getClientRects().length).length);
      }
      pageIsolation.push({ label: button.textContent.trim(), visibleMainPanels, secondaryCounts, mainWidth: Math.round(document.querySelector('.desktop-main').getBoundingClientRect().width) });
    }
    let coreSubmissionError = '';
    try {
      await window.__TAURI_INTERNALS__.invoke('desktop_create_local_job', { input: {
        modelId: 'ui-no-gpu-probe', prompt: 'ui gate probe', negativePrompt: null,
        width: 1024, height: 1024, qualityPreset: 'custom', steps: 1, cfg: 1,
        samplerName: 'euler', schedulerName: 'normal', samplingMaxEdge: 1024,
        samplingPixelBudget: 1048576, aspectStepThreshold: 1.5, aspectAdjustedSteps: 1,
        upscaleMethod: 'lanczos', qualityPromptEnabled: false, defaultNegativeEnabled: false,
        seed: 1, loras: [], privacy: 'private'
      }});
    } catch (error) { coreSubmissionError = String(error); }
    const banner = document.querySelector('.environment-banner');
    return {
      environmentStatus: shell.dataset.environmentStatus || '',
      documentTitle: document.title,
      inferenceReady: shell.dataset.inferenceReady === 'true',
      trainingReady: shell.dataset.trainingReady === 'true',
      fontScale: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-font-scale')),
      bannerText: banner?.textContent?.trim() || '',
      coreStatusText: document.querySelector('.desktop-sidebar .core-status')?.textContent?.trim() || '',
      navigationPages,
      pageIsolation,
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
      const message = String(error);
      if (!["Execution context was destroyed", "Inspected target navigated or closed", "Cannot find default execution context"].some((fragment) => message.includes(fragment))) throw error;
      await delay(500);
    }
  }
  throw lastError || new Error("WebView 初始页面未稳定");
}

/** 对无 GPU Runner 执行强门禁；其他硬件仍至少要求导航横幅状态一致。 */
function validateProbe(result, expectNoGpu) {
  const expectedNavigation = ["启动 / 账号", "本地生成", "训练集打标", "LoRA 训练", "模型仓库", "LoRA 仓库", "图库 / 记录", "设置"];
  const actualNavigation = Array.isArray(result?.navigationPages) ? result.navigationPages.map((item) => item.label) : [];
  if (JSON.stringify(actualNavigation) !== JSON.stringify(expectedNavigation)) throw new Error(`桌面导航结构异常：${actualNavigation.join(" / ")}`);
  if (!Array.isArray(result.pageIsolation) || result.pageIsolation.some((item) => item.visibleMainPanels !== 1 || item.secondaryCounts.some((count) => count !== 1))) throw new Error("桌面主分页或二级分页存在内容堆叠");
  if (new Set(result.pageIsolation.map((item) => item.mainWidth)).size !== 1) throw new Error("桌面分页切换时滚动条导致主布局宽度抖动");
  if (!Number.isFinite(result.fontScale) || result.fontScale < 1 || result.fontScale > 1.3) throw new Error(`桌面字体缩放不正确：${result.fontScale}`);
  // Runtime、自检与必需依赖统一由左下角本地核心承载；其他阻断问题仍使用全局横幅。
  const centralizedCoreIssue = ["本地核心未就绪", "本地核心等待自检", "本地核心不可用", "本地核心错误", "依赖通道未配置", "依赖清单不完整"].some((label) => result.coreStatusText.includes(label));
  if (result.environmentStatus !== "ready" && result.navigationPages.some((item) => !item.bannerVisible) && !centralizedCoreIssue) throw new Error("环境异常既未显示全局横幅，也未集中显示在本地核心");
  // 生成能力未就绪时必须由 Tauri 最终边界拒绝提交，不能只依赖前端按钮禁用。
  if (!result.inferenceReady && !isCoreSubmissionBlocked(result.coreSubmissionError)) throw new Error(`未就绪核心未拒绝生成提交：${result.coreSubmissionError || "无错误"}`);
  if (expectNoGpu) {
    if (result.environmentStatus !== "blocked") throw new Error(`无 GPU 环境状态应为 blocked，实际为 ${result.environmentStatus}`);
    if (result.inferenceReady || result.trainingReady) throw new Error("无 GPU 环境错误开放了生成或训练能力");
    if (!result.bannerText.includes("NVIDIA GPU")) throw new Error("无 GPU 横幅缺少 NVIDIA GPU 原因");
    if (!isCoreSubmissionBlocked(result.coreSubmissionError)) throw new Error(`核心未拒绝无 GPU 生成提交：${result.coreSubmissionError || "无错误"}`);
  }
}

/** 同时兼容硬件能力门禁与 Runtime 未启动门禁的真实错误文本。 */
function isCoreSubmissionBlocked(message) {
  return ["本地生成当前不可用", "本地核心未启动或不可用"].some((fragment) => String(message || "").includes(fragment));
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
