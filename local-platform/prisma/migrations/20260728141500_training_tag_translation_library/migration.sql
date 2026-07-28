-- 本迁移创建独立的 LoRA 训练标签翻译集；不修改训练图片、Caption、任务、LoRA、余额或媒体。
CREATE TABLE `TrainingTagTranslation` (
    `id` VARCHAR(36) NOT NULL,
    `tag` VARCHAR(191) NOT NULL,
    `translated` VARCHAR(500) NOT NULL,
    `color` CHAR(7) NOT NULL,
    `source` VARCHAR(100) NOT NULL,
    `usageCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `TrainingTagTranslation_tag_key`(`tag`),
    UNIQUE INDEX `TrainingTagTranslation_color_key`(`color`),
    INDEX `TrainingTagTranslation_usageCount_updatedAt_idx`(`usageCount`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
