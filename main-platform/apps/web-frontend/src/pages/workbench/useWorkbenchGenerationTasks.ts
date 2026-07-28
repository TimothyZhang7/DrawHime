/** 本文件封装工作台窗口内生成任务状态轮询，只读取当前用户可见的真实生成任务。 */
import { useEffect, useMemo, useState } from 'react';
import type { GenerationTasksResponse, GenerationTaskView, WorkbenchMessageView } from '@aiimage/shared-contracts';
import { api } from '../../lib/api';

const MAX_TRACKED_TASKS = 30;
const ACTIVE_POLL_MS = 2500;
const BACKGROUND_POLL_MS = 8000;

/** 返回当前工作台窗口消息关联的生成任务状态，用于在消息流内展示进度和结果。 */
export function useWorkbenchGenerationTasks(messages: WorkbenchMessageView[], authenticated: boolean) {
  const [generationTasks, setGenerationTasks] = useState<GenerationTaskView[]>([]);
  const trackedTaskIds = useMemo(() => collectWorkbenchTaskIds(messages).slice(0, MAX_TRACKED_TASKS), [messages]);

  useEffect(() => {
    if (trackedTaskIds.length === 0 || !authenticated || !hasBrowserToken()) {
      setGenerationTasks([]);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof window.setTimeout> | undefined;
    const ids = trackedTaskIds;

    /** 串行轮询当前窗口关联任务，避免一个窗口内并发刷同一批任务状态。 */
    const poll = async () => {
      const result = await api<GenerationTasksResponse>(`/api/generations/tasks?ids=${encodeURIComponent(ids.join(','))}`);
      if (cancelled) return;
      if (result.ok && result.data?.tasks) {
        setGenerationTasks(result.data.tasks);
        if (hasActiveTask(result.data.tasks)) {
          timer = window.setTimeout(poll, getPollInterval());
        }
        return;
      }
      timer = window.setTimeout(poll, BACKGROUND_POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [trackedTaskIds.join(','), authenticated]);

  return generationTasks;
}

/** 提取当前窗口所有关联任务或批次 ID，供工作台内状态轮询。 */
function collectWorkbenchTaskIds(messages: WorkbenchMessageView[]) {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const id of message.taskIds) if (id) ids.add(id);
    for (const tool of message.toolCalls) {
      for (const id of tool.taskIds) if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** 判断是否仍有需要继续轮询的非终态任务。 */
function hasActiveTask(tasks: GenerationTaskView[]) {
  return tasks.some(item => item.status === 'queued' || item.status === 'running' || item.status === 'finalizing' || item.status === 'deferred');
}

/** 读取浏览器 token；未登录时不轮询，避免全局 401 刷屏。 */
function hasBrowserToken() {
  return typeof window !== 'undefined' && Boolean(window.localStorage.getItem('token'));
}

/** 后台标签页降低轮询频率，减少工作台长期开启时的后端压力。 */
function getPollInterval() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden' ? BACKGROUND_POLL_MS : ACTIVE_POLL_MS;
}
