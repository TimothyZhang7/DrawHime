/**
 * 本文件实现导航工作台多模态聊天模型调用。
 *
 * 工作台默认是可交流的 AI 助手：文本和图片上下文会调用后台配置的 OpenAI 兼容 chat/completions。
 * 同一对话窗口内会先由模型判断用户意图，明确需要生成图片时才进入真实绘图任务链路。
 */
import type { GenerationTaskView, WorkbenchAttachmentView, WorkbenchMessageView } from '@aiimage/shared-contracts';
import { getPrismaClient } from '../../infrastructure/database/prisma-client.js';
import { GenerationsService } from '../generations/generations-service.js';
import { WorkbenchAttachmentService } from './workbench-attachment-service.js';
import {
  CHAT_RESPONSE_TOOL,
  GENERATION_LOOKUP_TOOL,
  IMAGE_GENERATION_TOOL,
  type ChatCompletionResponse,
  type ChatCompletionMessage,
  type ChatCompletionOptions,
  type ChatContentPart,
  type WorkbenchActionContext,
  type WorkbenchActionDecision,
  buildDecisionUserText,
  clampNumber,
  formatHistoryMessage,
  normalizeBaseUrl,
  parseActionDecision,
  parseToolDecision,
  readChatContent,
  readStreamPart,
} from './workbench-agent-helpers.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4.1-mini';

/** 本地绘图提示词规范：用于约束工作台 Agent 产出的真实绘图 prompt，不能被后台自定义系统提示词绕过。 */
const WORKBENCH_DRAWING_PROMPT_CONSTRAINTS = [
  '【本地绘图提示词规范】',
  '生成或改写绘图 prompt 时必须按“主体/意图 → 场景与背景 → 构图与镜头 → 风格与媒介 → 光影色彩 → 关键细节 → 质量要求 → 约束/禁止项”的顺序组织；不要只堆砌质量词。',
  'prompt 必须描述最终画面本身，不写“请生成、帮我画、你需要、确认后、点击按钮、任务、余额、平台、模型会”等流程说明。',
  '文生图 prompt 必须明确主体数量、主体身份或外观、动作姿态、环境、构图、风格、光影、画幅用途；用户只给短词时要补全为可复现画面。',
  '图生图 prompt 必须明确图1/图2等参考关系：基底图、角色参考、风格参考、要保留的构图/姿态/表情/画风/色调、要修改的区域、禁止改变的内容。',
  '局部编辑必须把“只修改什么、保持什么完全不变、禁止新增什么”写清楚；角色替换必须区分身体姿态/构图优先级与角色特征迁移项。',
  '多参考图必须逐张编号说明用途，不能笼统写“参考图片”；只需要一张图时不要强行引用其他历史图片。',
  '用户指定作品名、角色名、品牌名、专有名词、具体风格词时必须原样保留，不要改写成泛化替代词；但不要伪称官方、不要要求添加 logo/UI/水印，除非用户明确需要文字设计。',
  '每个候选方案必须独立完整，禁止使用“同上、如上、上述、省略、见上、完整提示词、...（同上）”等占位表达。',
  '提示词应使用具体视觉名词和可执行约束，避免空泛词堆叠；质量词最多作为结尾补充，不能替代主体、构图和编辑要求。',
].join('\n');

const DEFAULT_SYSTEM_PROMPT = [
  '你是绘图姬 DrawHime 的工作台 Agent，不是闲聊软件。',
  '你的目标是理解用户意图、维护上下文、选择工具、提交绘图任务、查询任务详情，并把工具结果解释清楚。',
  '当用户要求生成图片、确认上文方案生成、查看任务状态或排查任务时，优先通过后端工具处理，不要只继续输出文本。',
  '生成图片工具只会给出待确认方案；只有用户点击某个方案后，后端才会创建真实任务和扣费。',
  '普通聊天只用于澄清需求、整理方案、分析图片或给出可复制提示词；聊天时不要声称已经创建任务。',
  '当前 Agent 可以提交文生图和图生图：用户本轮带图片并要求参考、替换、保持构图、换背景、改风格或编辑图片时，应通过工具生成图生图待确认方案。',
  '生成或改写绘图方案时，必须保留用户明确写出的作品名、角色名、品牌名、专有名词和风格关键词；不要擅自抽象成泛化描述，也不要编造“系统限制所以不能写”的解释。',
  '回答优先使用中文，除非用户明确要求其他语言。保持具体、可操作，避免空泛套话和营销腔。',
  WORKBENCH_DRAWING_PROMPT_CONSTRAINTS,
].join('\n');

