/**
 * 本文件调用独立平台已有提示辅助端点，把英文 LoRA 训练标签批量翻译为简体中文对照。
 */
import type { TrainingTagTranslationView } from "@drawhime/contracts";

const translationCache = new Map<string, string>();
const maximumCachedTags = 5000;

/** 批量翻译去重后的英文标签；中文结果只用于人工核对，不改写训练 Caption。 */
export async function translateTrainingTags(tags: string[]): Promise<TrainingTagTranslationView> {
  const normalized = [...new Set(tags.map(normalizeTag).filter(Boolean))];
  const missing = normalized.filter((tag) => !translationCache.has(tag));
  if (missing.length > 0) {
    const translated = await requestTranslations(missing);
    for (const item of translated) translationCache.set(item.tag, item.translated);
    trimCache();
  }
  return {
    translations: normalized.flatMap((tag) => {
      const translated = translationCache.get(tag);
      return translated ? [{ tag, translated }] : [];
    }),
  };
}

/** 调用真实 OpenAI 兼容文本模型并要求稳定 JSON 数组。 */
async function requestTranslations(tags: string[]): Promise<Array<{ tag: string; translated: string }>> {
  const baseUrl = requiredEnvironment("PROMPT_ASSIST_BASE_URL").replace(/\/+$/, "").replace(/\/v1$/, "");
  const request = {
    model: requiredEnvironment("PROMPT_ASSIST_MODEL"),
    reasoning_effort: "low",
    max_tokens: Math.min(6000, 400 + tags.length * 24),
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "你是 LoRA 数据集标签翻译器。把每个英文动漫或摄影标签准确翻译为简短简体中文，只输出严格 JSON：{\"translations\":[{\"tag\":\"原标签\",\"translated\":\"中文\"}]}。保持输入顺序和原标签原样，不合并、不遗漏、不增加解释。",
      },
      { role: "user", content: JSON.stringify({ tags }) },
    ],
  };
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${requiredEnvironment("PROMPT_ASSIST_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(translationTimeoutSeconds() * 1000),
    });
  } catch {
    throw new Error("标签翻译请求超时");
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`标签翻译上游调用失败（HTTP ${response.status}）`);
  const items = readTranslationItems(text);
  const resultMap = new Map(items.map((item) => [normalizeTag(item.tag), item.translated.trim()]));
  const result = tags.flatMap((tag) => {
    const translated = resultMap.get(tag);
    return translated ? [{ tag, translated }] : [];
  });
  if (result.length !== tags.length) throw new Error("标签翻译结果不完整");
  return result;
}

/** 解析模型响应并丢弃空值或被篡改的结构。 */
function readTranslationItems(text: string): Array<{ tag: string; translated: string }> {
  let response: { choices?: Array<{ message?: { content?: unknown } }> };
  try { response = JSON.parse(text) as typeof response; } catch { throw new Error("标签翻译上游返回格式不正确"); }
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("标签翻译上游未返回内容");
  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: { translations?: unknown };
  try { parsed = JSON.parse(stripped) as typeof parsed; } catch { throw new Error("标签翻译结果不是有效 JSON"); }
  if (!Array.isArray(parsed.translations)) throw new Error("标签翻译结果缺少 translations");
  return parsed.translations.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.tag === "string" && typeof record.translated === "string" && record.translated.trim()
      ? [{ tag: record.tag, translated: record.translated }]
      : [];
  });
}

/** 统一英文标签空白和大小写，缓存键与训练 Caption 保持一致。 */
function normalizeTag(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 限制进程内翻译缓存大小，避免长期运行持续增长。 */
function trimCache(): void {
  while (translationCache.size > maximumCachedTags) {
    const first = translationCache.keys().next().value;
    if (typeof first !== "string") return;
    translationCache.delete(first);
  }
}

/** 读取必填提示辅助配置，缺失时明确返回未配置错误。 */
function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

/** 标签翻译使用短文本超时，不占用逐图自动打标的长任务窗口。 */
function translationTimeoutSeconds(): number {
  const parsed = Number(process.env.PROMPT_ASSIST_TIMEOUT_SEC || 90);
  return Number.isSafeInteger(parsed) ? Math.min(180, Math.max(30, parsed)) : 90;
}
