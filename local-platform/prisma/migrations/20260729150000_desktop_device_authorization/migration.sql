-- 桌面设备授权只保存随机密钥哈希；确认身份引用独立身份记录，删除身份时保留过期审计。
CREATE TABLE `DesktopAuthorization` (
    `id` VARCHAR(36) NOT NULL,
    `deviceCodeHash` CHAR(64) NOT NULL,
    `userCode` VARCHAR(9) NOT NULL,
    `deviceName` VARCHAR(80) NOT NULL,
    `externalIdentityId` VARCHAR(36) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `lastPolledAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DesktopAuthorization_deviceCodeHash_key`(`deviceCodeHash`),
    UNIQUE INDEX `DesktopAuthorization_userCode_key`(`userCode`),
    INDEX `DesktopAuthorization_expiresAt_idx`(`expiresAt`),
    INDEX `DesktopAuthorization_externalIdentityId_createdAt_idx`(`externalIdentityId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DesktopAuthorization`
    ADD CONSTRAINT `DesktopAuthorization_externalIdentityId_fkey`
    FOREIGN KEY (`externalIdentityId`) REFERENCES `ExternalIdentity`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
