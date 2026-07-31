/**
 * 对话模式主视图（chat 界面）。
 *
 * 路由：#/p/:pid/chat。左栏多对话列表（新建/切换/归档/重命名 + 每对话 claude/codex），
 * 右栏复用 ChatPane（按 conv 独立流：传 conv=<对话 id> 钉住该对话自身会话）。
 * 每条 chat 对话有独立 tmux 会话（后端 chat-<convId>），切换只是重连 WS、不 kill 其它对话，
 * 故来回切换互不打断。选中/新建即 activate（幂等：会话活着不重启）。
 *
 * 宽屏左右并排；窄屏列表整页，点对话进整页聊天（顶部返回回列表）。
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { AutoApproveSwitch } from '../components/AutoApproveSwitch';
import { ModelBadge } from '../components/badges';
import { ChatPane } from '../components/ChatPane';
import { ListSplitter } from '../components/ListSplitter';
import { Loading } from '../components/Loaders';
import { NativeModeSwitch, type NativeMode } from '../components/NativeModeSwitch';
import { SummaryButton } from '../components/SummaryButton';
import { TermPane } from '../components/TermPane';
import { api, ApiError, getProjectExecutorAgents, setConvAutoApprove } from '../lib/api';
import { timeAgo } from '../lib/fmt';
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
  Project,
} from '../lib/types';
import { useConvModel } from '../lib/useConvModel';
import { useWide } from '../lib/useWide';
import { reconcileAgent } from '../components/AgentPicker';

export function ChatView({ pid }: { pid: number }) {
  const [project, setProject] = useState<Project | null>(null);
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<NativeMode>('chat');
  const [newAgent, setNewAgent] = useState<AgentKind>('claude');
  const [supportedAgents, setSupportedAgents] = useState<AgentKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [err, setErr] = useState('');
  const [showFiles, setShowFiles] = useState(false);
  const [produced, setProduced] = useState<string[]>([]);
  const [memBusy, setMemBusy] = useState(false);
  const wide = useWide();
  const listW = useListWidth(); // 宽屏对话列表栏宽度：拖拽持久化，未设则回落 CSS 默认（与工作台共用 mando.wbListW）
  const splitRef = useRef<HTMLDivElement>(null); // .wb-split 容器 ref，供分隔条换算左栏像素宽

  useEffect(() => {
    setProject(null);
    setConvs(null);
    setSelected(null);
    setErr('');
    api<Project>(`/api/projects/${pid}`).then(setProject).catch((e: Error) => setErr(e.message));
    void getProjectExecutorAgents(pid)
      .then((agents) => {
        setSupportedAgents(agents);
        const next = reconcileAgent(newAgent, agents);
        if (next) setNewAgent(next);
      })
      .catch(() => setSupportedAgents([]));
    api<{ conversations: Conversation[] }>(`/api/projects/${pid}/conversations`)
      .then((r) => {
        setConvs(r.conversations);
        // 默认选中最近活跃的一条（后端已按最近使用倒序）
        const initial = r.conversations[0]?.id ?? null;
        setSelected(initial);
        // 服务重启后 tmux 可能已不在；与手动点选一致，幂等确保原生视图有真实代理会话可连。
        if (initial) activate(initial);
      })
      .catch((e: Error) => setErr(e.message));
  }, [pid]);

  // 确保对话自身会话已启动（幂等：会话活着不重启，故不打断其它在跑对话）
  const activate = (id: string): void => {
    void api(`/api/projects/${pid}/conversations/${id}/activate`, 'POST').catch(() => {});
  };

  const select = (id: string): void => {
    setSelected(id);
    activate(id);
  };

  const createConv = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api<{ conversation: Conversation }>(
        `/api/projects/${pid}/conversations`,
        'POST',
        { agent: newAgent },
      );
      setConvs((cur) => (cur ? [r.conversation, ...cur] : [r.conversation]));
      setSelected(r.conversation.id);
      activate(r.conversation.id);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const archiveConv = async (id: string): Promise<void> => {
    if (!window.confirm('归档这条对话？会停止其后台会话（历史保留，可在归档中找回）。')) return;
    try {
      await api(`/api/projects/${pid}/conversations/${id}/archive`, 'POST');
      const rest = (convs ?? []).filter((c) => c.id !== id);
      setConvs(rest);
      if (selected === id) {
        const next = rest[0]?.id ?? null;
        setSelected(next);
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
      if (final.summaryStatus === 'done') toast.success('项目记忆已更新');
      else if (final.summaryStatus === 'error') toast.error(final.summaryError ?? '更新失败');
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

  // 返回目标：chat 类型项目回项目列表；issue 项目（从工作台「对话」进来）回其看板。
  // project 未载入时按 issue 处理——常见入口即 issue 工作台，且 chat 项目回看板会被 BoardView 重定向回本页，无害。
  const backTo = project?.kind === 'chat' ? '/' : `/p/${pid}`;

  const convRow = (c: Conversation) => {
    const renaming = renamingId === c.id;
    return (
      <div
        key={c.id}
        class={'conv-it' + (c.id === selected ? ' on' : '')}
        onClick={() => !renaming && select(c.id)}
      >
        <span class={'conv-agent ' + (c.agent === 'codex' ? 'cx' : 'cl')} title={c.agent}>
          {c.agent === 'codex' ? 'CX' : 'CL'}
        </span>
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
            <span class="conv-nm grow">{c.label || '新对话'}</span>
            <span class="conv-time">{timeAgo(c.lastActiveTs ?? c.createdTs)}</span>
            <span
              class="conv-act"
              role="button"
              title="重命名"
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
              title="归档"
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
        <span class="conv-list-t">对话{convs ? ` · ${convs.length}` : ''}</span>
        <div class="conv-new">
          <div class="seg sm" role="tablist">
            {supportedAgents.map((agent) => (
              <button
                key={agent}
                class={`seg-btn ${newAgent === agent ? 'on' : ''}`}
                onClick={() => setNewAgent(agent)}
              >
                {agent}
              </button>
            ))}
          </div>
          <button
            class="btn sm primary"
            disabled={busy || supportedAgents.length === 0}
            onClick={() => void createConv()}
          >
            ＋ 新建
          </button>
        </div>
      </div>
      <div class="conv-items">
        {convs === null && <Loading />}
        {convs !== null && convs.length === 0 && (
          <div class="empty">还没有对话，选择代理后点「＋ 新建」开始。</div>
        )}
        {(convs ?? []).map(convRow)}
      </div>
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
            <span class="btitle">{selectedConv?.label || '对话'}</span>
            <span class="badge b-gray">{selectedConv?.agent ?? ''}</span>
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
          <span class="btitle">{project?.name ?? `项目 #${pid}`}</span>
          <span class="badge b-purple">对话</span>
          <div class="bacts">
            <SummaryButton
              status={project?.summaryStatus}
              busy={memBusy}
              models={MEMORY_MODELS.filter((m) =>
                supportedAgents.includes(m.mode as AgentKind),
              )}
              renderLabel={memoryBtnLabel}
              title="更新项目记忆（读对话历史+代码库，刷新 CLAUDE.md/AGENTS.md）"
              onPick={(mode) => void updateMemory(mode)}
            />
            <button
              class={'btn sm' + (wide && showFiles ? ' primary' : '')}
              title="文件与预览"
              onClick={() => (wide ? setShowFiles((v) => !v) : nav(`/p/${pid}/files`))}
            >
              文件
            </button>
            <button class="btn sm" onClick={() => nav(`/p/${pid}/term`)}>
              原生 Bash
            </button>
          </div>
        </div>
        {project?.understanding && (
          <details class="understanding">
            <summary>
              🧠 项目记忆
              {project.understandingAgent ? `（${project.understandingAgent}）` : ''}
              {project.understandingTs ? ` · ${timeAgo(project.understandingTs)}` : ''}
            </summary>
            <div class="understanding-body">{project.understanding}</div>
          </details>
        )}
        {project?.summaryError && project.summaryStatus === 'error' && (
          <div class="err">记忆更新失败：{project.summaryError}</div>
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
          <ListSplitter containerRef={splitRef} list={listW} label="对话列表栏宽" />
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
              <div class="gd-empty">← 选择或新建一条对话</div>
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
          原生会话启动失败：{error}
          <div>
            <button class="btn primary" onClick={() => setGen((g) => g + 1)}>
              重试
            </button>
          </div>
        </div>
      ) : (
        <div class="empty">正在启动原生会话…</div>
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
  const [rel, setRel] = useState('');
  const [list, setList] = useState<FsList | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [uploading, setUploading] = useState(false);
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

  // 上传到当前目录（复用 Files 页逻辑：multipart，成功后刷新当前目录）
  const uploadFile = async (f: File): Promise<void> => {
    setUploading(true);
    const fd = new FormData();
    fd.append('file', f, f.name);
    try {
      const r = await fetch(`/api/projects/${pid}/fs/upload?path=${encodeURIComponent(rel)}`, {
        method: 'POST',
        body: fd,
      });
      const j = (await r.json().catch(() => null)) as (FsUploadResult & { error?: string }) | null;
      if (!r.ok || !j?.ok) throw new Error(j?.error ?? `上传失败(HTTP ${r.status})`);
      toast.success(`已上传 ${j.name}`);
      load(rel);
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
    } finally {
      setUploading(false);
    }
  };

  const segs = rel ? rel.split('/') : [];

  return (
    <div class="fpanel">
      <div class="fpanel-hd">
        <span class="fpanel-t">文件</span>
        <button
          class="linkbtn"
          title="上传到当前目录"
          disabled={uploading}
          onClick={() => fileInput.current?.click()}
        >
          {uploading ? '…' : '⇧'}
        </button>
        <button class="linkbtn" title="刷新" onClick={() => load(rel, false)}>
          🔄
        </button>
        <button class="linkbtn" title="关闭" onClick={onClose}>
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
        {list !== null && list.entries.length === 0 && <div class="empty">（空目录）</div>}
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
        <button class="linkbtn" title="收起预览" onClick={onBack}>
          ▾
        </button>
        <span class="fp-preview-nm" title={path}>
          {name}
        </span>
        <button
          class="btn sm"
          title="在完整文件目录页中打开"
          onClick={() => nav(`/p/${pid}/files`)}
        >
          展开
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
            PDF 文件，请下载后查看。
            <a class="btn sm primary" href={dl}>
              ⬇ 下载 PDF
            </a>
          </div>
        )}
        {kind === 'text' && <TextPreview pid={pid} path={path} />}
        {kind === 'download' && (
          <div class="fp-dl">
            该类型不支持预览。
            <a class="btn sm primary" href={dl}>
              ⬇ 下载
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
  if (err) return <div class="fp-dl">{err}（请下载查看）</div>;
  if (text === null) return <Loading />;
  return <pre class="fp-code">{text}</pre>;
}
