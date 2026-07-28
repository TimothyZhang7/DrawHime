/** 本文件渲染 Bot 帮助卡片，按每个真实启用命令展示详细说明、格式、示例和别名。 */
import type { BotCommandConfig } from '@aiimage/shared-contracts';
import { Icons } from '../icons.js';
import { renderCard, T, arrayValue, esc, textValue, type UserBadgeData } from '../shared-style-v2.js';

/** 帮助卡片输入；commandConfigs 为新版详细输入，commands 为旧版字符串兜底。 */
export type Data = {
  commands?: string[];
  commandConfigs?: BotCommandConfig[];
  cmdPrefix?: string;
  submitter?: UserBadgeData;
};

type HelpGroup = 'create' | 'query' | 'account' | 'system' | 'admin';

type HelpDef = {
  type: string;
  group: HelpGroup;
  title: string;
  summary: string;
  format: string;
  examples: string[];
  details: string[];
  tips: string[];
  icon: keyof typeof Icons;
  color: string;
};

type HelpItem = HelpDef & {
  command: string;
  aliases: string[];
  enabled: boolean;
};

const GROUP_META: Record<HelpGroup, { title: string; subtitle: string; accent: string }> = {
  create: { title: '创作命令', subtitle: '提交任务、复投、模型选择', accent: '#2563eb' },
  query: { title: '查询命令', subtitle: '任务、统计、站点状态', accent: '#7c3aed' },
  account: { title: '账户命令', subtitle: '余额、充值、绑定、隐私', accent: '#059669' },
  system: { title: '系统命令', subtitle: '帮助、连通、Bot 状态', accent: '#475569' },
  admin: { title: '管理命令', subtitle: '管理员维护入口', accent: '#d97706' },
};

const GROUP_ORDER: HelpGroup[] = ['create', 'query', 'account', 'system', 'admin'];

