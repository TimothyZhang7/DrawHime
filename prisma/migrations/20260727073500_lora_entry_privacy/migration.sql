-- 本迁移为 LoRA 增加公开/私有外显控制；既有 LoRA 默认保持公开，不删除模型、示例图或历史任务引用。
ALTER TABLE `LoraEntry` ADD COLUMN `isPrivate` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `LoraEntry_status_isPrivate_updatedAt_idx` ON `LoraEntry`(`status`, `isPrivate`, `updatedAt`);
