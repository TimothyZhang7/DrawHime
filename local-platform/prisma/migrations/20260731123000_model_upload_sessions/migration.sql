-- 用户 Anima 底模分片上传会话；只新增独立表，不改写现有模型、任务、余额或媒体数据。
CREATE TABLE `ModelUploadSession` (
  `id` VARCHAR(36) NOT NULL,
  `ownerIdentityId` VARCHAR(36) NOT NULL,
  `fileName` VARCHAR(255) NOT NULL,
  `temporaryFileName` VARCHAR(96) NOT NULL,
  `totalBytes` BIGINT NOT NULL,
  `receivedBytes` BIGINT NOT NULL DEFAULT 0,
  `metadata` JSON NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'UPLOADING',
  `modelVersionId` VARCHAR(36) NULL,
  `errorMessage` TEXT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `ModelUploadSession_temporaryFileName_key`(`temporaryFileName`),
  UNIQUE INDEX `ModelUploadSession_modelVersionId_key`(`modelVersionId`),
  INDEX `model_upload_owner_status_created_idx`(`ownerIdentityId`, `status`, `createdAt`),
  INDEX `model_upload_status_expires_idx`(`status`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ModelUploadSession`
  ADD CONSTRAINT `ModelUploadSession_ownerIdentityId_fkey`
  FOREIGN KEY (`ownerIdentityId`) REFERENCES `ExternalIdentity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `ModelUploadSession_modelVersionId_fkey`
  FOREIGN KEY (`modelVersionId`) REFERENCES `ModelVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
