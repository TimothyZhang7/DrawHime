-- 本迁移为推理与训练记录增加软删除标记；删除记录不删除钱包预留、计费、训练与 LoRA 审计。
ALTER TABLE `InferenceJob` ADD COLUMN `deletedAt` DATETIME(3) NULL;
ALTER TABLE `TrainingJob` ADD COLUMN `deletedAt` DATETIME(3) NULL;

CREATE INDEX `InferenceJob_externalIdentityId_deletedAt_createdAt_idx` ON `InferenceJob`(`externalIdentityId`, `deletedAt`, `createdAt`);
CREATE INDEX `TrainingJob_externalIdentityId_deletedAt_createdAt_idx` ON `TrainingJob`(`externalIdentityId`, `deletedAt`, `createdAt`);
