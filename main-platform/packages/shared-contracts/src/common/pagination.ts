/** 本文件定义分页请求和分页结果类型，规范来源：standards/interfaces/common.md。 */

/** 分页请求统一使用 page/pageSize，后端必须限制 pageSize 上限。 */
export type PageRequest = {
  page?: number;
  pageSize?: number;
};

/** 分页结果必须包含 items 和分页元数据，列表接口不得返回无上限数组。 */
export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};
