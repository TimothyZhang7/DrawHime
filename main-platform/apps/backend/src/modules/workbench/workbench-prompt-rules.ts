/**
 * 本文件集中定义工作台绘图提示词的本地校验规则。
 *
 * 这些规则只拦截明显不是绘图提示词的占位文本或流程话术，不参与 AI 路由判断、不创建任务、不扣费。
 */

/** 校验绘图提示词是否完整，防止 AI 的“同上/省略/已提交”等占位文本进入真实绘图任务。 */
export function isCompleteDrawingPrompt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 24) return false;
  if (/[.…]{2,}/.test(text) && /(同上|如上|上述|前述|省略|完整提示词|不再重复|见上)/.test(text)) return false;
  if (/（?\s*同上\s*完整提示词\s*）?/i.test(text)) return false;
  if (/^(好的|可以|我已经|已为你|这是一段|以下是|当前|抱歉|无法|不能)/.test(text) && /(生成|绘图|提示词|提交|任务|工具|工作台|确认)/.test(text)) return false;
  if (/(点击|选择|确认|拒绝|余额|费用|任务ID|任务 ID|已提交|无法直接|不能直接).{0,24}(生成|绘图|提交|任务|方案)/.test(text)) return false;
  return true;
}
