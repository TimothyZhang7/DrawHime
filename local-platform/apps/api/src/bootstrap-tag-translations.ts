/**
 * 本脚本在部署阶段幂等写入平台维护的常用 LoRA 训练标签翻译集。
 */
import { disconnectDatabase } from "@drawhime/database";
import { ensureCommonTagTranslations } from "./training-tag-library.js";

try {
  const count = await ensureCommonTagTranslations();
  process.stdout.write(`[bootstrap-tag-translations] common=${count}\n`);
} finally {
  await disconnectDatabase();
}
