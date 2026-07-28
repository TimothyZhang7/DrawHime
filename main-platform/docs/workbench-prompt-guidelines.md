# 工作台绘图提示词规范

本文件记录工作台 Agent 生成绘图提示词时必须遵守的本地规范。规范约束落地在 `apps/backend/src/modules/workbench/workbench-ai-service.ts` 和 `workbench-agent-helpers.ts`，用于约束 `submit_image_generation_task` 产出的候选方案。

## 调研摘要

- OpenAI 图像生成提示建议把需求写成具体、可观察的画面描述，并补充主体、场景、构图、风格、光影、颜色和限制条件，而不是只写短关键词。
- OpenAI Cookbook 的图像模型提示示例强调结构化描述、逐步明确编辑目标、保持项和变化项；图像编辑尤其需要说清参考图关系和保留内容。
- GitHub 上常见的图像提示词仓库通常把 prompt 拆成主体、环境、构图、风格、镜头/媒介、光照、细节、质量词和负面约束几个模块，便于复用和避免遗漏。

参考来源：

- OpenAI image generation guide: https://platform.openai.com/docs/guides/image-generation
- OpenAI Cookbook image generation prompting guide: https://cookbook.openai.com/examples/multimodal/image_gen_model_prompting_guide
- GitHub prompt engineering topic: https://github.com/topics/prompt-engineering

## 本地硬约束

1. 每个候选方案的 `prompt` 必须独立完整，禁止使用“同上、如上、上述、省略、见上、完整提示词、...（同上）”等占位表达。
2. prompt 必须描述最终画面本身，不写“请生成、帮我画、确认后、点击按钮、任务、余额、平台、模型会”等流程说明。
3. 文生图 prompt 必须包含主体数量、主体身份或外观、动作姿态、环境、构图、风格、光影和画幅用途；用户只给短词时由 Agent 补全为可复现画面。
4. 图生图 prompt 必须明确图1/图2等参考关系：基底图、角色参考、风格参考、保持项、修改项、禁止项。
5. 局部编辑必须写清“只修改什么、保持什么完全不变、禁止新增什么”。
6. 角色替换必须区分身体姿态/构图优先级和角色特征迁移项，避免为了展示参考角色细节破坏基底图姿态。
7. 多参考图必须逐张编号说明用途；只需要一张图时不能强行引用其他历史图片。
8. 用户指定作品名、角色名、品牌名、专有名词、具体风格词时必须原样保留，不得泛化改写。
9. 质量词只能作为补充，不能替代主体、构图和编辑要求。

## 推荐结构

```text
主体/意图：
场景与背景：
构图与镜头：
风格与媒介：
光影与色彩：
关键细节：
质量要求：
约束/禁止项：
```

实际提交给绘图链路时不要求保留这些字段标题，但内容必须覆盖这些维度。

## 本地检查

修改提示词校验规则后，先构建 backend，再运行：

```powershell
pnpm --prefix apps/backend run build
pnpm run check:workbench-prompts
```

该检查只导入构建后的纯函数，不连接数据库、不创建任务、不修改余额。
