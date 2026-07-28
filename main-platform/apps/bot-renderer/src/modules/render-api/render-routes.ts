/** bot-renderer 路由 — 24 种独立卡片 + 预览 + 目录 */
import type { IncomingMessage } from 'node:http';
import { ApiErrorCode } from '@aiimage/shared-contracts';
import { isMissingServiceTokenAllowed, sendJson, type Route } from '@aiimage/core-utils';
import { renderHtmlToPng } from '../screenshot/screenshot-service.js';

// 全部 22 张独立卡片
import { render as ping } from '../templates/cards/ping.js';
import { render as balanceSuccess } from '../templates/cards/balance-success.js';
import { render as drawCooldown } from '../templates/cards/draw-cooldown.js';
import { render as drawQuotaExceeded } from '../templates/cards/draw-quota-exceeded.js';
import { render as modelList } from '../templates/cards/model-list.js';
import { render as modelSwitched } from '../templates/cards/model-switched.js';
import { render as privacyPublic } from '../templates/cards/privacy-public.js';
import { render as privacyPrivate } from '../templates/cards/privacy-private.js';
import { render as bindHowto } from '../templates/cards/bind-howto.js';
import { render as bindSuccess } from '../templates/cards/bind-success.js';
import { render as bindFailed } from '../templates/cards/bind-failed.js';
import { render as botList } from '../templates/cards/bot-list.js';
import { render as botListEmpty } from '../templates/cards/bot-list-empty.js';
import { render as adminBalance } from '../templates/cards/admin-balance.js';
import { render as drawResult } from '../templates/cards/draw-result.js';
import { render as drawSubmitted } from '../templates/cards/draw-submitted-v2.js';
import { render as drawSubmittedI2I } from '../templates/cards/draw-submitted-v2.js';
import { render as retryNotify } from '../templates/cards/retry-notify.js';
import { render as errorRetryable } from '../templates/cards/error-retryable.js';
import { render as errorFatal } from '../templates/cards/error-fatal.js';
import { render as siteStatus } from '../templates/cards/site-status.js';
import { render as taskList } from '../templates/cards/task-list.js';
import { render as generationStats } from '../templates/cards/generation-stats.js';
import { render as help } from '../templates/cards/help.js';
import { render as siteInfo, sampleSiteInfoData } from '../templates/cards/site-info.js';

/** Bot 卡片截图倍率；1.5 倍能保持 QQ 内清晰度，同时明显降低截图压缩和传输成本。 */
const CARD_RENDER_SCALE = Number(process.env.CARD_SCALE ?? '1.5');

