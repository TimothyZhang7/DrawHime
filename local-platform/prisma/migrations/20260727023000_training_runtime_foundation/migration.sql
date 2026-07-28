-- 本迁移为真实训练任务补充预留中状态、独立计费镜像和训练 GPU 租约，不修改既有任务与余额。
ALTER TABLE `TrainingJob` MODIFY `status` ENUM('QUEUED','RESERVING','READY','RUNNING','EVALUATING','SUCCEEDED','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED';

CREATE TABLE `TrainingGpuLease` (
  `id` VARCHAR(36) NOT NULL,
  `gpuDeviceId` VARCHAR(36) NOT NULL,
  `trainingJobId` VARCHAR(36) NOT NULL,
  `leaseTokenHash` CHAR(64) NOT NULL,
  `status` ENUM('OFFERED','ACCEPTED','RUNNING','RELEASED','EXPIRED') NOT NULL DEFAULT 'OFFERED',
  `offeredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `acceptedAt` DATETIME(3) NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `releasedAt` DATETIME(3) NULL,
  UNIQUE INDEX `TrainingGpuLease_leaseTokenHash_key`(`leaseTokenHash`),
  INDEX `TrainingGpuLease_gpuDeviceId_status_expiresAt_idx`(`gpuDeviceId`, `status`, `expiresAt`),
  INDEX `TrainingGpuLease_trainingJobId_idx`(`trainingJobId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `TrainingBillingReservationMirror` (
  `id` VARCHAR(36) NOT NULL,
  `trainingJobId` VARCHAR(36) NOT NULL,
  `mainReservationId` VARCHAR(191) NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL,
  `priceVersion` VARCHAR(100) NOT NULL,
  `amountMinor` BIGINT NOT NULL,
  `currency` CHAR(3) NOT NULL,
  `status` ENUM('PENDING','RESERVED','COMMITTED','RELEASED','FAILED') NOT NULL DEFAULT 'PENDING',
  `expiresAt` DATETIME(3) NULL,
  `lastSynchronizedAt` DATETIME(3) NULL,
  `errorMessage` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `TrainingBillingReservationMirror_trainingJobId_key`(`trainingJobId`),
  UNIQUE INDEX `TrainingBillingReservationMirror_mainReservationId_key`(`mainReservationId`),
  UNIQUE INDEX `TrainingBillingReservationMirror_idempotencyKey_key`(`idempotencyKey`),
  INDEX `TrainingBillingReservationMirror_status_expiresAt_idx`(`status`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TrainingGpuLease` ADD CONSTRAINT `TrainingGpuLease_gpuDeviceId_fkey` FOREIGN KEY (`gpuDeviceId`) REFERENCES `GpuDevice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TrainingGpuLease` ADD CONSTRAINT `TrainingGpuLease_trainingJobId_fkey` FOREIGN KEY (`trainingJobId`) REFERENCES `TrainingJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TrainingBillingReservationMirror` ADD CONSTRAINT `TrainingBillingReservationMirror_trainingJobId_fkey` FOREIGN KEY (`trainingJobId`) REFERENCES `TrainingJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
