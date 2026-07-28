-- 本迁移为训练数据集添加触发词规则及每张图片的已注入快照，不修改已有 Caption、训练任务、余额或媒体。
ALTER TABLE `TrainingDataset`
  ADD COLUMN `triggerWords` JSON NULL;

ALTER TABLE `DatasetAsset`
  ADD COLUMN `appliedTriggerWords` JSON NULL;
