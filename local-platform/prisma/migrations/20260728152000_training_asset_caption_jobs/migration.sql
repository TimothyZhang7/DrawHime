-- 本迁移为单张训练图片增加独立自动打标任务范围，不修改既有 Caption、训练任务、余额或媒体。
ALTER TABLE `TrainingCaptionJob`
  ADD COLUMN `scope` VARCHAR(16) NOT NULL DEFAULT 'DATASET',
  ADD COLUMN `assetId` VARCHAR(36) NULL;

CREATE INDEX `TrainingCaptionJob_assetId_createdAt_idx`
  ON `TrainingCaptionJob`(`assetId`, `createdAt`);

ALTER TABLE `TrainingCaptionJob`
  ADD CONSTRAINT `TrainingCaptionJob_assetId_fkey`
  FOREIGN KEY (`assetId`) REFERENCES `DatasetAsset`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
