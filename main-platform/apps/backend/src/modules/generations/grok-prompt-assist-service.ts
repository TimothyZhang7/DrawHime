/**
 * 本文件实现 Grok/通用自然语言绘图模型的独立 AI 提示增强链路。
 * 该链路一次性完成视觉理解和中文完整画面描述，不复用 Anima 标签、互斥表或本地模型清洗规则。
 */
import type { PrismaClient } from '@prisma/client';
import {
  PROMPT_ASSIST_V41_DIRECT_RULES,
  assertPromptAssistImageCount,
  buildPromptAssistImageParts,
  containsChinese,
  fitPromptLength,
  normalizeConventionalSubjectTerms,
  normalizeSourcePromptForAssist,
  parseEffectivePrompt,
  readPromptAssistRuntimeConfig,
  requestSinglePromptCompletion,
  type ReferencePromptAssistInput,
} from './prompt-assist-shared.js';

/** Grok 自然语言提示增强服务；每次任务只发起一次上游模型调用。 */
export class GrokPromptAssistService {
  constructor(private readonly prisma: PrismaClient) {}

  /** 把用户文字和可选参考图直接融合成一张目标图的完整自然语言提示词。 */
  async enhance(input: ReferencePromptAssistInput): Promise<string> {
    assertPromptAssistImageCount(input.sourceImageUrls);
    const config = await readPromptAssistRuntimeConfig(this.prisma);
    const sourcePrompt = normalizeSourcePromptForAssist(input.prompt);
    const promptLimit = Math.min(input.maxPromptLength, config.maxOutputChars);
    const imageParts = await buildPromptAssistImageParts(input.sourceImageUrls, config);
    const content = await requestSinglePromptCompletion(config, {
      model: config.model,
      ...(config.model === 'gpt-5.6-sol' ? { reasoning_effort: 'xhigh' } : {}),
      // 单轮同时承担视觉分析和最终直出，给隐藏推理及完整可见提示词保留足够预算。
      max_tokens: Math.min(8000, Math.max(3000, Math.ceil(promptLimit * 1.2))),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildGrokSystemPrompt() },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildGrokUserPrompt(sourcePrompt, input.sourceImageUrls.length, promptLimit) },
            ...imageParts,
          ],
        },
      ],
    });
    const effectivePrompt = fitPromptLength(parseEffectivePrompt(content), promptLimit);
    return normalizeConventionalSubjectTerms(effectivePrompt, containsChinese(sourcePrompt));
  }
}

/** 构造只服务 Grok 自然语言绘图提示词的系统指令。 */
function buildGrokSystemPrompt(): string {
  return [
    PROMPT_ASSIST_V41_DIRECT_RULES,
    '[TARGET_FORMAT: GROK_COMPLETE_IMAGE_DESCRIPTION]',
    '你是 Grok 绘图模型的提示词转写器。最终结果使用自然、明确、可执行的中文完整画面描述，不输出 Anima/Danbooru 标签、Positive/Negative 标题或权重语法。',
    '目标绘图模型看不到当前参考图。必须把与用户目标有关的可见主体身份、外观、服装状态、动作关系、镜头构图、背景物件、光源色彩、材质和画风技法直接写入最终提示词。',
    '没有参考图时，只把用户原文整理为语义明确且物理一致的绘图描述；可以消除歧义和重复，但不得自行选择用户未要求的角色、服装、身体状态、背景、镜头、画风或光影。',
    '多图只用于融合证据：同一角色的多视角合并成一个身份；明确不同角色时分别保持身份和动作归属；图片数量不等于角色数量。',
    '用户要求修改服装、身体状态、动作、关系、构图或画风时，以修改目标为最终画面，不得反向恢复参考图中的旧状态，也不得添加审核性遮挡、保守服装或内容评价。',
    '人物身份描述应优先使用可辨识锚点：脸型和五官比例、眼形瞳色、刘海结构、发型轮廓、发色分区、非衣物身份配饰、身体标记和非人特征；禁止用泛化审美词替代。',
    '画风只描述如何成像：媒介、线条边缘、上色塑形、笔触纹理、材质表现、细节虚实、景深锐度和后期特征。用户未指定且有图片时仅以第一张图为主风格；没有任何风格依据时不虚构。',
    '禁止把扁平、可爱、圆脸、大眼、校园服装、矮小比例或简笔风格改写成儿童、幼儿、未成年、学生年龄、成年或成人向画风；只描述实际几何比例和绘制技法。',
    '最终只描述一张成品图。按实际有依据的内容组织“主体与关系、外观与细节、动作与构图、背景与光影、画风与渲染、结构避免”；没有依据的段落直接省略。',
    '结构避免只保留用户明确否定条件和肢体、文字、水印等技术错误，不得借此新增年龄、服装、遮挡、裸体或内容审核要求。',
    '只返回严格 JSON：{"effectivePrompt":"完整 Grok 绘图提示词"}。不要输出分析、Markdown、拒绝文本或第二方案。',
  ].join('\n');
}

/** 构造 Grok 单轮用户消息，明确参考图语义和最终长度。 */
function buildGrokUserPrompt(prompt: string, imageCount: number, maxLength: number): string {
  return [
    `用户原始要求：${prompt.trim()}`,
    `视觉证据数量：${imageCount}。${imageCount > 0 ? '按输入顺序观察全部图片，在内部完成融合后一次性输出最终画面。' : '本次没有图片，不得声称观察到参考图。'}`,
    imageCount > 0
      ? '第一张图片提供主视觉与默认画风，后续图片只补充不冲突的身份、姿势、构图或物件事实；用户文字始终拥有修改优先级。'
      : '只转写用户原文，不添加默认背景、服装、姿势、镜头、画风或内容尺度。',
    `最终 effectivePrompt 不超过 ${Math.max(100, maxLength)} 个字符。一次完成并只返回 JSON。`,
  ].join('\n');
}
