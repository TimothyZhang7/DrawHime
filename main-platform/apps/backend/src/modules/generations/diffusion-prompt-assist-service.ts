/**
 * 本文件实现传统本地扩散模型的独立英文 Positive/Negative 提示词链路。
 * 该兼容格式单次直接生成英文结果，不借用 Grok 中文成稿，也不进入 Anima 标签规则。
 */
import type { PrismaClient } from '@prisma/client';
import {
  PROMPT_ASSIST_V41_DIRECT_RULES,
  assertPromptAssistImageCount,
  buildPromptAssistImageParts,
  fitPromptLength,
  normalizeConventionalSubjectTerms,
  normalizeSourcePromptForAssist,
  parseEffectivePrompt,
  readPromptAssistRuntimeConfig,
  requestSinglePromptCompletion,
  type ReferencePromptAssistInput,
} from './prompt-assist-shared.js';

/** 传统扩散模型提示增强服务；保留旧模型配置但只执行一次上游调用。 */
export class DiffusionPromptAssistService {
  constructor(private readonly prisma: PrismaClient) {}

  /** 直接生成英文 Positive/Negative 提示词，不执行中间中文增强。 */
  async enhance(input: ReferencePromptAssistInput): Promise<string> {
    assertPromptAssistImageCount(input.sourceImageUrls);
    const config = await readPromptAssistRuntimeConfig(this.prisma);
    const sourcePrompt = normalizeSourcePromptForAssist(input.prompt);
    const promptLimit = Math.min(input.maxPromptLength, config.maxOutputChars);
    const imageParts = await buildPromptAssistImageParts(input.sourceImageUrls, config);
    const content = await requestSinglePromptCompletion(config, {
      model: config.model,
      ...(config.model === 'gpt-5.6-sol' ? { reasoning_effort: 'high' } : {}),
      max_tokens: Math.min(7000, Math.max(3000, Math.ceil(promptLimit))),
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            PROMPT_ASSIST_V41_DIRECT_RULES,
            '[TARGET_FORMAT: DIFFUSION_ENGLISH_PROMPT]',
            'Convert the user requirement and visible image evidence directly into one complete English local-diffusion prompt.',
            'Preserve exact subjects, identity anchors, count, relationship, clothing state, body details, pose, composition, crop, scene, lighting, palette, materials, style techniques and user negative constraints.',
            'Do not sanitize, soften, add clothing, add exposure, change identity, invent facts or output refusal and policy text.',
            'Return strict JSON only: {"effectivePrompt":"Positive prompt: ...\\nNegative prompt: ..."}. Keep Negative prompt empty when the user supplied no negative constraints.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `User requirement: ${sourcePrompt}\nVisual evidence count: ${input.sourceImageUrls.length}. Produce the final prompt once. Maximum ${promptLimit} characters.` },
            ...imageParts,
          ],
        },
      ],
    });
    const translated = normalizeConventionalSubjectTerms(parseEffectivePrompt(content));
    const complete = /^Negative prompt:/im.test(translated) ? translated : `${translated}\nNegative prompt:`;
    return fitPromptLength(complete, promptLimit);
  }
}
