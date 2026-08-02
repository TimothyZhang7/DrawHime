/**
 * 本文件负责训练集详情页的专项 WebView 验收，只读取真实训练集并检查滚动与布局，不修改用户数据。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** 验证训练集逐图和批量工作区在常规、紧凑窗口中的滚动归属与可用空间。 */
export async function captureCaptioningWorkspace(client, directory, { requireAssets = false } = {}) {
  const targetDirectory = path.resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const entry = await client.evaluate(String.raw`(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const navigation = [...document.querySelectorAll('.desktop-sidebar nav button')].find((button) => button.textContent.trim() === '训练集打标');
    if (!navigation) throw new Error('未找到训练集打标导航');
    navigation.click();
    await delay(250);
    let page = document.querySelector('.captioning-page');
    if (page && !page.classList.contains('captioning-detail-page')) {
      const candidates = [...page.querySelectorAll('.caption-dataset-grid > button')].map((button) => {
        const count = Number((button.querySelector('small')?.textContent.match(/(\d+)\s*张/) || [])[1] || 0);
        return { button, count };
      }).sort((left, right) => right.count - left.count);
      const target = candidates.find((item) => item.count > 0) || candidates[0];
      target?.button.click();
      const deadline = Date.now() + 3_000;
      while (!document.querySelector('.captioning-detail-page') && Date.now() < deadline) await delay(80);
      page = document.querySelector('.captioning-page');
    }
    const visibleText = page?.textContent || '';
    const declaredAssetCount = Number((page?.querySelector('.caption-detail-header > header > div:first-child > span')?.textContent.match(/(\d+)\s*张/) || [])[1] || 0);
    return {
      libraryVisible: Boolean(document.querySelector('.captioning-library-page')?.getClientRects().length),
      detailVisible: Boolean(page?.classList.contains('captioning-detail-page')),
      assetCount: Math.max(declaredAssetCount, page?.querySelectorAll('.training-asset-list > article').length || 0, page?.querySelectorAll('.training-batch-thumbnails > button').length || 0),
      cleanPresetCount: page?.querySelectorAll('.ai-clean-preset-picker button').length || 0,
      cleanPresetLabels: [...(page?.querySelectorAll('.ai-clean-preset-picker button strong') || [])].map((item) => item.textContent.trim()),
      directCleanAction: [...(page?.querySelectorAll('.ai-clean-submit button') || [])].some((button) => button.textContent.includes('清洗')),
      legacyReviewAbsent: !visibleText.includes('AI 清洗建议') && !visibleText.includes('应用所选建议') && !visibleText.includes('撤销本次清洗'),
      backgroundRemovalAbsent: !visibleText.includes('抠图') && !visibleText.includes('背景移除') && !visibleText.includes('训练图片版本'),
      splitWorkspaceLeaked: Boolean(page?.querySelector('.training-workspace')),
      trainingParametersLeaked: Boolean(page?.querySelector('.desktop-training-parameters')),
    };
  })()`);

  if (!entry.detailVisible) {
    if (requireAssets || !entry.libraryVisible) throw new Error(`训练集专项验收缺少可用训练集：${JSON.stringify(entry)}`);
    return { ...entry, skipped: "当前没有可读取的训练集", screenshots: [] };
  }
  if (requireAssets && entry.assetCount === 0) throw new Error(`训练集专项验收需要至少一张真实图片：${JSON.stringify(entry)}`);
  const expectedPresets = ["角色身份", "画风", "服装 / 物体", "仅纠错", "自定义"];
  if (entry.cleanPresetCount !== expectedPresets.length || JSON.stringify(entry.cleanPresetLabels) !== JSON.stringify(expectedPresets) || !entry.directCleanAction || !entry.legacyReviewAbsent || !entry.backgroundRemovalAbsent || entry.splitWorkspaceLeaked || entry.trainingParametersLeaked) {
    throw new Error(`训练集功能边界验收失败：${JSON.stringify(entry)}`);
  }

  const cards = await inspectCaptioningLayout(client, "cards");
  validateCommonCaptioningState(cards, requireAssets);
  const cardsFile = "captioning-cards-workspace.png";
  await writeFile(path.join(targetDirectory, cardsFile), Buffer.from(await client.captureScreenshot(), "base64"));

  const batch = await inspectCaptioningLayout(client, "batch");
  validateCommonCaptioningState(batch, requireAssets);
  if (batch.assetCount > 0 && (!batch.batchSingleColumn || !batch.thumbnailGridExpanded || batch.thumbnailColumnCount < Math.min(batch.assetCount, 2) || batch.editorWidthRatio < 0.9 || batch.editorHeight > 500 || batch.toolbarRowCount > 1 || batch.visibleTagCount < 1)) {
    throw new Error(`训练集批量工作区布局验收失败：${JSON.stringify(batch)}`);
  }
  const batchFile = "captioning-batch-workspace.png";
  await writeFile(path.join(targetDirectory, batchFile), Buffer.from(await client.captureScreenshot(), "base64"));

  await client.setViewport(720, 560);
  let compact;
  try {
    compact = await inspectCaptioningLayout(client, "batch");
    validateCommonCaptioningState(compact, requireAssets);
    if (compact.assetCount > 0 && (!compact.editorSingleColumn || !compact.thumbnailGridExpanded || compact.editorHeight > 500 || compact.clippedControls.length > 0)) {
      throw new Error(`训练集紧凑窗口布局验收失败：${JSON.stringify(compact)}`);
    }
    const compactFile = "captioning-batch-compact.png";
    await writeFile(path.join(targetDirectory, compactFile), Buffer.from(await client.captureScreenshot(), "base64"));
    compact.screenshot = compactFile;
  } finally {
    await client.clearViewport();
  }

  return {
    ...entry,
    cards: { ...cards, screenshot: cardsFile },
    batch: { ...batch, screenshot: batchFile },
    compact,
    screenshots: [cardsFile, batchFile, compact.screenshot],
  };
}

