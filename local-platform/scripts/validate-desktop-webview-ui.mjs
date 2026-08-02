/**
 * 本文件通过本机 WebView2 调试协议验证桌面环境横幅、能力锁定和核心提交门禁，不读取用户业务数据。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { captureCaptioningWorkspace } from "./lib/validate-captioning-workspace.mjs";

const argumentsMap = parseArguments(process.argv.slice(2));
const executable = requiredArgument(argumentsMap, "executable");
const evidencePath = argumentsMap.get("evidence") || null;
const screenshotDirectory = argumentsMap.get("screenshot-directory") || null;
const expectNoGpu = argumentsMap.has("expect-no-gpu");
const loraDialogOnly = argumentsMap.has("lora-dialog-only");
const galleryOnly = argumentsMap.has("gallery-only");
const repositoryOnly = argumentsMap.has("repository-only");
const captioningOnly = argumentsMap.has("captioning-only");
const logsOnly = argumentsMap.has("logs-only");
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
    const workflowEvidence = screenshotDirectory && !galleryOnly && !repositoryOnly && !logsOnly
      ? captioningOnly
        ? { generation: null, captioning: await captureCaptioningWorkspace(client, screenshotDirectory, { requireAssets: true }), training: null }
        : await captureGenerationAndTrainingPages(client, screenshotDirectory)
      : null;
    const fontSettingsEvidence = screenshotDirectory && !captioningOnly && !loraDialogOnly && !galleryOnly && !repositoryOnly && !logsOnly ? await captureFontSettings(client, screenshotDirectory) : null;
    const repositoryEvidence = screenshotDirectory && !captioningOnly && !loraDialogOnly && !galleryOnly && !logsOnly ? await captureRepositoryPages(client, screenshotDirectory) : null;
    const galleryEvidence = screenshotDirectory && !captioningOnly && !loraDialogOnly && !repositoryOnly && !logsOnly ? await captureGalleryPage(client, screenshotDirectory) : null;
    const resourceEvidence = screenshotDirectory && !captioningOnly && !loraDialogOnly && !galleryOnly && !repositoryOnly && !logsOnly ? await captureResourceCenter(client, screenshotDirectory) : null;
    const logsEvidence = screenshotDirectory && !captioningOnly && !loraDialogOnly && !galleryOnly && !repositoryOnly ? await captureDesktopLogs(client, screenshotDirectory) : null;
    const evidence = {
      checkedAt: new Date().toISOString(),
      targetTitle: result.documentTitle,
      environmentStatus: result.environmentStatus,
      inferenceReady: result.inferenceReady,
      trainingReady: result.trainingReady,
      fontScale: result.fontScale,
      contentFontScale: result.contentFontScale,
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
      logsEvidence,
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

/** 通过真实 IPC 分别验证页面缩放和内容字体，确认两者互不串扰且 SQLite 持久链路一致。 */
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
    const findSelect = (title) => [...document.querySelectorAll('.settings-grid label')].find((item) => item.querySelector(':scope > span')?.textContent.trim() === title)?.querySelector('select');
    const pageSelect = findSelect('页面缩放');
    const contentSelect = findSelect('内容字体');
    if (!pageSelect || !contentSelect) throw new Error('未找到页面缩放或内容字体设置');
    const originalPage = Number(pageSelect.value);
    const originalContent = Number(contentSelect.value);
    const pageScales = [1, 1.3];
    const contentScales = [1, 1.6];
    const pageSamples = [];
    const contentSamples = [];
    // 干净环境尚未安装底模时生成表单不会渲染，临时挂载相同选择器验证真实提示词字号规则。
    const promptProbe = document.createElement('label');
    promptProbe.className = 'prompt-field';
    promptProbe.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;';
    promptProbe.append(document.createElement('textarea'));
    document.body.append(promptProbe);
    const applySetting = async (title, scale) => {
      const select = findSelect(title);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, String(scale));
      select?.dispatchEvent(new Event('change', { bubbles: true }));
      await delay(180);
      const previewVisibleFontSize = Number.parseFloat(getComputedStyle(document.querySelector('.settings-grid label > span')).fontSize);
      return previewVisibleFontSize;
    };
    try {
      for (const scale of pageScales) {
        await applySetting('页面缩放', scale);
        const viewportWidth = document.documentElement.clientWidth;
        // 页面已固定预留滚动条槽位，根节点应覆盖的是 body 可用内容宽度，而不是包含槽位的 HTML 宽度。
        const availableWidth = document.body.clientWidth || viewportWidth;
        const rootBounds = document.querySelector('#root')?.getBoundingClientRect();
        const mainBounds = document.querySelector('.desktop-main')?.getBoundingClientRect();
        const pageBounds = document.querySelector('.desktop-main > .workspace-page:not([hidden])')?.getBoundingClientRect();
        const navigationControl = document.querySelector('.desktop-sidebar nav button');
        pageSamples.push({
          target: scale,
          applied: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-font-scale')),
          contentApplied: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-content-font-scale')),
          rootZoom: Number(getComputedStyle(document.querySelector('#root')).zoom),
          devicePixelRatio: window.devicePixelRatio,
          viewportWidth,
          navigationControlHeight: navigationControl?.getBoundingClientRect().height || 0,
          rootWidthCoverage: rootBounds ? rootBounds.width / availableWidth : 0,
          horizontalOverflow: document.documentElement.scrollWidth > viewportWidth,
          mainInsideViewport: !mainBounds || (mainBounds.left >= -1 && mainBounds.right <= viewportWidth + 1),
          pageInsideViewport: !pageBounds || (pageBounds.left >= -1 && pageBounds.right <= viewportWidth + 1),
        });
      }
      await applySetting('页面缩放', originalPage);
      for (const scale of contentScales) {
        const previewVisibleFontSize = await applySetting('内容字体', scale);
        const prompt = document.querySelector('.prompt-field textarea');
        const visibleContent = document.querySelector('.settings-grid label > span');
        contentSamples.push({
          target: scale,
          applied: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-content-font-scale')),
          pageApplied: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-font-scale')),
          promptFontSize: prompt ? Number.parseFloat(getComputedStyle(prompt).fontSize) : null,
          previewVisibleFontSize,
          visibleContentFontSize: visibleContent ? Number.parseFloat(getComputedStyle(visibleContent).fontSize) : null,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        });
      }
    } finally {
      await applySetting('页面缩放', originalPage);
      await applySetting('内容字体', originalContent);
      promptProbe.remove();
    }
    const restoredPage = Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-font-scale'));
    const restoredContent = Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-content-font-scale'));
    const aiTab = [...document.querySelectorAll('.workspace-tabs button')].find((button) => button.textContent.includes('AI 辅助'));
    aiTab?.click();
    await delay(120);
    const aiControls = [...document.querySelectorAll('.ai-settings-grid input:not([type="checkbox"]):not([type="radio"]), .ai-settings-grid select')];
    const aiControlHeights = aiControls.map((control) => Math.round(control.getBoundingClientRect().height));
    const aiControlDetails = aiControls.map((control) => {
      const style = getComputedStyle(control);
      const bounds = control.getBoundingClientRect();
      const labelBounds = control.closest('label')?.getBoundingClientRect();
      return {
        tagName: control.tagName,
        borderTopWidth: style.borderTopWidth,
        outlineWidth: style.outlineWidth,
        controlRight: Math.round(bounds.right * 10) / 10,
        labelRight: labelBounds ? Math.round(labelBounds.right * 10) / 10 : null,
        insideLabel: !labelBounds || bounds.right <= labelBounds.right + 1,
      };
    });
    const aiBorderWidths = aiControlDetails.map((control) => Number.parseFloat(control.borderTopWidth));
    const aiControlsConsistent = aiControls.length >= 4
      && new Set(aiControlHeights).size === 1
      && new Set(aiControlDetails.map((control) => control.borderTopWidth)).size === 1
      && aiBorderWidths.every((width) => Number.isFinite(width) && width > 0)
      && aiControlDetails.every((control) => control.outlineWidth === '0px' && control.insideLabel);
    basicTab?.click();
    await delay(80);
    const notice = document.querySelector('.desktop-notice');
    const noticePosition = notice ? getComputedStyle(notice).position : null;
    await delay(4_300);
    const noticeCleared = !document.querySelector('.desktop-notice');
    return { originalPage, originalContent, restoredPage, restoredContent, pageSamples, contentSamples, aiControlCount: aiControls.length, aiControlHeights, aiControlDetails, aiControlsConsistent, pageOptionValues: [...pageSelect.options].map((option) => Number(option.value)), contentOptionValues: [...contentSelect.options].map((option) => Number(option.value)), noticePosition, noticeCleared };
  })()`);
  const invalidPageSample = result.pageSamples.find((sample) => sample.applied !== sample.target || sample.rootZoom !== 1 || sample.contentApplied !== result.originalContent || sample.rootWidthCoverage < 0.99 || sample.horizontalOverflow || !sample.mainInsideViewport || !sample.pageInsideViewport);
  const invalidContentSample = result.contentSamples.find((sample) => sample.applied !== sample.target || sample.pageApplied !== result.originalPage || sample.promptFontSize === null || sample.horizontalOverflow);
  const nativePageScaleApplied = result.pageSamples.at(-1)?.devicePixelRatio > result.pageSamples[0]?.devicePixelRatio * 1.2 && result.pageSamples.at(-1)?.viewportWidth < result.pageSamples[0]?.viewportWidth * 0.85;
  const contentFontGrows = result.contentSamples.at(-1)?.promptFontSize > result.contentSamples[0]?.promptFontSize;
  const visibleContentFontGrows = result.contentSamples.at(-1)?.visibleContentFontSize > result.contentSamples[0]?.visibleContentFontSize * 1.5;
  const livePreviewMatchesSaved = result.contentSamples.every((sample) => sample.previewVisibleFontSize === sample.visibleContentFontSize);
  if (invalidPageSample || invalidContentSample || !nativePageScaleApplied || !contentFontGrows || !visibleContentFontGrows || !livePreviewMatchesSaved || !result.aiControlsConsistent || result.restoredPage !== result.originalPage || result.restoredContent !== result.originalContent || JSON.stringify(result.pageOptionValues) !== JSON.stringify([1, 1.1, 1.2, 1.3]) || JSON.stringify(result.contentOptionValues) !== JSON.stringify([1, 1.2, 1.4, 1.6])) throw new Error(`页面缩放、内容字体与输入控件验收失败：${JSON.stringify(result)}`);
  const screenshot = "font-settings.png";
  await writeFile(path.join(targetDirectory, screenshot), Buffer.from(await client.captureScreenshot(), "base64"));
  return { ...result, screenshot };
}

/** 验证生成单栏、独立原生预览、三栏参数、根级悬浮帮助、训练集列表和分步骤训练入口。 */
async function captureGenerationAndTrainingPages(client, directory) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  // 已完成初始化但尚未启动时，走真实“启动”入口等待 Runtime 就绪；绝不触发依赖下载或绕过门禁。
  const runtimeStart = await client.evaluate(String.raw`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const overview = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '启动 / 账号');
    overview?.click();
    await delay(120);
    const primary = document.querySelector('.startup-primary');
    const initialLabel = primary?.querySelector(':scope > span')?.textContent.trim() || '';
    if (initialLabel === '启动' && !primary.disabled) primary.click();
    if (initialLabel === '启动') {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const generation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '本地生成');
        if (generation && !generation.disabled) return { attempted: true, ready: true };
        await delay(500);
      }
    }
    const generation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '本地生成');
    return { attempted: initialLabel === '启动', ready: Boolean(generation && !generation.disabled), initialLabel };
  })()`);
  const protectedNavigation = await client.evaluate(String.raw`(() => {
    const buttons = [...document.querySelectorAll('.desktop-sidebar nav button')];
    const generation = buttons.find((button) => button.textContent.trim().includes('本地生成'));
    const training = buttons.find((button) => button.textContent.trim().includes('LoRA 训练'));
    return {
      generationLocked: Boolean(generation?.disabled && generation.classList.contains('core-locked') && generation.querySelector('.navigation-lock')),
      trainingLocked: Boolean(training?.disabled && training.classList.contains('core-locked') && training.querySelector('.navigation-lock')),
    };
  })()`);
  // 未运行核心时以真实锁定入口作为验收结果，不绕过门禁进入生成或训练页面。
  if (protectedNavigation.generationLocked || protectedNavigation.trainingLocked) {
    if (!protectedNavigation.generationLocked || !protectedNavigation.trainingLocked) throw new Error(`生成与训练核心门禁不一致：${JSON.stringify(protectedNavigation)}`);
    const lockedFile = "core-locked-workflows.png";
    await writeFile(path.join(targetDirectory, lockedFile), Buffer.from(await client.captureScreenshot(), "base64"));
    return { generation: { coreLocked: true, runtimeStart, screenshot: lockedFile }, captioning: null, training: { coreLocked: true, runtimeStart, screenshot: lockedFile } };
  }
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
    const parameterGrid = layout?.querySelector('.generation-grid');
    const parameterColumnCount = parameterGrid ? getComputedStyle(parameterGrid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
    const help = [...(layout?.querySelectorAll('.parameter-help') || [])].find((item) => item.getClientRects().length);
    // CDP 窗口不一定拥有系统键盘焦点，派发真实冒泡鼠标事件验证用户悬浮链路。
    help?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    help?.focus({ preventScroll: true });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const tooltip = document.querySelector('.parameter-tooltip');
    const tooltipVisible = !help || Boolean(tooltip?.getClientRects().length && Number(getComputedStyle(tooltip).zIndex) >= 13000);
    help?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    help?.blur();
    return {
      layoutVisible: Boolean(layout?.getClientRects().length),
      singleColumn: getComputedStyle(layout).gridTemplateColumns.split(' ').length === 1,
      parameterColumnCount,
      responsiveParameterColumns: fields.length < 2 || (parameterColumnCount >= 2 && parameterColumnCount <= 4),
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
  if (!generation.layoutVisible || !generation.singleColumn || !generation.responsiveParameterColumns || !parameterHelpReady || !generation.tooltipVisible || !generation.embeddedPreviewAbsent || !generation.previewButtonVisible || generation.sidebarThemeControls !== 3 || generation.topbarRecheckVisible || !generation.controlsFit || generation.horizontalOverflow) throw new Error(`本地生成布局验收失败：${JSON.stringify(generation)}`);
  // 生成页存在可用模型时，验证 LoRA 两级筛选的默认值、范围计数和卡片布局。
  generation.loraDialog = await client.evaluate(String.raw`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const trigger = [...document.querySelectorAll('.generation-lora-summary button')].find((button) => button.textContent.includes('选择 LoRA'));
    if (!trigger) return { available: false };
    trigger.click();
    await delay(180);
    const dialog = document.querySelector('.generation-lora-dialog');
    if (!dialog) throw new Error('LoRA 选择弹窗未打开');
    const scopes = [...dialog.querySelectorAll('.generation-lora-scopes button')];
    const categories = [...dialog.querySelectorAll('.generation-lora-categories button')];
    const buttonLabel = (button) => button?.querySelector('span')?.textContent.trim() || '';
    const buttonCount = (button) => Number(button?.querySelector('b')?.textContent || 0);
    const visibleCards = () => [...dialog.querySelectorAll('[data-lora-entry]')];
    const installedButton = scopes.find((button) => buttonLabel(button) === '已下载');
    const allScopeButton = scopes.find((button) => buttonLabel(button) === '全部');
    const allCategoryButton = categories.find((button) => buttonLabel(button) === '全部分类');
    const installedCards = visibleCards();
    const defaultState = {
      installedActive: Boolean(installedButton?.classList.contains('active')),
      allCategoryActive: Boolean(allCategoryButton?.classList.contains('active')),
      categoryLabels: categories.map(buttonLabel),
      installedCount: buttonCount(installedButton),
      visibleCount: installedCards.length,
      installedCardsOnly: installedCards.every((card) => card.dataset.localAvailable === 'true'),
      installedStatusCount: installedCards.filter((card) => card.querySelector('.generation-lora-copy > header b')?.textContent.trim() === '已下载').length,
    };
    allScopeButton?.click();
    await delay(120);
    const allCards = visibleCards();
    const firstPageTitle = allCards[0]?.querySelector('.generation-lora-copy strong')?.textContent || '';
    const pager = dialog.querySelector('.collection-pagination');
    const nextPageButton = pager?.querySelector('button:last-child');
    const cardLayoutValid = allCards.every((card) => {
      const cover = card.querySelector('.generation-lora-cover');
      const action = card.querySelector('.generation-lora-action button');
      const bounds = card.getBoundingClientRect();
      return Boolean(cover && action && cover.getBoundingClientRect().height >= 110 && action.getBoundingClientRect().right <= bounds.right + 1);
    });
    nextPageButton?.click();
    await delay(100);
    const nextPageTitle = visibleCards()[0]?.querySelector('.generation-lora-copy strong')?.textContent || '';
    const result = {
      available: true,
      defaultState,
      allActive: Boolean(allScopeButton?.classList.contains('active')),
      allCount: buttonCount(allScopeButton),
      allCategoryCount: buttonCount(allCategoryButton),
      allVisibleCount: allCards.length,
      paginationVisible: Boolean(pager),
      nextPageChanged: !nextPageButton || nextPageButton.disabled || Boolean(firstPageTitle && nextPageTitle && firstPageTitle !== nextPageTitle),
      cardLayoutValid,
      horizontalOverflow: dialog.scrollWidth > dialog.clientWidth,
    };
    dialog.querySelector(':scope > header > button')?.click();
    return result;
  })()`);
  if (generation.loraDialog.available) {
    const dialog = generation.loraDialog;
    const expectedCategories = ['全部分类', '角色', '画风', '服装', '姿势', '概念', '其他'];
    if (!dialog.defaultState.installedActive || !dialog.defaultState.allCategoryActive || !dialog.defaultState.installedCardsOnly || Math.min(dialog.defaultState.installedCount, 18) !== dialog.defaultState.visibleCount || dialog.defaultState.installedStatusCount !== dialog.defaultState.visibleCount || JSON.stringify(dialog.defaultState.categoryLabels) !== JSON.stringify(expectedCategories) || !dialog.allActive || dialog.allCount !== dialog.allCategoryCount || dialog.allVisibleCount < 1 || dialog.allVisibleCount > 18 || (dialog.allCount > 18 && !dialog.paginationVisible) || !dialog.nextPageChanged || !dialog.cardLayoutValid || dialog.horizontalOverflow) throw new Error(`LoRA 两级筛选、分页与卡片布局验收失败：${JSON.stringify(dialog)}`);
  }
  // 专项模式到此为止，并保存默认“已下载 / 全部分类”弹窗的真实截图。
  if (loraDialogOnly) {
    await client.evaluate(String.raw`(async () => {
      [...document.querySelectorAll('.generation-lora-summary button')].find((button) => button.textContent.includes('选择 LoRA'))?.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
    })()`);
    const loraFile = "generation-lora-dialog.png";
    await writeFile(path.join(targetDirectory, loraFile), Buffer.from(await client.captureScreenshot(), "base64"));
    await client.evaluate("document.querySelector('.generation-lora-dialog > header > button')?.click()");
    return { generation: { ...generation, screenshot: loraFile }, captioning: null, training: null };
  }
  // 真实点击主窗口按钮，并通过只读 Tauri 命令确认原生窗口表完成创建和销毁。
  await client.evaluate("[...document.querySelectorAll('.generation-heading-actions button')].find((button) => button.textContent.includes('预览窗口'))?.click()");
  generation.previewWindowOpened = await waitForNativePreviewState(client, true);
  await client.evaluate("[...document.querySelectorAll('.generation-heading-actions button')].find((button) => button.textContent.includes('预览窗口'))?.click()");
  generation.previewWindowClosed = await waitForNativePreviewState(client, false);
  if (!generation.previewWindowOpened || !generation.previewWindowClosed) throw new Error(`独立生成预览窗口验收失败：${JSON.stringify(generation)}`);
  const generationFile = "generation-workspace.png";
  await writeFile(path.join(targetDirectory, generationFile), Buffer.from(await client.captureScreenshot(), "base64"));

  const captioning = await captureCaptioningWorkspace(client, targetDirectory);

  const training = await client.evaluate(String.raw`(async () => {
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === 'LoRA 训练');
    if (!navigation) throw new Error('未找到 LoRA 训练导航');
    navigation.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const page = document.querySelector('.lora-training-page');
    const visibleText = page?.textContent || '';
    return { visible: Boolean(page?.getClientRects().length), steps: page?.querySelectorAll('.training-stepper button').length || 0, captionControlsLeaked: Boolean(page?.querySelector('.caption-control')), legacySnapshotOptionAbsent: !visibleText.includes('使用 AI 标签处理任务快照') && !visibleText.includes('训练目标'), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);
  if (!training.visible || training.steps !== 3 || training.captionControlsLeaked || !training.legacySnapshotOptionAbsent || training.horizontalOverflow) throw new Error(`LoRA 分步骤训练页面验收失败：${JSON.stringify(training)}`);
  const trainingFile = "training-workflow.png";
  await writeFile(path.join(targetDirectory, trainingFile), Buffer.from(await client.captureScreenshot(), "base64"));
  return { generation: { ...generation, screenshot: generationFile }, captioning, training: { ...training, screenshot: trainingFile } };
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

/** 验证图库统一任务流；存在真实任务时继续验证完整参数子页面。 */
async function captureGalleryPage(client, directory) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const result = await client.evaluate(String.raw`(async () => {
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '图库');
    if (!navigation) throw new Error('未找到图库导航');
    navigation.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    let invalidPreviewError = '';
    let invalidRevealError = '';
    try { await window.__TAURI_INTERNALS__.invoke('desktop_show_gallery_preview', { id: 'ui-missing-gallery-job' }); } catch (error) { invalidPreviewError = String(error); }
    try { await window.__TAURI_INTERNALS__.invoke('desktop_reveal_local_job_artifact', { id: 'ui-missing-gallery-job' }); } catch (error) { invalidRevealError = String(error); }
    const tabs = [...document.querySelectorAll('.desktop-main > .workspace-page:not([hidden]) > .workspace-tabs button')];
    const cards = [...document.querySelectorAll('.gallery-card')];
    const covers = [...document.querySelectorAll('.gallery-cover')];
    const media = [...document.querySelectorAll('.gallery-cover-media')];
    return { pageVisible: Boolean(document.querySelector('.gallery-page')?.getClientRects().length), legacyWrapperAbsent: !document.querySelector('.gallery-page > .section-card') && !document.querySelector('.gallery-page header'), tabCount: tabs.length, sourceCards: cards.length, redundantLocalTags: document.querySelectorAll('.gallery-card .gallery-source, .gallery-detail-tags > b').length, squareCards: cards.every((card) => Math.abs(card.getBoundingClientRect().width - card.getBoundingClientRect().height) <= 1), squareCovers: covers.every((cover) => Math.abs(cover.getBoundingClientRect().width - cover.getBoundingClientRect().height) <= 1), mediaCount: media.length, completeMediaCount: media.filter((item) => { const image = item.querySelector('.gallery-cover-image'); const backdrop = item.querySelector('.gallery-cover-backdrop'); const style = getComputedStyle(image); return style.objectFit === 'contain' && style.width !== '100%' && style.height !== '100%' && getComputedStyle(backdrop).objectFit === 'cover'; }).length, invalidPreviewBlocked: invalidPreviewError.includes('不存在或已删除'), invalidRevealBlocked: invalidRevealError.includes('不存在或已删除'), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);
  if (!result.pageVisible || !result.legacyWrapperAbsent || result.tabCount !== 0 || result.redundantLocalTags !== 0 || !result.squareCards || !result.squareCovers || result.completeMediaCount !== result.mediaCount || !result.invalidPreviewBlocked || !result.invalidRevealBlocked || result.horizontalOverflow) throw new Error(`图库统一任务流验收失败：${JSON.stringify(result)}`);
  const galleryFile = 'gallery-list.png';
  await writeFile(path.join(targetDirectory, galleryFile), Buffer.from(await client.captureScreenshot(), 'base64'));
  let galleryDetail = null;
  let galleryDetailFile = null;
  if (result.sourceCards > 0) {
    galleryDetail = await client.evaluate(String.raw`(async () => {
      document.querySelector('.gallery-card')?.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      const detail = document.querySelector('.gallery-detail');
      const host = detail?.closest('.desktop-page-host');
      let main = document.querySelector('.gallery-detail-image-main');
      // 本地大图首次进入详情页可能尚未完成解码，必须等真实尺寸可用后再判断完整展示比例。
      const imageDeadline = Date.now() + 3_000;
      while (main && (!main.complete || main.naturalWidth <= 0 || main.naturalHeight <= 0) && Date.now() < imageDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        main = document.querySelector('.gallery-detail-image-main');
      }
      const backdrop = document.querySelector('.gallery-detail-image-backdrop');
      const imageRegion = document.querySelector('.gallery-detail-image.has-preview');
      const actions = [...document.querySelectorAll('.gallery-detail-actions button')].map((button) => button.textContent.trim());
      let completeImage = false;
      let centeredImage = false;
      let backdropCovered = false;
      let imageGeometry = null;
      if (main && backdrop && imageRegion) {
        const mainRect = main.getBoundingClientRect();
        const backdropRect = backdrop.getBoundingClientRect();
        const regionRect = imageRegion.getBoundingClientRect();
        const sourceRatio = main.naturalWidth / main.naturalHeight;
        const renderedRatio = mainRect.width / mainRect.height;
        const mainStyle = getComputedStyle(main);
        completeImage = mainStyle.objectFit === 'contain' && Math.abs(sourceRatio - renderedRatio) <= 0.02 && mainRect.width <= regionRect.width + 1 && mainRect.height <= regionRect.height + 1;
        centeredImage = Math.abs(mainRect.left + mainRect.width / 2 - regionRect.left - regionRect.width / 2) <= 1.5 && Math.abs(mainRect.top + mainRect.height / 2 - regionRect.top - regionRect.height / 2) <= 1.5;
        backdropCovered = getComputedStyle(backdrop).objectFit === 'cover' && backdropRect.width >= regionRect.width && backdropRect.height >= regionRect.height;
        imageGeometry = { sourceRatio, renderedRatio, imageWidth: mainRect.width, imageHeight: mainRect.height, regionWidth: regionRect.width, regionHeight: regionRect.height };
      }
      const hostStyle = host ? getComputedStyle(host) : null;
      const detailStyle = detail ? getComputedStyle(detail) : null;
      const outerScrollOwner = Boolean(hostStyle && ['auto', 'scroll'].includes(hostStyle.overflowY) && detailStyle && !['auto', 'scroll'].includes(detailStyle.overflowY));
      return { visible: Boolean(detail), hasArtifact: Boolean(imageRegion), promptSection: Boolean(document.querySelector('.job-prompt-grid')), taskLogs: Boolean(document.querySelector('.task-log-section .desktop-log-list, .task-log-section .empty-block, .task-log-section .logs-inline-error')), loraSection: Boolean(document.querySelector('.job-lora-gallery, .gallery-detail-section .empty-block')), parameterSection: Boolean(document.querySelector('.job-parameter-panel')), attempts: Boolean(document.querySelector('.job-attempt-list')), previewAction: actions.some((label) => label.includes('预览图片')), revealAction: actions.some((label) => label.includes('文件位置')), completeImage, centeredImage, backdropCovered, imageGeometry, outerScrollOwner, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    })()`);
    const artifactInvalid = galleryDetail.hasArtifact && (!galleryDetail.previewAction || !galleryDetail.revealAction || !galleryDetail.completeImage || !galleryDetail.centeredImage || !galleryDetail.backdropCovered);
    if (!galleryDetail.visible || !galleryDetail.promptSection || !galleryDetail.taskLogs || !galleryDetail.loraSection || !galleryDetail.parameterSection || !galleryDetail.attempts || artifactInvalid || !galleryDetail.outerScrollOwner || galleryDetail.horizontalOverflow) throw new Error(`图库任务详情子页面验收失败：${JSON.stringify(galleryDetail)}`);
    galleryDetailFile = 'gallery-detail.png';
    await writeFile(path.join(targetDirectory, galleryDetailFile), Buffer.from(await client.captureScreenshot(), 'base64'));
    await client.evaluate("document.querySelector('.gallery-detail-back')?.click()");
  }
  return { ...result, galleryDetail, screenshots: [galleryFile, galleryDetailFile].filter(Boolean) };
}

/** 验证设置页全局日志默认范围、真实查询结果和紧凑布局。 */
async function captureDesktopLogs(client, directory) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const result = await client.evaluate(String.raw`(async () => {
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '设置');
    if (!navigation) throw new Error('未找到设置导航');
    navigation.click();
    await new Promise((resolve) => setTimeout(resolve, 160));
    const tab = [...document.querySelectorAll('.workspace-tabs button')].find((button) => button.textContent.trim() === '日志');
    if (!tab) throw new Error('未找到日志设置入口');
    tab.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const page = document.querySelector('.logs-page');
    const range = page?.querySelector('select[aria-label="日志时间范围"]');
    const title = page?.querySelector('.logs-toolbar-title small')?.textContent || '';
    const rows = page?.querySelectorAll('.desktop-log-list article').length || 0;
    return { visible: Boolean(page?.getClientRects().length), defaultRange: range?.value || null, defaultTitle: title, rowCount: rows, filters: page?.querySelectorAll('.logs-filters select').length || 0, copyButton: Boolean(page?.querySelector('button[title="复制当前日志"]')), horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  })()`);
  if (!result.visible || result.defaultRange !== '30' || !result.defaultTitle.includes('最近 30 分钟') || result.rowCount < 1 || result.filters < 3 || !result.copyButton || result.horizontalOverflow) throw new Error(`全局日志页面验收失败：${JSON.stringify(result)}`);
  const screenshot = 'desktop-logs.png';
  await writeFile(path.join(targetDirectory, screenshot), Buffer.from(await client.captureScreenshot(), 'base64'));
  return { ...result, screenshot };
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
    const dependencyPanel = document.querySelector('.dependency-panel');
    const environmentPanel = document.querySelector('.environment-panel');
    const dependencyBounds = dependencyPanel?.getBoundingClientRect();
    const environmentBounds = environmentPanel?.getBoundingClientRect();
    const panelsStacked = Boolean(dependencyBounds && environmentBounds && Math.abs(dependencyBounds.left - environmentBounds.left) < 2);
    return {
      dependencyCards: dependencyCards.length,
      segmenterResources: catalog.resources.filter((resource) => resource.kind === 'segmenter').length,
      summaryCount,
      primaryLabel: document.querySelector('.startup-primary > span')?.textContent || '',
      optionalModelVisible: ['Anime Bulldozer', 'MiaoMiao RealSkin', 'MiaoMiao 3D Harem', 'MiaoMiao Harem'].some((name) => dependencyText.includes(name)),
      dependencyPanelOverflow: Boolean(dependencyPanel && dependencyPanel.scrollHeight > dependencyPanel.clientHeight + 1),
      dependencyCardsContained: Boolean(dependencyBounds && dependencyCards.every((card) => card.getBoundingClientRect().bottom <= dependencyBounds.bottom + 1)),
      stackedPanelsOverlap: Boolean(panelsStacked && dependencyBounds.bottom > environmentBounds.top + 1),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  if (result.dependencyCards < 4 || result.segmenterResources !== 1 || result.summaryCount !== 3 || !['初始化', '启动', '启动中', '运行中', '正在检测', '正在初始化', '正在自检'].includes(result.primaryLabel) || result.optionalModelVisible || result.dependencyPanelOverflow || !result.dependencyCardsContained || result.stackedPanelsOverlap || result.horizontalOverflow) throw new Error(`启动页验收失败：${JSON.stringify(result)}`);
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
    if (["expect-no-gpu", "lora-dialog-only", "gallery-only", "repository-only", "captioning-only", "logs-only"].includes(key)) parsed.set(key, "true");
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
      const grid = pageRoot?.querySelector('.repository-grid');
      const cardHeights = cards.map((card) => card.getBoundingClientRect().height);
      const coverHeights = cards.map((card) => card.querySelector('.repository-cover')?.getBoundingClientRect().height || 0);
      const coverTitles = cards.map((card) => card.querySelector('.repository-card-title strong')).filter(Boolean);
      const imageCards = cards.filter((card) => card.querySelector('.repository-cover-slides > img'));
      const cardActions = cards.map((card) => card.querySelector('.repository-card-action')).filter(Boolean);
      const clippedCriticalContent = cards.filter((card) => {
        const cardBounds = card.getBoundingClientRect();
        const critical = [...card.querySelectorAll('.repository-card-title, .repository-lora-description, .repository-lora-triggers, .repository-card-action')];
        return critical.some((item) => {
          const bounds = item.getBoundingClientRect();
          return bounds.top < cardBounds.top - 1 || bounds.bottom > cardBounds.bottom + 1 || bounds.left < cardBounds.left - 1 || bounds.right > cardBounds.right + 1;
        });
      }).length;
      const clippedCardActions = cardActions.filter((button) => button.scrollHeight > button.clientHeight + 1 || button.scrollWidth > button.clientWidth + 1).length;
      const normalScaleColumns = grid ? await (async () => {
        const documentRoot = document.documentElement;
        const appRoot = document.querySelector('#root');
        const previousScale = documentRoot.style.getPropertyValue('--desktop-font-scale');
        const previousHeight = documentRoot.style.getPropertyValue('--desktop-viewport-height');
        const previousZoom = appRoot?.style.zoom || '';
        // 生产逻辑同时设置 CSS 变量和根节点内联 zoom，验收必须完整模拟同一链路。
        documentRoot.style.setProperty('--desktop-font-scale', '1');
        documentRoot.style.setProperty('--desktop-viewport-height', '100vh');
        if (appRoot) appRoot.style.zoom = '1';
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const count = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
        if (previousScale) documentRoot.style.setProperty('--desktop-font-scale', previousScale); else documentRoot.style.removeProperty('--desktop-font-scale');
        if (previousHeight) documentRoot.style.setProperty('--desktop-viewport-height', previousHeight); else documentRoot.style.removeProperty('--desktop-viewport-height');
        if (appRoot) appRoot.style.zoom = previousZoom;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return count;
      })() : null;
      return {
        cardCount: cards.length,
        emptyVisible: Boolean(empty),
        gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
        normalScaleColumns,
        minimumCardHeight: cardHeights.length ? Math.min(...cardHeights) : null,
        minimumCoverHeight: coverHeights.length ? Math.min(...coverHeights) : null,
        visibleCoverTitles: coverTitles.filter((title) => title.getClientRects().length && title.textContent.trim()).length,
        minimumCoverTitleFontSize: coverTitles.length ? Math.min(...coverTitles.map((title) => Number.parseFloat(getComputedStyle(title).fontSize))) : null,
        coverActions: cards.filter((card) => card.querySelector('.repository-card-media .repository-card-action')).length,
        cardActions: cardActions.length,
        readableCardActions: cardActions.filter((button) => { const style = getComputedStyle(button); return style.color === 'rgb(255, 255, 255)' && Number(style.opacity) >= .8 && style.backgroundColor !== style.color; }).length,
        clippedCriticalContent,
        clippedCardActions,
        coverProgressBars: cards.filter((card) => card.querySelector('.repository-card-media .repository-card-progress')).length,
        loraContents: cards.filter((card) => card.querySelector('.repository-lora-content')).length,
        loraTriggers: cards.filter((card) => card.querySelector('.repository-lora-triggers')).length,
        loraTwoColumnCards: cards.filter((card) => getComputedStyle(card).gridTemplateColumns.split(' ').filter(Boolean).length === 2).length,
        imageCards: imageCards.length,
        containedImageCards: imageCards.filter((card) => getComputedStyle(card.querySelector('.repository-cover-slides > img')).objectFit === 'contain').length,
        blurredImageCards: imageCards.filter((card) => card.querySelector('.repository-cover img.blur')).length,
        exampleCoverTags: cards.filter((card) => card.querySelector('.repository-example-count')).length,
        localCoverTags: cards.filter((card) => [...card.querySelectorAll('.repository-card-tags b, .repository-card-tags i')].some((tag) => tag.textContent.trim() === '本地')).length,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
    const commonInvalid = page.horizontalOverflow || page.localCoverTags > 0 || page.exampleCoverTags > 0 || (page.cardCount > 0 && (page.minimumCoverHeight < 100 || page.visibleCoverTitles !== page.cardCount || page.minimumCoverTitleFontSize < 10 || page.coverActions !== 0 || page.coverProgressBars !== 0 || page.cardActions !== page.cardCount || page.readableCardActions !== page.cardCount || page.clippedCriticalContent !== 0 || page.clippedCardActions !== 0));
    const modelInvalid = pageLabel === "模型仓库" && page.cardCount > 0 && (page.minimumCardHeight < 220 || page.gridColumns !== 6 || page.normalScaleColumns !== 6 || page.containedImageCards !== page.imageCards || page.blurredImageCards !== page.imageCards);
    const loraInvalid = pageLabel === "LoRA 仓库" && page.cardCount > 0 && (page.minimumCardHeight < 140 || page.gridColumns !== 3 || page.normalScaleColumns !== 3 || page.loraContents !== page.cardCount || page.loraTriggers !== page.cardCount || page.loraTwoColumnCards !== page.cardCount);
    if (commonInvalid || modelInvalid || loraInvalid) throw new Error(`${pageLabel} 列表布局、封面动作或下载状态异常：${JSON.stringify(page)}`);
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
        return { visible: Boolean(pageRoot?.querySelector('.repository-detail-hero')), examples: Boolean(pageRoot?.querySelector('.repository-detail-media')), exampleCoverTags: pageRoot?.querySelectorAll('.repository-example-grid article > span').length || 0, relatedJobs: Boolean(pageRoot?.querySelector('.repository-related-jobs')) };
      })()`);
      detailVisible = detailState.visible;
      if (!detailState.visible || !detailState.examples || detailState.exampleCoverTags !== 0 || !detailState.relatedJobs) throw new Error(`${pageLabel} 详情结构不完整或示例封面仍有覆盖标签：${JSON.stringify(detailState)}`);
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
    // 首屏刚出现时仍在提交本地目录数据，先等待一次稳定窗口再测真实导航切换。
    await delay(300);
    const navigationPages = [];
    const pageIsolation = [];
    for (const button of document.querySelectorAll('.desktop-sidebar nav button')) {
      const navigationStartedAt = performance.now();
      button.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const navigationLatencyMs = performance.now() - navigationStartedAt;
      await delay(20);
      const banner = document.querySelector('.environment-banner');
      navigationPages.push({ label: button.textContent.trim(), navigationLatencyMs, bannerVisible: Boolean(banner && banner.getClientRects().length), disabled: button.disabled, coreLocked: button.classList.contains('core-locked'), lockVisible: Boolean(button.querySelector('.navigation-lock')) });
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
    let environmentRefreshFrames = 0;
    let environmentRefreshActive = true;
    const countEnvironmentFrame = () => { if (!environmentRefreshActive) return; environmentRefreshFrames += 1; requestAnimationFrame(countEnvironmentFrame); };
    requestAnimationFrame(countEnvironmentFrame);
    const environmentRefreshStartedAt = performance.now();
    const environment = await window.__TAURI_INTERNALS__.invoke('desktop_inspect_environment');
    const environmentRefreshDurationMs = performance.now() - environmentRefreshStartedAt;
    environmentRefreshActive = false;
    const runtime = await window.__TAURI_INTERNALS__.invoke('desktop_runtime_status');
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
      contentFontScale: Number(getComputedStyle(document.documentElement).getPropertyValue('--desktop-content-font-scale')),
      osVersion: environment.os.version,
      osBuild: environment.os.build,
      osSupported: environment.os.supported,
      totalMemoryBytes: environment.memory.totalBytes,
      environmentIssueCodes: environment.issues.map((issue) => issue.code),
      environmentRefreshDurationMs,
      environmentRefreshFrames,
      backendId: environment.executionBackend.id,
      backendDeviceIndex: environment.executionBackend.deviceIndex,
      runtimeStatus: runtime.status,
      runtimeBackend: runtime.backend,
      runtimeDeviceIndex: runtime.deviceIndex,
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
  const expectedNavigation = ["启动 / 账号", "本地生成", "训练集打标", "LoRA 训练", "模型仓库", "LoRA 仓库", "图库", "设置"];
  const actualNavigation = Array.isArray(result?.navigationPages) ? result.navigationPages.map((item) => item.label) : [];
  if (JSON.stringify(actualNavigation) !== JSON.stringify(expectedNavigation)) throw new Error(`桌面导航结构异常：${actualNavigation.join(" / ")}`);
  if (result.navigationPages.some((item) => !Number.isFinite(item.navigationLatencyMs) || item.navigationLatencyMs > 300)) throw new Error(`桌面分页切换超过 300ms：${JSON.stringify(result.navigationPages.map((item) => ({ label: item.label, latency: item.navigationLatencyMs })))}`);
  if (!Number.isFinite(result.environmentRefreshDurationMs) || (result.environmentRefreshDurationMs > 100 && result.environmentRefreshFrames < 2)) throw new Error(`环境刷新期间 WebView 停止响应：${result.environmentRefreshDurationMs}ms / ${result.environmentRefreshFrames} 帧`);
  const protectedNavigation = result.navigationPages.filter((item) => ["本地生成", "LoRA 训练"].includes(item.label));
  const coreRunning = result.runtimeStatus === "ready";
  if (protectedNavigation.length !== 2 || protectedNavigation.some((item) => coreRunning ? item.disabled || item.coreLocked || item.lockVisible : !item.disabled || !item.coreLocked || !item.lockVisible)) throw new Error(`生成与训练导航门禁未随核心状态同步：${JSON.stringify(protectedNavigation)}`);
  if (!Array.isArray(result.pageIsolation) || result.pageIsolation.some((item) => item.visibleMainPanels !== 1 || item.secondaryCounts.some((count) => count !== 1))) throw new Error("桌面主分页或二级分页存在内容堆叠");
  if (new Set(result.pageIsolation.map((item) => item.mainWidth)).size !== 1) throw new Error("桌面分页切换时滚动条导致主布局宽度抖动");
  if (!Number.isFinite(result.fontScale) || result.fontScale < 1 || result.fontScale > 1.3) throw new Error(`桌面字体缩放不正确：${result.fontScale}`);
  if (!Number.isFinite(result.contentFontScale) || result.contentFontScale < 1 || result.contentFontScale > 1.6) throw new Error(`桌面内容字体缩放不正确：${result.contentFontScale}`);
  const windowsVersionKnown = String(result.osVersion || '').startsWith('10.') && Number(result.osBuild) > 0;
  if (!windowsVersionKnown || result.environmentIssueCodes.includes('windows_version_unknown')) throw new Error(`Windows 版本未被真实识别：${result.osVersion || '空'} / ${result.osBuild || '空'}`);
  if (Number(result.osBuild) >= 17763 && (!result.osSupported || result.environmentIssueCodes.includes('windows_version_unsupported'))) throw new Error(`受支持 Windows 被误判：${result.osVersion} / ${result.osBuild}`);
  if (!Number.isFinite(Number(result.totalMemoryBytes)) || Number(result.totalMemoryBytes) <= 0) throw new Error(`系统内存未被真实识别：${result.totalMemoryBytes}`);
  if (result.backendId === 'nvidia_cuda' && (!Number.isInteger(result.backendDeviceIndex) || result.backendDeviceIndex < 0)) throw new Error('NVIDIA CUDA 后端缺少稳定设备索引');
  if (result.backendId !== 'nvidia_cuda' && result.backendDeviceIndex !== null) throw new Error('非 CUDA 后端错误声明 NVIDIA 设备索引');
  if (result.runtimeStatus === 'ready' && (result.runtimeBackend !== result.backendId || result.runtimeDeviceIndex !== result.backendDeviceIndex)) throw new Error('运行中 Runtime 与当前显卡后端或设备索引不一致');
  // Runtime、自检与必需依赖统一由左下角本地核心承载；其他阻断问题仍使用全局横幅。
  const centralizedCoreIssue = ["本地核心未就绪", "本地核心等待自检", "本地核心不可用", "本地核心错误", "依赖通道未配置", "依赖清单不完整"].some((label) => result.coreStatusText.includes(label));
  if (result.environmentStatus !== "ready" && result.navigationPages.some((item) => !item.bannerVisible) && !centralizedCoreIssue) throw new Error("环境异常既未显示全局横幅，也未集中显示在本地核心");
  // 生成能力未就绪时必须由 Tauri 最终边界拒绝提交，不能只依赖前端按钮禁用。
  if (!result.inferenceReady && !isCoreSubmissionBlocked(result.coreSubmissionError)) throw new Error(`未就绪核心未拒绝生成提交：${result.coreSubmissionError || "无错误"}`);
  if (expectNoGpu) {
    if (result.environmentStatus !== "blocked") throw new Error(`无 GPU 环境状态应为 blocked，实际为 ${result.environmentStatus}`);
    if (result.inferenceReady || result.trainingReady) throw new Error("无 GPU 环境错误开放了生成或训练能力");
    if (!result.bannerText.includes("NVIDIA 或 AMD GPU")) throw new Error("无 GPU 横幅缺少受支持 GPU 后端原因");
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
