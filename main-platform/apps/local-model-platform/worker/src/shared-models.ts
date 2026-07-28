/** 本文件保存独立本地模型平台 worker 使用的第一批真实模型注册数据。 */

/** 本地模型注册条目。 */
export type LocalModelRegistrySeed = {
  /** 注册键。 */
  modelKey: string;
  /** 展示名。 */
  displayName: string;
};

/** 第一批支持的模型清单。 */
export const LOCAL_MODEL_REGISTRY_SEED: readonly LocalModelRegistrySeed[] = [
  { modelKey: 'krea2_raw_bf16.safetensors', displayName: 'Krea 2 Raw' },
  { modelKey: 'krea2_turbo_bf16.safetensors', displayName: 'Krea 2 Turbo BF16' },
  { modelKey: 'krea2_turbo_fp8_scaled.safetensors', displayName: 'Krea 2 Turbo FP8' },
  { modelKey: 'krea2_turbo_nvfp4.safetensors', displayName: 'Krea 2 Turbo NVFP4' },
  { modelKey: 'qwen3vl_4b_fp8_scaled.safetensors', displayName: 'Qwen3-VL 4B FP8' },
];
