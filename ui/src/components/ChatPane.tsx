/**
 * components/ChatPane —— issue 执行现场的对话面板（原 views/Chat.tsx 平移抽取）。
 * WS /ws/chat/:pid[?conv=]：conv 钉住 issue 对话——live（=激活对话）全交互；
 * 非 live 只读历史（服务端 mode 帧驱动，输入区自动禁用）。
 * 底部单一操作区优先级：CC 菜单 selection > gateBar（卡点面板）> live 输入条 > 只读提示。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { connectWs, type WsHandle } from '../lib/ws';
import { mergeMessages } from '../lib/chatMerge';
import { createMockChat, isMockMode } from '../lib/mockChat';
import { markPending, maxOffOf, prunePending, type PendingMsg } from '../lib/pending';
import { ImageAttach, type AttachedImage } from './ImageAttach';
import { ImageLightbox } from './ImageLightbox';
import { RunStream } from './runstream';
import { RunControls } from './RunControls';
import { isDriving, retryPlan } from '../lib/issueStatus';
import { lastToolErrored, producedFilesOf } from '../lib/runstream';
import { issueStartTs, messagesForIssue } from '../lib/conversationSegments';
import type {
  ChatClientFrame,
  ChatMessage,
  ChatSelection,
  ChatServerFrame,
  ConversationSegment,
  IssueStatus,
} from '../lib/types';
import { useI18n } from '../i18n/provider';
import { tr } from '../i18n/runtime';

/** 常用键条（key 名 = 后端 tmux 白名单键名，与 v1 ALLOWED_KEYS 一致） */
const KEYS: Array<[string, string]> = [
  ['Esc', 'Escape'],
  ['⏎', 'Enter'],
  ['↑', 'Up'],
  ['↓', 'Down'],
  ['^C', 'C-c'],
  ['Tab', 'Tab'],
  ['⌫', 'BSpace'],
];

/** 「重试」按钮注入给 AI 的提示（subtask 7 细化文案/可用性） */
const RETRY_PROMPT = '请重试刚才失败的步骤。';

/** 运行操作栏所需的父层上下文（issue 状态 + 父层动作） */
export interface RunCtl {
  status: IssueStatus;
  busy?: boolean;
  /** 终止：取消整个 issue（父层带二次确认） */
  onTerminate: () => void;
  /** 受阻重试：解除阻塞重跑（POST /unblock，父层实现） */
  onUnblock: () => void;
}