const TOOL_ROUTER_SYSTEM_PROMPT = [
  '你是绘图姬 DrawHime 工作台 Agent 的工具路由器。你必须严格判断当前用户消息需要调用哪个真实工具。',
  '你必须通过工具调用返回判断结果，只能三选一：submit_image_generation_task、inspect_generation_task、respond_without_tool。',
  '用户明确要求生成、画、做一张、出图、创建头像/插画/海报/壁纸/logo 等真实图片产出时，调用 submit_image_generation_task 生成待确认方案。',
  '用户对上文完整绘图方案说“确认生成、直接生成、就按这个生成、按上面生成、开始吧、可以、OK、就这样”时，仍调用 submit_image_generation_task 生成候选方案，不能直接创建任务。',
  '用户要求查看任务、任务详情、进度、状态、失败原因，且消息或上下文有任务 ID 时，调用 inspect_generation_task。',
  '用户只是聊天、分析图片、描述图片、反推图片、改写 prompt、询问建议、比较方案、要求给一段文本时，调用 respond_without_tool。',
  '用户上传图片并要求替换、保持构图、图生图编辑、参考图迁移、换背景、改风格或生成参考图变体时，调用 submit_image_generation_task，mode=image-to-image。',
  // 角色延展类需求依赖历史图片身份特征，必须由 AI 走图生图而不是重新文生图。
  '用户要求把已上传、已描述或已分析的头像/半身图补全为完整角色、全身立绘、角色设定图，或要求同角色新姿势、新服装、新背景、新风格时，调用 submit_image_generation_task，mode=image-to-image。',
  '用户只说“重新生成、再生成一次、再来一张、换一张、重抽一张”等重新出图请求时，默认沿用上一轮主题和文字要求做 text-to-image，不要把上一张结果图作为参考图；只有用户明确说“基于这张、参考上一张、优化这张、重绘这张、把这张改成、保持构图/角色/姿势/画风”等才用 image-to-image。',
  '用户上传图片但只是要求分析、描述、反推、提取提示词或询问建议时，调用 respond_without_tool。',
  '调用生成工具时，必须给出 2-4 个候选方案；每个方案的 prompt 必须是完整中文正向绘图提示词，融合本窗口上下文中仍然有效的主体、风格、构图、镜头、质量要求和本轮新增要求。图生图 prompt 必须写清图1/图2等参考关系、保持项、替换项和禁止项；角色补全/同角色延展时必须写清以选中参考图角色为图1，保留脸部、发色、眼镜、气质等核心特征，再补全全身、服装、姿态或背景。',
  '用户明确指定作品名、角色名、品牌名、专有名词或风格关键词时，options.prompt 必须原样保留这些词，并围绕这些词补充画面要求；不要把“原神”等明确主题改写为泛化的“日式开放世界游戏”。',
  '每个候选方案的 prompt 都必须独立完整，不得写“同上、如上、上述、完整提示词、省略、见上、...（同上完整提示词）”等占位文本。',
  'prompt 不要写“请生成/帮我画/出图”等命令句，不要包含价格、余额、任务 ID、确认流程或平台说明。',
  '如果上下文中用户修改了前面的要求，以最新明确要求为准；冲突时保留最新要求，不要机械拼接旧内容。',
  WORKBENCH_DRAWING_PROMPT_CONSTRAINTS,
].join('\n');

const LEGACY_INTENT_SYSTEM_PROMPT = [
  '你是绘图姬 DrawHime 工作台的意图路由器，只能返回 JSON，不要返回 Markdown。',
  '注意：后端真实存在绘图工具和任务查询工具，你只负责选择 action；不要回答“当前工作台不支持直接调用绘图工具”。',
  '判断用户本轮是否要调用工具：draw 表示生成待确认绘图方案，inspect 表示查看任务详情，chat 表示只回复文本。',
  '用户明确要求“生成、画、做一张、出图、创建海报/头像/插画/壁纸/logo”，或对上文最终绘图方案说“开始吧、可以、OK、确认、就这样、按上面生成”时，action 必须是 draw。',
  '用户要求查看任务状态/详情且有任务 ID 时，action 必须是 inspect。',
  '如果用户只是聊天、分析图片、描述图片、改写提示词、询问建议、比较方案、要一段 prompt 文本，action 必须是 chat。',
  '如果用户上传参考图并要求编辑已有图、替换、保持构图、图生图、改背景或风格迁移，action 必须是 draw，mode 必须是 image-to-image。',
  // 兼容不支持 tools 的上游：同样要求 AI 把历史角色补全判断为图生图。
  '如果用户要求把已上传、已描述或已分析的头像/半身图补全为完整角色、全身立绘、角色设定图，或要求同角色新姿势、新服装、新背景、新风格，action 必须是 draw，mode 必须是 image-to-image。',
  '如果用户只说“重新生成、再生成一次、再来一张、换一张、重抽一张”等重新出图请求，action 必须是 draw，mode 必须是 text-to-image，并沿用上一轮主题和文字要求，不要自动参考上一张结果图。',
  '如果用户上传参考图但只要求分析、反推、描述或放大图片，action 必须是 chat。',
  '返回格式严格为 {"action":"chat|draw|inspect","mode":"text-to-image|image-to-image","prompt":"draw 推荐方案的完整中文提示词，其他为空字符串","options":[{"id":"opt_1","title":"短标题","reason":"方案特点","prompt":"完整提示词"}],"taskId":"inspect 时的任务ID","title":"短标题","reason":"简短原因"}。',
  'draw 的每个 options.prompt 都必须独立完整，禁止使用“同上、如上、完整提示词、省略、见上”等占位文本。',
  'draw 的每个 options.prompt 必须保留用户明确指定的作品名、角色名、品牌名、专有名词和风格关键词，不要擅自去名称化或泛化改写。',
  WORKBENCH_DRAWING_PROMPT_CONSTRAINTS,
].join('\n');

