/**
 * 本文件实现独立平台 Anima 提示增强上游调用与确定性格式清洗。
 */

const conflictPairs: ReadonlyArray<readonly [string, string]> = [
  ["from front", "from behind"], ["from above", "from below"], ["looking at viewer", "facing away"],
  ["pov", "full body"], ["close-up", "full body"], ["solo", "hetero"], ["blindfold", "glasses"],
  ["standing sex", "lying"], ["standing sex", "on back"], ["missionary", "doggystyle"],
  ["cowgirl position", "prone bone"], ["spread fingers", "clenched fist"], ["open mouth", "closed mouth"],
  ["rolling eyes", "looking at viewer"], ["spread legs", "legs together"],
];

/** 调用一次真实 OpenAI 兼容端点并返回可直接提交 Anima 的英文提示词。 */
export async function enhanceAnimaPrompt(prompt: string, cacheKey: string): Promise<{ prompt: string; response: { model: string; status: number; contentLength: number } }> {
  const baseUrl = requiredEnvironment("PROMPT_ASSIST_BASE_URL").replace(/\/+$/, "").replace(/\/v1$/, "");
  const model = requiredEnvironment("PROMPT_ASSIST_MODEL");
  const timeoutSeconds = clampInteger(process.env.PROMPT_ASSIST_TIMEOUT_SEC, 90, 10, 180);
  const maxOutputCharacters = clampInteger(process.env.PROMPT_ASSIST_MAX_OUTPUT_CHARS, 5000, 500, 50000);
  const request = {
    model,
    reasoning_effort: process.env.PROMPT_ASSIST_REASONING_EFFORT?.trim() || "high",
    max_tokens: Math.min(6000, Math.max(3000, maxOutputCharacters)),
    response_format: { type: "json_object" },
    prompt_cache_key: cacheKey,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: `用户原始要求：${prompt.trim()}\n本次没有参考图。一次性转换为不超过 ${maxOutputCharacters} 字符的 Anima 英文提示词，只返回 JSON。` },
    ],
  };
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${requiredEnvironment("PROMPT_ASSIST_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch {
    throw new Error("AI 提示增强请求超时，请稍后重试");
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`AI 提示增强上游调用失败（HTTP ${response.status}）`);
  const content = readCompletionContent(text);
  return { prompt: normalizeAnimaPrompt(parseEffectivePrompt(content), maxOutputCharacters), response: { model, status: response.status, contentLength: content.length } };
}

/** 构造只负责忠实转写的 Anima 模型知识。 */
function buildSystemPrompt(): string {
  return [
    "[MODE: DIRECT_ANIMA_PROMPT_TRANSCODER]",
    "把用户要求直接转换为一条可执行的 Anima 英文提示词，不输出分析、解释、警告、替代方案或第二套结果。",
    "只返回严格 JSON：{\"effectivePrompt\":\"one lower-case anima prompt\"}。提示词只有一行，项目用英文逗号加空格分隔。",
    "严格按 count/gender、character、appearance、clothing/state、pose/action、expression、camera、scene、detail/mood 排序。",
    "用户要求是最终目标。不得增加、删除、弱化或扩大用户未要求的角色、关系、动作、服装、身体细节、镜头、场景和画风。",
    "用户未写年龄时不得推断或添加年龄词；女性使用 girl/1girl，男性使用 boy/1boy。单人使用准确人数与 solo。",
    "只保留物理一致的动作、视角和状态，去重并消除互斥标签；复杂关系可在末尾追加一条不含逗号的简短英文绑定句。",
    "用户明确要求的光影、构图、环境、材质、服装状态和否定条件必须保留；未要求的内容不得补写。",
    "提交前内部核对人数、身份、动作归属、槽位顺序、重复项和互斥项，然后只输出最终 JSON。",
  ].join("\n");
}

/** 从兼容响应读取最终文本。 */
function readCompletionContent(text: string): string {
  let body: { choices?: Array<{ message?: { content?: unknown } }> };
  try { body = JSON.parse(text) as typeof body; } catch { throw new Error("AI 提示增强上游返回格式不正确"); }
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  throw new Error("AI 提示增强上游未返回提示词");
}

/** 解析严格 JSON 或兼容的直接文本。 */
function parseEffectivePrompt(content: string): string {
  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>).effectivePrompt ?? (parsed as Record<string, unknown>).prompt;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch { /* 兼容直接正文，由后续确定性校验负责。 */ }
  if (stripped.length > 1) return stripped;
  throw new Error("AI 提示增强上游未返回有效提示词");
}

/** 只做去重、互斥处理和长度限制，不二次改写用户语义。 */
function normalizeAnimaPrompt(value: string, maximumLength: number): string {
  if (/无法协助|不能协助|抱歉|内容政策|i\s+(?:can(?:not|'t)|won't)\s+(?:help|assist|create)|policy|safety guidelines/i.test(value)) throw new Error("AI 提示增强上游没有完成 Anima 提示词转化");
  const segments = [...new Set(value.replace(/^positive prompt\s*[:：]\s*/i, "").replace(/[\r\n;；]+/g, ", ").toLowerCase().split(/[,，]+/).map((item) => item.trim().replace(/\s+/g, " ")).filter(Boolean))];
  for (const [left, right] of conflictPairs) {
    const leftIndex = segments.indexOf(left); const rightIndex = segments.indexOf(right);
    if (leftIndex >= 0 && rightIndex >= 0) segments.splice(Math.max(leftIndex, rightIndex), 1);
  }
  const fitted: string[] = [];
  for (const segment of segments) { if ([...fitted, segment].join(", ").length > maximumLength) break; fitted.push(segment); }
  const normalized = fitted.join(", ");
  if (!normalized || /[\u3400-\u9fff]/.test(normalized)) throw new Error("AI 提示增强未返回有效的 Anima 英文提示词");
  return normalized;
}

/** 读取必填私有环境配置。 */
function requiredEnvironment(key: string): string { const value = process.env[key]?.trim(); if (!value) throw new Error(`缺少必填配置：${key}`); return value; }

/** 把环境整数限制到受控范围。 */
function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number { const parsed = Number(value); return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback; }