const CARDS = [
  { type: 'ping', path: '/render/ping', fn: ping, label: 'Ping 响应', sample: { botName:'DrawHime-Bot',uptime:'3h 12m',pingMs:45,memory:'128MB',nodeVersion:'v22.17.1' } },
  { type: 'balance-success', path: '/render/balance-success', fn: balanceSuccess, label: '余额查询', sample: {
    freeBalance:'10.00',
    paidBalance:'5.50',
    totalBalance:'15.50',
    qqNumber:'100000001',
    primaryWallet: { walletId: 1, ownerType: 'qq', ownerKey: '100000001', freeBalance: '6.00', paidBalance: '2.50' },
    linkedWallet: { walletId: 2, ownerType: 'user', ownerKey: '1', freeBalance: '4.00', paidBalance: '3.00' },
    linkedUsername: 'admin',
    linkedUserId: 1,
  } },
  { type: 'draw-cooldown', path: '/render/draw-cooldown', fn: drawCooldown, label: '绘图冷却', sample: { remainingSec: 45 } },
  { type: 'draw-quota-exceeded', path: '/render/draw-quota-exceeded', fn: drawQuotaExceeded, label: '余额不足', sample: {} },
  { type: 'model-list', path: '/render/model-list', fn: modelList, label: '模型列表', sample: { models: ['gpt-image-1', 'dall-e-3', 'sd3', 'flux-pro'], currentModel: 'gpt-image-1' } },
  { type: 'model-switched', path: '/render/model-switched', fn: modelSwitched, label: '模型切换', sample: { modelName: 'dall-e-3' } },
  { type: 'privacy-public', path: '/render/privacy-public', fn: privacyPublic, label: '设为公开', sample: {} },
  { type: 'privacy-private', path: '/render/privacy-private', fn: privacyPrivate, label: '设为私密', sample: {} },
  { type: 'bind-howto', path: '/render/bind-howto', fn: bindHowto, label: '绑定指引', sample: {} },
  { type: 'bind-success', path: '/render/bind-success', fn: bindSuccess, label: '绑定成功', sample: { qqNumber: '100000001', paidBalance: '5.50' } },
  { type: 'bind-failed', path: '/render/bind-failed', fn: bindFailed, label: '绑定失败', sample: { reason: '验证码不存在或已过期' } },
  { type: 'bot-list', path: '/render/bot-list', fn: botList, label: 'Bot 列表', sample: { bots: [{ selfId: '100000001', nickname: '绘图助手', status: 'online' }, { selfId: '100000002', nickname: '测试Bot', status: 'offline' }] } },
  { type: 'bot-list-empty', path: '/render/bot-list-empty', fn: botListEmpty, label: 'Bot 列表(空)', sample: {} },
  { type: 'admin-balance', path: '/render/admin-balance', fn: adminBalance, label: '额度调整', sample: { qqNumber: '100000001', amount: '+5.00', balanceAfter: '15.50' } },
  { type: 'draw-submitted-i2i', path: '/render/draw-submitted-i2i', fn: drawSubmittedI2I, label: '任务提交(图生图)', sample: { prompt: 'a cute cat on a windowsill, soft morning light, cinematic', model: 'gpt-image-1', charged: true, chargedAmount: '0.05', balance: '5.45', imageCount: 3, sourceImageUrls: [], qqNumber: '100000001', nickname: '测试用户', binding: { username: 'admin', userId: 1 }, freeBalance: '10.00', paidBalance: '5.50', taskId: 'b_lo8xk_a1b2_000001', isPrivate: false, estimatedPrice: '0.05' } },
  { type: 'draw-result', path: '/render/draw-result', fn: drawResult, label: '绘图结果', sample: { prompt: 'a cute cat', mode: 'text-to-image', model: 'gpt-image-1', siteName: 'OpenAI', latencySec: 12.5, retryCount: 0, chargedAmount: '0.05', balanceAfter: '15.45', balance: { freeBalance: '10.00', paidBalance: '5.45' } } },
  { type: 'draw-submitted', path: '/render/draw-submitted', fn: drawSubmitted, label: '任务已提交(图生图)', sample: { taskId:'b_lo8xk_a1b2_000001',prompt:'a cute cat on a windowsill, soft morning light, cinematic',mode:'text-to-image',model:'gpt-image-1',charged:true,chargedAmount:'0.05',balance:'5.45',freeBalance:"10.00",paidBalance:"5.50",siteName:'OpenAI',maxAttempts:3 } },
  { type: 'retry-notify', path: '/render/retry-notify', fn: retryNotify, label: '重试通知', sample: { prompt: 'a cute cat', type: 'same_site', attempt: 1, nextAttempt: 2, maxAttempts: 3, siteName: 'OpenAI', model: 'gpt-image-1', error: '请求超时 (timeout 30s)' } },
  { type: 'error-retryable', path: '/render/error-retryable', fn: errorRetryable, label: '可重试错误', sample: { prompt: 'a cute cat', error: '上游 API 503 暂时不可用', balance: '5.45' } },
  { type: 'error-fatal', path: '/render/error-fatal', fn: errorFatal, label: '致命错误', sample: { prompt: 'a cute cat', error: '所有绘图站点均已不可用，请稍后重试', balance: '5.45' } },
  { type: 'site-status', path: '/render/site-status', fn: siteStatus, label: '站点状态', sample: { sites: [{ name: 'OpenAI', isEnabled: true, consecutiveFailures: 0, successRate: 98.5 }, { name: 'StabilityAI', isEnabled: true, consecutiveFailures: 3, successRate: 72 }, { name: 'LocalGPU', isEnabled: false, consecutiveFailures: 5 }] } },
  { type: 'task-list', path: '/render/task-list', fn: taskList, label: '任务列表', sample: { tasks: [{ id:'b_xx',status:'success',prompt:'a cute cat',mode:'text-to-image',model:'gpt-image-1',siteName:'OpenAI',createdAt:'2026-06-07T12:00:00+08:00',latencySec:'3.2',retryCount:0,charged:true,chargedAmount:'0.05' },{ id:'b_yy',status:'failed',prompt:'test',mode:'image-to-image',model:'gpt-image-1',siteName:'OpenAI',createdAt:'2026-06-07T11:00:00+08:00',retryCount:1,imageCount:2,charged:false }], filter:'all',total:25,cmdPrefix:'#' } },
  { type: 'generation-stats', path: '/render/generation-stats', fn: generationStats, label: '生成统计', sample: { scope: 'all', generatedAt: '2026-06-16T22:30:00+08:00', buckets: [{ key:'total',label:'累计',total:1288,success:1102,failed:162,active:24,successRate:85.6,imageToImage:830,textToImage:458,attempts:1740,failedAttempts:392,avgLatencyMs:42800,chargedAmount:'64.40' }, { key:'today',label:'今日',total:86,success:72,failed:8,active:6,successRate:83.7,imageToImage:54,textToImage:32,attempts:113,failedAttempts:21,avgLatencyMs:39200,chargedAmount:'4.30' }, { key:'7d',label:'近 7 日',total:512,success:438,failed:62,active:12,successRate:85.5,imageToImage:330,textToImage:182,attempts:690,failedAttempts:142,avgLatencyMs:41700,chargedAmount:'25.60' }], ranking: [{ rank:1,qqNumber:'100000001',avatarUrl:'https://q.qlogo.cn/headimg_dl?dst_uin=100000001&spec=100',total:188,success:170,failed:14,successRate:90.4,todayTotal:12,lastTaskAt:'2026-06-16T22:20:00+08:00' }] } },
  { type: 'site-info', path: '/render/site-info', fn: siteInfo, label: '站点信息', sample: sampleSiteInfoData() },
  { type: 'help', path: '/render/help', fn: help, label: '帮助', sample: {
    cmdPrefix: '#',
    commands: ['#绘图', '#生成', '#draw', '#重试', '#retry', '#模型', '#任务', '#记录', '#统计', '#状态', '#info', '#余额', '#充值', '#绑定', '#隐私', '#帮助', '#help', '#ping', '#bot', '#bots', '#list', '#额度 加', '#额度 减', '#余额 加', '#余额 减'],
    commandConfigs: [
      { id: 'draw', command: '#绘图', aliases: ['#生成', '#draw', '#generate'], enabled: true, label: '绘图' },
      { id: 'retry', command: '#重试', aliases: ['#retry'], enabled: true, label: '重试' },
      { id: 'model', command: '#模型', aliases: ['#models'], enabled: true, label: '模型' },
      { id: 'tasks', command: '#任务', aliases: ['#记录', '#tasks'], enabled: true, label: '任务' },
      { id: 'generation_stats', command: '#统计', aliases: [], enabled: true, label: '统计' },
      { id: 'status', command: '#状态', aliases: ['#status', '#stats'], enabled: true, label: '状态' },
      { id: 'info', command: '#info', aliases: ['#站点统计'], enabled: true, label: '站点统计' },
      { id: 'balance', command: '#余额', aliases: ['#额度', '#次数'], enabled: true, label: '余额' },
      { id: 'recharge', command: '#充值', aliases: ['#兑换', '#redeem'], enabled: true, label: '充值' },
      { id: 'bind', command: '#绑定', aliases: ['#bind'], enabled: true, label: '绑定' },
      { id: 'privacy', command: '#隐私', aliases: ['#privacy'], enabled: true, label: '隐私' },
      { id: 'help', command: '#帮助', aliases: ['#help'], enabled: true, label: '帮助' },
      { id: 'ping', command: '#ping', aliases: [], enabled: true, label: '连通' },
      { id: 'botlist', command: '#bot', aliases: ['#bots', '#list'], enabled: true, label: 'Bot 列表' },
      { id: 'admin_balance', command: '#额度 加', aliases: ['#额度 减', '#余额 加', '#余额 减'], enabled: true, label: '管理员调额' },
    ],
  } },
] as const;

