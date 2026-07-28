-- CreateTable
CREATE TABLE `ExternalIdentity` (
    `id` VARCHAR(36) NOT NULL,
    `issuer` VARCHAR(500) NOT NULL,
    `subject` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `avatarUrl` VARCHAR(1000) NULL,
    `roles` JSON NOT NULL,
    `lastAuthenticatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ExternalIdentity_lastAuthenticatedAt_idx`(`lastAuthenticatedAt`),
    UNIQUE INDEX `ExternalIdentity_issuer_subject_key`(`issuer`, `subject`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModelFamily` (
    `id` VARCHAR(36) NOT NULL,
    `slug` VARCHAR(100) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ModelFamily_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModelVersion` (
    `id` VARCHAR(36) NOT NULL,
    `familyId` VARCHAR(36) NOT NULL,
    `version` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `runtimeFormat` VARCHAR(100) NOT NULL,
    `defaultParameters` JSON NOT NULL,
    `minimumVramBytes` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ModelVersion_status_idx`(`status`),
    UNIQUE INDEX `ModelVersion_familyId_version_key`(`familyId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModelFile` (
    `id` VARCHAR(36) NOT NULL,
    `modelVersionId` VARCHAR(36) NOT NULL,
    `role` VARCHAR(100) NOT NULL,
    `objectKey` VARCHAR(500) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `byteSize` BIGINT NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ModelFile_objectKey_key`(`objectKey`),
    INDEX `ModelFile_modelVersionId_role_idx`(`modelVersionId`, `role`),
    INDEX `ModelFile_sha256_idx`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RuntimeDefinition` (
    `id` VARCHAR(36) NOT NULL,
    `modelVersionId` VARCHAR(36) NOT NULL,
    `slug` VARCHAR(120) NOT NULL,
    `runtimeType` VARCHAR(100) NOT NULL,
    `imageReference` VARCHAR(500) NULL,
    `command` JSON NULL,
    `environment` JSON NULL,
    `healthPath` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RuntimeDefinition_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkflowTemplate` (
    `id` VARCHAR(36) NOT NULL,
    `slug` VARCHAR(120) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WorkflowTemplate_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkflowVersion` (
    `id` VARCHAR(36) NOT NULL,
    `workflowTemplateId` VARCHAR(36) NOT NULL,
    `modelVersionId` VARCHAR(36) NOT NULL,
    `runtimeDefinitionId` VARCHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `workflowJson` JSON NOT NULL,
    `inputMapping` JSON NOT NULL,
    `outputMapping` JSON NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WorkflowVersion_modelVersionId_status_idx`(`modelVersionId`, `status`),
    UNIQUE INDEX `WorkflowVersion_workflowTemplateId_version_key`(`workflowTemplateId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GpuHost` (
    `id` VARCHAR(36) NOT NULL,
    `agentKey` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `address` VARCHAR(500) NULL,
    `agentVersion` VARCHAR(100) NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `labels` JSON NULL,
    `lastHeartbeatAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GpuHost_agentKey_key`(`agentKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GpuDevice` (
    `id` VARCHAR(36) NOT NULL,
    `hostId` VARCHAR(36) NOT NULL,
    `deviceKey` VARCHAR(100) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `totalVramBytes` BIGINT NOT NULL,
    `freeVramBytes` BIGINT NULL,
    `utilizationPercent` DECIMAL(5, 2) NULL,
    `temperatureCelsius` DECIMAL(5, 2) NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `lastHeartbeatAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `GpuDevice_status_lastHeartbeatAt_idx`(`status`, `lastHeartbeatAt`),
    UNIQUE INDEX `GpuDevice_hostId_deviceKey_key`(`hostId`, `deviceKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GpuLease` (
    `id` VARCHAR(36) NOT NULL,
    `gpuDeviceId` VARCHAR(36) NOT NULL,
    `jobId` VARCHAR(36) NOT NULL,
    `leaseTokenHash` CHAR(64) NOT NULL,
    `status` ENUM('OFFERED', 'ACCEPTED', 'RUNNING', 'RELEASED', 'EXPIRED') NOT NULL DEFAULT 'OFFERED',
    `offeredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acceptedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `releasedAt` DATETIME(3) NULL,

    UNIQUE INDEX `GpuLease_leaseTokenHash_key`(`leaseTokenHash`),
    INDEX `GpuLease_gpuDeviceId_status_expiresAt_idx`(`gpuDeviceId`, `status`, `expiresAt`),
    INDEX `GpuLease_jobId_idx`(`jobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InferenceJob` (
    `id` VARCHAR(36) NOT NULL,
    `externalIdentityId` VARCHAR(36) NOT NULL,
    `modelVersionId` VARCHAR(36) NOT NULL,
    `runtimeDefinitionId` VARCHAR(36) NOT NULL,
    `workflowVersionId` VARCHAR(36) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `source` VARCHAR(50) NOT NULL,
    `status` ENUM('QUEUED', 'RESERVING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `progress` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `requestedPrompt` LONGTEXT NOT NULL,
    `effectivePrompt` LONGTEXT NULL,
    `negativePrompt` LONGTEXT NULL,
    `parameters` JSON NOT NULL,
    `errorCode` VARCHAR(100) NULL,
    `errorMessage` TEXT NULL,
    `queuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `InferenceJob_idempotencyKey_key`(`idempotencyKey`),
    INDEX `InferenceJob_externalIdentityId_createdAt_idx`(`externalIdentityId`, `createdAt`),
    INDEX `InferenceJob_status_queuedAt_idx`(`status`, `queuedAt`),
    INDEX `InferenceJob_modelVersionId_status_idx`(`modelVersionId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InferenceAttempt` (
    `id` VARCHAR(36) NOT NULL,
    `jobId` VARCHAR(36) NOT NULL,
    `attemptNumber` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `gpuHostId` VARCHAR(36) NULL,
    `runtimeJobId` VARCHAR(191) NULL,
    `requestJson` JSON NULL,
    `responseJson` JSON NULL,
    `errorCode` VARCHAR(100) NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `InferenceAttempt_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `InferenceAttempt_jobId_attemptNumber_key`(`jobId`, `attemptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobStage` (
    `id` VARCHAR(36) NOT NULL,
    `jobId` VARCHAR(36) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `stageType` VARCHAR(100) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `inputJson` JSON NULL,
    `outputJson` JSON NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `JobStage_jobId_stageType_idx`(`jobId`, `stageType`),
    UNIQUE INDEX `JobStage_jobId_sequence_key`(`jobId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobArtifact` (
    `id` VARCHAR(36) NOT NULL,
    `jobId` VARCHAR(36) NULL,
    `kind` ENUM('SOURCE_IMAGE', 'GENERATED_IMAGE', 'PREVIEW_IMAGE', 'MODEL_FILE', 'LORA_FILE', 'DATASET_ASSET', 'TRAINING_SAMPLE', 'TRAINING_LOG') NOT NULL,
    `objectKey` VARCHAR(500) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `byteSize` BIGINT NOT NULL,
    `width` INTEGER NULL,
    `height` INTEGER NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `JobArtifact_objectKey_key`(`objectKey`),
    INDEX `JobArtifact_jobId_kind_idx`(`jobId`, `kind`),
    INDEX `JobArtifact_sha256_idx`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillingReservationMirror` (
    `id` VARCHAR(36) NOT NULL,
    `jobId` VARCHAR(36) NOT NULL,
    `mainReservationId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `priceVersion` VARCHAR(100) NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` ENUM('PENDING', 'RESERVED', 'COMMITTED', 'RELEASED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `expiresAt` DATETIME(3) NULL,
    `lastSynchronizedAt` DATETIME(3) NULL,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BillingReservationMirror_jobId_key`(`jobId`),
    UNIQUE INDEX `BillingReservationMirror_mainReservationId_key`(`mainReservationId`),
    UNIQUE INDEX `BillingReservationMirror_idempotencyKey_key`(`idempotencyKey`),
    INDEX `BillingReservationMirror_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GalleryPublicationMirror` (
    `id` VARCHAR(36) NOT NULL,
    `jobId` VARCHAR(36) NOT NULL,
    `artifactId` VARCHAR(36) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `mainPublicationId` VARCHAR(191) NULL,
    `mainGalleryItemId` VARCHAR(191) NULL,
    `mediaUrl` VARCHAR(1000) NULL,
    `status` ENUM('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `lastSynchronizedAt` DATETIME(3) NULL,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GalleryPublicationMirror_jobId_key`(`jobId`),
    UNIQUE INDEX `GalleryPublicationMirror_artifactId_key`(`artifactId`),
    UNIQUE INDEX `GalleryPublicationMirror_idempotencyKey_key`(`idempotencyKey`),
    UNIQUE INDEX `GalleryPublicationMirror_mainPublicationId_key`(`mainPublicationId`),
    UNIQUE INDEX `GalleryPublicationMirror_mainGalleryItemId_key`(`mainGalleryItemId`),
    INDEX `GalleryPublicationMirror_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InboxEvent` (
    `id` VARCHAR(36) NOT NULL,
    `source` VARCHAR(100) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `processedAt` DATETIME(3) NULL,
    `processingError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `InboxEvent_processedAt_createdAt_idx`(`processedAt`, `createdAt`),
    UNIQUE INDEX `InboxEvent_source_eventId_key`(`source`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxEvent` (
    `id` VARCHAR(36) NOT NULL,
    `aggregateType` VARCHAR(100) NOT NULL,
    `aggregateId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `availableAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `publishedAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OutboxEvent_publishedAt_availableAt_idx`(`publishedAt`, `availableAt`),
    INDEX `OutboxEvent_aggregateType_aggregateId_idx`(`aggregateType`, `aggregateId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IdempotencyRecord` (
    `id` VARCHAR(36) NOT NULL,
    `scope` VARCHAR(100) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `statusCode` INTEGER NULL,
    `responseJson` JSON NULL,
    `lockedUntil` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `IdempotencyRecord_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `IdempotencyRecord_scope_key_key`(`scope`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LoraEntry` (
    `id` VARCHAR(36) NOT NULL,
    `ownerIdentityId` VARCHAR(36) NOT NULL,
    `modelFamilyId` VARCHAR(36) NOT NULL,
    `slug` VARCHAR(160) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `type` ENUM('STYLE', 'CHARACTER', 'CONCEPT', 'CLOTHING', 'POSE', 'OTHER') NOT NULL,
    `triggerWords` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LoraEntry_slug_key`(`slug`),
    INDEX `LoraEntry_modelFamilyId_type_status_idx`(`modelFamilyId`, `type`, `status`),
    INDEX `LoraEntry_ownerIdentityId_createdAt_idx`(`ownerIdentityId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LoraVersion` (
    `id` VARCHAR(36) NOT NULL,
    `loraEntryId` VARCHAR(36) NOT NULL,
    `version` VARCHAR(100) NOT NULL,
    `objectKey` VARCHAR(500) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `byteSize` BIGINT NOT NULL,
    `metadata` JSON NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LoraVersion_objectKey_key`(`objectKey`),
    INDEX `LoraVersion_sha256_idx`(`sha256`),
    UNIQUE INDEX `LoraVersion_loraEntryId_version_key`(`loraEntryId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LoraExample` (
    `id` VARCHAR(36) NOT NULL,
    `loraEntryId` VARCHAR(36) NOT NULL,
    `artifactId` VARCHAR(36) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `prompt` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LoraExample_loraEntryId_sortOrder_idx`(`loraEntryId`, `sortOrder`),
    UNIQUE INDEX `LoraExample_loraEntryId_artifactId_key`(`loraEntryId`, `artifactId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainingDataset` (
    `id` VARCHAR(36) NOT NULL,
    `ownerIdentityId` VARCHAR(36) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'DISABLED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TrainingDataset_ownerIdentityId_createdAt_idx`(`ownerIdentityId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DatasetAsset` (
    `id` VARCHAR(36) NOT NULL,
    `datasetId` VARCHAR(36) NOT NULL,
    `artifactId` VARCHAR(36) NOT NULL,
    `caption` LONGTEXT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DatasetAsset_datasetId_artifactId_key`(`datasetId`, `artifactId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainingJob` (
    `id` VARCHAR(36) NOT NULL,
    `externalIdentityId` VARCHAR(36) NOT NULL,
    `datasetId` VARCHAR(36) NOT NULL,
    `baseModelVersionId` VARCHAR(36) NOT NULL,
    `outputLoraVersionId` VARCHAR(36) NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'READY', 'RUNNING', 'EVALUATING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `progress` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `parameters` JSON NOT NULL,
    `errorCode` VARCHAR(100) NULL,
    `errorMessage` TEXT NULL,
    `queuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TrainingJob_idempotencyKey_key`(`idempotencyKey`),
    INDEX `TrainingJob_externalIdentityId_createdAt_idx`(`externalIdentityId`, `createdAt`),
    INDEX `TrainingJob_status_queuedAt_idx`(`status`, `queuedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainingAttempt` (
    `id` VARCHAR(36) NOT NULL,
    `trainingJobId` VARCHAR(36) NOT NULL,
    `attemptNumber` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `gpuHostId` VARCHAR(36) NULL,
    `runtimeJobId` VARCHAR(191) NULL,
    `metrics` JSON NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TrainingAttempt_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `TrainingAttempt_trainingJobId_attemptNumber_key`(`trainingJobId`, `attemptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EvaluationRun` (
    `id` VARCHAR(36) NOT NULL,
    `trainingJobId` VARCHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `parameters` JSON NOT NULL,
    `metrics` JSON NULL,
    `artifactIds` JSON NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EvaluationRun_trainingJobId_createdAt_idx`(`trainingJobId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModelDistribution` (
    `id` VARCHAR(36) NOT NULL,
    `modelFileId` VARCHAR(36) NOT NULL,
    `gpuHostId` VARCHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `localPath` VARCHAR(1000) NULL,
    `verifiedSha256` CHAR(64) NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ModelDistribution_gpuHostId_status_idx`(`gpuHostId`, `status`),
    UNIQUE INDEX `ModelDistribution_modelFileId_gpuHostId_key`(`modelFileId`, `gpuHostId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ModelVersion` ADD CONSTRAINT `ModelVersion_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `ModelFamily`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModelFile` ADD CONSTRAINT `ModelFile_modelVersionId_fkey` FOREIGN KEY (`modelVersionId`) REFERENCES `ModelVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RuntimeDefinition` ADD CONSTRAINT `RuntimeDefinition_modelVersionId_fkey` FOREIGN KEY (`modelVersionId`) REFERENCES `ModelVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowVersion` ADD CONSTRAINT `WorkflowVersion_workflowTemplateId_fkey` FOREIGN KEY (`workflowTemplateId`) REFERENCES `WorkflowTemplate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowVersion` ADD CONSTRAINT `WorkflowVersion_modelVersionId_fkey` FOREIGN KEY (`modelVersionId`) REFERENCES `ModelVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowVersion` ADD CONSTRAINT `WorkflowVersion_runtimeDefinitionId_fkey` FOREIGN KEY (`runtimeDefinitionId`) REFERENCES `RuntimeDefinition`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GpuDevice` ADD CONSTRAINT `GpuDevice_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `GpuHost`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GpuLease` ADD CONSTRAINT `GpuLease_gpuDeviceId_fkey` FOREIGN KEY (`gpuDeviceId`) REFERENCES `GpuDevice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GpuLease` ADD CONSTRAINT `GpuLease_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `InferenceJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InferenceJob` ADD CONSTRAINT `InferenceJob_externalIdentityId_fkey` FOREIGN KEY (`externalIdentityId`) REFERENCES `ExternalIdentity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InferenceJob` ADD CONSTRAINT `InferenceJob_modelVersionId_fkey` FOREIGN KEY (`modelVersionId`) REFERENCES `ModelVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InferenceJob` ADD CONSTRAINT `InferenceJob_runtimeDefinitionId_fkey` FOREIGN KEY (`runtimeDefinitionId`) REFERENCES `RuntimeDefinition`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InferenceJob` ADD CONSTRAINT `InferenceJob_workflowVersionId_fkey` FOREIGN KEY (`workflowVersionId`) REFERENCES `WorkflowVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InferenceAttempt` ADD CONSTRAINT `InferenceAttempt_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `InferenceJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobStage` ADD CONSTRAINT `JobStage_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `InferenceJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobArtifact` ADD CONSTRAINT `JobArtifact_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `InferenceJob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillingReservationMirror` ADD CONSTRAINT `BillingReservationMirror_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `InferenceJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GalleryPublicationMirror` ADD CONSTRAINT `GalleryPublicationMirror_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `InferenceJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GalleryPublicationMirror` ADD CONSTRAINT `GalleryPublicationMirror_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `JobArtifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LoraEntry` ADD CONSTRAINT `LoraEntry_ownerIdentityId_fkey` FOREIGN KEY (`ownerIdentityId`) REFERENCES `ExternalIdentity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LoraEntry` ADD CONSTRAINT `LoraEntry_modelFamilyId_fkey` FOREIGN KEY (`modelFamilyId`) REFERENCES `ModelFamily`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LoraVersion` ADD CONSTRAINT `LoraVersion_loraEntryId_fkey` FOREIGN KEY (`loraEntryId`) REFERENCES `LoraEntry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LoraExample` ADD CONSTRAINT `LoraExample_loraEntryId_fkey` FOREIGN KEY (`loraEntryId`) REFERENCES `LoraEntry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LoraExample` ADD CONSTRAINT `LoraExample_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `JobArtifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainingDataset` ADD CONSTRAINT `TrainingDataset_ownerIdentityId_fkey` FOREIGN KEY (`ownerIdentityId`) REFERENCES `ExternalIdentity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DatasetAsset` ADD CONSTRAINT `DatasetAsset_datasetId_fkey` FOREIGN KEY (`datasetId`) REFERENCES `TrainingDataset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DatasetAsset` ADD CONSTRAINT `DatasetAsset_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `JobArtifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainingJob` ADD CONSTRAINT `TrainingJob_externalIdentityId_fkey` FOREIGN KEY (`externalIdentityId`) REFERENCES `ExternalIdentity`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainingJob` ADD CONSTRAINT `TrainingJob_datasetId_fkey` FOREIGN KEY (`datasetId`) REFERENCES `TrainingDataset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainingJob` ADD CONSTRAINT `TrainingJob_baseModelVersionId_fkey` FOREIGN KEY (`baseModelVersionId`) REFERENCES `ModelVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainingJob` ADD CONSTRAINT `TrainingJob_outputLoraVersionId_fkey` FOREIGN KEY (`outputLoraVersionId`) REFERENCES `LoraVersion`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainingAttempt` ADD CONSTRAINT `TrainingAttempt_trainingJobId_fkey` FOREIGN KEY (`trainingJobId`) REFERENCES `TrainingJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EvaluationRun` ADD CONSTRAINT `EvaluationRun_trainingJobId_fkey` FOREIGN KEY (`trainingJobId`) REFERENCES `TrainingJob`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModelDistribution` ADD CONSTRAINT `ModelDistribution_modelFileId_fkey` FOREIGN KEY (`modelFileId`) REFERENCES `ModelFile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModelDistribution` ADD CONSTRAINT `ModelDistribution_gpuHostId_fkey` FOREIGN KEY (`gpuHostId`) REFERENCES `GpuHost`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