export function ChatPane({
  pid,
  conv,
  gateBar,
  runCtl,
  headerLeading,
  onProducedFiles,
  conversationSegments,
  currentIssueId,
}: {
  pid: number;
  /** 钉住的对话 id（issue.convId）；undefined = 跟随激活对话 */
  conv?: string;
  /** 底部操作区覆盖：非 null 时（且无 CC 菜单）替代输入条显示（卡点/澄清/受阻面板） */
  gateBar?: JSX.Element | null;
  /** 运行操作栏上下文；仅在 issue 驱动中 + live 时于顶部显示 */
  runCtl?: RunCtl;
  /** 头行行首插槽（如「对话/原生」切换钮）：驱动中与运行操作钮同行，不驱动时单行只剩它 */
  headerLeading?: JSX.Element;
  /** 对话产出/改动的文件路径变化时回调（对话模式文件侧栏据此自动预览产出图片） */
  onProducedFiles?: (paths: string[]) => void;
  /** 模块永久共享会话的 issue 分段；仅 issue 执行页传入。 */
  conversationSegments?: ConversationSegment[];
  currentIssueId?: number;
}) {
  const { t } = useI18n();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [sel, setSel] = useState<ChatSelection | null>(null);
  const [live, setLive] = useState(conv === undefined); // 钉住模式等 mode 帧定夺
  const [staleHint, setStaleHint] = useState(false);
  // codex 等 agent 未就绪（退回 shell / 正在重启）提示：发消息被就绪门禁拦下时显示，收到新气泡即清
  const [notReady, setNotReady] = useState<string | null>(null);
  // 连接状态：正常(open)缩为快捷键行小圆点，其余态才显示文字提示行
  const [conn, setConn] = useState<'open' | 'connecting' | 'down' | 'mock'>('connecting');
  const [connErr, setConnErr] = useState<string | null>(null); // ⚠ 服务端错误码（连接状态变化即清）
  const [text, setText] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [hasMore, setHasMore] = useState(true); // 是否还有更早历史可拉（history 帧回填；切对话重置）
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null); // 点开的附图 rel（全屏灯箱）；null=未开
  // 我发出去的消息（issue #116）：点发送即本地插一条带送达状态的气泡，真消息从 jsonl 回流后撤掉
  const [pending, setPending] = useState<PendingMsg[]>([]);
  const pendingSeq = useRef(0);
  // 菜单解读（issue #112「解释一下」）：点了才生成，按菜单本体签名认领——光标挪一格不算换菜单
  const [explain, setExplain] = useState<{ optionsSig: string; text: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainErr, setExplainErr] = useState(false);
  const selOptSig = useRef(''); // 当前菜单本体签名，用来判定「菜单是否真的换了」
  const wsRef = useRef<WsHandle | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const seenBaseline = useRef(false); // 首个 baseline 才贴底；重连的 baseline 只合并、不打断阅读位置
  const histInFlight = useRef(false); // history 请求在途守卫：防滚动连发/重复请求
  const historyExhausted = useRef(false); // 真正读到文件头后，重连 baseline 不得把它重新变成“还有更早”
  const pendingAnchor = useRef<number | null>(null); // 前插前记录的 scrollHeight，用于补 scrollTop 保锚点

  const targetStart =
    currentIssueId !== undefined && conversationSegments?.length
      ? issueStartTs(conversationSegments, currentIssueId)
      : undefined;
  const issueScoped = currentIssueId !== undefined && targetStart !== undefined;
  const visibleMsgs = issueScoped
    ? messagesForIssue(msgs, conversationSegments ?? [], currentIssueId)
    : msgs;
  const loadedTimestamps = msgs.flatMap((m) => (m.ts === undefined ? [] : [m.ts]));
  const earliestLoadedTs = loadedTimestamps.length ? Math.min(...loadedTimestamps) : undefined;
  // 当前 issue 起点之前已经读到一条消息，即已覆盖完整 issue；再向前只会拿到前一个 issue。
  const reachedIssueStart =
    !issueScoped || (earliestLoadedTs !== undefined && earliestLoadedTs <= targetStart);
  const canLoadOlder = hasMore && (!issueScoped || !reachedIssueStart);

  useEffect(() => {
    setMsgs([]);
    setSel(null);
    setImages([]); // 切换对话丢弃未发出的附图
    setLightbox(null); // 切对话收起灯箱
    setPending([]); // 乐观气泡属于上一条对话，跟着清
    setNotReady(null);
    setConnErr(null);
    setLive(conv === undefined);
    setHasMore(true);
    setLoadingHistory(false);
    seenBaseline.current = false; // 切对话才重置（唯一清空点）
    histInFlight.current = false;
    historyExhausted.current = false;
    pendingAnchor.current = null;
    setExplain(null);
    setExplaining(false);
    setExplainErr(false);
    selOptSig.current = '';
    /** 换菜单即作废解读（含加载/失败态）：上一个问题的解读挂在新菜单上会误导人 */
    const applySelection = (next: ChatSelection | null): void => {
      const sig = next ? next.options.join('|') : '';
      if (sig !== selOptSig.current) {
        selOptSig.current = sig;
        setExplain(null);
        setExplaining(false);
        setExplainErr(false);
      }
      setSel(next);
    };
    const handleFrame = (raw: string): void => {
      let f: ChatServerFrame;
      try {
        f = JSON.parse(raw) as ChatServerFrame;
      } catch {
        return;
      }
      if (f.type === 'baseline') {
        // 合并而非整表替换：重连只补末段、不清空已加载的更早历史（修「重连缩回 60 条」）
        setMsgs((prev) => mergeMessages(prev, f.msgs ?? []));
        setHasMore(historyExhausted.current ? false : f.hasMore);
        applySelection(f.selection ?? null);
        setStaleHint(false);
        setNotReady(null);
        if (!seenBaseline.current) {
          seenBaseline.current = true;
          stick.current = true; // 仅首屏贴底；重连合并保持当前位置
        }
      } else if (f.type === 'msg') {
        setMsgs((p) => mergeMessages(p, [f.m])); // 去重追加（重连重叠不产生重复气泡）
        setNotReady(null); // 有新气泡 = agent 已在响应，清掉「未就绪」提示
      } else if (f.type === 'history') {
        // 更早一页：有内容才前插——先记录当前总高（前插后按增量补 scrollTop 保锚点，见 useLayoutEffect）
        if (f.msgs && f.msgs.length) {
          const el = listRef.current;
          pendingAnchor.current = el ? el.scrollHeight : null;
          setMsgs((p) => mergeMessages(p, f.msgs));
        }
        setHasMore(f.hasMore); // 到顶 → false → 顶部显示「已到最早」
        historyExhausted.current = !f.hasMore;
        setLoadingHistory(false);
        histInFlight.current = false;
      } else if (f.type === 'selection') {
        applySelection(f.sel ?? null);
        setStaleHint(false);
      } else if (f.type === 'mode') {
        setLive(f.live);
      } else if (f.type === 'stale') {
        // 我方 select/explain 已过期：清掉旧菜单，等服务端补发新 selection
        applySelection(null);
        setStaleHint(true);
      } else if (f.type === 'explanation') {
        // 迟到的解读（菜单已换）直接丢：optionsSig 对不上就不是这个问题的答案
        if (f.optionsSig === selOptSig.current) {
          setExplain({ optionsSig: f.optionsSig, text: f.text });
          setExplainErr(false);
        }
        setExplaining(false);
      } else if (f.type === 'ack') {
        setPending((p) => markPending(p, f.id, 'sent')); // 真注入成功 = 已送达
      } else if (f.type === 'err') {
        // 带 id = 这条文本消息没发出去（「正在重启并自动补发」那帧故意不带 id，气泡保持发送中）
        const failedId = f.id;
        if (failedId) setPending((p) => markPending(p, failedId, 'failed'));
        // 就绪门禁：代理未就绪/正在重启——显式提示（替代「发了没反应」），别当普通报错塞进状态行。
        // 文案以服务端下发的 msg 为准（issue #97：文本消息会「重启并自动补发」，不用手动重发）
        if (f.code === 'agent_not_ready') setNotReady(f.msg ?? t('ui.agentRestarting'));
        else if (f.code === 'explain_failed') {
          // 解读失败只在菜单卡里说一声，别塞进连接状态行（那是连接层的位置）
          setExplaining(false);
          setExplainErr(true);
        } else setConnErr(f.code);
      }
    };
    let handle: WsHandle;
    if (isMockMode()) {
      handle = createMockChat(handleFrame);
      setConn('mock');
    } else {
      handle = connectWs(`/ws/chat/${pid}${conv ? `?conv=${encodeURIComponent(conv)}` : ''}`, {
        onText: handleFrame,
        onStatus: (s) => {
          setConn(s === 'open' ? 'open' : s === 'connecting' ? 'connecting' : 'down');
          setConnErr(null);
        },
        reconnectMs: 2000,
      });
    }
    wsRef.current = handle;
    return () => {
      handle.close();
      wsRef.current = null;
    };
  }, [pid, conv]);

  // 前插更早历史后保持滚动锚点：内容在顶部变高，scrollTop 补上增量 → 视口停在原来的消息上、不跳。
  // useLayoutEffect 在浏览器绘制前同步补位，无闪跳；与贴底 useEffect 不冲突（前插时 stick=false，贴底不触发）。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pendingAnchor.current !== null) {
      el.scrollTop += el.scrollHeight - pendingAnchor.current;
      pendingAnchor.current = null;
    }
  }, [msgs]);
  // 贴底自动滚动（用户上翻时不打扰）
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, sel]);
  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop < 40) loadOlder(); // 滚到顶自动拉更早（loadOlder 内部有在途/到顶守卫）
  };

  // 真消息从 jsonl 回流即撤掉对应的乐观气泡（否则同一句话显示两遍）
  useEffect(() => {
    setPending((p) => prunePending(p, msgs));
  }, [msgs]);

  // 产出文件上报（仅在集合变化时触发；回调用 ref 存，避免父层重渲染导致重订阅）
  const onProdRef = useRef(onProducedFiles);
  onProdRef.current = onProducedFiles;
  const producedKey = producedFilesOf(visibleMsgs).join('\n');
  useEffect(() => {
    onProdRef.current?.(producedKey ? producedKey.split('\n') : []);
  }, [producedKey]);

  const send = (f: ChatClientFrame): void => wsRef.current?.send(JSON.stringify(f));

  // 向上翻页拉更早历史：baseline 之后才允许（否则会在 historyHead 未定时误判到顶）；在途/到顶时短路。
  const loadOlder = (): void => {
    if (!seenBaseline.current || histInFlight.current || !canLoadOlder) return;
    histInFlight.current = true;
    setLoadingHistory(true);
    const offs = msgs.map((m) => m.off).filter((off): off is number => off !== undefined);
    const before = offs.length ? Math.min(...offs) : undefined;
    send({ type: 'history', ...(before !== undefined && before > 0 ? { before } : {}) });
  };

  // 当前 issue 不在首屏时自动逐页向前，直到覆盖它的起点；普通对话首屏不足一屏时也自动补满。
  useEffect(() => {
    const el = listRef.current;
    const needsIssueBoundary = issueScoped && !reachedIssueStart;
    const needsViewportFill = !issueScoped && el !== null && el.scrollHeight <= el.clientHeight + 40;
    if ((needsIssueBoundary || needsViewportFill) && canLoadOlder && !loadingHistory) loadOlder();
  }, [msgs, canLoadOlder, issueScoped, reachedIssueStart, loadingHistory]);

  // 有图还没上传完（rel 未回）→ 暂不能发，避免漏图
  const uploading = images.some((im) => im.rel === null && !im.error);
  const canSend = (text.trim().length > 0 || images.length > 0) && !uploading;

  const sendText = (): void => {
    const t = text.trim();
    const rels = images.map((im) => im.rel).filter((r): r is string => r !== null);
    if ((!t && rels.length === 0) || uploading) return; // 只发图也允许，但纯空/上传中不发
    // 乐观气泡（issue #116）：id 随帧发出，服务端把结局 ack/err 原样带回；真消息回流后自动撤
    const id = `p${pendingSeq.current++}`;
    send({ type: 'text', text: t, ...(rels.length ? { images: rels } : {}), id });
    setPending((p) => [...p, { id, text: t, imgCount: rels.length, sinceOff: maxOffOf(msgs), state: 'sending' }]);
    setText('');
    // 释放本地预览 URL 再清空
    images.forEach((im) => {
      try {
        URL.revokeObjectURL(im.url);
      } catch {
        /* noop */
      }
    });
    setImages([]);
    stick.current = true;
  };

  const choose = (index: number): void => {
    if (!sel) return;
    send({ type: 'select', index, sig: sel.sig });
    // 多选表单：点一下只是勾选/取消，菜单还在——乐观清掉会让卡片闪一下再回来（实测 CC 语义）
    if (!sel.multiSelect) {
      setSel(null); // 乐观清掉；若过期服务端回 stale + 新 selection
      selOptSig.current = '';
      setExplain(null); // 菜单没了，解读跟着走
      setExplaining(false);
      setExplainErr(false);
    }
  };

  /** 「解释一下」：点了才发，服务端按菜单缓存一份，连点期间钮置灰不重复发 */
  const askExplain = (): void => {
    if (!sel || explaining) return;
    setExplainErr(false);
    setExplaining(true);
    send({ type: 'explain', sig: sel.sig });
  };

  const menuUp = sel !== null && live;
  // 非正常连接态才占一行提示；正常态缩为快捷键行左端小圆点（title 悬浮）
  const connHint = connErr
    ? `⚠ ${connErr}`
    : conn === 'connecting'
      ? t('ui.connecting')
      : conn === 'down'
        ? `⚪ ${t('ui.reconnecting')}`
        : conn === 'mock'
          ? `🧪 ${t('ui.mockMode')}`
          : null;
  // 流式活动：同步显示 AI 当前步骤（执行某工具 / 思考中）——菜单弹出时是用户回合，不显示。
  const activity =
    live && !menuUp ? activityOf(visibleMsgs.length > 0 ? visibleMsgs[visibleMsgs.length - 1] : undefined) : null;
  // 运行操作栏：仅 issue 驱动中 + live（可注入）时于顶部常驻；重试走 WS，终止/解阻走父层。
  const showRunCtl = runCtl !== undefined && live && isDriving(runCtl.status);
  const plan = runCtl ? retryPlan(runCtl.status, lastToolErrored(visibleMsgs)) : null;
  const doRetry = (): void => {
    if (!plan || !plan.enabled || !runCtl) return;
    if (plan.action === 'unblock') runCtl.onUnblock();
    else if (plan.action === 'inject') send({ type: 'text', text: RETRY_PROMPT });
  };
  return (
    <div class="fullcol chatpane">
      {showRunCtl && runCtl && plan ? (
        <RunControls
          leading={headerLeading}
          busy={runCtl.busy}
          onRetry={doRetry}
          retryLabel={plan.label}
          retryEnabled={plan.enabled}
          retryHint={plan.hint}
          onTerminate={runCtl.onTerminate}
        />
      ) : (
        headerLeading && <div class="runctl">{headerLeading}</div>
      )}
      <div class="chat-msgs runstream" ref={listRef} onScroll={onScroll}>
        {visibleMsgs.length === 0 && pending.length === 0 && !loadingHistory && (
          <div class="empty">{t('ui.noChatMessages')}</div>
        )}
        {(visibleMsgs.length > 0 || loadingHistory) && (
          <div class="chat-hist-top">
            {loadingHistory ? (
              <span class="chat-hist-hint">
                <span class="tool-spin" /> {t('ui.loadingEarlier')}
              </span>
            ) : canLoadOlder ? (
              <button class="chat-hist-more" onClick={loadOlder}>
                ↑ {t('ui.loadingEarlier')}
              </button>
            ) : (
              <span class="chat-hist-hint mut">· {t('ui.startOfHistory')} ·</span>
            )}
          </div>
        )}
        <RunStream msgs={visibleMsgs} pid={pid} onOpenImage={setLightbox} />
        {/* 我刚发出去、还没从 jsonl 回流的消息（issue #116）：恒在流的末尾，带送达状态 */}
        {pending.map((p) => (
          <div key={p.id} class={`rs-msg user pending ${p.state}`}>
            {p.text || null}
            {p.imgCount > 0 && <div class="rs-msg-note">📎 {t('ui.imageCount', { count: p.imgCount })}</div>}
            <span class="rs-msg-ack">{pendingHint(p.state)}</span>
          </div>
        ))}
      </div>

      <div class="composer">
        {connHint && <div class="conn-hint mut small">{connHint}</div>}
        {activity && (
          <div class="chat-activity">
            <span class="tool-spin" />
            {activity}
          </div>
        )}
        {menuUp && sel && (
          <div class="copts">
            <div class="copt-hd">
              <span>
                ⬇ {t('ui.agentWaitingChoice')}
                {sel.multiSelect && <span class="copt-tag">{t('ui.multipleChoice')}</span>}
              </span>
              {/* 解读按需生成（issue #112）：不点不调 LLM，省额度也不拖慢菜单出现 */}
              <button
                class="copt-why-btn"
                disabled={explaining}
                title={t('ui.explainChoice')}
                onClick={askExplain}
              >
                {explaining ? t('ui.explaining') : `🤔 ${t('ui.explain')}`}
              </button>
            </div>
            {/* 多选表单的按键语义与单选不同（实测）：点/回车只是勾选，→ 才进复核页提交。
                不说清楚的话用户点完以为答过了，实际什么都没提交。 */}
            {sel.multiSelect && (
              <div class="copt-multi-hint">
                {t('ui.multiSelectHelp')}
              </div>
            )}
            {sel.context && <div class="copt-ctx">{sel.context}</div>}
            {explain && explain.optionsSig === sel.options.join('|') && (
              <div class="copt-why">{explain.text}</div>
            )}
            {explainErr && <div class="copt-why bad">{t('ui.explainFailed')}</div>}
            {sel.options.map((o, i) => (
              <button key={i} class={`copt${i === sel.cursorIndex ? ' cur' : ''}`} onClick={() => choose(i)}>
                <span class="copt-n">{i + 1}</span>
                <span class="copt-body">
                  <span class="copt-label">{o}</span>
                  {sel.details?.[i] && <span class="copt-desc">{sel.details[i]}</span>}
                </span>
              </button>
            ))}
            {sel.multiSelect && (
              <button class="copt-submit" onClick={() => send({ type: 'key', key: 'Right' })}>
                → {t('ui.goReview')}
              </button>
            )}
          </div>
        )}
        {staleHint && !sel && <div class="stale-hint">⟳ {t('ui.staleMenu')}</div>}
        {notReady && <div class="not-ready-hint">⏳ {notReady}</div>}
        {!menuUp && gateBar}
        {!menuUp && !gateBar && live && (
          <>
            <ImageAttach
              projectId={pid}
              images={images}
              onChange={setImages}
              compact
              leading={
                <span
                  class={`conn-dot${conn === 'open' ? ' ok' : ''}`}
                  title={conn === 'open' ? t('ui.connected') : connHint ?? ''}
                />
              }
              trailing={
                <div class="ckeys">
                  {KEYS.map(([label, key]) => (
                    <button key={key} class="ckey" onClick={() => send({ type: 'key', key })}>
                      {label}
                    </button>
                  ))}
                </div>
              }
            />
            <div class="crow">
              <textarea
                rows={1}
                value={text}
                placeholder={t('ui.sendPlaceholder')}
                onInput={(e) => {
                  setText(e.currentTarget.value);
                  e.currentTarget.style.height = 'auto';
                  e.currentTarget.style.height = Math.min(120, e.currentTarget.scrollHeight) + 'px';
                }}
              />
              {/* 圆形上箭头发送（#113 iMessage 化）：文案挪进 title/aria，上传中先禁点 */}
              <button
                class="send"
                disabled={!canSend}
                title={uploading ? t('ui.imageUploading') : t('ui.send')}
                aria-label={uploading ? t('ui.imageUploading') : t('ui.send')}
                onClick={sendText}
              >
                {uploading ? '…' : '↑'}
              </button>
            </div>
          </>
        )}
        {!menuUp && !gateBar && !live && (
          <div class="ro-note">📖 {t('ui.readOnlyChat')}</div>
        )}
      </div>
      {lightbox !== null && (
        <ImageLightbox pid={pid} path={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

// ---------- 底部活动指示 ----------

/** 最新消息驱动的「运行状态」文案：正在执行某工具 / 思考中 → 别的返回 null。 */
function activityOf(m: ChatMessage | undefined): string | null {
  if (!m) return null;
  if (m.role === 'tool_use') return tr('ui.toolRunning', { tool: m.title ?? m.tool ?? tr('ui.tool') });
  if (m.role === 'thinking') return tr('ui.thinking');
  return null;
}

function pendingHint(state: PendingMsg['state']): string {
  if (state === 'sent') return tr('ui.pendingSent');
  if (state === 'failed') return tr('ui.pendingFailed');
  return tr('ui.pendingSending');
}
