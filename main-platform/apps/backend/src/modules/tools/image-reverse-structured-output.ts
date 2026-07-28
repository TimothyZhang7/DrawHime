/**
 * 本文件把图片反推的示例 JSON 转成 OpenAI Structured Outputs 严格 schema，兼容端点失败时由调用方降级。
 */

interface JsonSchemaNode {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchemaNode;
}

/** OpenAI 兼容端点的严格 JSON Schema response_format。 */
export interface ImageReverseJsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: true;
    schema: JsonSchemaNode;
  };
}

/** 根据当前模式的完整示例构造严格 schema，避免在业务服务重复维护第二套字段清单。 */
export function buildImageReverseJsonSchemaResponseFormat(name: string, example: Record<string, unknown>): ImageReverseJsonSchemaResponseFormat {
  return {
    type: 'json_schema',
    json_schema: {
      name: sanitizeSchemaName(name),
      strict: true,
      schema: buildSchemaNode(example),
    },
  };
}

/** 递归生成严格 schema；空数组按当前反推契约统一视为字符串数组。 */
function buildSchemaNode(value: unknown): JsonSchemaNode {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? buildSchemaNode(value[0]) : { type: 'string' },
    };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: 'object',
      properties: Object.fromEntries(entries.map(([key, item]) => [key, buildSchemaNode(item)])),
      required: entries.map(([key]) => key),
      additionalProperties: false,
    };
  }
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

function sanitizeSchemaName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'image_reverse_result';
}