const IMAGE_SELECTION_SYSTEM_PROMPT = [
  '你是绘图姬 DrawHime 工作台的图片上下文选择器。',
  '你只能根据用户本轮消息和图片索引选择本轮确实需要读取内容的图片，不要选择无关图片。',
  '如果用户只说“重新生成、再生成一次、再来一张、换一张、重抽一张”，且没有明确要求参考/基于/优化/重绘/修改上一张图，返回空数组，让后续按上一轮文字主题重新文生图。',
  '如果用户说“不要参考图片、不用参考图、不要用上一张、纯文生图、不要图生图”，返回空数组。',
  '如果用户说“这张图、刚上传的图、图1/图2、参考图、用这几张、替换/保持构图/换背景/看图分析”，优先选择本轮上传图片。',
  '如果用户说“本次生成的图片、刚生成的图、刚才生成的图、上一张结果图、上个成图、把这次结果改成”，必须优先选择最近成功生成结果图，而不是原始上传参考图。',
  '如果用户说“上一张图、刚才那张、前面的图、上个参考图”，选择最近历史图片；如果索引里同时有历史生成结果图和历史上传附件，按用户措辞区分结果图与参考图。',
  '如果用户本轮上传了新图，同时说“把该图片/这张图/当前图中的角色替换为上一张图/刚才生成图/本次生成图的角色”，必须同时选择两张：本轮上传图作为图1基底，最近成功生成结果图作为图2角色来源。',
  // 头像补全、同角色延展等承接需求必须让 AI 先拿到最近图片，后续路由才能准确走图生图。
  '如果用户在历史中已经上传、描述或分析过图片，随后要求“生成完整角色立绘、补全全身、扩展成全身、生成设定图、同角色立绘、基于刚才这个角色继续生成、新姿势/新服装/新背景”，应选择最近相关历史图片；本轮没有新上传图时优先选择最近历史参考图。',
  '如果用户使用“该角色、这个角色、她、他、它、这张图”这类单数指代，通常只能选择 1 张最近相关图片；只有用户明确说“图一和图二、两张、多张、三张、合影、合集、组合、对比”时才选择多张。',
  '如果同时存在本轮上传图和历史图片，用户明确说“本轮/这张/刚上传”时选择本轮图；用户明确说“刚才描述的图片/上面那个角色/上一张图”时选择对应历史图。',
  '如果用户没有要求看图、改图或参考图，返回空数组。',
  '只返回 JSON：{"selectedIds":["图片ID"],"reason":"一句话原因"}。',
].join('\n');

type WorkbenchAiConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  systemPrompt: string;
  maxOutputChars: number;
};

type WorkbenchImageCandidate = {
  id: string;
  label: string;
  attachment?: WorkbenchAttachmentView;
  generation?: {
    taskId: string;
    imageUrl: string;
    thumbnailUrl?: string;
  };
  source: 'current' | 'history' | 'generation';
  summary: string;
};

type SelectedWorkbenchImage = WorkbenchImageCandidate;

const MAX_IMAGE_CANDIDATES = 16;
const MAX_ROUTER_IMAGES = 3;
const MAX_CHAT_IMAGES = 4;
const MEDIA_URL = process.env.MEDIA_SERVICE_URL ?? 'http://localhost:3013';


/** 工作台 AI 错误，路由层会保存成 assistant 错误消息。 */
export class WorkbenchAiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'WorkbenchAiError';
  }
}

/** 多模态聊天服务：负责配置读取、上下文组装和上游调用。 */
export class WorkbenchAiService {
  private readonly prisma = getPrismaClient();
  private readonly attachmentService = new WorkbenchAttachmentService();
  private readonly generationsService = new GenerationsService();

  /** 调用工作台聊天模型，返回模型文本回复和使用模型名。 */
  async chat(userId: number, history: WorkbenchMessageView[], content: string, attachmentIds: string[]): Promise<{ content: string; model: string; attachments: WorkbenchAttachmentView[] }> {
    const config = await this.readConfig();
    if (!config.enabled) throw new WorkbenchAiError('ai_disabled', '后台未启用工作台 AI');
    if (!config.baseUrl) throw new WorkbenchAiError('config_missing', '后台未配置工作台 AI 地址');
    if (!config.apiKey) throw new WorkbenchAiError('config_missing', '后台未配置工作台 AI Key');

    const attachments = await this.attachmentService.listOwned(userId, attachmentIds);
    const selectedImages = await this.selectRelevantImages(config, userId, history, content, attachments, MAX_CHAT_IMAGES);
    const messages = await this.buildMessages(userId, config, history, content, selectedImages);
    const responseText = await this.callChatCompletion(config, messages);
    return { content: responseText.slice(0, config.maxOutputChars), model: config.model, attachments };
  }

  /** 流式调用工作台聊天模型；每个 delta 会回调给路由层转发 SSE。 */
  async streamChat(
    userId: number,
    history: WorkbenchMessageView[],
    content: string,
    attachmentIds: string[],
    onDelta: (text: string) => void,
  ): Promise<{ content: string; model: string; attachments: WorkbenchAttachmentView[] }> {
    const config = await this.readConfig();
    if (!config.enabled) throw new WorkbenchAiError('ai_disabled', '后台未启用工作台 AI');
    if (!config.baseUrl) throw new WorkbenchAiError('config_missing', '后台未配置工作台 AI 地址');
    if (!config.apiKey) throw new WorkbenchAiError('config_missing', '后台未配置工作台 AI Key');

    const attachments = await this.attachmentService.listOwned(userId, attachmentIds);
    const selectedImages = await this.selectRelevantImages(config, userId, history, content, attachments, MAX_CHAT_IMAGES);
    const messages = await this.buildMessages(userId, config, history, content, selectedImages);
    const responseText = await this.callChatCompletionStream(config, messages, onDelta);
    return { content: responseText.slice(0, config.maxOutputChars), model: config.model, attachments };
  }

