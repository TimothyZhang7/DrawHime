import { Icons } from '../icons.js';
import { renderCard, T, esc, arrayValue, textValue } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 模型列表展示卡片
 */

/** Bot 模型列表项；name 是真实模型 ID，类型和能力来自后台模型设置。 */
export type ModelListItem = {
  name: string;
  label?: string;
  aliases?: string[];
  isDefault?: boolean;
  type?: 'universal' | 'text_to_image' | 'image_to_image' | 'video' | 'text';
  capabilities?: { textToVideo?: boolean; imageToVideo?: boolean };
};

export type Data = { models: Array<string | ModelListItem>; currentModel: string; cmdPrefix?: string };

export function render(d: Data): string {
  const P = d.cmdPrefix ?? '';
  // 模型配置可能被后台关闭到空列表；空列表也渲染提示，不让 renderer 抛错。
  const models = arrayValue<string | ModelListItem>(d.models).map(normalizeModelItem).filter((item) => item.name);
  const currentModel = textValue(d.currentModel, models[0]?.name ?? '未设置');
  const currentDisplay = formatModelDisplay(models.find((item) => item.name === currentModel) ?? { name: currentModel });
  const pillsCSS = `
.model-list{display:flex;flex-direction:column;gap:7px;margin-top:4px}
.model-row{display:grid;grid-template-columns:34px 1fr;gap:8px;align-items:center;padding:8px 10px;border-radius:10px;border:1px solid ${T.border};background:${T.bg};color:${T.muted}}
.model-row.on{background:${T.primary};color:#fff;border-color:${T.primary}}
.model-index{font-size:13px;font-weight:900;text-align:center}
.model-main{font-size:13px;font-weight:800;line-height:1.35}
.model-alias{font-size:10px;font-weight:600;opacity:.76;margin-top:2px;word-break:break-all}
`;
  const rows = models.map((m, index) => {
    const aliasText = m.aliases?.length ? m.aliases.join('/') : '无别名';
    const currentMark = m.name === currentModel ? ' ✓' : '';
    return `<div class="model-row${m.name === currentModel ? ' on' : ''}">
      <div class="model-index">${index + 1}</div>
      <div>
        <div class="model-main">${index + 1}-${esc(formatModelDisplay(m))}${isVideoModel(m) ? ' [视频]' : ''}${currentMark}</div>
        <div class="model-alias">-${esc(aliasText)}</div>
      </div>
    </div>`;
  }).join('');

  return renderCard({ submitter: (d as any).submitter,
    accent: '#06b6d4',
    icon: Icons.model,
    layout: 'default',
    hero: {
      eyebrow: 'Model · 模型',
      title: '可用模型',
      subtitle: `${models.length} 个可用 · 当前首选 ${currentDisplay}`,
      rightContent: `<span class="badge">${models.length}</span>`,
    },
    body: `
      <div class="grid">
        <div class="meta wide">
          <div class="label">模型列表</div>
          <div class="model-list">${rows || `<div class="model-row"><div class="model-index">-</div><div class="model-main">暂无可用模型</div></div>`}</div>
        </div>
      </div>
      <div style="text-align:center;font-size:13px;color:${T.muted};margin-top:8px">使用 ${P}模型 序号 切换默认模型；绘图可用 m序号 临时指定</div>`,
    footer: ['高亮行为当前首选模型'],
    title: '模型列表',
    extraCSS: pillsCSS,
  });
}

/** 格式化 QQ 卡片中的模型展示名，必须和 bot-service 文本兜底保持一致。 */
function formatModelDisplay(model: ModelListItem): string {
  return model.label || model.name;
}

/** 识别视频模型，保证模型卡片明确显示媒体类型。 */
function isVideoModel(model: ModelListItem): boolean {
  return model.type === 'video' || model.capabilities?.textToVideo === true || model.capabilities?.imageToVideo === true;
}

/** 兼容旧 renderer 调用只传字符串的情况。 */
function normalizeModelItem(value: string | ModelListItem): ModelListItem {
  if (typeof value === 'string') return { name: value };
  return {
    name: textValue(value.name),
    label: textValue(value.label),
    aliases: arrayValue<string>(value.aliases).map((alias) => textValue(alias)).filter(Boolean),
    isDefault: value.isDefault === true,
    type: value.type,
    capabilities: value.capabilities,
  };
}
