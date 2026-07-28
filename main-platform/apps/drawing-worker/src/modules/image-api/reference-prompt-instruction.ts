/**
 * 本文件统一构造图生图参考图说明。
 * 多参考图进入不同上游协议前都要补充同一套编号语义，避免上游弱化或忽略部分参考图。
 */

/** 构造给上游模型的参考图使用说明，只在图生图且存在参考图时使用。 */
export function buildImageReferenceInstruction(sourceImageCount: number): string {
  const count = normalizeSourceImageCount(sourceImageCount);
  if (count <= 0) return '';
  const labels = Array.from({ length: count }, (_, index) => `参考图${index + 1}`).join('、');
  return [
    `本次图生图包含 ${count} 张参考图：${labels}。`,
    '请严格按提交顺序理解这些参考图，必须全部用于生成，不要忽略、替换或丢弃任意一张。',
    '如果用户提示词提到图1、图2、构图、角色、服装、风格、替换、融合或保持原图等关系，请按参考图编号对应理解。',
    '未明确指定关系时，请综合所有参考图的主体、构图、风格和关键细节，并以用户提示词作为最终编辑目标。',
  ].join('\n');
}

/** 把用户提示词和参考图说明合并为上游 prompt，保留用户原始意图并强化多参考图约束。 */
export function withImageReferenceInstruction(prompt: string, sourceImageCount: number): string {
  const instruction = buildImageReferenceInstruction(sourceImageCount);
  return joinReferenceInstruction(instruction, prompt);
}

/** 构造 BFL Kontext 专用编辑说明，单图短提示默认保留原主体身份而不是重新创作无关角色。 */
export function buildBflImageReferenceInstruction(sourceImageCount: number): string {
  const count = normalizeSourceImageCount(sourceImageCount);
  const commonInstruction = buildImageReferenceInstruction(count);
  if (count !== 1) return commonInstruction;
  return [
    commonInstruction,
    'The input_image is the actual source image to edit, not a weak thematic reference.',
    'Unless the user explicitly requests replacing a subject, preserve the exact same subject identities, gender, face, hairstyle, hair color, species traits, outfit, colors, companion characters, and key identifying details from input_image.',
    'If the user prompt is short or only requests an output type such as 角色立绘 (character portrait), 头像 (avatar), 换背景 (change background), or 调整构图 (adjust composition), keep the original input_image subject as the only identity and perform only that transformation.',
    'Never invent, substitute, or redesign an unrelated person or character. Only attributes explicitly requested by the user may change.',
  ].join('\n');
}

/** 把用户提示词与 BFL Kontext 专用参考图说明合并。 */
export function withBflImageReferenceInstruction(prompt: string, sourceImageCount: number): string {
  return joinReferenceInstruction(buildBflImageReferenceInstruction(sourceImageCount), prompt);
}

/** 构造 xAI Grok 专用参考图说明，使用官方零下标图片占位符绑定每张图片。 */
export function buildXaiImageReferenceInstruction(sourceImageCount: number): string {
  const count = normalizeSourceImageCount(sourceImageCount);
  if (count <= 0) return '';
  const placeholders = Array.from({ length: count }, (_, index) => `<IMAGE_${index}>`);
  const mappings = placeholders.map((placeholder, index) => `图${index + 1}/参考图${index + 1}=${placeholder}`).join('，');
  const instructions = [
    `本次图生图包含 ${count} 张按提交顺序排列的参考图：${placeholders.join('、')}。`,
    `用户提示词中的图片编号必须按以下关系理解：${mappings}。`,
    '必须使用全部已提交图片，不要忽略、替换或丢弃任何一个图片占位符对应的主体、构图、风格和关键细节。',
    '执行编辑或融合时，以用户提示词为最终目标，并优先保持各图片中用户要求保留的身份特征和结构锚点。',
  ];
  if (count === 1) {
    instructions.push(
      '这是对 <IMAGE_0> 原图本身的直接局部编辑，不是以用户文字为主题重新创作新图片。',
      '除用户明确要求修改的属性外，必须保持原图的画风、构图、背景、人物数量、姿势、表情、服饰、发型、配色和镜头。',
    );
  }
  return instructions.join('\n');
}

/** 把用户提示词与 xAI 官方图片占位符说明合并，避免模型只把图片当作无编号弱参考。 */
export function withXaiImageReferenceInstruction(prompt: string, sourceImageCount: number): string {
  return joinReferenceInstruction(buildXaiImageReferenceInstruction(sourceImageCount), prompt);
}

/** 统一拼接参考图说明与用户原始提示词。 */
function joinReferenceInstruction(instruction: string, prompt: string): string {
  const normalizedPrompt = prompt.trim();
  if (!instruction) return normalizedPrompt;
  return `${instruction}\n\n用户提示词：\n${normalizedPrompt}`;
}

/** 归一化参考图数量，防止异常输入把说明构造成无意义的大数组。 */
function normalizeSourceImageCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(8, Math.trunc(value)));
}