  /** 使用工作台 AI 判断本轮应继续聊天还是提交真实绘图任务。 */
  async decideAction(userId: number, history: WorkbenchMessageView[], content: string, attachmentIds: string[], context: WorkbenchActionContext): Promise<WorkbenchActionDecision> {
    const config = await this.readConfig();
    if (!config.enabled) throw new WorkbenchAiError('ai_disabled', '后台未启用工作台 AI');
    if (!config.baseUrl) throw new WorkbenchAiError('config_missing', '后台未配置工作台 AI 地址');
    if (!config.apiKey) throw new WorkbenchAiError('config_missing', '后台未配置工作台 AI Key');

    const attachments = await this.attachmentService.listOwned(userId, attachmentIds);
    const selectedImages = await this.selectRelevantImages(config, userId, history, content, attachments, MAX_ROUTER_IMAGES);
    const messages = await this.buildToolDecisionMessages(userId, history, content, attachments, selectedImages, context);
    try {
      const message = await this.callChatCompletionMessage(
        { ...config, temperature: 0, maxOutputChars: 1600 },
        messages,
        { tools: [IMAGE_GENERATION_TOOL, GENERATION_LOOKUP_TOOL, CHAT_RESPONSE_TOOL], toolChoice: 'required' },
      );
      const toolDecision = parseToolDecision(message);
      if (toolDecision) return appendSelectedImageIds(toolDecision, selectedImages);
      // 不支持 tools 的上游可能把“无法调用工具”包装成普通文本或 chat JSON；不能把这类内容当最终路由。
      return this.decideActionWithJsonFallback(config, userId, history, content, attachments, selectedImages, context, readChatContent({ choices: [{ message }] }));
    } catch (error) {
      // 部分 OpenAI 兼容上游尚不支持 tools；此时退回纯 JSON 意图判断，不影响普通聊天可用性。
      if (error instanceof WorkbenchAiError && error.code === 'upstream_failed' && error.status >= 400 && error.status < 500) {
        return this.decideActionWithJsonFallback(config, userId, history, content, attachments, selectedImages, context, error.message);
      }
      throw error;
    }
  }

  /** 从 system_configs 读取工作台 AI 独立配置；不再复用其他工具配置，避免跨职责污染 Agent 行为。 */
  private async readConfig(): Promise<WorkbenchAiConfig> {
    const keys = [
      'workbench_ai_enabled',
      'workbench_ai_base_url',
      'workbench_ai_api_key',
      'workbench_ai_model',
      'workbench_ai_temperature',
      'workbench_ai_timeout_ms',
      'workbench_ai_system_prompt',
      'workbench_ai_max_output_chars',
    ];
    const rows = await this.prisma.systemConfig.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
    const map = new Map(rows.map(row => [row.key, row.value]));
    const ownBaseUrl = String(map.get('workbench_ai_base_url') ?? '').trim();
    const ownApiKey = String(map.get('workbench_ai_api_key') ?? '').trim();
    return {
      enabled: map.get('workbench_ai_enabled') === 'true',
      baseUrl: normalizeBaseUrl(ownBaseUrl || DEFAULT_BASE_URL, DEFAULT_BASE_URL),
      apiKey: ownApiKey,
      model: String(map.get('workbench_ai_model') ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      temperature: clampNumber(Number(map.get('workbench_ai_temperature') ?? 0.7), 0, 1.5, 0.7),
      timeoutMs: clampNumber(Number(map.get('workbench_ai_timeout_ms') ?? 60000), 5000, 180000, 60000),
      systemPrompt: appendLocalPromptConstraints(String(map.get('workbench_ai_system_prompt') ?? '').trim() || DEFAULT_SYSTEM_PROMPT),
      maxOutputChars: Math.trunc(clampNumber(Number(map.get('workbench_ai_max_output_chars') ?? 12000), 500, 30000, 12000)),
    };
  }

  /** 构造聊天上下文，历史消息只取近期，图片由后端读取本地文件转 data URL。 */
  private async buildMessages(userId: number, config: WorkbenchAiConfig, history: WorkbenchMessageView[], content: string, selectedImages: SelectedWorkbenchImage[]) {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }> = [
      { role: 'system', content: config.systemPrompt },
    ];
    for (const message of history.slice(-18)) {
      const formatted = formatHistoryMessage(message, 5000);
      if (!formatted) continue;
      messages.push({ role: message.role, content: formatted });
    }
    const currentParts: ChatContentPart[] = [{ type: 'text', text: buildSelectedImageUserText(content, selectedImages) }];
    for (const image of selectedImages.slice(0, MAX_CHAT_IMAGES)) {
      const owned = await this.readSelectedImage(userId, image);
      if (!owned) continue;
      currentParts.push({ type: 'text', text: `${image.label}：${image.summary}` });
      currentParts.push({ type: 'image_url', image_url: { url: `data:${owned.mimeType};base64,${owned.buffer.toString('base64')}` } });
    }
    messages.push({ role: 'user', content: currentParts });
    return messages;
  }

