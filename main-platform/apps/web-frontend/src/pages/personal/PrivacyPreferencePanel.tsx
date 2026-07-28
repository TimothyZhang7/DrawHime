/** 本文件渲染个人中心默认隐私设置面板，分别控制网页端和 Bot 端偏好。 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Globe, Lock, MessageCircle } from 'lucide-react';
import { PrivacySwitch } from '../../components/common/PrivacySwitch';
import { usePrivacyPreferences } from '../../lib/usePrivacyPreferences';
import { useToast } from '../../providers/ToastProvider';

/** 个人中心隐私偏好面板；真实保存由 backend 按登录用户和 QQ 绑定校验。 */
export function PrivacyPreferencePanel() {
  const { show } = useToast();
  const {
    preferences,
    loading,
    saving,
    error,
    clearError,
    updateWebDefaultPrivate,
    updateBotDefaultPrivate,
  } = usePrivacyPreferences(true);

  useEffect(() => {
    if (!error) return;
    show(error, 'error');
    clearError();
  }, [clearError, error, show]);

  return (
    <section className="personal-privacy-panel" aria-label="默认隐私设置">
      <div className="personal-privacy-heading">
        <span className="personal-privacy-icon"><Lock size={15} /></span>
        <div>
          <h2>默认隐私</h2>
          <p>新生成内容按入口分别保存默认状态</p>
        </div>
      </div>
      <div className="personal-privacy-options">
        <PrivacyPreferenceItem
          icon={<Globe size={15} />}
          title="网页端"
          description="网页生成页默认使用此状态"
          checked={preferences.webDefaultPrivate}
          disabled={loading}
          pending={saving}
          onChange={updateWebDefaultPrivate}
        />
        <PrivacyPreferenceItem
          icon={<MessageCircle size={15} />}
          title="Bot 端"
          description={preferences.botAvailable && preferences.qqNumber ? `绑定 QQ ${preferences.qqNumber}` : '绑定 QQ 后可设置'}
          checked={preferences.botDefaultPrivate}
          disabled={loading || !preferences.botAvailable}
          pending={saving}
          onChange={updateBotDefaultPrivate}
        />
      </div>
    </section>
  );
}

type PrivacyPreferenceItemProps = {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: (checked: boolean) => void;
};

/** 单个入口的默认隐私设置项，使用真实 switch 控件支持键盘和读屏。 */
function PrivacyPreferenceItem({
  icon,
  title,
  description,
  checked,
  disabled,
  pending,
  onChange,
}: PrivacyPreferenceItemProps) {
  return (
    <div className={`personal-privacy-item ${disabled ? 'is-disabled' : ''}`}>
      <div className="personal-privacy-copy">
        <span className="personal-privacy-entry-icon">{icon}</span>
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
      </div>
      <PrivacySwitch
        checked={checked}
        disabled={disabled}
        pending={pending}
        label={checked ? '私密' : '公开'}
        ariaLabel={`${title}默认隐私`}
        onChange={onChange}
      />
    </div>
  );
}
