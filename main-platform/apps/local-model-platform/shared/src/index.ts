/** 本文件集中导出独立本地模型平台的共享契约、注册数据和纯展示工具。 */
export * from './local-model/local-model-contracts.js';
export * from './local-model/local-model-registry.js';

/** 平台标题。 */
export function createLocalModelPlatformTitle() {
  return '独立本地模型平台';
}

/** 平台配置文件默认名。 */
export const LOCAL_MODEL_PLATFORM_CONFIG_FILE_NAME = 'local-model-platform-config.json';
