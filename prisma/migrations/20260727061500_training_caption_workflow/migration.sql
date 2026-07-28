-- 本迁移新增可恢复的训练图片自动打标与人工确认记录，不修改既有数据集、训练任务、产物或余额。
CREATE TABLE `TrainingCaptionJob` (
  `id` VARCHAR(36) NOT NULL,
  `datasetId` VARCHAR(36) NOT NULL,
  `mode` VARCHAR(16) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  `progress` DECIMAL(5, 2) NOT NULL DEFAULT 0,
  `assetSnapshot` JSON NOT NULL,
  `totalAssets` INTEGER NOT NULL,
  `completedAssets` INTEGER NOT NULL DEFAULT 0,
  `errorMessage` TEXT NULL,
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `confirmedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `TrainingCaptionJob_datasetId_createdAt_idx`(`datasetId`, `createdAt`),
  INDEX `TrainingCaptionJob_status_createdAt_idx`(`status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TrainingCaptionJob` ADD CONSTRAINT `TrainingCaptionJob_datasetId_fkey` FOREIGN KEY (`datasetId`) REFERENCES `TrainingDataset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