const HELP_DEFS: HelpDef[] = [
  {
    type: 'draw',
    group: 'create',
    title: '绘图',
    summary: '按当前模型提交图片或视频任务，带图时自动使用参考图模式。',
    format: '{cmd} [m序号] [d秒数 r分辨率 a画幅] <提示词>',
    examples: ['{cmd} 角色立绘，白色长发，蓝色眼睛', '{cmd} m3 d5 r720p a16:9 镜头缓慢推进'],
    details: ['图片模型支持文生图和图生图；视频模型支持文生视频和最多 8 张参考图。', '视频默认 5 秒、720p、16:9，并继续遵守隐私、余额和冷却规则。'],
    tips: ['群内多 Bot 场景会做命令抢占，避免多个 Bot 重复提交。', '提示词越明确越稳定；涉及审核风险时建议调整描述。'],
    icon: 'draw',
    color: '#2563eb',
  },
  {
    type: 'retry',
    group: 'create',
    title: '重试',
    summary: '复用最近一次绘图任务的提示词、参考图、模式和模型重新提交。',
    format: '{cmd}',
    examples: ['{cmd}'],
    details: ['会重新创建任务并重新走扣费、限流和调度。', '只读取当前 QQ 最近一次可重试任务。'],
    tips: ['参考图会沿用原任务真实链路，不需要重新上传。', '适合上游波动或想再抽一次结果时使用。'],
    icon: 'retry',
    color: '#0f766e',
  },
  {
    type: 'model',
    group: 'create',
    title: '模型',
    summary: '查看可用模型，或设置自己的默认绘图模型。',
    format: '{cmd} [模型名]',
    examples: ['{cmd}', '{cmd} gpt-image-2'],
    details: ['不带参数时展示模型列表。', '带模型名时会保存为当前 QQ 的首选模型。'],
    tips: ['模型名必须来自真实绘图服务返回的可用模型。', '提交任务卡片会显示实际使用的模型。'],
    icon: 'model',
    color: '#7c3aed',
  },
  {
    type: 'tasks',
    group: 'query',
    title: '任务',
    summary: '查看自己的最近绘图任务，也可按状态筛选。',
    format: '{cmd} [all|success|failed|running]',
    examples: ['{cmd}', '{cmd} failed', '{cmd} all'],
    details: ['展示真实任务状态、模型、站点、耗时、尝试次数和扣费状态。', '失败任务不会按成功任务展示扣费。'],
    tips: ['运行中、排队、收尾、成功、失败会按主任务真实状态展示。', '想排查失败原因时，先看任务列表再看任务详情。'],
    icon: 'botList',
    color: '#2563eb',
  },
  {
    type: 'generation_stats',
    group: 'query',
    title: '统计',
    summary: '查看绘图使用统计，支持个人统计和全站排行。',
    format: '{cmd} [all]',
    examples: ['{cmd}', '{cmd} all'],
    details: ['默认展示当前 QQ 的总量、今日、近 7 日和成功率。', 'all 展示全站总览与前 10 排行。'],
    tips: ['统计只读取 backend 真实任务、耗时、扣费和 QQ 头像数据。', '排行头像来自 QQ 头像服务，失败时不影响统计。'],
    icon: 'stats',
    color: '#7c3aed',
  },
  {
    type: 'status',
    group: 'query',
    title: '状态',
    summary: '查看绘图站点当前启用状态、连续失败和运行健康。',
    format: '{cmd}',
    examples: ['{cmd}'],
    details: ['适合判断当前是否存在站点波动或自动禁用。', '使用后端真实站点配置和运行字段。'],
    tips: ['连续失败、禁用、队列状态会直接影响调度结果。', '如果站点异常较多，可稍后重试或切换模型。'],
    icon: 'siteStatus',
    color: '#0f766e',
  },
  {
    type: 'info',
    group: 'query',
    title: '站点统计',
    summary: '查看服务、任务、平台、Bot、站点和最近错误的综合面板。',
    format: '{cmd} [error]',
    examples: ['{cmd}', '{cmd} error'],
    details: ['默认复用网页状态页 24 小时真实统计。', 'error 子命令会返回最近错误文本列表。'],
    tips: ['包含服务健康、任务分布、平台概览、Bot、站点和错误。', '用于判断当前整体链路是否健康。'],
    icon: 'siteStatus',
    color: '#475569',
  },
  {
    type: 'balance',
    group: 'account',
    title: '余额',
    summary: '查看当前 QQ 可访问余额和钱包来源。',
    format: '{cmd}',
    examples: ['{cmd}'],
    details: ['会区分免费余额、付费余额、QQ 钱包和 Web 钱包。', '绑定网页账号后可访问两端钱包，但钱包不合并。'],
    tips: ['扣费顺序和余额归属由 backend 钱包逻辑决定。', '余额不足时绘图不会绕过扣费校验。'],
    icon: 'balance',
    color: '#059669',
  },
  {
    type: 'recharge',
    group: 'account',
    title: '充值',
    summary: '使用卡密给当前 QQ 钱包充值。',
    format: '{cmd} <卡密>',
    examples: ['{cmd} ABCD-EFGH-1234'],
    details: ['Bot 端兑换入账 QQ 钱包。', '卡密只能使用一次，后端只保存哈希。'],
    tips: ['兑换成功后会返回新的可用余额。', '不要在公共群暴露卡密。'],
    icon: 'balance',
    color: '#d97706',
  },
  {
    type: 'bind',
    group: 'account',
    title: '绑定',
    summary: '把当前 QQ 身份绑定到网页账号。',
    format: '{cmd} <验证码>',
    examples: ['{cmd} 8F3K2A'],
    details: ['验证码从网页个人中心生成。', '绑定只共享可访问余额，不迁移、不合并钱包。'],
    tips: ['解绑不会删除两端钱包和余额。', '命令里的 QQ 号不会被采信，只使用消息发送者 QQ。'],
    icon: 'bind',
    color: '#2563eb',
  },
  {
    type: 'privacy',
    group: 'account',
    title: '隐私',
    summary: '切换 Bot 端默认图片公开或私密状态。',
    format: '{cmd}',
    examples: ['{cmd}'],
    details: ['只影响后续 Bot 生成任务的默认隐私。', '网页端默认隐私有独立开关。'],
    tips: ['当前命令不修改历史图片。', '单张图片仍可在自己的图库里单独切换隐私。'],
    icon: 'privacyPrivate',
    color: '#475569',
  },
  {
    type: 'help',
    group: 'system',
    title: '帮助',
    summary: '查看当前 Bot 已启用命令、别名和详细用法。',
    format: '{cmd}',
    examples: ['{cmd}'],
    details: ['命令别名会按每个命令独立展示。', '后台禁用的命令不会显示。'],
    tips: ['卡片渲染失败时会退回详细纯文本。', '本卡片内容来自当前真实命令配置。'],
    icon: 'help',
    color: '#111827',
  },
  {
    type: 'ping',
    group: 'system',
    title: '连通',
    summary: '检查 Bot、backend 和绘图服务是否可用。',
    format: '{cmd}',
    examples: ['{cmd}'],
    details: ['用于快速判断 Bot 侧链路是否在线。', '不会创建任务或扣费。'],
    tips: ['返回内容包含 Bot 名称、运行时间、延迟和 Node 版本。', '服务异常时可配合 info 查看更完整状态。'],
    icon: 'ping',
    color: '#2563eb',
  },
  {
    type: 'botlist',
    group: 'system',
    title: 'Bot 列表',
    summary: '查看当前 OneBot 连接和在线 Bot 摘要。',
    format: '{cmd}',
    examples: ['{cmd}'],
    details: ['用于多 Bot 场景确认连接情况。', '只展示连接摘要，不暴露 token。'],
    tips: ['可用于检查 wsproxy 是否有多个 OneBot 实例在线。', '群内多 Bot 同时存在时，以命令抢占和去重逻辑避免重复响应。'],
    icon: 'botList',
    color: '#475569',
  },
  {
    type: 'admin_balance',
    group: 'admin',
    title: '管理员调额',
    summary: '管理员对指定 QQ 或钱包进行余额调整。',
    format: '{cmd} <加/减> <QQ号> <金额>',
    examples: ['{cmd} 加 123456 5', '{cmd} 减 123456 1'],
    details: ['仅管理员可用，普通用户不会通过权限校验。', '余额调整必须走后端真实钱包逻辑。'],
    tips: ['会写入真实余额流水，不允许绕过钱包规则。', '操作前确认目标身份，避免误调。'],
    icon: 'adminBalance',
    color: '#d97706',
  },
];