  /** 构造意图判断上下文；该分支只做路由判断，不直接创建任何绘图任务。 */
  private async buildToolDecisionMessages(
    userId: number,
    history: WorkbenchMessageView[],
    content: string,
    attachments: WorkbenchAttachmentView[],
    selectedImages: SelectedWorkbenchImage[],
    context: WorkbenchActionContext,
  ) {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }> = [
      { role: 'system', content: TOOL_ROUTER_SYSTEM_PROMPT },
    ];
    for (const message of history.slice(-14)) {
      const formatted = formatHistoryMessage(message, 1800);
      if (!formatted) continue;
      messages.push({ role: message.role, content: formatted });
    }
    const currentParts: ChatContentPart[] = [{ type: 'text', text: buildDecisionUserText(content, attachments, context, selectedImages.length) }];
    for (const image of selectedImages.slice(0, MAX_ROUTER_IMAGES)) {
      const owned = await this.readSelectedImage(userId, image);
      if (!owned) continue;
      currentParts.push({ type: 'text', text: `${image.label}：${image.summary}` });
      currentParts.push({ type: 'image_url', image_url: { url: `data:${owned.mimeType};base64,${owned.buffer.toString('base64')}` } });
    }
    messages.push({ role: 'user', content: currentParts });
    return messages;
  }

  /** 构造旧 JSON 意图判断上下文，兼容不支持 tools 的 OpenAI 兼容上游。 */
  private async buildLegacyIntentMessages(
    userId: number,
    history: WorkbenchMessageView[],
    content: string,
    attachments: WorkbenchAttachmentView[],
    selectedImages: SelectedWorkbenchImage[],
    context: WorkbenchActionContext,
  ) {
    const messages = await this.buildToolDecisionMessages(userId, history, content, attachments, selectedImages, context);
    return [{ role: 'system' as const, content: LEGACY_INTENT_SYSTEM_PROMPT }, ...messages.slice(1)];
  }

  /** 当上游不支持 tools 或未返回工具调用时，继续要求同一个 AI 输出 JSON 路由结果。 */
  private async decideActionWithJsonFallback(
    config: WorkbenchAiConfig,
    userId: number,
    history: WorkbenchMessageView[],
    content: string,
    attachments: WorkbenchAttachmentView[],
    selectedImages: SelectedWorkbenchImage[],
    context: WorkbenchActionContext,
    previousResult: string,
  ): Promise<WorkbenchActionDecision> {
    const fallbackMessages = await this.buildLegacyIntentMessages(userId, history, content, attachments, selectedImages, context);
    const responseText = await this.callChatCompletion(
      { ...config, temperature: 0, maxOutputChars: 1200 },
      fallbackMessages,
      { responseFormat: { type: 'json_object' } },
    );
    const decision = appendSelectedImageIds(parseActionDecision(responseText), selectedImages);
    if (!isInvalidRouteDecision(decision)) return decision;
    const retryMessages = [
      ...fallbackMessages,
      {
        role: 'user' as const,
        content: [
          `上一次路由输出无效：${previousResult.slice(0, 400)}`,
          '请重新判断本轮用户消息，只返回单个 JSON 对象，不要解释，不要 Markdown。',
          '如果用户要求生成图片，action 必须是 draw，并给出 2-4 个 options 候选方案和推荐 prompt。',
        ].join('\n'),
      },
    ];
    const retryText = await this.callChatCompletion(
      { ...config, temperature: 0, maxOutputChars: 1200 },
      retryMessages,
      { responseFormat: { type: 'json_object' } },
    );
    return appendSelectedImageIds(parseActionDecision(retryText), selectedImages);
  }

  /** 先让 AI 基于文本索引选择要读取的图片，再只把少量被选图片传给多模态请求。 */
  private async selectRelevantImages(
    config: WorkbenchAiConfig,
    userId: number,
    history: WorkbenchMessageView[],
    content: string,
    currentAttachments: WorkbenchAttachmentView[],
    maxImages: number,
  ): Promise<SelectedWorkbenchImage[]> {
    const candidates = await this.buildImageCandidates(userId, history, currentAttachments);
    if (candidates.length === 0) return [];
    const fallback = candidates.filter(item => item.source === 'current').slice(0, maxImages);
    try {
      const selectionText = await this.callChatCompletion(
        { ...config, temperature: 0, maxOutputChars: 900 },
        [
          { role: 'system', content: IMAGE_SELECTION_SYSTEM_PROMPT },
          { role: 'user', content: buildImageSelectionPrompt(content, candidates, maxImages) },
        ],
        { responseFormat: { type: 'json_object' } },
      );
      const selectedIds = parseSelectedImageIds(selectionText);
      if (!selectedIds) return constrainSelectedImagesByRequest(content, fallback, candidates, maxImages);
      const selected = selectedIds
        .map(id => candidates.find(item => item.id === id))
        .filter((item): item is WorkbenchImageCandidate => Boolean(item))
        .slice(0, maxImages);
      return constrainSelectedImagesByRequest(content, selected, candidates, maxImages);
    } catch {
      // 图片选择失败时只回退到本轮新上传图片，避免把历史上下文图片全部塞给 AI。
      return constrainSelectedImagesByRequest(content, fallback, candidates, maxImages);
    }
  }

  /** 读取 AI 最终选中的图片内容；附件读私有本地文件，历史生成结果读 media-service 真实成图。 */
  private async readSelectedImage(userId: number, image: SelectedWorkbenchImage): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (image.attachment) return this.attachmentService.readOwnedImage(userId, image.attachment.id);
    const url = image.generation?.thumbnailUrl || image.generation?.imageUrl;
    return url ? readStationMediaImage(url) : null;
  }

  /** 构造可供 AI 选择的图片索引，最近图片优先但不包含任何图片二进制。 */
  private async buildImageCandidates(userId: number, history: WorkbenchMessageView[], currentAttachments: WorkbenchAttachmentView[]): Promise<WorkbenchImageCandidate[]> {
    const candidates = buildCurrentAttachmentImageCandidates(currentAttachments);
    const generated = await this.buildGenerationImageCandidates(userId, history, candidates.length);
    const usedAttachmentIds = new Set(candidates.map(item => item.attachment?.id).filter((item): item is string => Boolean(item)));
    const historyAttachments = buildHistoryAttachmentImageCandidates(history, usedAttachmentIds, candidates.length + generated.length);
    return [...candidates, ...generated, ...historyAttachments].slice(0, MAX_IMAGE_CANDIDATES);
  }

  /** 从历史工具调用里读取当前用户自己的成功生成结果图，供“本次生成的图片”一类指代使用。 */
  private async buildGenerationImageCandidates(userId: number, history: WorkbenchMessageView[], existingCount: number): Promise<WorkbenchImageCandidate[]> {
    const requests = collectRecentGenerationRequests(history);
    if (requests.length === 0 || existingCount >= MAX_IMAGE_CANDIDATES) return [];
    const response = await this.generationsService.findTasks(userId, requests.map(item => item.taskId));
    const requestById = new Map(requests.map(item => [item.taskId, item]));
    const candidates: WorkbenchImageCandidate[] = [];
    const seenUrls = new Set<string>();
    for (const task of response.tasks) {
      if (candidates.length + existingCount >= MAX_IMAGE_CANDIDATES) break;
      if (task.status !== 'success' || !task.imageUrl || seenUrls.has(task.imageUrl)) continue;
      seenUrls.add(task.imageUrl);
      const meta = requestById.get(task.id) ?? requests[0];
      candidates.push(buildGenerationImageCandidate(task, meta, candidates.length + 1));
    }
    return candidates;
  }

  /** 调用 OpenAI 兼容 chat/completions；失败时返回清晰错误。 */
  private async callChatCompletion(
    config: WorkbenchAiConfig,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }>,
    options: ChatCompletionOptions = {},
  ): Promise<string> {
    const message = await this.callChatCompletionMessage(config, messages, options);
    const content = readChatContent({ choices: [{ message }] });
    if (!content) throw new WorkbenchAiError('upstream_empty', '工作台 AI 未返回内容', 502);
    return content;
  }

  /** 调用 OpenAI 兼容 chat/completions 并保留 tool_calls，供工作台真实工具路由使用。 */
  private async callChatCompletionMessage(
    config: WorkbenchAiConfig,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }>,
    options: ChatCompletionOptions = {},
  ): Promise<ChatCompletionMessage> {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          messages,
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
          ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError' ? '工作台 AI 请求超时' : '工作台 AI 暂时无法连接';
      throw new WorkbenchAiError('upstream_unavailable', message, 502);
    }
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      // 上游或代理中途断开时 undici 会抛出 TypeError: terminated，不能把底层英文泄露给用户。
      throw normalizeWorkbenchUpstreamReadError(error);
    }
    if (!response.ok) throw new WorkbenchAiError('upstream_failed', `工作台 AI 调用失败：HTTP ${response.status}`, response.status >= 500 ? 502 : 400);
    let body: ChatCompletionResponse;
    try {
      body = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new WorkbenchAiError('upstream_invalid', '工作台 AI 返回不是合法 JSON', 502);
    }
    const message = body.choices?.[0]?.message;
    if (!message) throw new WorkbenchAiError('upstream_empty', '工作台 AI 未返回内容', 502);
    return message;
  }

  /** 调用 OpenAI 兼容流式 chat/completions；逐段解析 SSE 并累积完整回复。 */
  private async callChatCompletionStream(
    config: WorkbenchAiConfig,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }>,
    onDelta: (text: string) => void,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          messages,
          stream: true,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError' ? '工作台 AI 请求超时' : '工作台 AI 暂时无法连接';
      throw new WorkbenchAiError('upstream_unavailable', message, 502);
    }
    if (!response.ok) throw new WorkbenchAiError('upstream_failed', `工作台 AI 调用失败：HTTP ${response.status}`, response.status >= 500 ? 502 : 400);
    if (!response.body) throw new WorkbenchAiError('upstream_empty', '工作台 AI 未返回流式内容', 502);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const delta = readStreamPart(part);
          if (!delta) continue;
          fullText += delta;
          if (fullText.length <= config.maxOutputChars) onDelta(delta);
        }
      }
      const tail = decoder.decode();
      if (tail) buffer += tail;
    } catch (error) {
      // 流式响应可能已返回 200 后被代理或上游中断；这里统一转成可恢复的业务错误。
      throw normalizeWorkbenchUpstreamReadError(error);
    }
    const tailDelta = readStreamPart(buffer);
    if (tailDelta) {
      fullText += tailDelta;
      if (fullText.length <= config.maxOutputChars) onDelta(tailDelta);
    }
    if (!fullText.trim()) throw new WorkbenchAiError('upstream_empty', '工作台 AI 未返回内容', 502);
    return fullText;
  }
}

