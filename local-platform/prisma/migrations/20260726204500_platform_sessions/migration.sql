-- AlterTable
ALTER TABLE `ExternalIdentity` ADD COLUMN `emailVerified` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `PlatformSession` (
    `id` VARCHAR(36) NOT NULL,
    `externalIdentityId` VARCHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PlatformSession_tokenHash_key`(`tokenHash`),
    INDEX `PlatformSession_externalIdentityId_expiresAt_idx`(`externalIdentityId`, `expiresAt`),
    INDEX `PlatformSession_expiresAt_revokedAt_idx`(`expiresAt`, `revokedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PlatformSession` ADD CONSTRAINT `PlatformSession_externalIdentityId_fkey` FOREIGN KEY (`externalIdentityId`) REFERENCES `ExternalIdentity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