/** 渲染帮助卡片。 */
export function render(d: Data): string {
  const commands = uniqueCommands(arrayValue<string>(d.commands));
  const configs = normalizeConfigs(d.commandConfigs, commands);
  const items = buildHelpItems(configs, commands);
  const extras = commands.filter((command) => !items.some((item) => [item.command, ...item.aliases].includes(command)));
  const commandCount = items.reduce((sum, item) => sum + 1 + item.aliases.length, 0) + extras.length;
  const aliasCount = items.reduce((sum, item) => sum + item.aliases.length, 0);
  const cmdPrefix = resolveCommandPrefix(commands, textValue(d.cmdPrefix, '/'));
  const body = `
    <div class="help-top">
      <section class="help-title-box">
        <div class="help-eyebrow">DrawHime Command Manual</div>
        <div class="help-title">绘图姬 Bot 命令手册</div>
        <div class="help-sub">每个命令独立展示格式、示例、说明和别名。后台禁用的命令不会展示。</div>
      </section>
      ${topMeter('命令', items.length, '#111827')}
      ${topMeter('触发词', commandCount, '#2563eb')}
      ${topMeter('别名', aliasCount, '#059669')}
    </div>
    <div class="group-stack">
      ${GROUP_ORDER.map((group) => groupBlock(group, items.filter((item) => item.group === group))).join('')}
    </div>
    ${extras.length > 0 ? extraBlock(extras) : ''}
  `;

  return renderCard({
    submitter: d.submitter,
    accent: '#111827',
    icon: Icons.help,
    title: '命令帮助',
    layout: 'wide',
    extraCSS: `
      :root{--w:1060px;--cp:14px 16px 16px}
      .help-top{display:grid;grid-template-columns:minmax(0,1fr) 88px 96px 88px;gap:8px;margin-bottom:9px}
      .help-title-box{position:relative;overflow:hidden;padding:12px 14px;border:0.5px solid #dbe3ea;border-radius:8px;background:linear-gradient(135deg,#ffffff,#f8fafc)}
      .help-title-box:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:#111827}
      .help-eyebrow{font-size:8.5px;font-weight:950;letter-spacing:.12em;text-transform:uppercase;color:${T.soft}}
      .help-title{margin-top:4px;font-size:22px;line-height:1;font-weight:950;color:${T.text}}
      .help-sub{margin-top:6px;font-size:9.5px;font-weight:800;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .top-meter{display:flex;flex-direction:column;align-items:center;justify-content:center;border:0.5px solid #e2e8f0;border-radius:8px;background:#fff}
      .top-meter strong{font-size:24px;line-height:1;font-weight:950;color:var(--c);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
      .top-meter span{margin-top:5px;font-size:8.5px;font-weight:900;color:${T.zinc};white-space:nowrap}
      .group-stack{display:grid;gap:8px}
      .help-group{border:0.5px solid #e2e8f0;border-radius:8px;background:#fff;overflow:hidden}
      .group-head{height:32px;display:flex;align-items:center;gap:8px;padding:0 10px;background:#f8fafc;border-bottom:0.5px solid #edf2f7}
      .group-mark{width:6px;height:19px;border-radius:99px;background:var(--accent);flex-shrink:0}
      .group-title{font-size:11px;font-weight:950;color:${T.text};white-space:nowrap}
      .group-sub{margin-left:auto;font-size:8px;font-weight:850;color:${T.soft};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .command-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:8px}
      .cmd-card{min-width:0;border:0.5px solid #e2e8f0;border-radius:8px;background:#fff;overflow:hidden}
      .cmd-head{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:7px;align-items:center;padding:7px 8px;background:linear-gradient(135deg,var(--soft),#ffffff);border-bottom:0.5px solid #edf2f7}
      .cmd-icon{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:#fff;color:var(--color);border:0.5px solid rgba(255,255,255,.75)}
      .cmd-icon svg{width:14px;height:14px}
      .cmd-title{font-size:10.5px;font-weight:950;color:${T.text};line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cmd-summary{margin-top:2px;font-size:8.2px;line-height:1.25;font-weight:800;color:${T.muted};white-space:normal;word-break:break-word}
      .cmd-primary{font-size:10px;font-weight:950;color:var(--color);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}
      .cmd-body{padding:7px 8px 8px}
      .cmd-format{display:flex;align-items:center;gap:5px;margin-bottom:5px;min-width:0}
      .cmd-format label,.cmd-label{font-size:7.5px;font-weight:950;color:${T.soft};letter-spacing:.04em;white-space:nowrap}
      .cmd-format code{min-width:0;font-size:9px;font-weight:900;color:${T.text};font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cmd-cols{display:grid;grid-template-columns:1.05fr .95fr;gap:6px}
      .cmd-list{display:grid;gap:3px}
      .cmd-list div{font-size:8.2px;line-height:1.32;font-weight:780;color:${T.zinc};word-break:break-word}
      .cmd-list div:before{content:"";display:inline-block;width:4px;height:4px;border-radius:99px;background:var(--color);margin-right:5px;vertical-align:1px;opacity:.75}
      .alias-box{margin-top:6px;display:flex;align-items:flex-start;gap:5px}
      .alias-list{display:flex;flex-wrap:wrap;gap:3px;min-width:0}
      .alias-list span{max-width:94px;height:16px;padding:1px 5px;border-radius:4px;background:#f1f5f9;color:${T.zinc};font-size:7.5px;font-weight:850;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .no-alias{font-size:7.8px;font-weight:820;color:${T.soft}}
      .help-extra{margin-top:8px;border:0.5px solid #e2e8f0;border-radius:8px;background:#fff;overflow:hidden}
      .help-extra-head{height:30px;display:flex;align-items:center;padding:0 10px;background:#f8fafc;border-bottom:0.5px solid #edf2f7}
      .help-extra-head strong{font-size:10.5px;font-weight:950;color:${T.text}}
      .help-extra-list{display:flex;flex-wrap:wrap;gap:4px;padding:8px}
      .help-extra-list span{height:18px;padding:2px 6px;border-radius:5px;background:#f1f5f9;color:${T.zinc};font-size:8px;font-weight:850;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
    `,
    body,
    footer: [`示例：${cmdPrefix}绘图 角色立绘`, `带图发送 ${cmdPrefix}绘图 提示词 可进入图生图`, `${cmdPrefix}info error 查看最近错误`],
  });
}