/** 在卡片 HTML 的 hero 区域末注入用户徽章 */
export function createRenderRoutes(): Route[] {
  const result: Route[] = [
    { method: 'POST', path: '/render/screenshot', handle: renderScreenshot },
    { method: 'GET', path: '/render/catalog', handle: (_req, res) =>
      sendJson(res, 200, { ok: true, data: CARDS.map(c => ({ path: c.path, label: c.label, type: c.type })) }) },
    { method: 'GET', path: '/render/preview/:type', handle: async (req, res, params) => {
      const card = CARDS.find(c => c.type === (params?.type ?? ''));
      if (!card) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '未知卡片类型' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const png = url.searchParams.has('png') && url.searchParams.get('png') !== '0';
      const data: Record<string, unknown> = { ...card.sample };
      for (const [k, v] of url.searchParams) {
        if (k === 'png' || k === 't') continue;
        if (v === 'true') { data[k] = true; continue; }
        if (v === 'false') { data[k] = false; continue; }
        if (/^\d+$/.test(v)) { data[k] = Number(v); continue; }
        data[k] = v;
      }
      let html = '';
      try {
        html = card.fn(data as any);
      } catch (error) {
        logRenderError(`preview-template:${card.type}`, error);
        return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError as any, message: '卡片模板渲染失败' });
      }
      if (png) {
        try {
          const w = Number(url.searchParams.get('w') || '780');
          const scale = Number(url.searchParams.get('scale') || CARD_RENDER_SCALE);
          const img = await renderHtmlToPng(html, { width: w, deviceScaleFactor: scale });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
          res.end(img);
        } catch (error) {
          logRenderError(`preview:${card.type}`, error);
          return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError as any, message: '截图失败' });
        }
      } else {
        const buffer = Buffer.from(html, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buffer.length });
        res.end(buffer);
      }
    }},
    // POST 预览：接受 JSON body 作为卡片数据
    { method: 'POST', path: '/render/preview/:type', handle: async (req, res, params) => {
      const card = CARDS.find(c => c.type === (params?.type ?? ''));
      if (!card) return sendJson(res, 404, { ok: false, code: ApiErrorCode.NotFound, message: '未知卡片类型' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const png = url.searchParams.has('png') && url.searchParams.get('png') !== '0';
      const body = await readBody(req).catch(() => ({}));
      const data: Record<string, unknown> = { ...card.sample, ...body };
      let html = '';
      try {
        html = card.fn(data as any);
      } catch (error) {
        logRenderError(`preview-template:${card.type}`, error);
        return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError as any, message: '卡片模板渲染失败' });
      }
      if (png) {
        try {
          const w = Number(url.searchParams.get('w') || '780');
          const scale = Number(url.searchParams.get('scale') || CARD_RENDER_SCALE);
          const img = await renderHtmlToPng(html, { width: w, deviceScaleFactor: scale });
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
          res.end(img);
        } catch (error) {
          logRenderError(`preview:${card.type}`, error);
          return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError as any, message: '截图失败' });
        }
      } else {
        const buffer = Buffer.from(html, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buffer.length });
        res.end(buffer);
      }
    }},
  ];

  for (const c of CARDS) {
    result.push({ method: 'POST', path: c.path, handle: createHandler(c.fn) });
  }

  return result;
}

