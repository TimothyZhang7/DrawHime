/** 本文件是独立本地模型平台 worker 入口。 */
import { LOCAL_MODEL_REGISTRY_SEED } from './shared-models.js';

const sample = LOCAL_MODEL_REGISTRY_SEED.find((item) => item.modelKey === 'krea2_turbo_fp8_scaled.safetensors');

console.log('[local-model-platform-worker] ready', {
  supported: Boolean(sample),
  sampleModel: sample?.displayName ?? null,
});
