/**
 * 本文件定义通用 API 响应类型，规范来源：standards/interfaces/common.md。
 */

import type { ApiErrorResponse } from './api-error.js';

/** 带 data 字段的成功响应用于普通资源读取和列表接口。 */
export type ApiDataResponse<TData> = {
  ok: true;
  data: TData;
};

/** 带中文 message 的成功响应用于无需返回业务对象的操作。 */
export type ApiMessageResponse = {
  ok: true;
  message: string;
};

/** 通用 API 响应联合类型用于客户端统一处理成功和失败分支。 */
export type ApiResponse<TData> = ApiDataResponse<TData> | ApiErrorResponse;
