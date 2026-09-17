/**
 * 对话模式主视图（chat 界面）。
 *
 * 路由：#/p/:pid/chat 与 #/p/:pid/chat/:cid（选中即把对话 id 写进地址栏，可直链/可对账：
 * 该 id 就是 conversations.id，也是执行机上的 tmux 会话名 chat-<id>）。左栏多对话列表（新建/切换/归档/重命名 + 每对话 claude/codex），
 * 右栏复用 ChatPane（按 conv 独立流：传 conv=<对话 id> 钉住该对话自身会话）。
 * 每条 chat 对话有独立 tmux 会话（后端 chat-<convId>），切换只是重连 WS、不 kill 其它对话，
 * 故来回切换互不打断。选中/新建即 activate（幂等：会话活着不重启）。
 *
 * 宽屏左右并排；窄屏列表整页，点对话进整页聊天（顶部返回回列表）。
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { AutoApproveSwitch } from '../components/AutoApproveSwitch';
import { AgentLogo } from '../components/AgentLogo';
import { ModelBadge } from '../components/badges';
import { ChatPane } from '../components/ChatPane';
import { ListSplitter } from '../components/ListSplitter';
import { Loading } from '../components/Loaders';
import { NativeModeSwitch, type NativeMode } from '../components/NativeModeSwitch';
import { Modal } from '../components/Modal';
import { SummaryButton } from '../components/SummaryButton';
import { TermPane } from '../components/TermPane';
import { api, ApiError, getProjectExecutorAgents, setConvAutoApprove, uploadWithProgress } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { resolveChatSync } from '../lib/chatsync';
import { timeAgo } from '../lib/fmt';
import { readChatAgent, writeChatAgent, readChatConversation, writeChatConversation, restoreChatConversation } from '../lib/chatPrefs';
import { useListWidth } from '../lib/listwidth';
import { pollProjectSummary } from '../lib/pollSummary';
import { extOf, isImageExt, isImagePath, previewKind } from '../lib/preview';
import { nav } from '../lib/router';
import { MEMORY_MODELS, memoryBtnLabel, type SummaryMode } from '../lib/summaryModes';
import { toast } from '../lib/toast';
import type {
  AgentKind,
  AutoApproveLevel,
  Conversation,
  FsFile,
  FsList,
  FsUploadResult,
  LocalHistoryImportResponse,
  LocalHistoryResponse,
  LocalHistorySession,
  Project,
} from '../lib/types';
import { useConvModel } from '../lib/useConvModel';
import { useWide } from '../lib/useWide';
import { reconcileAgent } from '../components/AgentPicker';
import { useI18n } from '../i18n/provider';
import { tr } from '../i18n/runtime';

/** 代理正式名：图标按钮不显示文字，名称改由 title/aria-label 承载。 */
const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };

/** 导入本地历史：收成图标钮后用「下载进托盘」的形状表达导入。 */
function ImportIcon() {
  return (
    <svg
      class="conv-hd-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3.5v10m0 0 3.6-3.6M12 13.5 8.4 9.9" />
      <path d="M4.5 15.5v2.6a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.6" />
    </svg>
  );
}

