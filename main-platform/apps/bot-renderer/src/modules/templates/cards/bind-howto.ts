import { Icons } from '../icons.js';
import { renderCard, T, esc } from '../shared-style-v2.js';
/**
 * V2 Blue Theme — 绑定操作指引卡片
 */

export type Data = {};

export function render(_: Data): string {
  const stepsCSS = `
.steps{display:flex;flex-direction:column;gap:10px}
.step{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;border:1px solid ${T.border};background:${T.bg}}
.step-num{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#fff;flex-shrink:0}
.step-text{font-size:14px;color:${T.text};line-height:1.45}
.step-text code{background:${T.primarySoft};padding:1px 6px;border-radius:4px;font-size:13px;font-weight:700;color:${T.primary};font-family:'SF Mono','Cascadia Code','Consolas',monospace}
`;
  return renderCard({ submitter: (_ as any).submitter,
    layout: 'compact',
    hero: {
      eyebrow: 'Account · Bind',
      title: 'QQ 账号绑定',
      subtitle: '绑定后可查看余额和生成记录',
    },
    body: `
      <div class="grid">
        <div class="meta wide">
          <div class="label">绑定步骤</div>
          <div class="steps">
            <div class="step"><span class="step-num" style="background:${T.green}">1</span><span class="step-text">登录网页端 → 个人页面 → 获取验证码</span></div>
            <div class="step"><span class="step-num" style="background:${T.primary}">2</span><span class="step-text">对 Bot 私聊发送 <code>/绑定 &lt;验证码&gt;</code></span></div>
            <div class="step"><span class="step-num" style="background:${T.amber}">3</span><span class="step-text">绑定完成后即可使用全部功能</span></div>
          </div>
        </div>
      </div>`,
    footer: ['一个 QQ 只能绑定一个网页账户'],
    title: '绑定指引',
    extraCSS: stepsCSS,
  });
}