function createHandler(fn: (body: any) => string): Route['handle'] {
  return async (req, res) => {
    if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden, message: '服务间 token 不正确' });
    const body = await readBody(req);
    // 模板异常必须在 renderer 内记录清楚，避免 Bot 侧只能看到 status=500。
    let html = '';
    try {
      html = fn(body as any);
    } catch (error) {
      logRenderError(req.url ?? 'unknown', error);
      return sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError as any, message: '卡片模板渲染失败' });
    }
    return sendCardImage(res, html);
  };
}

async function renderScreenshot(req: IncomingMessage, res: Parameters<typeof sendJson>[0]) {
  if (!verifyToken(req)) return sendJson(res, 403, { ok: false, code: ApiErrorCode.Forbidden as any, message: '服务间 token 不正确' });
  const body = await readBody(req);
  const html = String(body.html ?? '');
  if (!html) return sendJson(res, 400, { ok: false, code: ApiErrorCode.BadRequest as any, message: '缺少 html 参数' });
  await sendCardImage(res, html);
}

function verifyToken(req: IncomingMessage): boolean {
  const expected = process.env.WS_PROXY_TOKEN?.trim();
  if (!expected) return isMissingServiceTokenAllowed();
  return String(req.headers['x-service-token'] ?? '').trim() === expected;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function sendCardImage(res: Parameters<typeof sendJson>[0], html: string): Promise<void> {
  try {
    const png = await renderHtmlToPng(html, { width: 960, deviceScaleFactor: CARD_RENDER_SCALE });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
  } catch (error) {
    logRenderError('screenshot', error);
    sendJson(res, 500, { ok: false, code: ApiErrorCode.InternalError as any, message: '截图失败' });
  }
}

/** 统一记录 renderer 异常，日志只写类型和错误摘要，不输出 HTML 或敏感请求头。 */
function logRenderError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[bot-renderer] ${scope} failed: ${message}`);
}
