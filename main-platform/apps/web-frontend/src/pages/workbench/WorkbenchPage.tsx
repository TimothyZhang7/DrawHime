/** 本文件实现导航 Agent 工作台页面，负责多上下文窗口、工具调用和真实绘图任务提交。 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  MessageSquareText,
  Plus,
  Send,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import type {
  DrawingModelListResponse,
  DrawingModelOptionView,
  DrawingPublicConfigResponse,
  GenerationCooldownResponse,
  WorkbenchDrawingDecision,
  WorkbenchDrawingDecisionResponse,
  WorkbenchConversationDetailResponse,
  WorkbenchConversationDeleteResponse,
  WorkbenchConversationListResponse,
  WorkbenchConversationView,
  WorkbenchAttachmentView,
  WorkbenchMessageView,
  WorkbenchAttachmentUploadResponse,
  WorkbenchStreamDoneEvent,
  WorkbenchStreamEvent,
  WorkbenchStreamStatusEvent,
} from '@aiimage/shared-contracts';
import { Seo } from '../../components/Seo';
import { PrivacySwitch } from '../../components/common/PrivacySwitch';
import { addRecentTasks } from '../generate/TaskPanel';
import { useAuth } from '../../providers/AuthProvider';
import { useToast } from '../../providers/ToastProvider';
import { BACKEND_UNREACHABLE, api } from '../../lib/api';
import { usePrivacyPreferences } from '../../lib/usePrivacyPreferences';
import { config } from '../../lib/config';
import { formatDrawingModelDisplayName } from '../../lib/drawingModelDisplay';
import { WorkbenchMessageItem } from './WorkbenchMessageItem';
import { WorkbenchConversationListItem } from './WorkbenchConversationListItem';
import {
  buildTemporaryMessage,
  isImageToImageModel,
  isTextToImageModel,
  mergeConversation,
  readSseEventData,
  readSseEventName,
  readVisibleTaskInfo,
  takeTypewriterChunk,
} from './workbench-page-utils';
import { useWorkbenchGenerationTasks } from './useWorkbenchGenerationTasks';
import './WorkbenchPage.css';
import './WorkbenchMessages.css';
import './WorkbenchComposer.css';

const WORKBENCH_REFERENCE_LIMIT = 8;
const WORKBENCH_BOTTOM_STICKY_THRESHOLD = 96;

type WorkbenchComposerAttachment = WorkbenchAttachmentView & {
  /** 本地预览图是否仍在上传；上传完成前不能提交给 Agent。 */
  uploading?: boolean;
  /** 上传失败时保留本地预览并展示错误，避免用户误以为选择文件没有响应。 */
  uploadError?: string;
};