/** 将上游流读取异常归一化，避免 TypeError: terminated 直接进入工作台消息。 */
function normalizeWorkbenchUpstreamReadError(error: unknown): WorkbenchAiError {
  if (error instanceof WorkbenchAiError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/terminated|aborted|socket|network|fetch failed/i.test(message)) {
    return new WorkbenchAiError('upstream_unavailable', '工作台 AI 连接中断，请重试', 502);
  }
  return new WorkbenchAiError('upstream_unavailable', '工作台 AI 流式回复中断，请重试', 502);
}

/** 判断 AI 路由输出是否只是解析失败的兜底结果。 */
function isInvalidRouteDecision(decision: WorkbenchActionDecision) {
  return decision.action === 'chat' && (
    decision.reason === '未能解析 Agent JSON'
    || decision.reason === 'Agent JSON 解析失败'
  );
}

/** 构造本轮上传图片索引；本轮图优先级最高。 */
function buildCurrentAttachmentImageCandidates(currentAttachments: WorkbenchAttachmentView[]): WorkbenchImageCandidate[] {
  const candidates: WorkbenchImageCandidate[] = [];
  const seen = new Set<string>();
  currentAttachments.forEach((attachment, index) => {
    if (seen.has(attachment.id)) return;
    seen.add(attachment.id);
    candidates.push({
      id: attachment.id,
      label: `本轮上传图${index + 1}`,
      attachment,
      source: 'current',
      summary: formatAttachmentSummary(attachment, '用户本轮上传'),
    });
  });
  return candidates.slice(0, MAX_IMAGE_CANDIDATES);
}

