-- 本迁移为 LoRA 增加可审计的软删除标记；删除已发布或训练产物 LoRA 时保留历史任务、计费和对象存储证据。
ALTER TABLE `LoraEntry` ADD COLUMN `deletedAt` DATETIME(3) NULL;

CREATE INDEX `LoraEntry_deletedAt_status_updatedAt_idx` ON `LoraEntry`(`deletedAt`, `status`, `updatedAt`);
