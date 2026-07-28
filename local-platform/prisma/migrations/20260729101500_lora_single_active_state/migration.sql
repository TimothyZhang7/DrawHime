-- LoRA 仓库不再区分草稿与发布；只激活未删除条目，避免恢复已经下架的历史资产。
UPDATE `LoraEntry`
SET `status` = 'ACTIVE'
WHERE `status` = 'DISABLED' AND `deletedAt` IS NULL;