/** 新建工作台页面：用后端会话表保存上下文，用户自然描述需求后由后端 Agent 选择工具。 */
export function WorkbenchPage() {
  const { user } = useAuth();
  const { show } = useToast();
  const [conversations, setConversations] = useState<WorkbenchConversationView[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('');
  const [messages, setMessages] = useState<WorkbenchMessageView[]>([]);
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<WorkbenchComposerAttachment[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [referencePanelOpen, setReferencePanelOpen] = useState(false);
  const [confirmingProposalKey, setConfirmingProposalKey] = useState<string | null>(null);
  const [retryingMessageId, setRetryingMessageId] = useState<string | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [models, setModels] = useState<DrawingModelOptionView[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [multiConfig, setMultiConfig] = useState({ enabled: true, max: 4 });
  const [maxPromptLength, setMaxPromptLength] = useState<number | null>(null);
  const [count, setCount] = useState(1);
  const [isPrivate, setIsPrivate] = useState(false);
  const [balance, setBalance] = useState<{ freeBalance: string; paidBalance: string; totalBalance: string } | null>(null);
  const [generationCooldown, setGenerationCooldown] = useState<GenerationCooldownResponse | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const referencePreviewUrlsRef = useRef<Set<string>>(new Set());
  const privacyPrefs = usePrivacyPreferences(Boolean(user));

  useEffect(() => {
    if (activeConversationId) return;
    setIsPrivate(privacyPrefs.preferences.webDefaultPrivate);
  }, [activeConversationId, privacyPrefs.preferences.webDefaultPrivate]);

  useEffect(() => () => {
    referencePreviewUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    referencePreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => () => {
    if (scrollFrameRef.current) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    void api<{ freeBalance: string; paidBalance: string; totalBalance: string }>('/api/wallet/status').then(result => {
      if (result.ok && result.data) setBalance(result.data);
    });
    void api<DrawingModelListResponse>('/api/drawing/models').then(result => {
      if (!result.ok || !Array.isArray(result.data?.models)) return;
      const drawableModels = result.data.models.filter(item => isTextToImageModel(item) || isImageToImageModel(item));
      setModels(drawableModels);
      const defaultModel = result.data.defaultModel && drawableModels.some(item => item.name === result.data?.defaultModel)
        ? result.data.defaultModel
        : drawableModels.find(isTextToImageModel)?.name ?? drawableModels[0]?.name ?? '';
      setSelectedModel(defaultModel);
    });
    void api<DrawingPublicConfigResponse>('/api/drawing/config').then(result => {
      if (!result.ok || !result.data) return;
      const max = Math.min(Math.max(Number(result.data.multiCountMax) || 4, 1), 20);
      setMultiConfig({ enabled: result.data.multiEnabled !== false, max });
      const promptLimit = Number(result.data.maxPromptLength);
      if (Number.isFinite(promptLimit) && promptLimit > 0) setMaxPromptLength(Math.floor(promptLimit));
      setCount(value => Math.min(value, max));
    });
  }, []);

  useEffect(() => {
    if (!privacyPrefs.error) return;
    show(privacyPrefs.error, 'error');
    privacyPrefs.clearError();
  }, [privacyPrefs, show]);

  useEffect(() => {
    if (!user) return;
    void loadConversations();
  }, [user]);

  useEffect(() => {
    if (!user || !localStorage.getItem('token')) {
      setGenerationCooldown(null);
      return;
    }
    void refreshGenerationCooldown();
  }, [user]);

  useEffect(() => {
    const remaining = generationCooldown?.remainingSeconds ?? 0;
    if (remaining <= 0) return;
    const timer = window.setInterval(() => {
      setGenerationCooldown(current => current ? { ...current, remainingSeconds: Math.max(0, current.remainingSeconds - 1) } : current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [generationCooldown?.remainingSeconds]);

  const activeConversation = useMemo(
    () => conversations.find(item => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations],
  );

  const activeDrawingMode = attachments.length > 0 ? 'image-to-image' : 'text-to-image';
  const availableModels = useMemo(
    () => models.filter(item => activeDrawingMode === 'image-to-image' ? isImageToImageModel(item) : isTextToImageModel(item)),
    [activeDrawingMode, models],
  );

  const currentModel = useMemo(
    () => availableModels.find(item => item.name === selectedModel) ?? availableModels[0] ?? null,
    [availableModels, selectedModel],
  );

  const generationTasks = useWorkbenchGenerationTasks(messages, Boolean(user));
  const cooldownRemaining = generationCooldown?.remainingSeconds ?? 0;
  const generationTaskScrollKey = useMemo(
    () => generationTasks.map(item => `${item.id}:${item.status}:${item.imageUrl ?? ''}:${item.thumbnailUrl ?? ''}`).join('|'),
    [generationTasks],
  );

  useEffect(() => {
    const target = scrollRef.current;
    if (!target || !shouldStickToBottomRef.current) return;
    if (scrollFrameRef.current) window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const current = scrollRef.current;
      if (!current || !shouldStickToBottomRef.current) return;
      current.scrollTo({ top: current.scrollHeight, behavior: 'auto' });
    });
  }, [messages, generationTaskScrollKey]);

  useEffect(() => {
    if (availableModels.length === 0) return;
    if (!selectedModel || !availableModels.some(item => item.name === selectedModel)) {
      setSelectedModel(availableModels[0]?.name ?? '');
    }
  }, [availableModels, selectedModel]);

  /** 刷新当前用户绘图冷却状态；只读接口用于禁用方案按钮，真实限制仍由后端创建任务兜底。 */
  const refreshGenerationCooldown = async () => {
    const result = await api<GenerationCooldownResponse>('/api/generations/cooldown');
    if (result.ok && result.data) setGenerationCooldown(result.data);
  };

  /** 加载当前用户全部工作台上下文窗口；没有窗口时自动创建第一个持久化上下文。 */
  const loadConversations = async () => {
    setLoadingConversations(true);
    const result = await api<WorkbenchConversationListResponse>('/api/workbench/conversations');
    if (!result.ok || !result.data) {
      setLoadingConversations(false);
      show(result.message ?? '工作台会话加载失败', 'error');
      return;
    }
    setConversations(result.data.items);
    const first = result.data.items[0];
    if (first) {
      await selectConversation(first.id, first);
    } else {
      await createConversation();
    }
    setLoadingConversations(false);
  };
  /** 创建一个新的 Agent 上下文窗口，并立即切换到该窗口。 */
  const createConversation = async () => {
    if (creatingConversation) return;
    setCreatingConversation(true);
    const result = await api<WorkbenchConversationDetailResponse>('/api/workbench/conversations', {
      method: 'POST',
      body: JSON.stringify({
        model: currentModel?.name || selectedModel || undefined,
        count: multiConfig.enabled ? count : 1,
        isPrivate,
      }),
    });
    setCreatingConversation(false);
    if (!result.ok || !result.data) {
      show(result.message ?? '新建工作台窗口失败', 'error');
      return;
    }
    const detail = result.data;
    applyConversationDetail(detail);
    setConversations(prev => mergeConversation(prev, detail.conversation));
    textareaRef.current?.focus();
  };
  /** 切换上下文窗口时从后端读取步骤记录，确保上下文来自持久化记录。 */
  const selectConversation = async (conversationId: string, known?: WorkbenchConversationView) => {
    if (!conversationId || conversationId === activeConversationId && messages.length > 0) return;
    shouldStickToBottomRef.current = true;
    setActiveConversationId(conversationId);
    setLoadingMessages(true);
    if (known) applyConversationSettings(known);
    const result = await api<WorkbenchConversationDetailResponse>(`/api/workbench/conversations/${conversationId}`);
    setLoadingMessages(false);
    if (!result.ok || !result.data) {
      show(result.message ?? '会话读取失败', 'error');
      return;
    }
    const detail = result.data;
    applyConversationDetail(detail);
    setConversations(prev => mergeConversation(prev, detail.conversation));
  };
  /** 删除当前用户自己的上下文窗口；只删除工作台会话，不影响已提交的真实绘图任务。 */
  const deleteConversation = async (conversationId: string) => {
    if (!conversationId || deletingConversationId) return;
    const target = conversations.find(item => item.id === conversationId);
    const confirmed = window.confirm(`删除「${target?.title || '这个窗口'}」的上下文记录？已提交的绘图任务和图库图片不会被删除。`);
    if (!confirmed) return;
    setDeletingConversationId(conversationId);
    const result = await api<WorkbenchConversationDeleteResponse>(`/api/workbench/conversations/${conversationId}`, { method: 'DELETE' });
    setDeletingConversationId(null);
    if (!result.ok || !result.data) {
      show(result.message ?? '删除上下文窗口失败', 'error');
      return;
    }
    const items = result.data.items;
    setConversations(items);
    show('上下文窗口已删除', 'success');
    if (conversationId !== activeConversationId) return;
    setMessages([]);
    const next = items[0];
    if (next) {
      await selectConversation(next.id, next);
    } else {
      setActiveConversationId('');
      await createConversation();
    }
  };
  /** 执行一次工作台流式提交；普通发送和失败重试都走这里，避免两套 Agent 调用逻辑分叉。 */
  const runWorkbenchStreamSubmission = async (
    conversationId: string,
    cleanPrompt: string,
    sendAttachments: WorkbenchAttachmentView[],
    options: { clearComposer: boolean },
  ) => {
    const tempUserMessage = buildTemporaryMessage(conversationId, 'user', cleanPrompt, 'sent', 'chat', sendAttachments);
    const tempAssistantMessage = buildTemporaryMessage(conversationId, 'assistant', '正在思考...', 'pending', 'chat', []);
    shouldStickToBottomRef.current = true;
    setMessages(prev => [...prev, tempUserMessage, tempAssistantMessage]);
    if (options.clearComposer) {
      setPrompt('');
      setAttachments([]);
      setReferencePanelOpen(false);
    }
    setSending(true);

    try {
      await streamAutoMessage(conversationId, cleanPrompt, sendAttachments, tempAssistantMessage.id);
    } catch (error) {
      const message = normalizeWorkbenchStreamError(error);
      setMessages(prev => prev.map(item => item.id === tempAssistantMessage.id
        ? { ...item, content: message, status: 'error', error: message, agentRunStatus: item.agentRunId ? 'error' : item.agentRunStatus }
        : item));
      show(message, 'error');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };
  /** 发送本轮指令；后端 Agent 会在同一窗口内自动判断工具调用或文本回复。 */
  const submitChatPrompt = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return show('请输入消息内容', 'warn');
    // 工作台与生成页共用后台提示词长度配置，提交前只提示并保留原文，不做静默截断。
    if (maxPromptLength !== null && cleanPrompt.length > maxPromptLength) return show(`提示词不能超过 ${maxPromptLength} 字符`, 'warn');
    if (!user) return show('请先登录', 'error');
    if (sending) return;

    const conversationId = activeConversationId || await ensureConversation();
    if (!conversationId) return;
    // 关键分支：只有后端已保存的附件 ID 才能交给 Agent；失败或上传中的本地占位只用于预览。
    const sendAttachments = attachments.filter(item => !item.uploading && !item.uploadError && !item.id.startsWith('local_att_'));
    if (attachments.length > 0 && sendAttachments.length === 0) return show('参考图仍在上传或上传失败，请处理后再发送', 'warn');
    await runWorkbenchStreamSubmission(conversationId, cleanPrompt, sendAttachments, { clearComposer: true });
  };
  /** 重试失败消息：后端会复用原始用户消息并原位覆盖这条失败 assistant 消息。 */
  const retryFailedMessage = async (assistantMessageId: string) => {
    if (!user) return show('请先登录', 'error');
    if (sending || retryingMessageId) return;
    const targetMessage = messages.find(item => item.id === assistantMessageId);
    if (!targetMessage || targetMessage.role !== 'assistant' || targetMessage.status !== 'error') return show('只能重试失败的 Agent 消息', 'error');
    const conversationId = activeConversationId || targetMessage.conversationId;
    if (!conversationId) return show('会话不存在，无法重试', 'error');
    setRetryingMessageId(assistantMessageId);
    setMessages(prev => prev.map(item => item.id === assistantMessageId
      ? { ...item, content: '正在思考...', status: 'pending', kind: 'chat', taskIds: [], toolCalls: [], error: null, agentRunId: null, agentRunStatus: null, agentElapsedMs: null }
      : item));
    try {
      await streamRetryFailedMessage(conversationId, assistantMessageId);
    } catch (error) {
      const message = normalizeWorkbenchStreamError(error);
      setMessages(prev => prev.map(item => item.id === assistantMessageId
        ? { ...item, content: message, status: 'error', error: message, agentRunStatus: item.agentRunId ? 'error' : item.agentRunStatus }
        : item));
      show(message, 'error');
    } finally {
      setRetryingMessageId(null);
    }
  };
  /** 使用 SSE 接收 Agent 结果；文本回复走流式，工具调用会在 done 中返回真实结果。 */
  const streamAutoMessage = async (
    conversationId: string,
    content: string,
    sendAttachments: WorkbenchAttachmentView[],
    tempAssistantMessageId: string,
  ) => {
    const token = localStorage.getItem('token') ?? '';
    const response = await fetch(`${config.apiBase}/api/workbench/conversations/${conversationId}/messages/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        content,
        attachmentIds: sendAttachments.map(item => item.id),
        model: currentModel?.name,
        count: multiConfig.enabled ? count : 1,
        isPrivate,
      }),
    }).catch(() => null);
    await consumeWorkbenchStreamResponse(response, tempAssistantMessageId, sendAttachments);
  };
  /** 调用失败消息专用重试流；该接口会覆盖原 assistant 消息，不新增用户消息。 */
  const streamRetryFailedMessage = async (conversationId: string, assistantMessageId: string) => {
    const token = localStorage.getItem('token') ?? '';
    const response = await fetch(`${config.apiBase}/api/workbench/conversations/${conversationId}/messages/${assistantMessageId}/retry/stream`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }).catch(() => null);
    await consumeWorkbenchStreamResponse(response, assistantMessageId, []);
  };
  /** 统一消费工作台 SSE 响应；普通发送更新临时消息，失败重试更新原消息。 */
  const consumeWorkbenchStreamResponse = async (
    response: Response | null,
    tempAssistantMessageId: string,
    sendAttachments: WorkbenchAttachmentView[],
  ) => {
    if (!response) throw new Error(BACKEND_UNREACHABLE);
    if (response.status === 401) {
      localStorage.removeItem('token');
      window.dispatchEvent(new CustomEvent('aiimage:auth-expired'));
      throw new Error('请先登录');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({} as { message?: string }));
      throw new Error(body.message || `工作台请求失败：HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('浏览器未收到流式回复');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let renderedText = '';
    let pendingText = '';
    let typewriterTimer: ReturnType<typeof window.setInterval> | null = null;
    let elapsedTimer: ReturnType<typeof window.setInterval> | null = null;
    let typewriterResolve: (() => void) | null = null;
    let doneEvent: WorkbenchStreamDoneEvent | null = null;
    let runStartedAt = 0;
    let liveAssistantMessageId = tempAssistantMessageId;
    const renderTypewriterText = (text: string) => {
      setMessages(prev => prev.map(item => item.id === liveAssistantMessageId ? { ...item, content: text, status: 'pending' } : item));
    };
    /** 状态事件只更新临时气泡，真实 delta 到达后不再覆盖模型文本。 */
    const renderStatusText = (text: string) => {
      if (renderedText || pendingText) return;
      setMessages(prev => prev.map(item => item.id === liveAssistantMessageId ? { ...item, content: text, status: 'pending' } : item));
    };
    const stopTypewriter = () => {
      if (!typewriterTimer) return;
      window.clearInterval(typewriterTimer);
      typewriterTimer = null;
    };
    const updateRunningElapsed = (runId: string, status: 'running' | 'success' | 'error' = 'running') => {
      if (!runStartedAt) return;
      const elapsedMs = Math.max(0, Math.round((Date.now() - runStartedAt) / 100) * 100);
      setMessages(prev => prev.map(item => item.id === liveAssistantMessageId
        ? { ...item, agentRunId: runId, agentRunStatus: status, agentElapsedMs: elapsedMs }
        : item));
    };
    const stopElapsedTimer = () => {
      if (!elapsedTimer) return;
      window.clearInterval(elapsedTimer);
      elapsedTimer = null;
    };
    const resolveTypewriterIfIdle = () => {
      if (pendingText || !typewriterResolve) return;
      const resolve = typewriterResolve;
      typewriterResolve = null;
      resolve();
    };
    const startTypewriter = () => {
      if (typewriterTimer) return;
      typewriterTimer = window.setInterval(() => {
        if (!pendingText) {
          stopTypewriter();
          resolveTypewriterIfIdle();
          return;
        }
        const chunk = takeTypewriterChunk(pendingText);
        pendingText = pendingText.slice(chunk.length);
        renderedText += chunk;
        renderTypewriterText(renderedText);
      }, 16);
    };
    const enqueueTypewriterText = (text: string) => {
      pendingText += text;
      startTypewriter();
    };
    const waitForTypewriter = () => new Promise<void>(resolve => {
      if (!pendingText && !typewriterTimer) {
        resolve();
        return;
      }
      typewriterResolve = resolve;
      startTypewriter();
    });
    const handleBlock = (block: string) => {
      const event = readSseEventName(block);
      const data = readSseEventData(block);
      if (!data) return;
      if (event === 'run_started') {
        const payload = JSON.parse(data) as Extract<WorkbenchStreamEvent, { type: 'run_started' }>;
        const nextAssistantMessageId = payload.assistantMessageId || liveAssistantMessageId;
        // 后端已经持久化 pending 消息后，前端把临时气泡切换到真实 ID，避免刷新或重载会话后丢失。
        if (nextAssistantMessageId !== liveAssistantMessageId) {
          const previousAssistantMessageId = liveAssistantMessageId;
          setMessages(prev => {
            const hasPersistentMessage = prev.some(item => item.id === nextAssistantMessageId);
            if (hasPersistentMessage) {
              return prev
                .filter(item => item.id !== previousAssistantMessageId)
                .map(item => item.id === nextAssistantMessageId
                  ? { ...item, status: 'pending', agentRunId: payload.runId, agentRunStatus: 'running' as const, agentElapsedMs: 0 }
                  : item);
            }
            return prev.map(item => item.id === previousAssistantMessageId
              ? { ...item, id: nextAssistantMessageId, status: 'pending', agentRunId: payload.runId, agentRunStatus: 'running' as const, agentElapsedMs: 0 }
              : item);
          });
          liveAssistantMessageId = nextAssistantMessageId;
        }
        runStartedAt = Date.now();
        updateRunningElapsed(payload.runId);
        elapsedTimer = window.setInterval(() => updateRunningElapsed(payload.runId), 100);
        renderStatusText('Agent Run 已启动');
      } else if (event === 'status') {
        const payload = JSON.parse(data) as WorkbenchStreamStatusEvent;
        if (payload.text) renderStatusText(payload.text);
      } else if (event === 'tool_start') {
        const payload = JSON.parse(data) as Extract<WorkbenchStreamEvent, { type: 'tool_start' }>;
        if (payload.text) renderStatusText(payload.text);
      } else if (event === 'tool_result') {
        const payload = JSON.parse(data) as Extract<WorkbenchStreamEvent, { type: 'tool_result' }>;
        if (payload.text) renderStatusText(payload.text);
      } else if (event === 'delta') {
        const payload = JSON.parse(data) as { text?: string };
        if (!payload.text) return;
        enqueueTypewriterText(payload.text);
      } else if (event === 'done') {
        const payload = JSON.parse(data) as { data?: WorkbenchStreamDoneEvent } | WorkbenchStreamDoneEvent;
        doneEvent = 'data' in payload && payload.data ? payload.data : payload as WorkbenchStreamDoneEvent;
      } else if (event === 'error') {
        const payload = JSON.parse(data) as { message?: string };
        throw new Error(payload.message || '工作台 AI 回复失败');
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) handleBlock(block);
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleBlock(buffer);
      if (!doneEvent) throw new Error('流式回复未完成，请稍后重试');
      await waitForTypewriter();
    } catch (error) {
      stopTypewriter();
      stopElapsedTimer();
      throw new Error(normalizeWorkbenchStreamError(error));
    }
    stopElapsedTimer();
    const finalEvent: WorkbenchStreamDoneEvent = doneEvent;
    applyConversationDetail(finalEvent);
    sendAttachments.forEach(releaseReferencePreviewUrl);
    setConversations(prev => mergeConversation(prev, finalEvent.conversation));
    if (finalEvent.generation) {
      const taskInfo = readVisibleTaskInfo(finalEvent.generation);
      addRecentTasks(taskInfo.ids);
      show(taskInfo.count > 1 ? `工作台已提交 ${taskInfo.count} 张` : '工作台任务已提交', 'success');
    }
    if (finalEvent.assistantMessage.status === 'error') show(finalEvent.assistantMessage.error || finalEvent.assistantMessage.content, 'error');
  };
  /** 上传一组工作台参考图；后端会在生成方案阶段转存为真实图生图参考图。 */
  const uploadAttachments = async (files: File[] | FileList) => {
    const candidates = Array.from(files).filter(isWorkbenchImageFile);
    if (candidates.length === 0) return show('只能上传图片', 'error');
    const remaining = WORKBENCH_REFERENCE_LIMIT - attachments.length;
    if (remaining <= 0) return show(`最多上传 ${WORKBENCH_REFERENCE_LIMIT} 张参考图`, 'warn');
    setReferencePanelOpen(true);
    setUploadingAttachment(true);
    for (const file of candidates.slice(0, remaining)) {
      if (file.size > 12 * 1024 * 1024) {
        show(`${file.name || '图片'} 超过 12MB`, 'error');
        continue;
      }
      const mimeType = resolveWorkbenchImageMime(file);
      const previewUrl = createReferencePreviewUrl(file);
      const localId = `local_att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const placeholder: WorkbenchComposerAttachment = {
        id: localId,
        kind: 'image',
        url: previewUrl,
        name: file.name || '图片',
        mimeType,
        sizeBytes: file.size,
        width: null,
        height: null,
        createdAt: new Date().toISOString(),
        uploading: true,
      };
      setAttachments(prev => [...prev, placeholder].slice(0, WORKBENCH_REFERENCE_LIMIT));
      const result = await api<WorkbenchAttachmentUploadResponse>('/api/workbench/attachments', {
        method: 'POST',
        headers: {
          'Content-Type': mimeType,
          'x-aiimage-file-name': encodeURIComponent(file.name),
          ...(activeConversationId ? { 'x-aiimage-conversation-id': activeConversationId } : {}),
        },
        body: file,
      });
      if (!result.ok || !result.data) {
        const message = result.message ?? '图片上传失败';
        setAttachments(prev => prev.map(item => item.id === localId ? { ...item, uploading: false, uploadError: message } : item));
        show(message, 'error');
        continue;
      }
      const savedAttachment = result.data.attachment;
      // 预览参考生成页做法使用本地 object URL；后端附件 URL 需要鉴权，不能直接作为 img src。
      setAttachments(prev => prev.map(item => item.id === localId
        ? { ...savedAttachment, url: previewUrl, uploading: false }
        : item));
    }
    setUploadingAttachment(false);
  };

  /** 支持拖放上传参考图，减少图生图任务前的操作路径。 */
  const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (uploadingAttachment) return;
    void uploadAttachments(event.dataTransfer.files);
  };

  /** 支持从剪贴板粘贴图片到工作台，常用于截图后直接图生图。 */
  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter(isWorkbenchImageFile);
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void uploadAttachments(imageFiles);
  };
  /** 输入框上方的唯一参考图按钮：只展开参考图区，不直接弹出系统文件选择器。 */
  const openReferencePanel = () => {
    setReferencePanelOpen(true);
  };
  /** 为参考图生成本地预览 URL；真实提交仍使用附件 ID，不使用这个 URL。 */
  const createReferencePreviewUrl = (file: File) => {
    const url = URL.createObjectURL(file);
    referencePreviewUrlsRef.current.add(url);
    return url;
  };
  /** 释放本地参考图预览 URL，避免用户频繁上传时泄露浏览器内存。 */
  const releaseReferencePreviewUrl = (attachmentOrUrl: WorkbenchComposerAttachment | string) => {
    const url = typeof attachmentOrUrl === 'string' ? attachmentOrUrl : attachmentOrUrl.url;
    if (!url.startsWith('blob:')) return;
    URL.revokeObjectURL(url);
    referencePreviewUrlsRef.current.delete(url);
  };
  /** 处理 AI 绘图建议确认；拒绝只标记消息，允许才由后端提交真实绘图任务。 */
  const decideDrawingProposal = async (messageId: string, decision: WorkbenchDrawingDecision, optionId?: string) => {
    if (!activeConversationId || confirmingProposalKey) return;
    const nextKey = optionId ? `${messageId}:${decision}:${optionId}` : `${messageId}:${decision}`;
    setConfirmingProposalKey(nextKey);
    const result = await api<WorkbenchDrawingDecisionResponse>(
      `/api/workbench/conversations/${activeConversationId}/messages/${messageId}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, ...(optionId ? { optionId } : {}) }),
      },
    );
    setConfirmingProposalKey(null);
    if (!result.ok || !result.data) {
      show(result.message ?? '绘图建议处理失败', 'error');
      return;
    }
    const detail = result.data;
    applyConversationDetail(detail);
    setConversations(prev => mergeConversation(prev, detail.conversation));
    if (detail.generation) {
      const taskInfo = readVisibleTaskInfo(detail.generation);
      addRecentTasks(taskInfo.ids);
      show(taskInfo.count > 1 ? `工作台已提交 ${taskInfo.count} 张` : '工作台任务已提交', 'success');
      void refreshGenerationCooldown();
    } else if (decision === 'reject') {
      show('已拒绝本次绘图提交', 'success');
    }
    if (detail.assistantMessage.status === 'error') show(detail.assistantMessage.error || detail.assistantMessage.content, 'error');
  };
  /** 没有当前窗口时先创建一个，避免前端自行伪造会话上下文。 */
  const ensureConversation = async () => {
    if (activeConversationId) return activeConversationId;
    const result = await api<WorkbenchConversationDetailResponse>('/api/workbench/conversations', {
      method: 'POST',
      body: JSON.stringify({ model: currentModel?.name, count: multiConfig.enabled ? count : 1, isPrivate }),
    });
    if (!result.ok || !result.data) {
      show(result.message ?? '新建工作台窗口失败', 'error');
      return '';
    }
    const detail = result.data;
    shouldStickToBottomRef.current = true;
    applyConversationDetail(detail);
    setConversations(prev => mergeConversation(prev, detail.conversation));
    return detail.conversation.id;
  };

  /** 后端详情是页面唯一可信步骤源，设置上下文和步骤后同步配置控件。 */
  const applyConversationDetail = (detail: WorkbenchConversationDetailResponse) => {
    setActiveConversationId(detail.conversation.id);
    setMessages(detail.messages);
    applyConversationSettings(detail.conversation);
  };

  /** 会话切换时同步该窗口最近使用的模型、张数和隐私。 */
  const applyConversationSettings = (conversation: WorkbenchConversationView) => {
    if (conversation.model) setSelectedModel(conversation.model);
    setCount(Math.min(Math.max(conversation.count || 1, 1), multiConfig.max));
    setIsPrivate(conversation.isPrivate);
  };

  /** 用户手动滚动后立即记录是否仍贴近底部；不在底部时禁止流式输出抢回滚动位置。 */
  const handleMessageListScroll = () => {
    const target = scrollRef.current;
    if (!target) return;
    shouldStickToBottomRef.current = isWorkbenchMessageListNearBottom(target);
  };

  return (
    <div className="workbench-page">
      <Seo
        title="Agent 工作台"
        description="在绘图姬 DrawHime 使用持久化 Agent 工作台提交绘图任务、查询任务状态并维护上下文。"
        path="/workbench"
        index={false}
      />

      <aside className="workbench-sidebar" aria-label="Agent 上下文窗口">
        <div className="workbench-sidebar-head">
          <div>
            <h2>Agent 工作台</h2>
            <span>{conversations.length} 个窗口</span>
          </div>
          <button type="button" onClick={() => void createConversation()} disabled={creatingConversation} aria-label="新建 Agent 上下文">
            {creatingConversation ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          </button>
        </div>

        <div className="workbench-conversation-list">
          {loadingConversations ? (
            <div className="workbench-state"><Loader2 size={16} className="animate-spin" />加载中</div>
          ) : conversations.length === 0 ? (
            <div className="workbench-state"><MessageSquarePlus size={16} />暂无窗口</div>
          ) : conversations.map(item => (
            <WorkbenchConversationListItem
              key={item.id}
              conversation={item}
              active={item.id === activeConversationId}
              deleting={deletingConversationId === item.id}
              onClick={() => void selectConversation(item.id, item)}
              onDelete={() => void deleteConversation(item.id)}
            />
          ))}
        </div>
      </aside>

      <section className="workbench-chat" aria-label="Agent 绘图工作台">
        <header className="workbench-chat-head">
          <div className="workbench-chat-title">
            <h1>{activeConversation?.title ?? 'Agent 工作台'}</h1>
          </div>

          {/* 右上角绘图参数只承载本轮可改配置，避免恢复模式标签造成标题栏拥挤。 */}
          <div className="workbench-config-bar" aria-label="本轮绘图参数">
            <div className="workbench-control-strip">
              <div className="workbench-model-picker workbench-control-section">
                <span className="workbench-control-caption">模型</span>
                <button
                  type="button"
                  className="workbench-model-trigger"
                  title="选择本轮绘图模型"
                  onClick={() => setModelMenuOpen(value => !value)}
                  disabled={availableModels.length === 0}
                >
                  <Sparkles size={14} />
                  <span>{currentModel ? formatDrawingModelDisplayName(currentModel) : activeDrawingMode === 'image-to-image' ? '无图生图模型' : '加载模型'}</span>
                  <ChevronDown size={14} />
                </button>
                {modelMenuOpen && (
                  <div className="workbench-model-menu">
                    {availableModels.map(item => (
                      <button
                        key={item.name}
                        type="button"
                        className={item.name === currentModel?.name ? 'is-active' : ''}
                        onClick={() => { setSelectedModel(item.name); setModelMenuOpen(false); }}
                      >
                        <span>{formatDrawingModelDisplayName(item)}</span>
                        {item.name === currentModel?.name && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="workbench-control-section workbench-count-control">
                <span className="workbench-control-caption">张数</span>
                <div className="workbench-count-stepper" aria-label="生成张数">
                  <button type="button" disabled={sending || !multiConfig.enabled} onClick={() => setCount(value => Math.max(1, value - 1))}>-</button>
                  <strong>{multiConfig.enabled ? count : 1}</strong>
                  <button type="button" disabled={sending || !multiConfig.enabled} onClick={() => setCount(value => Math.min(multiConfig.max, value + 1))}>+</button>
                </div>
              </div>

              <PrivacySwitch
                checked={isPrivate}
                pending={privacyPrefs.saving}
                disabled={privacyPrefs.loading}
                size="sm"
                label={isPrivate ? '私密' : '公开'}
                ariaLabel="工作台本轮隐私"
                className="workbench-privacy-control"
                onChange={setIsPrivate}
              />

              <div className="workbench-balance" aria-label="账户余额">
                <Wallet size={13} />
                <span>余额</span>
                <strong>¥{balance?.totalBalance ?? '-'}</strong>
              </div>
            </div>
          </div>
        </header>

        <div className="workbench-message-list" ref={scrollRef} onScroll={handleMessageListScroll}>
          {loadingMessages ? (
            <div className="workbench-message-loading"><Loader2 size={18} className="animate-spin" />读取对话</div>
          ) : messages.length === 0 ? (
            <div className="workbench-empty-chat">
              <MessageSquareText size={22} />
              <strong>新的 Agent 上下文</strong>
            </div>
          ) : messages.map(message => (
            <WorkbenchMessageItem
              key={message.id}
              message={message}
              generationTasks={generationTasks}
              cooldownRemaining={cooldownRemaining}
              confirmingKey={confirmingProposalKey}
              retryingMessageId={retryingMessageId}
              onDecision={(messageId, decision, optionId) => void decideDrawingProposal(messageId, decision, optionId)}
              onRetry={(messageId) => void retryFailedMessage(messageId)}
            />
          ))}
        </div>

        <footer className="workbench-composer">
          {!user?.emailVerified && (
            <div className="workbench-email-warning">
              <AlertTriangle size={14} />
              <span>邮箱未验证，部分账号安全能力可能受限。</span>
              <a href="/profile">去处理</a>
            </div>
          )}
          <div className="workbench-input-shell">
            {!referencePanelOpen && (
              <div className="workbench-reference-toolbar">
                <button
                  type="button"
                  className={`workbench-upload-button${attachments.length > 0 ? ' is-active' : ''}`}
                  disabled={uploadingAttachment}
                  onClick={openReferencePanel}
                >
                  {uploadingAttachment ? <Loader2 size={12} className="animate-spin" /> : <ImagePlus size={12} />}
                  {attachments.length > 0 ? `参考图 ${attachments.length}` : '上传参考图'}
                </button>
              </div>
            )}
            {referencePanelOpen && (
              <div
                className={`workbench-reference-board${attachments.length > 0 ? ' has-images' : ''}`}
                onDragOver={event => event.preventDefault()}
                onDrop={handleReferenceDrop}
              >
                <div className="workbench-reference-board-head">
                  <div>
                    <strong>{attachments.length > 0 ? '图生图参考图' : '添加参考图'}</strong>
                    <span>{attachments.length > 0 ? `${attachments.length}/${WORKBENCH_REFERENCE_LIMIT} 张` : '拖入、粘贴或点击下方区域选择图片'}</span>
                  </div>
                  <button
                    type="button"
                    className="workbench-reference-close"
                    onClick={() => setReferencePanelOpen(false)}
                    aria-label="关闭参考图上传区域"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="workbench-reference-grid">
                  {attachments.map((attachment, index) => (
                    <div key={attachment.id} className="workbench-reference-item">
                      <img src={attachment.url} alt={attachment.name || `参考图 ${index + 1}`} />
                      {attachment.uploading && (
                        <div className="workbench-reference-uploading">
                          <Loader2 size={14} className="animate-spin" />
                        </div>
                      )}
                      {attachment.uploadError && (
                        <div className="workbench-reference-error">
                          {attachment.uploadError}
                        </div>
                      )}
                      <span>{index + 1}</span>
                      <button
                        type="button"
                        onClick={() => setAttachments(prev => {
                          const removed = prev.find(item => item.id === attachment.id);
                          if (removed) releaseReferencePreviewUrl(removed);
                          return prev.filter(item => item.id !== attachment.id);
                        })}
                        aria-label="移除参考图"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  {attachments.length < WORKBENCH_REFERENCE_LIMIT && (
                    <div className={`workbench-reference-add-tile${uploadingAttachment ? ' is-disabled' : ''}`}>
                      {uploadingAttachment ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
                      <span>{attachments.length > 0 ? '继续添加' : '选择图片'}</span>
                      <input
                        className="workbench-reference-native-input"
                        type="file"
                        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                        multiple
                        disabled={uploadingAttachment}
                        onChange={event => {
                          // 原生 input 清空前必须复制 FileList；部分浏览器会让原 FileList 随 value 清空。
                          const files = Array.from(event.currentTarget.files ?? []);
                          event.target.value = '';
                          if (files.length) void uploadAttachments(files);
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={prompt}
              maxLength={maxPromptLength ?? undefined}
              placeholder="给 Agent 下达指令；可生成图片、确认上文生成、查看任务状态"
              onChange={event => setPrompt(event.target.value)}
              onPaste={handleComposerPaste}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submitChatPrompt();
                }
              }}
            />
            <button type="button" onClick={submitChatPrompt} disabled={sending || uploadingAttachment || !prompt.trim()}>
              {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              <span>{sending ? '提交中' : '发送'}</span>
            </button>
          </div>
          <div className="workbench-input-meta">
            <span><MessageSquareText size={12} />Enter 发送，Shift+Enter 换行</span>
            <span>{prompt.length}{maxPromptLength ? `/${maxPromptLength}` : ''}</span>
          </div>
        </footer>
      </section>
    </div>
  );
}

/** 判断工作台消息列表是否仍贴近底部；只有贴底时才允许新内容自动跟随。 */
function isWorkbenchMessageListNearBottom(target: HTMLDivElement) {
  const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
  return distance <= WORKBENCH_BOTTOM_STICKY_THRESHOLD;
}

/** 归一化浏览器流式读取错误，避免把底层 terminated/network 文案直接展示给用户。 */
function normalizeWorkbenchStreamError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/terminated|aborted|network|fetch failed|Failed to fetch/i.test(message)) return '工作台连接中断，请重试';
  return message || '提交失败，请稍后重试';
}

/** 工作台参考图识别同时看 MIME 和扩展名，兼容部分本地/QQ 图片缺失 file.type 的情况。 */
function isWorkbenchImageFile(file: File) {
  return Boolean(resolveWorkbenchImageMime(file));
}

/** 解析工作台参考图 MIME；后端只接受 PNG/JPEG/WebP，因此这里也统一到这三类。 */
function resolveWorkbenchImageMime(file: File) {
  const type = file.type.trim().toLowerCase();
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp') return type;
  const name = file.name.trim().toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  return '';
}
