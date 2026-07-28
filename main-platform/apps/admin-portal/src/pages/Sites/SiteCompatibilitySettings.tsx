/**
 * 本文件展示 API 站点的上游参数兼容开关，避免站点表单继续堆叠协议细节。
 */

/** 站点兼容开关值。 */
export type SiteCompatibilityValues = {
  /** 是否发送 response_format。 */
  sendResponseFormat: boolean;
  /** 是否发送稳定的 prompt_cache_key。 */
  sendPromptCacheKey: boolean;
  /** Auto 尺寸是否按首张参考图改写。 */
  autoSizeFromReference: boolean;
};

/** 站点兼容开关组件属性。 */
type SiteCompatibilitySettingsProps = SiteCompatibilityValues & {
  /** 回写单个兼容开关。 */
  onChange: (name: keyof SiteCompatibilityValues, value: boolean) => void;
};

/** 渲染 response_format、渠道亲和键和 Auto 尺寸三个独立开关。 */
export function SiteCompatibilitySettings({
  sendResponseFormat,
  sendPromptCacheKey,
  autoSizeFromReference,
  onChange,
}: SiteCompatibilitySettingsProps) {
  return (
    <>
      <SiteSwitch
        label="发送 response_format"
        checked={sendResponseFormat}
        onChange={(value) => onChange('sendResponseFormat', value)}
        title="关闭后不向上游发送 response_format 参数"
        description="开启：发送站点响应格式；关闭：完全省略该参数"
      />
      <SiteSwitch
        label="渠道亲和键"
        checked={sendPromptCacheKey}
        onChange={(value) => onChange('sendPromptCacheKey', value)}
        title="开启后发送按用户身份稳定生成的 prompt_cache_key"
        description="开启：同一用户请求可由兼容网关持续命中同一渠道"
      />
      <SiteSwitch
        label="Auto 尺寸兼容"
        checked={autoSizeFromReference}
        onChange={(value) => onChange('autoSizeFromReference', value)}
        title="开启后，图生图 size=auto 会改传第一张参考图向下对齐到 16 倍数的宽×高"
        description="开启：Auto 改传首图宽×高并对齐 16 倍数；关闭：原样传 Auto"
      />
    </>
  );
}

/** 单个布尔开关，统一站点表单的交互与说明样式。 */
function SiteSwitch({
  label,
  checked,
  onChange,
  title,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--color-text-2)' }}>{label}</label>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
          checked ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]'
        }`}
        title={title}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
      <span className="block text-[10px] text-gray-400">{description}</span>
    </div>
  );
}
