/** 本文件创建媒体存储服务；当前生产链路只允许本地文件系统，不再提供对象存储回退。 */
import { FileStoreService } from './file-store-service.js';
import type { Readable } from 'node:stream';

/** 媒体存储统一接口，所有图片读写都必须落到本地媒体目录。 */
export interface IStorageService {
  /** 写入图片并返回安全短文件名。 */
  writeImage(buffer: Buffer, mimeType: string, prefix?: string, options?: { maxFileSizeBytes?: number }): Promise<string>;
  /** 原样写入已校验的媒体文件，视频不能经过 Sharp 图片处理。 */
  writeMedia(buffer: Buffer, mimeType: string, prefix?: string, options?: { maxFileSizeBytes?: number }): Promise<string>;
  /** 读取图片流和基础元数据。 */
  readImage(filename: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number; contentType?: string }>;
  /** 读取本地媒体总大小和类型，供视频 Range 校验。 */
  readFileMetadata(filename: string): Promise<{ size: number; contentType?: string }>;
  /** 检查本地文件是否存在。 */
  fileExists(filename: string): Promise<boolean>;
  /** 删除本地文件，文件不存在时保持幂等。 */
  deleteFile(filename: string): Promise<void>;
}

/** 当前唯一存储实现类型。 */
export type StorageService = FileStoreService;

/** 创建本地媒体存储；禁止读取任何 S3/OSS 环境变量或初始化远端客户端。 */
export function createStorageService(): FileStoreService {
  console.log('[media-service] 使用本地文件存储');
  return new FileStoreService();
}

/** 判断是否为本地存储实例；保留该函数供媒体路由读取本地统计。 */
export function isLocalStore(store: IStorageService | StorageService): store is FileStoreService {
  return store instanceof FileStoreService;
}