/** 归一化命令配置；新版直接使用 commandConfigs，旧版 commands 字符串会按类型聚合。 */
function normalizeConfigs(commandConfigs: unknown, commands: string[]): BotCommandConfig[] {
  const configs = arrayValue<BotCommandConfig>(commandConfigs)
    .filter((config) => config && config.enabled !== false && typeof config.command === 'string' && config.command.trim());
  if (configs.length > 0) return configs;
  const byType = new Map<string, string[]>();
  for (const command of commands) {
    const type = inferCommandType(command);
    if (!type) continue;
    const items = byType.get(type) ?? [];
    items.push(command);
    byType.set(type, items);
  }
  return HELP_DEFS
    .filter((def) => byType.has(def.type))
    .map((def) => {
      const triggers = byType.get(def.type) ?? [];
      const primary = pickPrimaryCommand(triggers, def.format.replace('{cmd}', `/${def.title}`));
      return { id: def.type, command: primary, aliases: triggers.filter((trigger) => trigger !== primary), enabled: true, label: def.title, group: def.group };
    });
}

/** 根据真实配置生成帮助项；未知配置会落入额外命令区域。 */
function buildHelpItems(configs: BotCommandConfig[], commands: string[]): HelpItem[] {
  const items: HelpItem[] = [];
  const usedTypes = new Set<string>();
  for (const config of configs) {
    const type = resolveConfigType(config);
    const def = HELP_DEFS.find((item) => item.type === type);
    if (!def || usedTypes.has(def.type)) continue;
    usedTypes.add(def.type);
    const triggers = uniqueCommands([config.command, ...(config.aliases ?? [])]);
    const primary = pickPrimaryCommand(triggers, def.format.replace('{cmd}', `/${def.title}`));
    items.push({
      ...def,
      command: primary,
      aliases: triggers.filter((trigger) => trigger !== primary),
      enabled: config.enabled !== false,
    });
  }
  if (items.length > 0) return sortHelpItems(items);

  // 没有配置对象时，退回旧字符串列表，确保 renderer 预览和旧调用仍可显示完整菜单。
  const fallbackConfigs = normalizeConfigs([], commands);
  if (fallbackConfigs.length === 0) return [];
  return sortHelpItems(buildHelpItems(fallbackConfigs, []));
}

