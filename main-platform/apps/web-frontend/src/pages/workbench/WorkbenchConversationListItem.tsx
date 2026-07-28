/** 本文件实现工作台侧栏单个 Agent 上下文窗口项，负责选择和删除入口。 */
import { Loader2, Trash2 } from 'lucide-react';
import type { WorkbenchConversationView } from '@aiimage/shared-contracts';
import { formatConversationTime } from './workbench-page-utils';

type WorkbenchConversationListItemProps = {
  /** 当前上下文窗口摘要。 */
  conversation: WorkbenchConversationView;
  /** 是否为当前选中的窗口。 */
  active: boolean;
  /** 是否正在删除该窗口。 */
  deleting: boolean;
  /** 选择窗口时触发。 */
  onClick: () => void;
  /** 删除窗口时触发。 */
  onDelete: () => void;
};

/** 渲染 Agent 上下文窗口列表项；删除按钮独立于选择按钮，避免误切换。 */
export function WorkbenchConversationListItem({ conversation, active, deleting, onClick, onDelete }: WorkbenchConversationListItemProps) {
  return (
    <div className={`workbench-conversation-row ${active ? 'is-active' : ''}`}>
      <button
        type="button"
        className="workbench-conversation-button"
        onClick={onClick}
      >
        <span className="workbench-conversation-title">{conversation.title}</span>
        <span className="workbench-conversation-preview">{conversation.lastMessagePreview || '新的 Agent 上下文'}</span>
        <time>{formatConversationTime(conversation.lastMessageAt)}</time>
      </button>
      <button
        type="button"
        className="workbench-conversation-delete"
        disabled={deleting}
        aria-label={`删除上下文窗口 ${conversation.title}`}
        onClick={event => {
          event.stopPropagation();
          onDelete();
        }}
      >
        {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
      </button>
    </div>
  );
}
