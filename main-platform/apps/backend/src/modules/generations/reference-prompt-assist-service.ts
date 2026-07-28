/**
 * 本文件只负责按模型配置分派 AI 提示增强格式。
 * Grok 自然语言、Anima 本地标签和传统扩散格式拥有互不串联的独立提示词流程。
 */
import type { PrismaClient } from '@prisma/client';
import { AnimaPromptAssistService } from './anima-prompt-assist-service.js';
import { DiffusionPromptAssistService } from './diffusion-prompt-assist-service.js';
import { GrokPromptAssistService } from './grok-prompt-assist-service.js';
import type { ReferencePromptAssistInput } from './prompt-assist-shared.js';

export {
  REFERENCE_PROMPT_ASSIST_MAX_IMAGES,
  ReferencePromptAssistError,
} from './prompt-assist-shared.js';

/** AI 提示增强分派服务；只选择一条目标格式链路，链路之间不做二次转换。 */
export class ReferencePromptAssistService {
  private readonly grokService: GrokPromptAssistService;
  private readonly animaService: AnimaPromptAssistService;
  private readonly diffusionService: DiffusionPromptAssistService;

  constructor(prisma: PrismaClient) {
    this.grokService = new GrokPromptAssistService(prisma);
    this.animaService = new AnimaPromptAssistService(prisma);
    this.diffusionService = new DiffusionPromptAssistService(prisma);
  }

  /** 根据任务创建时固化的格式只执行一次对应链路。 */
  async enhance(input: ReferencePromptAssistInput): Promise<string> {
    if (input.promptFormat === 'anima') return this.animaService.enhance(input);
    if (input.promptFormat === 'diffusion') return this.diffusionService.enhance(input);
    return this.grokService.enhance(input);
  }
}