/** 读取当前训练集真实几何信息；切换只影响前端展示模式，不写入训练集内容。 */
async function inspectCaptioningLayout(client, layout) {
  return client.evaluate(String.raw`(async () => {
    const requestedLayout = ${JSON.stringify(layout)};
    const requestedLabel = requestedLayout === 'cards' ? '逐图卡片' : '批量工作区';
    const switchButton = [...document.querySelectorAll('.training-layout-switch button')].find((button) => button.textContent.includes(requestedLabel));
    switchButton?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const page = document.querySelector('.captioning-detail-page');
    const host = page?.closest('.desktop-page-host');
    const main = page?.closest('.desktop-main');
    const workspace = page?.querySelector('.caption-assets-workspace');
    const assetList = page?.querySelector('.training-asset-list');
    const batchWorkspace = page?.querySelector('.training-batch-workspace');
    const thumbnails = page?.querySelector('.training-batch-thumbnails');
    const editor = page?.querySelector('.training-batch-editor');
    const editorArticle = editor?.querySelector(':scope > article');
    const toolbar = page?.querySelector('.training-batch-toolbar');
    const batchActions = page?.querySelector('.training-batch-actions');
    const tagLists = [...(page?.querySelectorAll('.desktop-caption-tag-list') || [])];
    const verticalOverflow = (element) => element ? getComputedStyle(element).overflowY : null;
    const isOwnVerticalScroller = (element) => ['auto', 'scroll'].includes(verticalOverflow(element));
    const workspaceWidth = batchWorkspace?.getBoundingClientRect().width || 0;
    const editorWidth = editor?.getBoundingClientRect().width || 0;
    const toolbarRects = toolbar ? [...toolbar.children].filter((element) => element.getClientRects().length && !element.classList.contains('training-batch-progress')).map((element) => element.getBoundingClientRect()).sort((left, right) => left.top - right.top) : [];
    const toolbarRows = [];
    for (const rect of toolbarRects) {
      const row = toolbarRows.find((candidate) => rect.top < candidate.bottom - 2 && rect.bottom > candidate.top + 2);
      if (row) {
        row.top = Math.min(row.top, rect.top);
        row.bottom = Math.max(row.bottom, rect.bottom);
      } else {
        toolbarRows.push({ top: rect.top, bottom: rect.bottom });
      }
    }
    const cardHeights = [...(assetList?.children || [])].map((element) => element.getBoundingClientRect().height);
    const controls = [...(page?.querySelectorAll('button, input, select, textarea') || [])].filter((element) => element.getClientRects().length);
    const clippedControls = controls.filter((element) => element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2).map((element) => ({
      tag: element.tagName.toLowerCase(),
      className: element.className || '',
      text: (element.textContent || element.value || '').trim().slice(0, 48),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    return {
      layout: requestedLayout,
      assetCount: requestedLayout === 'cards' ? (assetList?.children.length || 0) : (thumbnails?.children.length || 0),
      hostOverflowY: verticalOverflow(host),
      hostScrollbarGutter: host ? getComputedStyle(host).scrollbarGutter : null,
      hostAtOuterEdge: Boolean(host && main && host.getBoundingClientRect().right >= main.getBoundingClientRect().right - 1),
      detailOverflowY: verticalOverflow(page),
      workspaceOverflowY: verticalOverflow(workspace),
      listOverflowY: verticalOverflow(assetList || batchWorkspace),
      tagOverflowValues: tagLists.map(verticalOverflow),
      independentVerticalScrollers: [page, workspace, assetList, batchWorkspace].filter(isOwnVerticalScroller).length,
      visibleTagCount: tagLists.reduce((count, list) => count + list.children.length, 0),
      batchSingleColumn: !batchWorkspace || getComputedStyle(batchWorkspace).gridTemplateColumns.split(' ').filter(Boolean).length === 1,
      thumbnailGridExpanded: !thumbnails || (getComputedStyle(thumbnails).overflowX === 'visible' && thumbnails.scrollWidth <= thumbnails.clientWidth + 2),
      thumbnailColumnCount: !thumbnails ? 0 : getComputedStyle(thumbnails).gridTemplateColumns.split(' ').filter(Boolean).length,
      editorWidthRatio: workspaceWidth > 0 ? editorWidth / workspaceWidth : 1,
      editorHeight: editorArticle?.getBoundingClientRect().height || 0,
      editorSingleColumn: !editorArticle || getComputedStyle(editorArticle).gridTemplateColumns.split(' ').filter(Boolean).length === 1,
      cardHeight: cardHeights.length ? Math.max(...cardHeights) : 0,
      toolbarRowCount: toolbarRows.length,
      toolbarColumns: toolbar ? getComputedStyle(toolbar).gridTemplateColumns : null,
      batchActionLayout: batchActions ? {
        width: batchActions.getBoundingClientRect().width,
        display: getComputedStyle(batchActions).display,
        columns: getComputedStyle(batchActions).gridTemplateColumns,
        children: [...batchActions.children].map((element) => ({ text: (element.textContent || '').trim().slice(0, 24), width: element.getBoundingClientRect().width, gridColumn: getComputedStyle(element).gridColumn, minWidth: getComputedStyle(element).minWidth })),
      } : null,
      clippedControls,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
}

/** 所有训练集布局都由最外层页面宿主承接纵向滚动，标签框保留自身的细滚动条。 */
function validateCommonCaptioningState(result, requireAssets) {
  const hostScrollable = ["auto", "scroll"].includes(result.hostOverflowY);
  const tagListsScrollable = result.tagOverflowValues.every((value) => value === "auto");
  if (!hostScrollable || result.hostScrollbarGutter !== "auto" || !result.hostAtOuterEdge || result.detailOverflowY !== "visible" || result.workspaceOverflowY !== "visible" || result.listOverflowY !== "visible" || !tagListsScrollable || result.independentVerticalScrollers !== 0 || result.cardHeight > 540 || result.horizontalOverflow || (requireAssets && result.assetCount < 1)) {
    throw new Error(`训练集滚动归属验收失败：${JSON.stringify(result)}`);
  }
}