/** 构造历史上传图片索引；只在本轮图和历史生成结果之后补充。 */
function buildHistoryAttachmentImageCandidates(history: WorkbenchMessageView[], seen: Set<string>, offset: number): WorkbenchImageCandidate[] {
  const candidates: WorkbenchImageCandidate[] = [];
  const recentHistory = [...history].reverse();
  for (const message of recentHistory) {
    for (const [index, attachment] of message.attachments.entries()) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      candidates.push({
        id: attachment.id,
        label: candidates.length === 0 ? '最近历史参考图' : `历史参考图${offset + candidates.length + 1}`,
        attachment,
        source: 'history',
        summary: [
          `来自${message.role === 'user' ? '用户' : 'Agent'}消息`,
          `消息时间=${message.createdAt}`,
          `消息摘要=${message.content.replace(/\s+/g, ' ').slice(0, 120) || '无文本'}`,
          `图片序号=${index + 1}`,
        ].join('；'),
      });
      if (offset + candidates.length >= MAX_IMAGE_CANDIDATES) return candidates;
    }
  }
  return candidates.slice(0, Math.max(0, MAX_IMAGE_CANDIDATES - offset));
}

/** 对图片选择结果做窄口径兜底：明确双参考替换保留两张图，明确重生成文生图时清空参考图。 */
function constrainSelectedImagesByRequest(content: string, selected: SelectedWorkbenchImage[], candidates: WorkbenchImageCandidate[], maxImages: number): SelectedWorkbenchImage[] {
  const text = content.replace(/\s+/g, '');
  if (shouldForceTextRegeneration(text)) return [];
  const explicitDualReference = resolveExplicitDualReferenceImages(text, selected, candidates, maxImages);
  if (explicitDualReference.length > 0) return explicitDualReference;
  if (selected.length <= 1) return selected;
  const asksMultipleImages = /(图[一二三四1234].*图[二三四234]|两张|二张|多张|三张|合影|合集|组合|拼图|对比|双人|三人|多人)/.test(text);
  const singularReference = /(该角色|这个角色|这位角色|该人物|这个人物|这张图|该图|她|他|它|刚才这个|上面那个角色|这个形象)/.test(text);
  if (singularReference && !asksMultipleImages) return selected.slice(0, 1);
  return selected.slice(0, maxImages);
}

/** 显式“当前图作为基底 + 上一张生成图作为角色来源”的替换需求必须保留双参考图。 */
function resolveExplicitDualReferenceImages(text: string, selected: SelectedWorkbenchImage[], candidates: WorkbenchImageCandidate[], maxImages: number): SelectedWorkbenchImage[] {
  if (maxImages < 2) return [];
  const mentionsCurrentTarget = /(该图片|这张图|当前图|当前图片|刚上传|本轮上传|新上传|图1|图一).{0,24}(角色|人物|主体)?(替换|换成|改成|迁移|使用|套用)/.test(text)
    || /(替换|换成|改成|迁移).{0,24}(该图片|这张图|当前图|当前图片|刚上传|本轮上传|新上传|图1|图一)/.test(text);
  const mentionsPreviousSource = /(上一张图|上一张|上张图|刚才生成|刚生成|本次生成|上个成图|上一张结果图|之前生成).{0,30}(角色|人物|形象|设定|特征)/.test(text)
    || /(角色|人物|形象|设定|特征).{0,30}(上一张图|上一张|上张图|刚才生成|刚生成|本次生成|上个成图|上一张结果图|之前生成)/.test(text);
  if (!mentionsCurrentTarget || !mentionsPreviousSource) return [];
  const current = candidates.find(item => item.source === 'current') ?? selected.find(item => item.source === 'current');
  const previous = candidates.find(item => item.source === 'generation') ?? candidates.find(item => item.source === 'history') ?? selected.find(item => item.source !== 'current');
  if (!current || !previous || current.id === previous.id) return [];
  return [current, previous].slice(0, maxImages);
}

/** 判断用户是否明确要求不带图片参考重新出图，避免历史生成图把任务强制切成图生图。 */
function shouldForceTextRegeneration(text: string) {
  if (/(不要参考|不参考|不用参考|不要用图|不要上一张|不用上一张|不要图生图|纯文生图|文生图重来|文生图重新)/.test(text)) return true;
  const asksRegenerate = /(重新生成|重生成|重新来|再生成|再来一张|再来一版|换一张|重抽一张|重新出图|再出一张)/.test(text);
  if (!asksRegenerate) return false;
  const asksImageReference = /(基于|参考|参照|用这张|用上一张|用刚才|根据这张|照着|以.*为参考|这张图|上一张图|刚才那张|刚生成的图|本次生成的图|结果图|成图|图生图|重绘|优化|修改|改成|调整|保持|换背景|换风格|换色|修复|细化|放大|扩图|补全)/.test(text);
  return !asksImageReference;
}

type GenerationRequestCandidate = {
  taskId: string;
  message: WorkbenchMessageView;
  toolTitle: string;
  toolPrompt: string;
};

/** 从历史工具调用里收集最近任务 ID；只使用已记录的真实任务或批次 ID，不臆造图片来源。 */
function collectRecentGenerationRequests(history: WorkbenchMessageView[]): GenerationRequestCandidate[] {
  const requests: GenerationRequestCandidate[] = [];
  const seen = new Set<string>();
  for (const message of [...history].reverse()) {
    for (const tool of [...message.toolCalls].reverse()) {
      if (tool.type !== 'image_generation' || tool.taskIds.length === 0) continue;
      for (const taskId of tool.taskIds) {
        if (!/^[a-zA-Z0-9:_-]{1,96}$/.test(taskId) || seen.has(taskId)) continue;
        seen.add(taskId);
        requests.push({
          taskId,
          message,
          toolTitle: tool.title || '生成图片',
          toolPrompt: tool.prompt || '',
        });
        if (requests.length >= MAX_IMAGE_CANDIDATES) return requests;
      }
    }
  }
  return requests;
}

