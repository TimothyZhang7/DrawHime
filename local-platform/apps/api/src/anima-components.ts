/**
 * 本文件定义当前 Anima 系列共享文本编码器与 VAE 的服务端目录默认值。
 * 客户端只读取底模目录响应，不持有组件文件名或哈希的第二套清单。
 */

/** 当前 Anima Runtime 共享组件；写入每个模型版本后可由目录数据独立演进。 */
export const animaRuntimeComponents = {
  textEncoder: {
    fileName: "qwen_3_06b_base.safetensors",
    sha256: "cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba",
  },
  vae: {
    fileName: "qwen_image_vae.safetensors",
    sha256: "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
  },
} as const;

/** 把共享组件写入模型自己的可配置参数，后续模型可独立覆盖。 */
export function animaComponentDefaults(): Record<string, string> {
  return {
    textEncoderFileName: animaRuntimeComponents.textEncoder.fileName,
    textEncoderSha256: animaRuntimeComponents.textEncoder.sha256,
    vaeFileName: animaRuntimeComponents.vae.fileName,
    vaeSha256: animaRuntimeComponents.vae.sha256,
  };
}