/** 按固定分组和定义顺序排序，避免后台返回顺序导致卡片跳动。 */
function sortHelpItems(items: HelpItem[]): HelpItem[] {
  const order = new Map(HELP_DEFS.map((def, index) => [def.type, index]));
  return [...items].sort((a, b) => (order.get(a.type) ?? 999) - (order.get(b.type) ?? 999));
}

/** 渲染顶部统计。 */
function topMeter(label: string, value: number, color: string): string {
  return `<div class="top-meter" style="--c:${color}"><strong>${formatInt(value)}</strong><span>${esc(label)}</span></div>`;
}

/** 渲染分组块。 */
function groupBlock(group: HelpGroup, items: HelpItem[]): string {
  if (items.length === 0) return '';
  const meta = GROUP_META[group];
  return `<section class="help-group" style="--accent:${meta.accent}">
    <div class="group-head"><span class="group-mark"></span><div class="group-title">${esc(meta.title)}</div><div class="group-sub">${esc(meta.subtitle)}</div></div>
    <div class="command-grid">${items.map((item) => commandCard(item)).join('')}</div>
  </section>`;
}

/** 渲染单个命令详情块。 */
function commandCard(item: HelpItem): string {
  const soft = colorToSoft(item.color);
  const icon = Icons[item.icon] || Icons.help;
  const format = item.format.replace('{cmd}', item.command);
  const examples = item.examples.map((example) => example.replaceAll('{cmd}', item.command));
  return `<article class="cmd-card" style="--color:${item.color};--soft:${soft}">
    <header class="cmd-head">
      <div class="cmd-icon">${icon}</div>
      <div style="min-width:0">
        <div class="cmd-title">${esc(item.title)}</div>
        <div class="cmd-summary">${esc(item.summary)}</div>
      </div>
      <code class="cmd-primary">${esc(item.command)}</code>
    </header>
    <div class="cmd-body">
      <div class="cmd-format"><label>格式</label><code>${esc(format)}</code></div>
      <div class="cmd-cols">
        <div>
          <div class="cmd-label">示例</div>
          <div class="cmd-list">${examples.slice(0, 2).map((text) => `<div>${esc(text)}</div>`).join('')}</div>
        </div>
        <div>
          <div class="cmd-label">说明</div>
          <div class="cmd-list">${[...item.details, ...item.tips].map((text) => `<div>${esc(text)}</div>`).join('')}</div>
        </div>
      </div>
      <div class="alias-box">
        <div class="cmd-label">别名</div>
        ${item.aliases.length > 0 ? `<div class="alias-list">${item.aliases.map((alias) => `<span>${esc(alias)}</span>`).join('')}</div>` : `<div class="no-alias">无额外别名</div>`}
      </div>
    </div>
  </article>`;
}

/** 渲染无法归类但已启用的命令，保证帮助菜单覆盖所有触发词。 */
function extraBlock(commands: string[]): string {
  return `<section class="help-extra">
    <div class="help-extra-head"><strong>其他可用触发词</strong></div>
    <div class="help-extra-list">${uniqueCommands(commands).map((command) => `<span>${esc(command)}</span>`).join('')}</div>
  </section>`;
}

