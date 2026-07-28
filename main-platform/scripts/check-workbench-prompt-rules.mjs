/**
 * 本脚本检查工作台绘图提示词本地校验规则。
 *
 * 运行前需要先构建 backend，使脚本可以导入 dist 中的真实实现；脚本不连接数据库、不创建任务、不读写余额。
 */
import assert from 'node:assert/strict';
import { isCompleteDrawingPrompt } from '../apps/backend/dist/modules/workbench/workbench-prompt-rules.js';

const invalidPrompts = [
  '同上完整提示词',
  '（同上完整提示词）',
  '基于三张参考图生成三人全身角色立绘设定图...（同上完整提示词）',
  '我已经帮你整理好提示词，请点击确认后生成图片。',
  '当前工作台无法直接生成图片，只能给你一段提示词。',
  '已提交到绘图队列，任务ID为 abc123。',
];

const validPrompts = [
  '科比·布莱恩特主题纪念海报，画面中心为身穿湖人紫金球衣的篮球运动员半身肖像，低角度聚光灯照亮人物轮廓，背景为虚化球馆观众席和金色粒子光尘，构图庄重对称，写实电影海报风格，高细节皮肤、球衣纹理和汗水反光，无文字、无logo、无水印。',
  '以图1为基底图，保持原图构图、人物姿态、表情、背景透视和整体画风不变，仅将角色眼睛颜色修改为自然翡翠绿色；其他五官、发型、服装、手部和光影完全保持一致，禁止新增饰品、文字、边框或额外人物。',
];

for (const prompt of invalidPrompts) {
  assert.equal(isCompleteDrawingPrompt(prompt), false, `应拦截无效提示词：${prompt}`);
}

for (const prompt of validPrompts) {
  assert.equal(isCompleteDrawingPrompt(prompt), true, `应允许完整提示词：${prompt}`);
}

console.log(`[workbench-prompt-rules] checked invalid=${invalidPrompts.length} valid=${validPrompts.length}`);
