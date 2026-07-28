-- 本迁移为底模仓库增加封面与示例图关联；现有模型、任务、余额和模型文件保持不变。
CREATE TABLE `ModelExample` (
    `id` VARCHAR(36) NOT NULL,
    `modelVersionId` VARCHAR(36) NOT NULL,
    `artifactId` VARCHAR(36) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `prompt` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `ModelExample_modelVersionId_artifactId_key`(`modelVersionId`, `artifactId`),
    INDEX `ModelExample_modelVersionId_sortOrder_idx`(`modelVersionId`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `ModelExample` ADD CONSTRAINT `ModelExample_modelVersionId_fkey` FOREIGN KEY (`modelVersionId`) REFERENCES `ModelVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ModelExample` ADD CONSTRAINT `ModelExample_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `JobArtifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
