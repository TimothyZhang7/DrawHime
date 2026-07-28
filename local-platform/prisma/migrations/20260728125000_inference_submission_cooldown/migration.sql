-- 本迁移增加全局用户提交冷却配置和身份级提交闸门；不修改历史任务、钱包、计费或媒体数据。
CREATE TABLE `PlatformRuntimeConfig` (
    `id` INTEGER NOT NULL,
    `inferenceSubmissionCooldownSeconds` INTEGER NOT NULL DEFAULT 180,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `InferenceSubmissionGate` (
    `externalIdentityId` VARCHAR(36) NOT NULL,
    `lastSubmittedAt` DATETIME(3) NOT NULL,
    `lastJobId` VARCHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `InferenceSubmissionGate_lastSubmittedAt_idx`(`lastSubmittedAt`),
    PRIMARY KEY (`externalIdentityId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `PlatformRuntimeConfig` (`id`, `inferenceSubmissionCooldownSeconds`, `createdAt`, `updatedAt`)
VALUES (1, 180, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

ALTER TABLE `InferenceSubmissionGate`
ADD CONSTRAINT `InferenceSubmissionGate_externalIdentityId_fkey`
FOREIGN KEY (`externalIdentityId`) REFERENCES `ExternalIdentity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
