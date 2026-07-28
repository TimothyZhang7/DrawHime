/** 本文件负责用户端本地工具成功调用后的轻量计数上报，不上传图片或操作参数。 */
import type { ToolId, ToolUsageRecordRequest } from '@aiimage/shared-contracts';
import { api } from '../../lib/api';

/** 上报一次工具成功调用；统计失败不影响用户下载或本地处理结果。 */
export function recordToolUsage(toolId: ToolId): void {
  const payload: ToolUsageRecordRequest = { toolId };
  void api('/api/tools/usage', {
    method: 'POST',
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}
