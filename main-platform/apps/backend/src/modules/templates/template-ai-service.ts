/**
 * 本文件实现“普通提示词转绘图模板”的 AI 服务。
 *
 * 约束：
 * - 只调用后台配置的真实 OpenAI 兼容 chat/completions 接口；
 * - API Key 只在服务端读取，不返回给浏览器；
 * - AI 输出必须解析为当前模板格式，校验失败直接报错，不伪造模板成功。
 */
import type { TemplateAiConvertResponse, TemplateVariableType, TemplateVariableView } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { TemplateError } from './template-types.js';

/** 后台配置键：模板 AI 是否启用。 */
const CONFIG_ENABLED = 'template_ai_enabled';
/** 后台配置键：OpenAI 兼容接口 base URL。 */
const CONFIG_BASE_URL = 'template_ai_base_url';
/** 后台配置键：OpenAI 兼容接口 API Key。 */
const CONFIG_API_KEY = 'template_ai_api_key';
/** 后台配置键：模型名称。 */
const CONFIG_MODEL = 'template_ai_model';
/** 后台配置键：温度。 */
const CONFIG_TEMPERATURE = 'template_ai_temperature';
/** 后台配置键：请求超时毫秒。 */
const CONFIG_TIMEOUT_MS = 'template_ai_timeout_ms';
/** 后台配置键：可由管理员覆盖的系统提示词。 */
const CONFIG_SYSTEM_PROMPT = 'template_ai_system_prompt';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1-mini';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_INPUT_PROMPT_LENGTH = 5000;
const MAX_OUTPUT_TEMPLATE_LENGTH = 8000;
const TEMPLATE_VAR_RE = /\{\{([^{}\s:#]+)(?:#([^{}\s:]+))?(?:[:：]([^}]*?))?\}\}/g;

type TemplateAiConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  systemPrompt: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
};

type RawTemplateAiDraft = {
  name?: unknown;
  description?: unknown;
  promptTemplate?: unknown;
  defaultValues?: unknown;
  variables?: unknown;
  size?: unknown;
  quality?: unknown;
  moderation?: unknown;
};

/** 模板 AI 服务，负责把用户普通提示词转成可保存的模板草稿。 */
export class TemplateAiService {
  private readonly prisma = getPrismaClient();

  /** 调用 AI 并返回已经校验过的模板草稿。 */
  async convertPromptToTemplate(rawPrompt: string): Promise<TemplateAiConvertResponse> {
    const prompt = String(rawPrompt ?? '').trim();
    if (!prompt) throw new TemplateError('invalid_request', '请先输入普通绘图提示词');
    if (prompt.length > MAX_INPUT_PROMPT_LENGTH) throw new TemplateError('invalid_request', `提示词不能超过 ${MAX_INPUT_PROMPT_LENGTH} 字`);

    const config = await this.readConfig();
    if (!config.enabled) throw new TemplateError('invalid_request', '后台未启用模板 AI 转换');
    if (!config.apiKey) throw new TemplateError('invalid_request', '后台未配置模板 AI API Key');

    const content = await this.callChatCompletion(config, prompt);
    const parsed = parseAiJson(content);
    return normalizeDraft(parsed);
  }

  /** 从 system_configs 读取模板 AI 配置；密钥只在服务端使用。 */
  private async readConfig(): Promise<TemplateAiConfig> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: [CONFIG_ENABLED, CONFIG_BASE_URL, CONFIG_API_KEY, CONFIG_MODEL, CONFIG_TEMPERATURE, CONFIG_TIMEOUT_MS, CONFIG_SYSTEM_PROMPT] } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const baseUrl = normalizeBaseUrl(map.get(CONFIG_BASE_URL) || DEFAULT_BASE_URL);
    return {
      enabled: map.get(CONFIG_ENABLED) === 'true',
      baseUrl,
      apiKey: String(map.get(CONFIG_API_KEY) ?? '').trim(),
      model: String(map.get(CONFIG_MODEL) ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      temperature: clampNumber(Number(map.get(CONFIG_TEMPERATURE) ?? DEFAULT_TEMPERATURE), 0, 1, DEFAULT_TEMPERATURE),
      timeoutMs: clampNumber(Number(map.get(CONFIG_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS), 5000, 120000, DEFAULT_TIMEOUT_MS),
      systemPrompt: String(map.get(CONFIG_SYSTEM_PROMPT) ?? '').trim() || DEFAULT_TEMPLATE_AI_SYSTEM_PROMPT,
    };
  }

  /** 调用 OpenAI 兼容 chat/completions；非 2xx 或空响应都视为失败。 */
  private async callChatCompletion(config: TemplateAiConfig, userPrompt: string): Promise<string> {
    const url = `${config.baseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user', content: buildUserPrompt(userPrompt) },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new TemplateError('invalid_request', `模板 AI 调用失败：HTTP ${response.status}`);
    }
    let body: ChatCompletionResponse;
    try {
      body = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new TemplateError('invalid_request', '模板 AI 返回不是合法 JSON');
    }
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) throw new TemplateError('invalid_request', '模板 AI 未返回内容');
    return content;
  }
}

/** 构建用户消息；把普通提示词和目标字段明确隔离，减少模型跑偏。 */
function buildUserPrompt(prompt: string): string {
  return [
    '请把下面这段普通图片生成提示词转换为绘图姬模板草稿。',
    '必须只返回一个 JSON 对象，不要 Markdown，不要解释。',
    '',
    '普通提示词：',
    prompt,
  ].join('\n');
}

/** 解析 AI JSON；兼容模型偶尔包裹 ```json 的情况。 */
function parseAiJson(content: string): RawTemplateAiDraft {
  const trimmed = content.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(withoutFence) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as RawTemplateAiDraft;
  } catch {
    throw new TemplateError('invalid_request', '模板 AI 返回格式无法解析');
  }
}

/** 规范并校验 AI 输出，保证一定符合当前模板编辑器格式。 */
function normalizeDraft(raw: RawTemplateAiDraft): TemplateAiConvertResponse {
  const name = clampText(readString(raw.name), 2, 40, '未命名模板');
  const description = clampText(readString(raw.description), 0, 180, '由普通提示词转换生成，可继续调整变量默认值。');
  const promptTemplate = readString(raw.promptTemplate).trim();
  if (!promptTemplate) throw new TemplateError('invalid_request', '模板 AI 没有返回 promptTemplate');
  if (promptTemplate.length > MAX_OUTPUT_TEMPLATE_LENGTH) throw new TemplateError('invalid_request', '模板 AI 返回的模板过长');

  const variables = parseTemplateVariables(promptTemplate);
  if (variables.length === 0) {
    throw new TemplateError('invalid_request', '模板 AI 未生成任何变量占位符');
  }

  const returnedDefaults = readStringRecord(raw.defaultValues);
  const defaultValues: Record<string, string> = {};
  for (const variable of variables) {
    defaultValues[variable.key] = variable.defaultValue || returnedDefaults[variable.key] || variable.key;
  }

  return {
    name,
    description,
    promptTemplate,
    defaultValues,
    variables: variables.map((variable) => ({ ...variable, defaultValue: defaultValues[variable.key] ?? variable.defaultValue })),
    size: normalizeOption(readString(raw.size), ['auto', '1024x1024', '1024x1536', '1536x1024'], 'auto'),
    quality: normalizeOption(readString(raw.quality), ['auto', 'standard', 'hd', 'low', 'medium', 'high'], 'auto'),
    moderation: normalizeOption(readString(raw.moderation), ['auto', 'low'], 'auto'),
  };
}

/** 提取模板变量，变量名、类型和默认值必须匹配当前前端模板语法。 */
function parseTemplateVariables(template: string): TemplateVariableView[] {
  const seen = new Map<string, TemplateVariableView>();
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_VAR_RE.exec(template)) !== null) {
    const key = sanitizeVariableKey(match[1]);
    if (!key || seen.has(key)) continue;
    const type = normalizeVariableType(match[2]);
    const defaultValue = sanitizeDefaultValue(String(match[3] ?? ''));
    seen.set(key, { key, type, defaultValue });
  }
  return [...seen.values()];
}

/** 变量名只能使用模板编辑器支持的安全字符。 */
function sanitizeVariableKey(value: string): string {
  return value.replace(/[{}\s:#：]/g, '').trim().slice(0, 24);
}

/** 默认值不能包含模板定界符，避免嵌套破坏编辑器解析。 */
function sanitizeDefaultValue(value: string): string {
  return value.replace(/[{}]/g, '').trim().slice(0, 120);
}

/** 模板变量类型归一化。 */
function normalizeVariableType(value: string | undefined): TemplateVariableType {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'color' || normalized === '颜色') return 'color';
  if (normalized === 'image' || normalized === 'img' || normalized === '图片' || normalized === '参考图') return 'image';
  return 'text';
}

/** 字符串字段读取。 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 读取默认值对象，只保留字符串值。 */
function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[sanitizeVariableKey(key)] = sanitizeDefaultValue(item);
  }
  return result;
}

/** 限制文本长度；标题等字段为空时用默认值兜底。 */
function clampText(value: string, min: number, max: number, fallback: string): string {
  const text = value.trim();
  if (text.length < min) return fallback;
  return text.slice(0, max);
}

/** 规范枚举选项。 */
function normalizeOption<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

/** 规范 baseUrl，最终请求会追加 /chat/completions。 */
function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_BASE_URL;
}

