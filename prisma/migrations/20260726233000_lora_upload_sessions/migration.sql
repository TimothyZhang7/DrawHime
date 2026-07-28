-- 本迁移只新增 LoRA 分片上传会话表，不修改现有模型、任务、身份、计费或产物数据。
CREATE TABLE `LoraUploadSession` (
  `id` VARCHAR(36) NOT NULL,
  `loraEntryId` VARCHAR(36) NOT NULL,
  `fileName` VARCHAR(255) NOT NULL,
  `temporaryFileName` VARCHAR(96) NOT NULL,
  `totalBytes` BIGINT NOT NULL,
  `receivedBytes` BIGINT NOT NULL DEFAULT 0,
  `status` VARCHAR(16) NOT NULL DEFAULT 'UPLOADING',
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `LoraUploadSession_temporaryFileName_key` (`temporaryFileName`),
  INDEX `LoraUploadSession_loraEntryId_status_idx` (`loraEntryId`, `status`),
  INDEX `LoraUploadSession_status_expiresAt_idx` (`status`, `expiresAt`),
  CONSTRAINT `LoraUploadSession_loraEntryId_fkey` FOREIGN KEY (`loraEntryId`) REFERENCES `LoraEntry` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
