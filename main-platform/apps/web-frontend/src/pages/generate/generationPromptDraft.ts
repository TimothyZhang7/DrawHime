/** 本文件管理工具页到绘图页的一次性提示词草稿，避免长 Prompt 暴露在 URL 或被重复消费。 */

const GENERATION_PROMPT_DRAFT_KEY = 'aiimage_generation_prompt_draft_v1';
const MAX_DRAFT_AGE_MS = 30 * 60 * 1000;

/** 工具页写入的绘图提示词草稿。 */
export interface GenerationPromptDraft {
  /** 需要预填到生成页的完整提示词。 */
  prompt: string;
  /** 草稿来源工具。 */
  source: 'image-reverse';
  /** 来源任务 ID，仅用于用户端追踪，不参与提交。 */
  sourceJobId?: string;
  /** 推荐提示词格式；生成页不据此擅自切换模型。 */
  recommendedPromptFormat?: 'anima';
  /** 草稿创建时间。 */
  createdAt: number;
}

/** 保存一次性绘图草稿；调用方负责在存储失败时向用户显示错误。 */
export function saveGenerationPromptDraft(input: Omit<GenerationPromptDraft, 'createdAt'>): void {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('提示词为空');
  const draft: GenerationPromptDraft = { ...input, prompt, createdAt: Date.now() };
  window.sessionStorage.setItem(GENERATION_PROMPT_DRAFT_KEY, JSON.stringify(draft));
}

/** 读取并立即删除一次性草稿；过期或结构异常时不污染生成页。 */
export function takeGenerationPromptDraft(): GenerationPromptDraft | undefined {
  const raw = window.sessionStorage.getItem(GENERATION_PROMPT_DRAFT_KEY);
  window.sessionStorage.removeItem(GENERATION_PROMPT_DRAFT_KEY);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<GenerationPromptDraft>;
    if (value.source !== 'image-reverse' || typeof value.prompt !== 'string' || !value.prompt.trim()) return undefined;
    if (typeof value.createdAt !== 'number' || Date.now() - value.createdAt > MAX_DRAFT_AGE_MS) return undefined;
    return { ...value, prompt: value.prompt.trim() } as GenerationPromptDraft;
  } catch {
    return undefined;
  }
}
