/** 本文件提供隐私状态开关，供生成页和个人中心复用同一套可访问交互。 */
import { Globe, Lock, Loader2 } from 'lucide-react';

/** 隐私开关参数。 */
export type PrivacySwitchProps = {
  /** 当前是否私密。 */
  checked: boolean;
  /** 用户切换后的回调。 */
  onChange: (checked: boolean) => void;
  /** 显示在开关旁的短标签。 */
  label?: string;
  /** 控件不可操作时禁用点击。 */
  disabled?: boolean;
  /** 正在保存时展示轻量状态。 */
  pending?: boolean;
  /** 紧凑尺寸用于工具栏。 */
  size?: 'sm' | 'md';
  /** 无可见标签时提供给读屏软件的名称。 */
  ariaLabel?: string;
  /** 附加类名，便于页面做布局约束。 */
  className?: string;
};

/** 渲染真实 button switch；持久化和权限校验由调用方负责。 */
export function PrivacySwitch({
  checked,
  onChange,
  label,
  disabled = false,
  pending = false,
  size = 'md',
  ariaLabel,
  className = '',
}: PrivacySwitchProps) {
  const icon = pending
    ? <Loader2 size={size === 'sm' ? 11 : 13} className="animate-spin" />
    : checked
      ? <Lock size={size === 'sm' ? 11 : 13} />
      : <Globe size={size === 'sm' ? 11 : 13} />;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label ?? (checked ? '私密' : '公开')}
      disabled={disabled}
      className={`privacy-switch privacy-switch-${size} ${checked ? 'is-on' : 'is-off'} ${pending ? 'is-saving' : ''} ${className}`.trim()}
      onClick={() => { if (!disabled) onChange(!checked); }}
    >
      <span className="privacy-switch-track" aria-hidden="true">
        <span className="privacy-switch-thumb">{icon}</span>
      </span>
      {label && <span className="privacy-switch-label">{label}</span>}
    </button>
  );
}
