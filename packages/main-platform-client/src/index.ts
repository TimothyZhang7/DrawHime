/**
 * 本文件封装独立平台到主站的价格与钱包集成调用，统一鉴权、响应校验和错误语义。
 */
import { billingReservationViewSchema, galleryPublicationRemovalViewSchema, galleryPublicationViewSchema, type BillingReservationView, type GalleryPublicationCreateRequest, type GalleryPublicationRemovalView, type GalleryPublicationView } from "@drawhime/contracts";

/** 主站集成错误，保留 HTTP 状态和业务码供 API 映射。 */
export class MainPlatformIntegrationError extends Error {
  public constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "MainPlatformIntegrationError";
  }
}

/** 发布独立平台不可变价格版本。 */
export async function publishMainPrice(input: {
  productCode: string;
  pricingVersion: number;
  unitPrice: string;
  billingUnit?: "image" | "training_job";
}): Promise<void> {
  await requestMain("/internal/integrations/local-model/prices", {
    method: "PUT",
    body: JSON.stringify({ ...input, billingUnit: input.billingUnit || "image", currency: "CNY" }),
  });
}

/** 按主站价格版本创建资金预留。 */
export async function reserveMainBilling(input: {
  jobId: string;
  idempotencyKey: string;
  userSubject: string;
  walletOwnerType: "user" | "qq";
  productCode: string;
  pricingVersion: number;
  quantity: number;
}): Promise<BillingReservationView> {
  const payload = await requestMain("/internal/integrations/local-model/billing/reservations", {
    method: "POST",
    body: JSON.stringify({
      externalTaskId: input.jobId,
      idempotencyKey: input.idempotencyKey,
      userSubject: input.userSubject,
      walletOwnerType: input.walletOwnerType,
      productCode: input.productCode,
      pricingVersion: input.pricingVersion,
      quantity: input.quantity,
    }),
  });
  return billingReservationViewSchema.parse(payload);
}

/** 提交已经成功保存产物的资金预留。 */
export async function commitMainBilling(reservationId: string, idempotencyKey: string): Promise<BillingReservationView> {
  const payload = await requestMain(`/internal/integrations/local-model/billing/reservations/${encodeURIComponent(reservationId)}/commit`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey }),
  });
  return billingReservationViewSchema.parse(payload);
}

/** 释放失败或取消任务的资金预留。 */
export async function releaseMainBilling(reservationId: string, idempotencyKey: string, reason: string): Promise<BillingReservationView> {
  const payload = await requestMain(`/internal/integrations/local-model/billing/reservations/${encodeURIComponent(reservationId)}/release`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey, reason }),
  });
  return billingReservationViewSchema.parse(payload);
}

/** 把已经成功保存并提交计费的产物发布到主站正式图库。 */
export async function publishMainGallery(jobId: string, input: GalleryPublicationCreateRequest): Promise<GalleryPublicationView> {
  const payload = await requestMain(`/internal/integrations/local-model/generations/${encodeURIComponent(jobId)}/publish`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return galleryPublicationViewSchema.parse(payload);
}

/** 删除主站正式图库中的本地模型作品，不触碰主站钱包和计费审计。 */
export async function removeMainGallery(jobId: string): Promise<GalleryPublicationRemovalView> {
  const payload = await requestMain(`/internal/integrations/local-model/generations/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  return galleryPublicationRemovalViewSchema.parse(payload);
}

/** 发起带服务 token 的主站内部 JSON 请求。 */
async function requestMain(path: string, init: RequestInit): Promise<unknown> {
  const baseUrl = process.env.MAIN_PLATFORM_INTERNAL_URL?.trim() || process.env.MAIN_PLATFORM_BASE_URL?.trim();
  const token = process.env.MAIN_PLATFORM_CLIENT_SECRET?.trim();
  if (!baseUrl || !token) throw new MainPlatformIntegrationError(503, "main_integration_missing", "主站集成配置不完整");
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-local-platform-token": token, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new MainPlatformIntegrationError(503, "main_integration_unreachable", error instanceof Error ? error.message : "主站集成端点不可达");
  }
  const payload = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; code?: string; message?: string } | null;
  if (!response.ok || payload?.ok !== true) {
    throw new MainPlatformIntegrationError(response.status, payload?.code || "main_integration_failed", payload?.message || `主站集成返回 HTTP ${response.status}`);
  }
  return payload.data;
}
