-- 桌面本机产物分片上传与正式图库发布镜像；不触碰已有推理、训练、钱包或图库数据。
CREATE TABLE `DesktopGalleryUpload` (
  `id` VARCHAR(36) NOT NULL,
  `externalIdentityId` VARCHAR(36) NOT NULL,
  `localTaskId` VARCHAR(36) NOT NULL,
  `artifactSha256` CHAR(64) NOT NULL,
  `fileName` VARCHAR(255) NOT NULL,
  `temporaryFileName` VARCHAR(64) NOT NULL,
  `mimeType` VARCHAR(64) NOT NULL,
  `totalBytes` BIGINT NOT NULL,
  `receivedBytes` BIGINT NOT NULL DEFAULT 0,
  `width` INTEGER NOT NULL,
  `height` INTEGER NOT NULL,
  `isPrivate` BOOLEAN NOT NULL,
  `effectivePrompt` LONGTEXT NOT NULL,
  `negativePrompt` LONGTEXT NULL,
  `modelDisplayName` VARCHAR(191) NOT NULL,
  `parameters` JSON NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'UPLOADING',
  `artifactId` VARCHAR(36) NULL,
  `mainPublicationId` VARCHAR(191) NULL,
  `mainGalleryItemId` VARCHAR(191) NULL,
  `mediaUrl` VARCHAR(1000) NULL,
  `errorMessage` TEXT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `publishedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `DesktopGalleryUpload_temporaryFileName_key`(`temporaryFileName`),
  UNIQUE INDEX `DesktopGalleryUpload_artifactId_key`(`artifactId`),
  UNIQUE INDEX `DesktopGalleryUpload_mainPublicationId_key`(`mainPublicationId`),
  UNIQUE INDEX `DesktopGalleryUpload_mainGalleryItemId_key`(`mainGalleryItemId`),
  UNIQUE INDEX `desktop_gallery_owner_task_sha_uq`(`externalIdentityId`, `localTaskId`, `artifactSha256`),
  INDEX `desktop_gallery_owner_status_created_idx`(`externalIdentityId`, `status`, `createdAt`),
  INDEX `desktop_gallery_status_expires_idx`(`status`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DesktopGalleryUpload`
  ADD CONSTRAINT `DesktopGalleryUpload_externalIdentityId_fkey`
  FOREIGN KEY (`externalIdentityId`) REFERENCES `ExternalIdentity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `DesktopGalleryUpload_artifactId_fkey`
  FOREIGN KEY (`artifactId`) REFERENCES `JobArtifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