/** 从配置对象推断命令类型，优先稳定 id，其次触发词和卡片类型。 */
function resolveConfigType(config: BotCommandConfig): string | null {
  if (config.id && HELP_DEFS.some((item) => item.type === config.id)) return config.id;
  for (const trigger of [config.command, ...(config.aliases ?? [])]) {
    const type = inferCommandType(trigger);
    if (type) return type;
  }
  for (const cardType of config.cardTypes ?? []) {
    const type = cardTypeToHelpType(cardType);
    if (type) return type;
  }
  return null;
}

/** 通过触发词推断命令类型，和 bot-service 默认路由保持一致。 */
function inferCommandType(command: string): string | null {
  const name = command.replace(/^[^a-zA-Z0-9一-鿿\s]+/, '').trim();
  if (/^(额度|余额)\s+(加|减)\b/i.test(name)) return 'admin_balance';
  if (/^(绘图|生成|draw|generate)\b/i.test(name)) return 'draw';
  if (/^(重试|retry)\b/i.test(name)) return 'retry';
  if (/^(模型|models)\b/i.test(name)) return 'model';
  if (/^(任务|记录|tasks)\b/i.test(name)) return 'tasks';
  if (/^统计\b/i.test(name)) return 'generation_stats';
  if (/^(状态|status|stats)\b/i.test(name)) return 'status';
  if (/^(info|站点统计)\b/i.test(name)) return 'info';
  if (/^(余额|额度|次数)\b/i.test(name)) return 'balance';
  if (/^(充值|兑换|redeem)\b/i.test(name)) return 'recharge';
  if (/^(绑定|bind)\b/i.test(name)) return 'bind';
  if (/^(隐私|privacy)\b/i.test(name)) return 'privacy';
  if (/^(帮助|help)\b/i.test(name)) return 'help';
  if (/^ping\b/i.test(name)) return 'ping';
  if (/^(bot|bots|list)\b/i.test(name)) return 'botlist';
  return null;
}

/** 从卡片类型兜底推断命令类型。 */
function cardTypeToHelpType(cardType: string): string | null {
  const map: Record<string, string> = {
    ping: 'ping',
    help: 'help',
    'bot-list': 'botlist',
    'bot-list-empty': 'botlist',
    'bind-howto': 'bind',
    'bind-success': 'bind',
    'bind-failed': 'bind',
    'balance-success': 'balance',
    'admin-balance': 'admin_balance',
    'draw-submitted': 'draw',
    'draw-submitted-i2i': 'draw',
    'draw-result': 'draw',
    'draw-cooldown': 'draw',
    'draw-quota-exceeded': 'draw',
    'generation-stats': 'generation_stats',
    'site-status': 'status',
    'site-info': 'info',
    'task-list': 'tasks',
    'model-list': 'model',
    'model-switched': 'model',
    'privacy-public': 'privacy',
    'privacy-private': 'privacy',
  };
  return map[cardType] ?? null;
}

/** 去重并过滤空命令，保持后端返回顺序。 */
function uniqueCommands(commands: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of commands) {
    const command = textValue(raw).trim();
    if (!command || seen.has(command)) continue;
    seen.add(command);
    result.push(command);
  }
  return result;
}

/** 优先使用中文命令作为主命令；没有中文时使用第一个触发词。 */
function pickPrimaryCommand(commands: string[], fallback: string): string {
  return commands.find((command) => /[一-鿿]/.test(command)) ?? commands[0] ?? fallback;
}

/** 从真实命令列表里提取当前命令前缀，渲染示例时避免写死斜杠。 */
function resolveCommandPrefix(commands: string[], fallback: string): string {
  const command = commands.find((item) => item.trim().length > 0);
  if (!command) return fallback;
  const match = command.match(/^([^a-zA-Z0-9一-鿿\s]+)/);
  return match?.[1] || fallback;
}

/** 为命令色生成浅底色，避免 help 卡片变成单一蓝色。 */
function colorToSoft(color: string): string {
  const map: Record<string, string> = {
    '#2563eb': '#dbeafe',
    '#0f766e': '#ccfbf1',
    '#7c3aed': '#ede9fe',
    '#059669': '#d1fae5',
    '#d97706': '#fef3c7',
    '#475569': '#f1f5f9',
    '#111827': '#e5e7eb',
  };
  return map[color] ?? '#f1f5f9';
}

/** 格式化整数统计。 */
function formatInt(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('zh-CN');
}
