/** 本文件定义 media-service 内部运行时配置契约，供 backend 下发后台系统配置。 */

/** media-service 运行时配置响应；只包含媒体链路需要的非敏感功能配置。 */
export interface MediaRuntimeConfigResponse {
  /** 缩略图目标宽度，单位像素。 */
  thumbnailWidth: number;
  /** 缩略图 JPEG 输出质量，范围 1-100。 */
  thumbnailQuality: number;
  /** 图片写入本地存储的最大字节数。 */
  imageMaxFileSizeBytes: number;
  /** 图片最大边长，避免超大分辨率解码耗尽内存。 */
  imageMaxResolution: number;
  /** 参考图任务输入版压缩后的最大字节数。 */
  referenceTaskInputMaxBytes: number;
}