export function ChatView({ pid, cid }: { pid: number; cid?: string }) {
  const { t } = useI18n();
  const [project, setProject] = useState<Project | null>(null);
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // 深链里的对话 id：装载时的初始选中要用它，但列表拉取的 effect 只依赖 pid，故用 ref 读最新值
  const cidRef = useRef<string | undefined>(cid);
  cidRef.current = cid;
  const [mode, setMode] = useState<NativeMode>('chat');
  const [newAgent, setNewAgent] = useState<AgentKind>(readChatAgent);
  const [supportedAgents, setSupportedAgents] = useState<AgentKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [importingHistory, setImportingHistory] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [err, setErr] = useState('');
  const [showFiles, setShowFiles] = useState(false);
  const [produced, setProduced] = useState<string[]>([]);
  const [memBusy, setMemBusy] = useState(false);
  const wide = useWide();
  const listW = useListWidth(); // 宽屏对话列表栏宽度：拖拽持久化，未设则回落 CSS 默认（与工作台共用 panda.wbListW）
  const splitRef = useRef<HTMLDivElement>(null); // .wb-split 容器 ref，供分隔条换算左栏像素宽

  useEffect(() => {
    let disposed = false;
    setProject(null);
    setConvs(null);
    setSelected(null);
    setSupportedAgents([]);
    setNewAgent(readChatAgent());
    setErr('');
    api<Project>(`/api/projects/${pid}`)
      .then((value) => { if (!disposed) setProject(value); })
      .catch((e: Error) => { if (!disposed) setErr(e.message); });
    void getProjectExecutorAgents(pid)
      .then((agents) => {
        if (disposed) return;
        setSupportedAgents(agents);
        const next = reconcileAgent(readChatAgent(), agents);
        if (next) setNewAgent(next);
      })
      .catch(() => { if (!disposed) setSupportedAgents([]); });
    api<{ conversations: Conversation[] }>(`/api/projects/${pid}/conversations`)
      .then((r) => {
        if (disposed) return;
        setConvs(r.conversations);
        // 地址栏带的对话优先（直链/刷新/分享），其次本项目上次打开的，最后回退最近活跃项。
        const linked = r.conversations.find((c) => c.id === cidRef.current)?.id ?? null;
        const initial = linked ?? restoreChatConversation(pid, r.conversations);
        setSelected(initial);
        writeChatConversation(pid, initial);
        // 服务重启后 tmux 可能已不在；与手动点选一致，幂等确保原生视图有真实代理会话可连。
        if (initial) activate(initial);
      })
      .catch((e: Error) => { if (!disposed) setErr(e.message); });
    return () => { disposed = true; };
  }, [pid]);

  // 确保对话自身会话已启动（幂等：会话活着不重启，故不打断其它在跑对话）
  const activate = (id: string): void => {
    void api(`/api/projects/${pid}/conversations/${id}/activate`, 'POST').catch(() => {});
  };

  const select = (id: string): void => {
    setSelected(id);
    writeChatConversation(pid, id);
    activate(id);
  };

  /**
   * 地址栏与选中项的同步——决策在 lib/chatsync（纯函数 + 收敛性单测），这里只执行。
   * **必须是同一个 effect**：拆成两个方向会互相对打，永远收敛不了（详见 chatsync.ts 的事故记录）。
   */
  const prevCidRef = useRef<string | undefined>(cid);
  useEffect(() => {
    const action = resolveChatSync({
      cid,
      prevCid: prevCidRef.current,
      selected,
      conversationIds: convs?.map((c) => c.id) ?? null,
    });
    prevCidRef.current = cid;
    if (action.kind === 'select') {
      setSelected(action.convId);
      writeChatConversation(pid, action.convId);
      activate(action.convId);
    } else if (action.kind === 'nav') {
      // 一律 replace：切对话不往历史里堆条目（返回键仍是「离开对话页」）
      nav(action.convId ? `/p/${pid}/chat/${action.convId}` : `/p/${pid}/chat`, { replace: true });
    }
  }, [pid, cid, convs, selected]);

  const createConv = async (): Promise<void> => {
    if (busy || !supportedAgents.includes(newAgent)) return;
    setBusy(true);
    try {
      const r = await api<{ conversation: Conversation }>(
        `/api/projects/${pid}/conversations`,
        'POST',
        { agent: newAgent },
      );
      setConvs((cur) => (cur ? [r.conversation, ...cur] : [r.conversation]));
      setSelected(r.conversation.id);
      writeChatConversation(pid, r.conversation.id);
      activate(r.conversation.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enterImportedHistory = async (conversation: Conversation): Promise<void> => {
    setImportingHistory(false);
    setConvs((current) => [conversation, ...(current ?? []).filter((item) => item.id !== conversation.id)]);
    setSelected(conversation.id);
    writeChatConversation(pid, conversation.id);
    setMode('chat');
    activate(conversation.id);
    try {
      const r = await api<{ conversations: Conversation[] }>(`/api/projects/${pid}/conversations`);
      setConvs(r.conversations);
      const target = r.conversations.some((item) => item.id === conversation.id)
        ? conversation.id
        : (r.conversations[0]?.id ?? null);
      setSelected(target);
      writeChatConversation(pid, target);
      if (target && target !== conversation.id) activate(target);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const archiveConv = async (id: string): Promise<void> => {
    if (!window.confirm(t('view.archiveConversationConfirm'))) return;
    try {
      await api(`/api/projects/${pid}/conversations/${id}/archive`, 'POST');
      const rest = (convs ?? []).filter((c) => c.id !== id);
      setConvs(rest);
      // 手机上返回列表只收起对话；归档被记住的项时仍需更新记录。
      if (readChatConversation(pid) === id) writeChatConversation(pid, rest[0]?.id ?? null);
      if (selected === id) {
        const next = rest[0]?.id ?? null;
        setSelected(next);
        writeChatConversation(pid, next);
        if (next) activate(next);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const startRename = (c: Conversation): void => {
    setRenamingId(c.id);
    setRenameText(c.label ?? '');
  };
  const commitRename = async (): Promise<void> => {
    const id = renamingId;
    const label = renameText.trim();
    setRenamingId(null);
    if (!id || !label) return;
    try {
      const r = await api<{ conversation: Conversation }>(
        `/api/projects/${pid}/conversations/${id}/rename`,
        'POST',
        { label },
      );
      setConvs((cur) => (cur ?? []).map((c) => (c.id === id ? r.conversation : c)));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  /** 改本对话的自动批准档位：先乐观改本地（切换钮立刻响应），失败回滚并提示 */
  const changeAutoApprove = (id: string, level: AutoApproveLevel): void => {
    const prev = (convs ?? []).find((c) => c.id === id)?.autoApprove;
    setConvs((cur) => (cur ?? []).map((c) => (c.id === id ? { ...c, autoApprove: level } : c)));
    void setConvAutoApprove(pid, id, level)
      .then((r) => setConvs((cur) => (cur ?? []).map((c) => (c.id === id ? r.conversation : c))))
      .catch((e: unknown) => {
        if (prev) setConvs((cur) => (cur ?? []).map((c) => (c.id === id ? { ...c, autoApprove: prev } : c)));
        toast.error(e instanceof ApiError ? e.message : String(e));
      });
  };

  // 对话产出文件变化：更新集合；宽屏下若产出了图片，自动打开文件侧栏预览
  const handleProduced = (paths: string[]): void => {
    setProduced(paths);
    if (wide && paths.some(isImagePath)) setShowFiles(true);
  };

  // 「更新记忆」：POST /memory 起后台任务（复用 summary_status 单飞）→ 轮询直到 done/error，就地刷新 understanding
  const updateMemory = async (mode: SummaryMode): Promise<void> => {
    if (memBusy) return;
    const agent: AgentKind = mode === 'codex' ? 'codex' : 'claude';
    setMemBusy(true);
    try {
      await api(`/api/projects/${pid}/memory`, 'POST', { agent });
      setProject((p) => (p ? { ...p, summaryStatus: 'running' } : p));
      const final = await pollProjectSummary(pid, { onTick: setProject });
      if (final.summaryStatus === 'done') toast.success(t('view.projectMemoryUpdated'));
      else if (final.summaryStatus === 'error') toast.error(final.summaryError ?? t('view.updateFailed'));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setMemBusy(false);
    }
  };

  const selectedConv = useMemo(
    () => (convs ?? []).find((c) => c.id === selected) ?? null,
    [convs, selected],
  );

  // 所有项目的对话页都返回对应 Issue 看板。
  const backTo = `/p/${pid}`;

  const convRow = (c: Conversation) => {
    const renaming = renamingId === c.id;
    return (
      <div
        key={c.id}
        class={'conv-it' + (c.id === selected ? ' on' : '')}
        onClick={() => !renaming && select(c.id)}
      >
        <AgentLogo agent={c.agent} />
        {renaming ? (
          <input
            class="conv-rename grow"
            autofocus
            value={renameText}
            onClick={(e) => e.stopPropagation()}
            onInput={(e) => setRenameText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              else if (e.key === 'Escape') setRenamingId(null);
            }}
            onBlur={() => void commitRename()}
          />
        ) : (
          <>
            <span class="conv-nm grow">{c.label || t('view.newConversation')}</span>
            <span class="conv-time">{timeAgo(c.lastActiveTs ?? c.createdTs)}</span>
            <span
              class="conv-act"
              role="button"
              title={t('ui.rename')}
              onClick={(e) => {
                e.stopPropagation();
                startRename(c);
              }}
            >
              ✎
            </span>
            <span
              class="conv-act"
              role="button"
              title={t('ui.archive')}
              onClick={(e) => {
                e.stopPropagation();
                void archiveConv(c.id);
              }}
            >
              🗑
            </span>
          </>
        )}
      </div>
    );
  };

  const list = (
    <div class="conv-list">
      <div class="conv-list-hd">
        <span class="conv-list-t">{t('view.conversation')}{convs ? ` · ${convs.length}` : ''}</span>
        <div class="conv-new">
          <button
            class="btn sm icon"
            title={t('view.importLocalHistory')}
            aria-label={t('view.importLocalHistory')}
            onClick={() => setImportingHistory(true)}
          >
            <ImportIcon />
          </button>
          <div class="seg sm" role="tablist">
            {supportedAgents.map((agent) => (
              <button
                key={agent}
                role="tab"
                aria-selected={newAgent === agent}
                title={AGENT_NAMES[agent]}
                aria-label={AGENT_NAMES[agent]}
                class={`seg-btn ${newAgent === agent ? 'on' : ''}`}
                onClick={() => {
                  setNewAgent(agent);
                  writeChatAgent(agent);
                }}
              >
                <AgentLogo agent={agent} decorative size="sm" />
              </button>
            ))}
          </div>
          <button
            class="btn sm primary conv-create"
            title={t('ui.create')}
            disabled={busy || supportedAgents.length === 0}
            onClick={() => void createConv()}
          >
            ＋<span class="conv-create-t">{t('ui.create')}</span>
          </button>
        </div>
      </div>
      <div class="conv-items">
        {convs === null && <Loading />}
        {convs !== null && convs.length === 0 && (
          <div class="empty">{t('view.noConversations')}</div>
        )}
        {(convs ?? []).map(convRow)}
      </div>
      {importingHistory && (
        <ImportLocalHistoryModal
          pid={pid}
          onClose={() => setImportingHistory(false)}
          onImported={(conversation) => void enterImportedHistory(conversation)}
        />
      )}
    </div>
  );

  // 窄屏且已选中 → 整页聊天（顶部返回回列表）
  if (!wide && selected) {
    return (
      <div class="fullcol chat-view">
        <div class="bhead">
          <div class="bhead-row">
            <button class="back" onClick={() => setSelected(null)}>
              ‹
            </button>
            <span class="btitle">{selectedConv?.label || t('view.conversation')}</span>
            {selectedConv && <AgentLogo agent={selectedConv.agent} size="sm" />}
          </div>
        </div>
        <div class="wb-main">
          <ConversationPane
            pid={pid}
            selected={selected}
            mode={mode}
            onModeChange={setMode}
            autoApprove={selectedConv?.autoApprove ?? 'cautious'}
            onAutoApprove={(l) => changeAutoApprove(selected, l)}
            onProducedFiles={setProduced}
          />
        </div>
      </div>
    );
  }

  return (
    <div class="fullcol chat-view">
      <div class="bhead">
        <div class="bhead-row">
          <button class="back" onClick={() => nav(backTo)}>
            ‹
          </button>
          <span class="btitle">{project?.name ?? t('view.projectFallback', { id: pid })}</span>
          <span class="badge b-purple">{t('view.conversation')}</span>
          <div class="bacts">
            <SummaryButton
              status={project?.summaryStatus}
              busy={memBusy}
              models={MEMORY_MODELS.filter((m) =>
                supportedAgents.includes(m.mode as AgentKind),
              )}
              renderLabel={memoryBtnLabel}
              title={t('view.updateProjectMemory')}
              onPick={(mode) => void updateMemory(mode)}
            />
            <button
              class={'btn sm' + (wide && showFiles ? ' primary' : '')}
              title={t('view.filesPreview')}
              onClick={() => (wide ? setShowFiles((v) => !v) : nav(`/p/${pid}/files`))}
            >
              {t('view.files')}
            </button>
            <button class="btn sm" onClick={() => nav(`/p/${pid}/term`)}>
              {t('view.nativeBash')}
            </button>
          </div>
        </div>
        {project?.understanding && (
          <details class="understanding">
            <summary>
              🧠 {t('view.projectMemory')}
              {project.understandingAgent ? `（${project.understandingAgent}）` : ''}
              {project.understandingTs ? ` · ${timeAgo(project.understandingTs)}` : ''}
            </summary>
            <div class="understanding-body">{project.understanding}</div>
          </details>
        )}
        {project?.summaryError && project.summaryStatus === 'error' && (
          <div class="err">{t('view.memoryUpdateFailed', { error: project.summaryError })}</div>
        )}
        {err && <div class="err">{err}</div>}
      </div>

      {wide ? (
        <div class="wb-split" ref={splitRef}>
          <div
            class="wb-list-col"
            style={listW.width != null ? { width: listW.width, maxWidth: listW.width } : undefined}
          >
            {list}
          </div>
          <ListSplitter containerRef={splitRef} list={listW} label={t('view.conversationListWidth')} />
          <div class="wb-main">
            {selected ? (
              <ConversationPane
                pid={pid}
                selected={selected}
                mode={mode}
                onModeChange={setMode}
                autoApprove={selectedConv?.autoApprove ?? 'cautious'}
                onAutoApprove={(l) => changeAutoApprove(selected, l)}
                onProducedFiles={handleProduced}
              />
            ) : (
              <div class="gd-empty">← {t('view.chooseConversation')}</div>
            )}
          </div>
          {showFiles && (
            <div class="chat-files-col">
              <FilePanel pid={pid} produced={produced} onClose={() => setShowFiles(false)} />
            </div>
          )}
        </div>
      ) : (
        <div class="wb-list-full">{list}</div>
      )}
    </div>
  );
}

type HistoryAgentFilter = 'all' | AgentKind;

const historySessionKey = (session: Pick<LocalHistorySession, 'agent' | 'sessionId'>): string =>
  `${session.agent}\0${session.sessionId}`;

function ImportLocalHistoryModal({
  pid,
  onClose,
  onImported,
}: {
  pid: number;
  onClose: () => void;
  onImported: (conversation: Conversation) => void;
}) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<LocalHistorySession[] | null>(null);
  const [cwd, setCwd] = useState('');
  const [filter, setFilter] = useState<HistoryAgentFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    setSessions(null);
    setError('');
    void api<LocalHistoryResponse>(
      `/api/projects/${pid}/conversations/local-history`,
    )
      .then((result) => {
        if (disposed) return;
        setCwd(result.cwd);
        setSessions(result.sessions);
      })
      .catch((e: Error) => {
        if (disposed) return;
        setSessions([]);
        setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [pid]);

  const visible = (sessions ?? []).filter((session) => filter === 'all' || session.agent === filter);
  const selectableVisible = visible.filter((session) => session.importedConversationId === null);
  const selectable = (sessions ?? []).filter((session) => session.importedConversationId === null);

  const toggle = (session: LocalHistorySession): void => {
    if (session.importedConversationId !== null) return;
    const key = historySessionKey(session);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectVisible = (): void => {
    setSelected((current) => {
      const next = new Set(current);
      selectableVisible.forEach((session) => next.add(historySessionKey(session)));
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (busy || selected.size === 0) return;
    const chosen = selectable
      .filter((session) => selected.has(historySessionKey(session)))
      .map((session) => ({ agent: session.agent, sessionId: session.sessionId }));
    if (chosen.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<LocalHistoryImportResponse>(
        `/api/projects/${pid}/conversations/local-history`,
        'POST',
        { sessions: chosen },
      );
      const target = result.conversations[0];
      if (!target) throw new Error(t('view.noImportedConversation'));
      toast.success(t('view.localHistoryImported', { count: result.imported + result.existing }));
      onImported(target);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={t('view.importLocalHistory')} onClose={onClose} wide>
      <div class="history-import" aria-busy={busy ? 'true' : 'false'}>
        <div class="history-import-help">
          <span>{t('view.localHistoryHelp')}</span>
          {cwd && <code>{cwd}</code>}
        </div>
        <div class="history-import-toolbar">
          <div class="seg sm history-import-filter" aria-label={t('view.localHistoryAgentFilter')}>
            {(['all', 'claude', 'codex'] as const).map((agent) => (
              <button
                type="button"
                key={agent}
                class={'seg-btn' + (filter === agent ? ' on' : '')}
                aria-pressed={filter === agent}
                title={agent === 'all' ? t('shell.all') : AGENT_NAMES[agent]}
                aria-label={agent === 'all' ? t('shell.all') : AGENT_NAMES[agent]}
                disabled={busy}
                onClick={() => setFilter(agent)}
              >
                {agent === 'all' ? t('shell.all') : <AgentLogo agent={agent} decorative size="sm" />}
              </button>
            ))}
          </div>
          <div class="history-import-selection" aria-live="polite">
            {t('view.historySelected', { count: selected.size })}
          </div>
          <button
            type="button"
            class="btn sm"
            disabled={busy || selectableVisible.length === 0}
            onClick={selectVisible}
          >
            {t('view.selectAllHistory')}
          </button>
          <button
            type="button"
            class="btn sm"
            disabled={busy || selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            {t('view.clearHistorySelection')}
          </button>
        </div>
        {sessions === null && (
          <div class="history-import-status" role="status" aria-live="polite">
            {t('view.readingLocalHistory')}
          </div>
        )}
        {sessions !== null && sessions.length === 0 && !error && (
          <div class="empty history-import-empty">{t('view.noLocalHistory')}</div>
        )}
        {sessions !== null && sessions.length > 0 && visible.length === 0 && (
          <div class="empty history-import-empty">{t('view.noFilteredLocalHistory')}</div>
        )}
        {visible.length > 0 && (
          <div class="history-import-list" aria-label={t('view.localHistoryCandidates')}>
            {visible.map((session) => {
              const key = historySessionKey(session);
              const imported = session.importedConversationId !== null;
              return (
                <label class={'history-import-item' + (selected.has(key) ? ' on' : '') + (imported ? ' imported' : '')} key={key}>
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    disabled={imported || busy}
                    onChange={() => toggle(session)}
                  />
                  <AgentLogo agent={session.agent} decorative />
                  <span class="history-import-copy">
                    <span class="history-import-title">{session.title || t('view.untitledHistory')}</span>
                    <span class="history-import-meta">
                      {timeAgo(session.updatedTs || session.createdTs)}
                    </span>
                  </span>
                  {imported && <span class="badge b-green">{t('view.historyAlreadyImported')}</span>}
                </label>
              );
            })}
          </div>
        )}
        {error && <div class="err" role="alert">{error}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" disabled={busy} onClick={onClose}>{t('ui.cancel')}</button>
        <button class="btn primary" disabled={busy || selected.size === 0} onClick={() => void submit()}>
          {busy ? t('project.importing') : t('view.importSelectedHistory')}
        </button>
      </div>
    </Modal>
  );
}

/**
 * 对话 id 徽标：显示前 8 位、点一下复制全 id。
 *
 * 这个 id 就是 `conversations.id`，也是执行机上这条对话的 tmux 会话名 `chat-<id>` 和
 * codex/claude 会话的绑定主键——排「网页看到的记录和终端里跑的不是同一条」这类问题时，
 * 拿它就能把地址栏、tmux 会话、库里的 agent_session_id 三边对上号。
 */
function ConvIdChip({ id }: { id: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class={'badge mono conv-id' + (copied ? ' ok' : '')}
      title={t('view.copyConversationId', { id })}
      aria-label={t('view.copyConversationId', { id })}
      onClick={() => {
        void copyText(id).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span class="conv-id-v">{id.slice(0, 8)}</span>
      <span class="conv-id-ic" aria-hidden="true">{copied ? '\u2713' : '\u29c9'}</span>
    </button>
  );
}

/** 选中对话的两种同源视图；mode 或 conversation 改变都卸载原有 WS/xterm。 */
function ConversationPane({
  pid,
  selected,
  mode,
  onModeChange,
  autoApprove,
  onAutoApprove,
  onProducedFiles,
}: {
  pid: number;
  selected: string;
  mode: NativeMode;
  onModeChange: (mode: NativeMode) => void;
  /** 本对话的自动批准档位 + 切换回调（原生终端模式下没有菜单卡片，钮也一并给出，语义一致） */
  autoApprove: AutoApproveLevel;
  onAutoApprove: (level: AutoApproveLevel) => void;
  onProducedFiles: (paths: string[]) => void;
}) {
  // 当前模型（issue #109）：只读展示，对话/原生两种模式与宽窄屏都在这一行同一位置
  const model = useConvModel(pid, selected);
  const switcher = (
    <>
      <NativeModeSwitch mode={mode} onChange={onModeChange} />
      <AutoApproveSwitch level={autoApprove} onChange={onAutoApprove} />
      <ModelBadge model={model} />
      <ConvIdChip id={selected} />
    </>
  );
  if (mode === 'chat') {
    return (
      <ChatPane
        key={`chat:${selected}`}
        pid={pid}
        conv={selected}
        headerLeading={switcher}
        onProducedFiles={onProducedFiles}
      />
    );
  }
  return (
    <NativeConversationTerminal
      key={`native:${selected}`}
      pid={pid}
      selected={selected}
      switcher={switcher}
    />
  );
}

/** 等独立 chat tmux 激活完成后再建 PTY，避免新建/服务重启后的首连 404 竞态。 */
function NativeConversationTerminal({
  pid,
  selected,
  switcher,
}: {
  pid: number;
  selected: string;
  switcher: JSX.Element;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [gen, setGen] = useState(0);

  useEffect(() => {
    let disposed = false;
    setReady(false);
    setError('');
    void api(`/api/projects/${pid}/conversations/${selected}/activate`, 'POST')
      .then(() => {
        if (!disposed) setReady(true);
      })
      .catch((e: Error) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [pid, selected, gen]);

  return (
    <div class="fullcol chatpane">
      <div class="runctl">{switcher}</div>
      {ready ? (
        <TermPane pid={pid} target={{ kind: 'conversation', convId: selected }} />
      ) : error ? (
        <div class="empty">
          {tr('view.nativeStartFailed', { error })}
          <div>
            <button class="btn primary" onClick={() => setGen((g) => g + 1)}>
              {tr('action.retry')}
            </button>
          </div>
        </div>
      ) : (
        <div class="empty">{tr('view.startingNative')}</div>
      )}
    </div>
  );
}

// ---------- 文件/预览侧栏 ----------

function FilePanel({
  pid,
  produced,
  onClose,
}: {
  pid: number;
  produced: string[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [rel, setRel] = useState('');
  const [list, setList] = useState<FsList | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [uploading, setUploading] = useState(false);
  const [prog, setProg] = useState(0); // 上传进度 0~100（整数）；进度未知时停在 0
  const fileInput = useRef<HTMLInputElement>(null);
  // 已见过的图片全路径：用于「新出现的图片=本轮产物」判定（Bash 生成的图也能被抓到）
  const seenImgs = useRef<Set<string>>(new Set());

  const load = (p: string, auto = false): void => {
    setErr('');
    api<FsList>(`/api/projects/${pid}/fs?path=${encodeURIComponent(p)}`)
      .then((r) => {
        setList(r);
        setRel(r.path);
        const imgs = r.entries
          .filter((e) => e.type === 'file' && isImageExt(extOf(e.name)))
          .map((e) => (r.path ? `${r.path}/${e.name}` : e.name));
        const fresh = imgs.filter((f) => !seenImgs.current.has(f));
        imgs.forEach((f) => seenImgs.current.add(f));
        // auto=活动刷新时：有新图片就自动预览最新一张
        if (auto && fresh.length > 0) setPreview(fresh[fresh.length - 1]!);
      })
      .catch((e: Error) => setErr(e.message));
  };

  // 首次加载 + 切项目重置
  useEffect(() => {
    seenImgs.current = new Set();
    setPreview(null);
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // 产出变化（对话有新写文件/活动）→ 刷新当前目录，抓新产出图片
  const producedKey = produced.join('\n');
  useEffect(() => {
    if (!producedKey) return;
    load(rel, true);
    // tool 明确解析出的产出图片：直接预览最新一张
    const img = [...produced].reverse().find(isImagePath);
    if (img) setPreview(img);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [producedKey]);

  const enterDir = (name: string): void => {
    setList(null);
    load(rel ? `${rel}/${name}` : name);
  };
  const openFile = (name: string): void => setPreview(rel ? `${rel}/${name}` : name);

  // 上传到当前目录（复用 Files 页逻辑：走 XHR 底座拿上传进度，成功后刷新当前目录）
  const uploadFile = async (f: File): Promise<void> => {
    setUploading(true);
    setProg(0);
    try {
      const j = await uploadWithProgress<FsUploadResult>(
        `/api/projects/${pid}/fs/upload?path=${encodeURIComponent(rel)}`,
        f,
        f.name,
        { onProgress: (p) => setProg(Math.round(p.ratio * 100)) },
      );
      toast.success(t('view.uploaded', { name: j.name }));
      load(rel);
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
    } finally {
      setUploading(false);
      setProg(0);
    }
  };

  const segs = rel ? rel.split('/') : [];

  return (
    <div class="fpanel">
      <div class="fpanel-hd">
        <span class="fpanel-t">{t('view.files')}</span>
        <button
          class="linkbtn fs-up"
          title={t('view.uploadCurrentDirectory')}
          disabled={uploading}
          onClick={() => fileInput.current?.click()}
        >
          {uploading ? (prog > 0 ? `${prog}%` : '…') : '⇧'}
          {uploading && (
            <span
              class="up-prog"
              role="progressbar"
              aria-valuenow={prog}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('ui.uploadingPercent', { percent: prog })}
            >
              <i style={{ width: `${prog}%` }} />
            </span>
          )}
        </button>
        <button class="linkbtn" title={t('ui.refresh')} onClick={() => load(rel, false)}>
          🔄
        </button>
        <button class="linkbtn" title={t('action.close')} onClick={onClose}>
          ✕
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) void uploadFile(f);
        }}
      />

      {preview && <FilePreview pid={pid} path={preview} onBack={() => setPreview(null)} />}

      <div class="fpanel-crumbs">
        <button class="crumb" onClick={() => load('')}>
          ⌂
        </button>
        {segs.map((s, i) => (
          <span key={i} class="crumb-seg">
            <span class="mut">/</span>
            <button class="crumb" onClick={() => load(segs.slice(0, i + 1).join('/'))}>
              {s}
            </button>
          </span>
        ))}
      </div>

      {err && <div class="err">{err}</div>}
      <div class="fpanel-list">
        {list === null && !err && <Loading />}
        {list !== null && list.entries.length === 0 && <div class="empty">{t('ui.emptyDirectory')}</div>}
        {(list?.entries ?? []).map((e) => (
          <div
            key={e.name}
            class={'fprow' + (preview === (rel ? `${rel}/${e.name}` : e.name) ? ' on' : '')}
            onClick={() => (e.type === 'dir' ? enterDir(e.name) : openFile(e.name))}
          >
            <span class="fpicon">{e.type === 'dir' ? '📁' : isImageExt(extOf(e.name)) ? '🖼' : '📄'}</span>
            <span class="fpname">{e.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilePreview({ pid, path, onBack }: { pid: number; path: string; onBack: () => void }) {
  const kind = previewKind(path);
  const raw = `/api/projects/${pid}/fs/raw?path=${encodeURIComponent(path)}`;
  const dl = `/api/projects/${pid}/fs/download?path=${encodeURIComponent(path)}`;
  const name = path.split('/').pop() ?? path;
  return (
    <div class="fp-preview">
      <div class="fp-preview-hd">
        <button class="linkbtn" title={tr('view.collapsePreview')} onClick={onBack}>
          ▾
        </button>
        <span class="fp-preview-nm" title={path}>
          {name}
        </span>
        <button
          class="btn sm"
          title={tr('view.openFullFiles')}
          onClick={() => nav(`/p/${pid}/files`)}
        >
          {tr('ui.expand')}
        </button>
        <a class="btn sm" href={dl}>
          ⬇
        </a>
      </div>
      <div class="fp-preview-body">
        {kind === 'image' && <img class="fp-img" src={raw} alt={name} />}
        {kind === 'html' && <iframe class="fp-frame" src={raw} sandbox="" title={name} />}
        {kind === 'pdf' && (
          <div class="fp-dl">
            {tr('ui.pdfDownload')}
            <a class="btn sm primary" href={dl}>
              ⬇ {tr('ui.downloadPdf')}
            </a>
          </div>
        )}
        {kind === 'text' && <TextPreview pid={pid} path={path} />}
        {kind === 'download' && (
          <div class="fp-dl">
            {tr('view.previewUnsupported')}
            <a class="btn sm primary" href={dl}>
              ⬇ {tr('ui.download')}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function TextPreview({ pid, path }: { pid: number; path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setText(null);
    setErr('');
    api<FsFile>(`/api/projects/${pid}/fs/file?path=${encodeURIComponent(path)}`)
      .then((r) => setText(r.content))
      .catch((e: Error) => setErr(e.message));
  }, [pid, path]);
  if (err) return <div class="fp-dl">{err} ({tr('view.downloadToOpen')})</div>;
  if (text === null) return <Loading />;
  return <pre class="fp-code">{text}</pre>;
}