/** 把当前用户自己的成功任务结果转换成可选择的历史生成图候选。 */
function buildGenerationImageCandidate(task: GenerationTaskView, meta: GenerationRequestCandidate | undefined, index: number): WorkbenchImageCandidate {
  return {
    id: `gen_${index}`,
    label: index === 1 ? '最近生成结果图' : `历史生成结果图${index}`,
    source: 'generation',
    generation: {
      taskId: task.id,
      imageUrl: task.imageUrl || '',
      thumbnailUrl: task.thumbnailUrl,
    },
    summary: [
      `来自已完成绘图任务`,
      `任务ID=${task.id}`,
      task.batchId ? `批次=${task.batchId}` : '',
      `消息时间=${meta?.message.createdAt ?? task.finishedAt ?? task.createdAt}`,
      meta?.toolTitle ? `工具标题=${meta.toolTitle}` : '',
      `原提示词=${(meta?.toolPrompt || task.prompt || '').replace(/\s+/g, ' ').slice(0, 160) || '无'}`,
      `最终图=${task.imageUrl}`,
    ].filter(Boolean).join('；'),
  };
}

/** 构造图片选择请求；只包含图片索引和用户文本，不上传图片内容。 */
function buildImageSelectionPrompt(content: string, candidates: WorkbenchImageCandidate[], maxImages: number) {
  return [
    `本轮用户消息：${content}`,
    `最多选择 ${maxImages} 张图片。`,
    '可选图片索引：',
    ...candidates.map(item => `- id=${item.id}；label=${item.label}；source=${item.source}；${item.summary}`),
  ].join('\n');
}

/** 解析图片选择 JSON；合法空选返回空数组，解析失败返回 null 以便进入保守兜底。 */
function parseSelectedImageIds(rawText: string): string[] | null {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(rawText.slice(start, end + 1)) as { selectedIds?: unknown };
    if (!Array.isArray(parsed.selectedIds)) return null;
    return parsed.selectedIds
      .filter((item): item is string => typeof item === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(item))
      .filter((item, index, array) => array.indexOf(item) === index)
      .slice(0, MAX_CHAT_IMAGES);
  } catch {
    return null;
  }
}

/** 把 AI 选中的图片写入绘图决策；只要 AI 已选择图片，执行层就必须按图生图转存这些参考图。 */
function appendSelectedImageIds(decision: WorkbenchActionDecision, selectedImages: SelectedWorkbenchImage[]): WorkbenchActionDecision {
  if (decision.action !== 'draw') return decision;
  if (selectedImages.length === 0) return decision;
  const sourceAttachmentIds = selectedImages
    .map(item => item.attachment?.id)
    .filter((item): item is string => Boolean(item));
  const sourceImageUrls = selectedImages
    .map(item => item.generation?.imageUrl)
    .filter((item): item is string => Boolean(item));
  return {
    ...decision,
    mode: 'image-to-image' as const,
    sourceAttachmentIds: [...(decision.sourceAttachmentIds ?? []), ...sourceAttachmentIds],
    sourceImageUrls: [...(decision.sourceImageUrls ?? []), ...sourceImageUrls],
  };
}

/** 给最终多模态请求补充已选择图片说明，方便模型理解图1/图2对应关系。 */
function buildSelectedImageUserText(content: string, selectedImages: SelectedWorkbenchImage[]) {
  if (selectedImages.length === 0) return content;
  return [
    content,
    '',
    '本轮已按上下文选择以下图片供你读取，请按这些标签理解图像关系：',
    ...selectedImages.map((item, index) => `${item.label}（图${index + 1}）：${item.summary}`),
  ].join('\n');
}

/** 图片索引里的附件摘要，不包含二进制内容。 */
function formatAttachmentSummary(attachment: WorkbenchAttachmentView, prefix: string) {
  const sizeText = attachment.sizeBytes > 0 ? `${Math.round(attachment.sizeBytes / 1024)}KB` : '大小未知';
  const dimensionText = attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : '尺寸未知';
  return `${prefix}；文件=${attachment.name || '图片'}；${dimensionText}；${sizeText}`;
}

/** 读取站内媒体文件供多模态模型分析；历史生成图只接受 /images 安全短文件名。 */
async function readStationMediaImage(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const filename = extractStationMediaFilename(imageUrl);
  if (!filename) return null;
  try {
    const response = await fetch(`${MEDIA_URL}/media/files/${encodeURIComponent(filename)}`, {
      headers: { 'x-service-token': process.env.WS_PROXY_TOKEN?.trim() ?? '' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return null;
    const mimeType = normalizeImageMimeType(response.headers.get('content-type'), filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > 0 ? { buffer, mimeType } : null;
  } catch {
    return null;
  }
}

/** 追加本地 prompt 规范；后台自定义系统提示词只扩展角色口径，不能绕过绘图提示词硬约束。 */
function appendLocalPromptConstraints(systemPrompt: string): string {
  const text = systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  return text.includes('【本地绘图提示词规范】') ? text : `${text}\n\n${WORKBENCH_DRAWING_PROMPT_CONSTRAINTS}`;
}

/** 从工作台允许的站内图片 URL 中提取安全短文件名。 */
function extractStationMediaFilename(value: string): string {
  const match = /^\/images\/([a-zA-Z0-9_.-]{1,128})$/.exec(value.trim().split(/[?#]/, 1)[0] ?? '');
  return match?.[1] && !match[1].includes('..') ? match[1] : '';
}

/** 归一化媒体 MIME；Content-Type 缺失时按扩展名兜底，避免构造无效 data URL。 */
function normalizeImageMimeType(contentType: string | null, filename: string): string {
  const clean = String(contentType || '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (clean.startsWith('image/')) return clean;
  if (/\.webp$/i.test(filename)) return 'image/webp';
  if (/\.jpe?g$/i.test(filename)) return 'image/jpeg';
  return 'image/png';
}
