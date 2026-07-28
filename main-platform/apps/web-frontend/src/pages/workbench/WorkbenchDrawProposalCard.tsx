/** 本文件实现工作台 AI 绘图建议确认卡片，负责展示完整提示词和允许/拒绝操作。 */
import { Check, Clock3, Loader2, Sparkles, X } from 'lucide-react';
import type { WorkbenchDrawingDecision, WorkbenchToolCallView } from '@aiimage/shared-contracts';
import { resolveMediaUrl } from '../../lib/media';

type WorkbenchDrawProposalCardProps = {
  /** 待展示的绘图工具调用。 */
  tool: WorkbenchToolCallView;
  /** 当前正在确认的按钮键，避免用户重复提交同一建议。 */
  confirmingKey: string | null;
  /** 当前用户绘图剩余冷却秒数；冷却中禁止选择方案。 */
  cooldownRemaining: number;
  /** 当前 assistant 消息 ID。 */
  messageId: string;
  /** 用户点击允许或拒绝时触发。 */
  onDecision: (messageId: string, decision: WorkbenchDrawingDecision, optionId?: string) => void;
};

/** 展示 AI 准备提交的完整绘图提示词，并让用户显式确认。 */
export function WorkbenchDrawProposalCard({ tool, confirmingKey, cooldownRemaining, messageId, onDecision }: WorkbenchDrawProposalCardProps) {
  const isPending = tool.decision === 'pending' && tool.status === 'pending';
  const rejecting = confirmingKey === `${messageId}:reject`;
  const options = normalizeProposalOptions(tool);
  const coolingDown = cooldownRemaining > 0;

  return (
    <div className={`workbench-draw-proposal is-${tool.decision ?? tool.status}`}>
      <div className="workbench-draw-proposal-head">
        <Sparkles size={14} />
        <span>{getProposalTitle(tool)}</span>
        <strong>{tool.mode === 'image-to-image' ? '图生图' : '文生图'}</strong>
      </div>
      {tool.sourceImageUrls && tool.sourceImageUrls.length > 0 && (
        <div className="workbench-draw-reference-row" aria-label="图生图参考图">
          {tool.sourceImageUrls.map((url, index) => (
            <img key={`${url}-${index}`} src={resolveMediaUrl(url)} alt={`参考图 ${index + 1}`} loading="lazy" decoding="async" />
          ))}
        </div>
      )}
      {tool.reason && <div className="workbench-draw-reason">{tool.reason}</div>}
      {options.length > 0 ? (
        <div className="workbench-draw-options">
          {options.map((option, index) => {
            const approving = confirmingKey === `${messageId}:approve:${option.id}`;
            const selected = tool.selectedOptionId === option.id;
            return (
              <div key={option.id} className={`workbench-draw-option${selected ? ' is-selected' : ''}`}>
                <div className="workbench-draw-option-head">
                  <strong>{option.title || `方案 ${index + 1}`}</strong>
                  {selected && <span>已选择</span>}
                </div>
                {option.reason && <small>{option.reason}</small>}
                <pre className="workbench-draw-prompt">{option.prompt}</pre>
                {isPending && (
                <button
                  type="button"
                  className="workbench-draw-option-submit"
                  disabled={Boolean(confirmingKey) || coolingDown}
                  onClick={() => onDecision(messageId, 'approve', option.id)}
                >
                    {approving ? <Loader2 size={14} className="animate-spin" /> : coolingDown ? <Clock3 size={14} /> : <Check size={14} />}
                    {coolingDown ? `冷却 ${cooldownRemaining}s` : '按此生成'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        tool.prompt && <pre className="workbench-draw-prompt">{tool.prompt}</pre>
      )}
      {isPending && coolingDown && <div className="workbench-draw-cooldown"><Clock3 size={13} /> 冷却期内不能选择方案，请等待 {cooldownRemaining} 秒。</div>}
      {isPending && (
        <div className="workbench-draw-actions">
          <button type="button" className="is-reject" disabled={Boolean(confirmingKey)} onClick={() => onDecision(messageId, 'reject')}>
            {rejecting ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            拒绝全部
          </button>
        </div>
      )}
      {!isPending && <div className="workbench-draw-decision">{getDecisionLabel(tool)}</div>}
    </div>
  );
}

/** 根据工具状态生成确认卡标题。 */
function getProposalTitle(tool: WorkbenchToolCallView) {
  if (tool.status === 'error') return '绘图提交失败';
  if (tool.decision === 'approved') return '已允许绘图提交';
  if (tool.decision === 'rejected') return '已拒绝绘图提交';
  return tool.title || '等待确认生成图片';
}

/** 根据工具状态生成确认结果标记。 */
function getDecisionLabel(tool: WorkbenchToolCallView) {
  if (tool.status === 'success') return '已提交到绘图队列';
  if (tool.status === 'error') return tool.error || '提交失败';
  if (tool.decision === 'approved') return '已允许';
  if (tool.decision === 'rejected') return '已拒绝';
  return '等待处理';
}

/** 读取候选方案；没有 options 的旧消息用单 prompt 兼容。 */
function normalizeProposalOptions(tool: WorkbenchToolCallView) {
  const options = Array.isArray(tool.options) ? tool.options.filter(item => item.prompt) : [];
  if (options.length > 0) return options;
  return tool.prompt ? [{ id: 'legacy_prompt', title: tool.title || '推荐方案', reason: tool.reason ?? null, prompt: tool.prompt }] : [];
}
