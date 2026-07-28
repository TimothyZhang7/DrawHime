/** 本文件把统一画幅比例转换为各类上游图片协议需要的真实参数值。 */
import {
  getDrawingAspectRatioOption,
  type DrawingAspectRatio,
} from '@aiimage/shared-contracts';
import sharp from 'sharp';

/** 输出参数转换所需的统一任务字段。 */
export type ImageOutputParameterInput = {
  /** 历史尺寸字段；auto 比例继续沿用该值。 */
  size?: string;
  /** 用户显式选择的统一画幅比例。 */
  aspectRatio?: DrawingAspectRatio;
};

/** OpenAI Images 使用 size=宽x高；gpt-image 固定尺寸模型只发送上游真实支持的三种原生尺寸。 */
export function resolveOpenAiImageSize(input: ImageOutputParameterInput, model?: string): string | undefined {
  if (!input.aspectRatio || input.aspectRatio === 'auto') return input.size;
  const option = getDrawingAspectRatioOption(input.aspectRatio);
  if (model?.toLowerCase().includes('gpt-image')) {
    if (!option.width || !option.height || option.width === option.height) return '1024x1024';
    return option.width > option.height ? '1536x1024' : '1024x1536';
  }
  return option.width && option.height ? `${option.width}x${option.height}` : input.size;
}

/** BFL 与 Grok JSON 协议使用 aspect_ratio；auto 不发送字段，让上游采用模型默认值。 */
export function resolveJsonAspectRatio(input: ImageOutputParameterInput): string | undefined {
  return input.aspectRatio && input.aspectRatio !== 'auto' ? input.aspectRatio : undefined;
}

/** 上游原图画幅校验结果；仅用于决定是否换站，不修改图片内容。 */
export type GeneratedAspectRatioValidation = {
  /** 返回图片宽度。 */
  width?: number;
  /** 返回图片高度。 */
  height?: number;
  /** 实际画幅是否在允许误差内。 */
  matches: boolean;
};

/** 校验上游返回画幅；允许 2% 的编码尺寸误差，兼容 1376×768 等近似 16:9 原生输出。 */
export async function validateGeneratedImageAspectRatio(
  imageBuffer: Buffer,
  aspectRatio: DrawingAspectRatio | undefined,
): Promise<GeneratedAspectRatioValidation> {
  if (!aspectRatio || aspectRatio === 'auto') return { matches: true };
  const option = getDrawingAspectRatioOption(aspectRatio);
  if (!option.width || !option.height) return { matches: true };
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.autoOrient.width;
  const height = metadata.autoOrient.height;
  if (!width || !height) return { width, height, matches: false };
  const expected = option.width / option.height;
  const actual = width / height;
  return { width, height, matches: Math.abs(actual / expected - 1) <= 0.02 };
}