/** 数值范围限制。 */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 默认系统提示词：严格约束 AI 输出当前模板编辑器可直接读取的 JSON。 */
const DEFAULT_TEMPLATE_AI_SYSTEM_PROMPT = [
  '你是绘图姬 DrawHime 的模板结构化助手。你的任务是把用户的一段普通图片生成提示词，转换成可复用的绘图模板。',
  '你必须只输出一个 JSON 对象，不能输出 Markdown、解释、注释、额外文本或代码块。',
  '输出 JSON 字段必须为：name、description、promptTemplate、defaultValues、variables、size、quality、moderation。',
  'name：中文标题，2 到 40 字，概括模板用途，不要包含“模板”二字堆叠。',
  'description：中文介绍，40 到 180 字，说明适用场景和用户需要填写的内容。',
  'promptTemplate：保留原提示词的核心意图、主体、风格、构图、质量要求、约束和负面约束；把可复用部分变量化。',
  '模板变量语法只能使用：{{变量名}}、{{变量名:默认值}}、{{变量名#颜色:默认值}}、{{变量名#图片:图1}}。',
  '变量名只能使用中文、英文、数字或下划线，不能含空格、冒号、井号、花括号。',
  '变量类型只允许 text、color、image；颜色变量必须用 {{变量名#颜色:#RRGGBB}}；图片变量必须用 {{变量名#图片:图1}}。',
  '必须至少生成 3 个 text 变量，优先抽取主体、动作、场景、风格、服饰、色调、构图、镜头、细节要求等。',
  '如果原提示词提到参考图、图1、图2、角色替换、风格沿用等，必须生成 image 变量，默认值按图1、图2 顺序。',
  '如果原提示词明显包含色彩、主色调、发色、肤色、背景色等可替换颜色，可以生成 color 变量。',
  'defaultValues：对象，key 必须与 promptTemplate 中变量名完全一致，value 为每个变量的默认值。',
  'variables：数组，每项包含 key、type、defaultValue，顺序必须与 promptTemplate 首次出现顺序一致。',
  'size 只能是 auto、1024x1024、1024x1536、1536x1024；不确定时用 auto。',
  'quality 只能是 auto、standard、hd、low、medium、high；不确定时用 auto。',
  'moderation 只能是 auto 或 low；不确定时用 auto。',
  '不得改变用户原始提示词的核心需求，不得添加色情、暴力、违法、诈骗或绕过安全策略的内容。',
  '返回示例：{"name":"角色风格替换","description":"用于把参考图角色融入指定构图...","promptTemplate":"沿用{{构图参考#图片:图1}}的构图，将角色替换为{{角色参考#图片:图2}}中的{{角色特征:发色、服饰、瞳色}}，保持{{画风:原图画风}}，{{质量要求:高细节，结构准确}}","defaultValues":{"构图参考":"图1","角色参考":"图2","角色特征":"发色、服饰、瞳色","画风":"原图画风","质量要求":"高细节，结构准确"},"variables":[{"key":"构图参考","type":"image","defaultValue":"图1"},{"key":"角色参考","type":"image","defaultValue":"图2"},{"key":"角色特征","type":"text","defaultValue":"发色、服饰、瞳色"},{"key":"画风","type":"text","defaultValue":"原图画风"},{"key":"质量要求","type":"text","defaultValue":"高细节，结构准确"}],"size":"auto","quality":"auto","moderation":"auto"}',
].join('\n');
