/**
 * 本文件实现邮件发送服务，通过 SMTP 投递邮箱验证和密码重置邮件。
 */

import { createTransport, type Transporter } from 'nodemailer';

export type EmailSendRequest = {
  to: string;
  subject: string;
  html: string;
  idempotencyKey: string;
};

/** SMTP 配置 */
function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: Number(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
    // 邮件只允许使用显式 HTML 内容，禁止模板触发本地文件读取或远程 URL 拉取。
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export class EmailService {
  private transporter: Transporter | null = null;
  private readonly cooldownMap = new Map<string, { lastSentAt: number; count: number; windowStartAt: number }>();
  /** 10 分钟内同一邮箱最多发送次数 */
  private readonly maxPerWindow = 3;
  private readonly windowMs = 10 * 60 * 1000;
  private readonly minIntervalMs = 60 * 1000;

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = createTransport(getSmtpConfig());
    }
    return this.transporter;
  }

  /** 检查冷却：返回是否允许发送 */
  private checkCooldown(to: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const entry = this.cooldownMap.get(to);
    if (!entry) return { allowed: true };
    if (now - entry.lastSentAt < this.minIntervalMs) {
      return { allowed: false, reason: `发送间隔不足 ${Math.ceil((this.minIntervalMs - (now - entry.lastSentAt)) / 1000)} 秒` };
    }
    // 窗口过期后重置计数器，避免 count 永久累积导致永远无法发送
    if (now - entry.windowStartAt > this.windowMs) {
      this.cooldownMap.delete(to);
      return { allowed: true };
    }
    const windowCount = (entry.count || 0);
    if (windowCount >= this.maxPerWindow) {
      return { allowed: false, reason: `10 分钟内已发送 ${windowCount} 封邮件，已达上限` };
    }
    return { allowed: true };
  }

  private recordSend(to: string) {
    const now = Date.now();
    const entry = this.cooldownMap.get(to);
    this.cooldownMap.set(to, {
      lastSentAt: now,
      count: (entry?.count ?? 0) + 1,
      windowStartAt: entry?.windowStartAt ?? now,
    });
    // 清理过期记录
    if (this.cooldownMap.size > 500) {
      for (const [k, v] of this.cooldownMap) {
        if (now - v.lastSentAt > this.windowMs) this.cooldownMap.delete(k);
      }
    }
  }

  async send(request: EmailSendRequest): Promise<void> {
    const { allowed, reason } = this.checkCooldown(request.to);
    if (!allowed) {
      console.warn(`[notification-worker] [EMAIL] 冷却拒绝: to=${request.to} reason=${reason}`);
      return;
    }
    this.recordSend(request.to);

    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    if (!smtpUser || !smtpPass) {
      // 未配置 SMTP 时只记录投递元数据，禁止把验证或重置链接中的一次性 token 写入日志。
      console.log(`[notification-worker] [EMAIL] SMTP 未配置，仅记录: to=${request.to} subject=${request.subject}`);
      return;
    }

    try {
      const fromName = normalizeMailBrandName(process.env.SMTP_FROM_NAME);
      await this.getTransporter().sendMail({
        from: `"${fromName}" <${smtpUser}>`,
        to: request.to,
        subject: request.subject,
        html: request.html,
      });
      console.log(`[notification-worker] [EMAIL] 发送成功: to=${request.to} subject=${request.subject}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[notification-worker] [EMAIL] 发送失败: to=${request.to} error=${msg}`);
      throw error;
    }
  }

  async sendVerificationEmail(to: string, verifyUrl: string, idempotencyKey: string): Promise<void> {
    return this.send({
      to, idempotencyKey,
      subject: '绘图姬 DrawHime - 邮箱验证',
      html: renderEmailHtml({
        title: '验证您的绘图姬邮箱',
        intro: '感谢注册绘图姬 DrawHime。请点击下方按钮完成邮箱验证，验证后即可继续使用账号安全相关功能。',
        buttonText: '验证邮箱',
        actionUrl: verifyUrl,
        note: '如果您没有注册绘图姬 DrawHime，请忽略此邮件。链接 24 小时后过期。',
      }),
    });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string, idempotencyKey: string): Promise<void> {
    return this.send({
      to, idempotencyKey,
      subject: '绘图姬 DrawHime - 密码重置',
      html: renderEmailHtml({
        title: '重置绘图姬账号密码',
        intro: '我们收到了绘图姬 DrawHime 账号的密码重置请求。请点击下方按钮设置新密码。',
        buttonText: '重置密码',
        actionUrl: resetUrl,
        note: '如果您没有请求重置密码，请忽略此邮件。链接 24 小时后过期。',
      }),
    });
  }
}

export const emailService = new EmailService();

/** 邮件模板统一使用绘图姬品牌文案，避免不同邮件显示旧名称或样式不一致。 */
function renderEmailHtml(input: { title: string; intro: string; buttonText: string; actionUrl: string; note: string }): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;max-width:520px;margin:0 auto;padding:28px 20px;color:#111827">
<div style="font-size:13px;font-weight:700;color:#fb7185;margin-bottom:8px">绘图姬 DrawHime</div>
<h2 style="margin:0 0 12px;font-size:22px;line-height:1.35;color:#0f172a">${escapeHtml(input.title)}</h2>
<p style="margin:0 0 22px;font-size:15px;line-height:1.75;color:#374151">${escapeHtml(input.intro)}</p>
<a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;padding:12px 24px;background:#fb7185;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">${escapeHtml(input.buttonText)}</a>
<p style="color:#6b7280;font-size:13px;line-height:1.65;margin-top:22px">${escapeHtml(input.note)}</p>
<p style="color:#9ca3af;font-size:12px;line-height:1.5;margin-top:18px">本邮件由绘图姬 DrawHime 自动发送，请勿直接回复。</p>
</div>`;
}

/** 转义邮件模板变量，避免 URL 或文案中的特殊字符破坏 HTML。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 生产环境若仍配置旧品牌名，邮件发件名也统一改为绘图姬。 */
function normalizeMailBrandName(value: string | undefined): string {
  const name = value?.trim();
  if (!name || /AIImage/i.test(name)) return '绘图姬 DrawHime';
  return name;
}
