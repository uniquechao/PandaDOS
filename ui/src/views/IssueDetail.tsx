/**
 * Issue 工作台（2026-07-15 重构：看板→主从工作台的右栏）。
 * 一个 issue 的三视图（tab，2026-07-24 issue #80 提交併入改动）：
 *  - 详情：body / 截图 / 计划(子任务)；
 *  - 执行：执行现场——「对话」(ChatPane 钉住 issue conv，含菜单/输入) 与「原生」(真实代理 tmux) 二选一；
 *  - 改动：本 issue 的完整 git 现场——状态头（分支/提交数/推送态/快照标注）+
 *         ⏳未提交树 + ✅已提交树（ChangeTree 目录树）+ 提交记录区；
 *         点文件 → 范围内/工作区单文件 diff，点提交 → 提交详情（复用 Git 页组件）。
 *         范围：固定/共享分支取 impl_base 起点 start..tip，否则 base..branch。
 * 卡点操作（GateBar：plan/merge review、blocked、clarifying、pending 启动）：
 *  - 执行 tab 落在 ChatPane 底部拇指区（承接 CC 菜单同一操作区）；
 *  - 其余 tab 作为工作台底部常驻条 —— 让开发者「看着 diff/提交就地拍板」。
 * embedded=true：作为看板右栏嵌入（无返回键，左栏列表即导航）；
 * embedded=false：窄屏整页（顶部返回键回项目看板）。
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { api, ApiError, getProjectExecutorAgents, setIssueAutoApprove } from '../lib/api';
import { nav } from '../lib/router';
import { timeAgo, tryJson } from '../lib/fmt';
import { onLazyLoadError } from '../lib/updatePrompt';
import { ChatPane } from '../components/ChatPane';
import type { TermStatus } from '../components/TermPane';
import { AutoApproveSwitch } from '../components/AutoApproveSwitch';
import { reconcileAgent } from '../components/AgentPicker';
import { NativeModeSwitch, type NativeMode } from '../components/NativeModeSwitch';
import { canEditSubtask, ExecProgress, execProgressState, stepGlyph } from '../components/ExecProgress';
import type {
  AgentKind,
  AutoApproveLevel,
  ConversationSegment,
  Gate,
  Issue,
  IssueCategory,
  IssueDetail,
  IssueEvent,
  IssueGitInfo,
  IssuePushState,
  MergeGatePayload,
  PlanGatePayload,
  ProjectModule,
  Subtask,
} from '../lib/types';
import { CatBadge, ModelBadge, StatusBadge, WaitingBadge } from '../components/badges';
import { useConvModel } from '../lib/useConvModel';
import { clarifyPanelState, retryPlan } from '../lib/issueStatus';
import { toApprovalLog, type ApprovalLogRow } from '../lib/approvalLog';
import { Loading } from '../components/Loaders';
import { Modal } from '../components/Modal';
import { ModuleSelect } from '../components/ModuleSelect';
import { ImageAttach, type AttachedImage } from '../components/ImageAttach';
import {
  IssueGitBranchFields,
  IssueGitBranchSummary,
} from '../components/IssueGitBranchFields';
import { ImageLightbox } from '../components/ImageLightbox';
import { ImgThumb } from '../components/ImgThumb';
import { gitImageUrls } from '../components/GitImagePreview';
import {
  CommitPanel,
  DiffContent,
  PathText,
  PlusMinus,
  RefBadges,
  StatusChip,
  sumFiles,
  useFileDiff,
} from './Git';
import { ChangeTree } from '../components/ChangeTree';
import { dedupWorktree, type ChangeLeaf } from '../lib/changetree';
import { ListSplitter } from '../components/ListSplitter';
import { useTreeWidth } from '../lib/treewidth';
import { useWide } from '../lib/useWide';
import {
  issueGitBranchPayload,
  type IssueGitBranchValue,
} from '../lib/issuegitbranch';
import { tr } from '../i18n/runtime';

const POLL_MS = 5000;

type WbTab = 'detail' | 'exec' | 'changes';

/**
 * 一个 issue 的工作台。embedded=true 作看板右栏（无返回键）；
 * embedded=false 为窄屏整页（顶部返回键回项目看板，路由 #/p/:pid/issue/:iid 走这条）。
 */
export function IssueWorkbench({
  pid,
  iid,
  embedded = false,
}: {
  pid: number;
  iid: number;
  embedded?: boolean;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [events, setEvents] = useState<IssueEvent[]>([]);
  const [err, setErr] = useState('');
  const [actErr, setActErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [tab, setTab] = useState<WbTab>('detail');
  const [editing, setEditing] = useState(false);
  const [clarifyOpen, setClarifyOpen] = useState(false);
  // 当前在灯箱里查看的截图相对路径（null=未打开）；详情/编辑里的缩略图点击时设置。
  const [lightbox, setLightbox] = useState<string | null>(null);
  // 5s 轮询的定时器 id：存 ref，便于遇 404/403 时在 load() 的 catch 里就地停掉（轮询不会自愈）。
  const pollRef = useRef<number | null>(null);

  const stopPoll = (): void => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const load = (): void => {
    api<IssueDetail>(`/api/projects/${pid}/issues/${iid}`)
      .then((d) => {
        setDetail(d);
        setErr('');
      })
      .catch((e: Error) => {
        // 404/403：issue 不在本项目 / 无权（数据缺失，轮询不会好）——停轮询 + 友好提示。
        // 网络错误 / 5xx（可能只是临时）——保持轮询，显示原始错误。
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          stopPoll();
          setErr(tr('issue.notFound'));
        } else {
          setErr(e.message);
        }
      });
    // events 随详情一起打；轮询一停，两者都不再重复请求。
    api<IssueEvent[]>(`/api/projects/${pid}/issues/${iid}/events`)
      .then(setEvents)
      .catch(() => {});
  };

  useEffect(() => {
    setDetail(null);
    setEvents([]);
    setActErr('');
    setNote('');
    setEditing(false);
    setLightbox(null); // 切换 issue 时收起灯箱
    load();
    pollRef.current = window.setInterval(load, POLL_MS);
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, iid]);

  const issue = detail?.issue ?? null;

  // 执行会话正在用的模型（issue #109）：只读展示，没开跑（无 convId）或探不到就不显示
  const model = useConvModel(pid, issue?.convId ?? null);

  // 本 issue 的 git 现场：进详情就预取（角标常显，不等点开 tab）；
  // issue 状态推进或进入改动 tab 时刷新（刷新键复合两者）。
  const needGit = tab === 'changes';
  const git = useIssueGit(pid, iid, issue !== null, `${issue?.status ?? ''}|${needGit ? 1 : 0}`);

  // 改动角标 = 已提交 ∪ 未提交 触碰的文件数（去重）——执行中未 commit 也能看到改动规模
  const changesN = useMemo(() => {
    if (!git.info) return 0;
    const paths = new Set(git.info.files.map((f) => f.path));
    for (const c of git.info.worktree ?? []) paths.add(c.path);
    return paths.size;
  }, [git.info]);

  const waitingGate: Gate | null = useMemo(() => {
    if (!detail || !issue) return null;
    const kind = issue.status === 'plan_review' ? 'plan' : issue.status === 'merge_review' ? 'merge_review' : null;
    if (!kind) return null;
    return detail.gates.find((g) => g.status === 'waiting' && g.kind === kind) ?? null;
  }, [detail, issue]);

  /** blocked 原因：优先 issue.note，否则从事件记录最后一次 to=blocked 的 transition 里挖 */
  const blockedReason = useMemo(() => {
    if (issue?.note) return issue.note;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.kind !== 'transition') continue;
      const d = tryJson<{ to?: string; note?: string }>(ev.dataJson);
      if (d?.to === 'blocked') return d.note ?? tr('issue.noReason');
    }
    return tr('issue.noReason');
  }, [issue, events]);

  /** 弹窗自动批复记录（issue #91）：events 已在手，纯本地归约，不额外请求 */
  const approvals = useMemo(() => toApprovalLog(events), [events]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActErr('');
    try {
      await fn();
      setNote('');
      load();
    } catch (x) {
      setActErr(x instanceof ApiError ? x.message : String(x));
    }
    setBusy(false);
  };

  const post = (path: string, body?: unknown) => act(() => api(path, 'POST', body ?? {}));

  /**
   * 改本 issue 的自动批准档位（#108）：先乐观改本地（切换钮立刻响应，不等一个来回），
   * 失败只报错不回滚——5s 轮询下一拍就会把服务端真值刷回来。
   */
  const changeAutoApprove = (level: AutoApproveLevel): void => {
    setDetail((d) => (d ? { ...d, issue: { ...d.issue, autoApprove: level } } : d));
    void setIssueAutoApprove(pid, iid, level).catch((e: unknown) =>
      setActErr(e instanceof ApiError ? e.message : String(e)),
    );
  };

  /** 复活重跑（#93）：二次确认必须点破「立刻开跑」——想改需求得先改完再点，落 pending 就没窗口了 */
  const reopen = (): void => {
    const plan = retryPlan('cancelled', false);
    if (!confirm(tr('issue.runAgainConfirm', { hint: plan.hint }))) return;
    void post(`/api/projects/${pid}/issues/${iid}/reopen`);
  };

  const approve = (): void => {
    if (!waitingGate) return;
    void post(`/api/projects/${pid}/gates/${waitingGate.id}/approve`);
  };
  const reject = (): void => {
    if (!waitingGate) return;
    if (!note.trim()) {
      setActErr(tr('issue.rejectionRequired'));
      return;
    }
    void post(`/api/projects/${pid}/gates/${waitingGate.id}/reject`, { note: note.trim() });
  };
  const retryGate = (): void => {
    void post(`/api/projects/${pid}/issues/${iid}/retry-gate`);
  };

  const remove = (): void => {
    if (!confirm(tr('issue.deleteConfirm', { id: iid }))) return;
    void act(async () => {
      await api(`/api/projects/${pid}/issues/${iid}`, 'DELETE');
      nav(`/p/${pid}`);
    });
  };

  const images = tryJson<string[]>(issue?.imagesJson) ?? [];
  // 顶部澄清面板派生（lib/issueStatus.clarifyPanelState，纯函数便于单测；事件溯源、跨状态）：
  //  - questions：最近一批 clarify_questions，答后（clarified）/超时（clarify_timeout）收起，
  //    新一轮问题事件自动覆盖旧问题重新展开；创建时问题开跑后仍显示到回答为止（spec 第 5 点）；
  //  - analyzing：创建/答澄清/改需求正文触发的（重）分析在途——澄清面板与「代理反馈」区显示
  //    「正在重新分析」占位（否则答完面板无声消失、反馈几分钟后才更新，很困惑）；
  //  - visible：问题/等待/待答标记/分析中任一即展开；终态一律收起。随既有 5s 轮询刷新。
  const clarify = useMemo(
    () =>
      clarifyPanelState(issue?.status ?? 'done', events, {
        awaitingClarify: !!issue?.awaitingClarify,
        clarifyPending: !!issue?.clarifyPending,
      }),
    [issue, events],
  );
  const clarifyQuestions = clarify.questions;
  const analyzing = clarify.analyzing;

  const subs = detail?.subtasks ?? [];
  const doneN = subs.filter((s) => s.done).length;

  const saveSubtask = async (index: number, text: string): Promise<void> => {
    try {
      const result = await api<{ ok: true; index: number; subtask: Subtask }>(
        `/api/projects/${pid}/issues/${iid}/subtasks/${index}`,
        'PATCH',
        { text },
      );
      setDetail((current) =>
        current
          ? {
              ...current,
              subtasks: current.subtasks.map((subtask, i) => (i === result.index ? result.subtask : subtask)),
            }
          : current,
      );
    } catch (error) {
      load();
      throw error;
    }
  };

  const closed = issue !== null && ['done', 'cancelled'].includes(issue.status);
  const needGateBar =
    issue !== null &&
    ['plan_review', 'merge_review', 'blocked', 'clarifying', 'pending'].includes(issue.status);
  const gateBar: JSX.Element | null = closed ? (
    issue!.status === 'cancelled' ? (
      // 取消不是死路（#93）：改完需求可以就地复活重跑，不用重开一条丢掉历史与模块绑定
      <div class="ro-note reopen-bar">
        <span class="reopen-txt">
          🚫 {tr('issue.cancelledCanRerun')}
          <span class="mut small"> {tr('issue.queueImmediately')}</span>
        </span>
        <button class="btn sm" disabled={busy} onClick={() => setEditing(true)}>
          ✏️ {tr('issue.editAction')}
        </button>
        <button class="btn sm primary" disabled={busy} onClick={reopen}>
          ▶ {tr('issue.runAgain')}
        </button>
      </div>
    ) : (
      <div class="ro-note">✅ {tr('issue.completedHistory')}</div>
    )
  ) : needGateBar ? (
    <GateBar
      issue={issue!}
      gate={waitingGate}
      note={note}
      setNote={setNote}
      busy={busy}
      actErr={actErr}
      blockedReason={blockedReason}
      onApprove={approve}
      onReject={reject}
      onRetry={retryGate}
      onStart={() => void post(`/api/projects/${pid}/issues/${iid}/start`)}
      onCancel={() => {
        if (confirm(tr('issue.cancelConfirm'))) void post(`/api/projects/${pid}/issues/${iid}/cancel`);
      }}
      onUnblock={() => void post(`/api/projects/${pid}/issues/${iid}/unblock`)}
    />
  ) : null;

  // 顶部常驻澄清提示条：有未回答的澄清问题（创建时/执行中）、代理在等你确认、或正在（重新）分析
  // 时展开；终态不显示。只占一行，点击弹窗回答（#103——原先整面板常驻会把执行 tab 挤扁，
  // 长问题清单还被 30vh 裁剪看着像没显示全）；answered/timeout 后 visible 消失，条与弹窗一起收起。
  const clarifyPanel: JSX.Element | null =
    issue !== null && clarify.visible ? (
      <>
        <ClarifyBar
          awaiting={!!issue.awaitingClarify}
          analyzing={analyzing}
          count={clarifyQuestions.length}
          onOpen={() => setClarifyOpen(true)}
        />
        {clarifyOpen && (
          <ClarifyPanel
            questions={clarifyQuestions}
            text={clarify.text}
            awaiting={!!issue.awaitingClarify}
            analyzing={analyzing}
            busy={busy}
            title={issue.title}
            body={issue.body}
            onClose={() => setClarifyOpen(false)}
            onSubmit={(answer) => {
              void post(`/api/projects/${pid}/issues/${iid}/clarify`, { answer });
              setClarifyOpen(false);
            }}
          />
        )}
      </>
    ) : null;

  return (
    <div class="fullcol wb">
      {/* 头部并成一条自动折行（#105）：宽屏 标题+徽标+动作 一行放下，窄屏徽标折到下一行；
          标题保底宽度不被徽标挤没，动作钮恒靠右成组 */}
      <div class="id-head">
        <div class="id-head-line">
          {!embedded && (
            <button class="back" onClick={() => nav(`/p/${pid}`)}>
              ‹
            </button>
          )}
          {issue && <span class="mut small mono">#{issue.id}</span>}
          <span class="btitle id-title">{issue ? issue.title : `issue #${iid}`}</span>
          {issue && (
            <>
              {issue.pinnedTs != null && issue.status === 'pending' && <span class="badge b-amber">📌 {tr('issue.pinned')}</span>}
              <CatBadge cat={issue.category} />
              <StatusBadge status={issue.status} awaitingClarify={issue.awaitingClarify} />
              {issue.waitingInput && <WaitingBadge />}
              {subs.length > 0 && (
                <span class="badge b-green">
                  {doneN}/{subs.length}
                </span>
              )}
              {issue.module && <span class="badge b-gray">{issue.module}</span>}
              {issue.implMode === 'team' && <span class="badge b-purple">{tr('issue.team')}</span>}
              {issue.agent === 'codex' && <span class="badge b-ai">codex</span>}
              <ModelBadge model={model} />
              {issue.branch && <span class="badge b-gray mono">⎇ {issue.branch}</span>}
              <span class="mut small id-creator">{tr('issue.creator', { name: issue.createdByName || '—' })}</span>
            </>
          )}
          <div class="id-acts">
            {issue && ['planning', 'implementing', 'testing', 'merging'].includes(issue.status) && (
              <button
                class="btn sm danger ghost"
                disabled={busy}
                onClick={() => {
                  if (confirm(tr('issue.cancelConfirm'))) void post(`/api/projects/${pid}/issues/${iid}/cancel`);
                }}
              >
                {tr('issue.cancel')}
              </button>
            )}
            {issue && issue.status === 'pending' && (
              <button
                class={`btn sm${issue.pinnedTs != null ? ' primary' : ''}`}
                disabled={busy}
                title={tr('issue.pinHint')}
                onClick={() => void post(`/api/projects/${pid}/issues/${iid}/pin`, { pinned: issue.pinnedTs == null })}
              >
                {issue.pinnedTs != null ? `📌 ${tr('board.unpin')}` : `📌 ${tr('issue.pinned')}`}
              </button>
            )}
            {issue && issue.status === 'pending' && (
              <button class="btn sm" disabled={busy} onClick={() => setEditing(true)}>
                {tr('issue.edit')}
              </button>
            )}
            {issue && ['pending', 'done', 'blocked', 'cancelled'].includes(issue.status) && (
              <button class="btn sm danger ghost" onClick={remove}>
                {tr('issue.delete')}
              </button>
            )}
          </div>
        </div>
        {err && <div class="err">{err}</div>}
      </div>

      {/* 顶部常驻澄清提示条（tab 栏之上，任何 tab 都看得到；点击弹窗回答，答完自动收起） */}
      {clarifyPanel}

      {/* iOS 分段控件（#113）：外层类名保留（测试/布局锚点），三枚 tab 收进 .seg 轨道 */}
      <div class="id-tabs wb-tabs">
        <div class="seg wb-tabseg">
          <button class={`seg-btn${tab === 'detail' ? ' on' : ''}`} onClick={() => setTab('detail')}>
            {tr('issue.detailsTab')}
          </button>
          <button class={`seg-btn${tab === 'exec' ? ' on' : ''}`} onClick={() => setTab('exec')}>
            {tr('issue.executionTab')}
          </button>
          <button class={`seg-btn${tab === 'changes' ? ' on' : ''}`} onClick={() => setTab('changes')}>
            {tr('issue.changesTab')}{changesN > 0 ? `·${changesN}` : ''}
          </button>
        </div>
      </div>

      <div class="wb-body">
        {!issue && !err && <Loading />}
        {issue && tab === 'detail' && (
          <DetailTab
            issue={issue}
            pid={pid}
            images={images}
            subs={subs}
            doneN={doneN}
            analyzing={analyzing}
            approvals={approvals}
            onOpenImage={setLightbox}
            onSaveSubtask={saveSubtask}
          />
        )}
        {issue && tab === 'exec' && (
          <ExecTab
            key={iid}
            pid={pid}
            issue={issue}
            conversationSegments={detail?.conversationSegments ?? []}
            subs={subs}
            gateBar={gateBar}
            busy={busy}
            onAutoApprove={changeAutoApprove}
            onTerminate={() => {
              if (confirm(tr('issue.terminateConfirm'))) void post(`/api/projects/${pid}/issues/${iid}/cancel`);
            }}
            onUnblock={() => void post(`/api/projects/${pid}/issues/${iid}/unblock`)}
          />
        )}
        {issue && tab === 'changes' && (
          <IssueChangesTab key={iid} pid={pid} iid={iid} info={git.info} err={git.err} onRefresh={git.refresh} />
        )}
      </div>

      {/* 执行 tab 的卡点条在 ChatPane 内；其余 tab 常驻底部，看着 diff/提交就地拍板 */}
      {tab !== 'exec' && gateBar}

      {editing && issue && (
        <EditIssueModal
          pid={pid}
          issue={issue}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
          }}
          onOpenImage={setLightbox}
        />
      )}

      {lightbox !== null && (
        <ImageLightbox pid={pid} path={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

// ---------- 编辑 issue（仅「提交后未运行」的 pending 可直接改内容） ----------

function EditIssueModal({
  pid,
  issue,
  onClose,
  onSaved,
  onOpenImage,
}: {
  pid: number;
  issue: Issue;
  onClose: () => void;
  onSaved: () => void;
  onOpenImage: (path: string) => void;
}) {
  const [title, setTitle] = useState(issue.title);
  const [body, setBody] = useState(issue.body ?? '');
  const [category, setCategory] = useState<IssueCategory>(issue.category);
  const [module, setModule] = useState(issue.module === '未分类' ? '' : issue.module);
  const [modules, setModules] = useState<ProjectModule[]>([]);
  const [agent, setAgent] = useState<AgentKind>(issue.agent);
  const [supportedAgents, setSupportedAgents] = useState<AgentKind[]>([]);
  const [team, setTeam] = useState(issue.implMode === 'team');
  const [gitBranch, setGitBranch] = useState<IssueGitBranchValue>({
    targetBranch: issue.targetBranch ?? '',
    sourceRef: issue.sourceRef ?? '',
  });
  const [gitBranchLoading, setGitBranchLoading] = useState(true);
  // 已上传的旧截图（rel path）：可逐张删除；新加的图走 ImageAttach（本地缩略图 + 后台上传）
  const [existing, setExisting] = useState<string[]>(() => tryJson<string[]>(issue.imagesJson) ?? []);
  const [added, setAdded] = useState<AttachedImage[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // pending 但已绑过对话（unblock 回 pending）不能换代理——对话文件格式已定，换即断上下文
  const selectedModule = modules.find((m) => m.slug === module.trim() || m.displayName === module.trim());
  const canChangeAgent = !issue.convId && !selectedModule;
  const effectiveAgent = selectedModule?.agent ?? agent;
  const agentUnavailable = !supportedAgents.includes(effectiveAgent);
  // 有新图还在上传（rel 未回）→ 禁存，避免提交 null 丢图
  const uploading = added.some((im) => im.rel === null && !im.error);
  const addSlots = Math.max(0, 6 - existing.length);

  useEffect(() => {
    void api<{ modules: ProjectModule[] }>(`/api/projects/${pid}/modules`)
      .then((r) => setModules(r.modules))
      .catch(() => setModules([]));
  }, [pid]);
  useEffect(() => {
    void getProjectExecutorAgents(pid)
      .then((agents) => {
        setSupportedAgents(agents);
        const next = reconcileAgent(agent, agents);
        if (next && canChangeAgent) setAgent(next);
      })
      .catch(() => setSupportedAgents([]));
  }, [pid]);

  const submit = async (): Promise<void> => {
    if (!title.trim() || busy || gitBranchLoading || uploading || agentUnavailable) return;
    setBusy(true);
    setErr('');
    try {
      const images = [...existing, ...added.map((im) => im.rel).filter((r): r is string => r !== null)];
      await api(`/api/projects/${pid}/issues/${issue.id}`, 'PATCH', {
        title: title.trim(),
        body: body.trim() || null,
        category,
        ...(selectedModule
          ? { moduleId: selectedModule.id }
          : { moduleName: module.trim() || 'general-work' }),
        implMode: team ? 'team' : 'seq',
        ...(canChangeAgent ? { agent } : {}),
        ...issueGitBranchPayload(gitBranch),
        images,
      });
      onSaved();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  return (
    <Modal title={tr('issue.editTitle', { id: issue.id })} onClose={onClose}>
      <div class="formcol">
        <label class="field">
          {tr('issue.titleField')}
          <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} placeholder={tr('board.whatToDo')} />
        </label>
        <label class="field">
          {tr('issue.bodyField')}
          <textarea
            rows={4}
            value={body}
            onInput={(e) => setBody(e.currentTarget.value)}
            placeholder={tr('board.issueBodyPlaceholder')}
          />
        </label>
        <div class="row">
          <label class="field grow">
            {tr('issue.categoryField')}
            <select value={category} onChange={(e) => setCategory(e.currentTarget.value as IssueCategory)}>
              <option value="task">{tr('status.categoryTask')}</option>
              <option value="design">{tr('status.categoryDesign')}</option>
              <option value="debug">DEBUG</option>
            </select>
          </label>
          <label class="field grow">
            {tr('issue.moduleField')}
            <ModuleSelect
              modules={modules}
              value={module}
              onChange={(value) => {
                setModule(value);
                const picked = modules.find((m) => m.slug === value.trim() || m.displayName === value.trim());
                if (picked) setAgent(picked.agent);
              }}
              placeholder={tr('board.autoModule')}
            />
          </label>
        </div>
        <label class="field">
          {tr('issue.agentField')}
          <select
            value={selectedModule?.agent ?? agent}
            disabled={!canChangeAgent}
            onChange={(e) => setAgent(e.currentTarget.value as AgentKind)}
          >
            {supportedAgents.map((a) => (
              <option key={a} value={a}>{a === 'claude' ? 'Claude Code' : 'Codex'}</option>
            ))}
          </select>
          {!canChangeAgent && (
            <span class="mut small">
              {selectedModule ? tr('board.moduleAgent', { agent: selectedModule.agent }) : tr('issue.conversationAgentLocked')}
            </span>
          )}
          {agentUnavailable && <span class="err small">{tr('board.agentUnavailable')}</span>}
        </label>
        <IssueGitBranchFields
          pid={pid}
          value={gitBranch}
          onChange={setGitBranch}
          onLoadingChange={setGitBranchLoading}
        />
        <label class="chkrow">
          <input type="checkbox" checked={team} onChange={(e) => setTeam(e.currentTarget.checked)} />
          {tr('issue.teamMode')}
        </label>
        {existing.length > 0 && (
          <div class="id-imgs">
            {existing.map((p, i) => (
              <ImgThumb
                key={p}
                pid={pid}
                path={p}
                onOpen={onOpenImage}
                onRemove={() => setExisting((prev) => prev.filter((_, k) => k !== i))}
              />
            ))}
          </div>
        )}
        <ImageAttach projectId={pid} images={added} onChange={setAdded} max={addSlots} />
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          {tr('ui.cancel')}
        </button>
        <button
          class="btn primary"
          disabled={busy || gitBranchLoading || uploading || !title.trim() || agentUnavailable}
          onClick={submit}
        >
          {busy
            ? tr('ui.saving')
            : gitBranchLoading
              ? tr('board.readingBranches')
              : uploading
                ? tr('ui.imageUploading')
                : tr('ui.save')}
        </button>
      </div>
    </Modal>
  );
}

// ---------- 本 issue 的 git 现场（提交/改动共用一次拉取，详情加载后即预取供角标常显） ----------

function useIssueGit(
  pid: number,
  iid: number,
  enabled: boolean,
  /** 刷新键：值变化即重拉（调用方复合 issue 状态 + 是否在 提交/改动 tab） */
  refreshKey: string,
): { info: IssueGitInfo | null; err: string; refresh: () => void } {
  const [info, setInfo] = useState<IssueGitInfo | null>(null);
  const [err, setErr] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setInfo(null);
    setErr('');
  }, [pid, iid]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api<IssueGitInfo>(`/api/projects/${pid}/issues/${iid}/git`)
      .then((d) => {
        if (alive) {
          setInfo(d);
          setErr('');
        }
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => {
      alive = false;
    };
  }, [pid, iid, enabled, refreshKey, nonce]);

  return { info, err, refresh: () => setNonce((n) => n + 1) };
}

/** 推送状态 → 展示文案与徽标色（语义同后端 IssuePushState） */
function pushBadge(p: IssuePushState): { text: string; cls: string } {
  switch (p.state) {
    case 'pushed':
      return { text: tr('issue.pushed'), cls: 'b-green' };
    case 'ahead':
      return { text: tr('issue.aheadOrigin', { count: p.n }), cls: 'b-amber' };
    case 'unpushed':
      return { text: tr('issue.notPushed'), cls: 'b-amber' };
    default:
      return { text: tr('issue.noRemote'), cls: 'b-gray' };
  }
}

/** 状态段（行内片段，并入头条单行）：N 条提交 · 推送状态 · 已提交文件数/增删行 · 工作区未提交数（活跃时）· 快照来源标注 */
function IssueGitStatus({ info }: { info: IssueGitInfo }) {
  const wtN = info.worktree?.length ?? 0;
  const pb = info.push ? pushBadge(info.push) : null;
  const totals = sumFiles(info.files);
  return (
    <>
      <span class="mut small">{tr('issue.commitCount', { count: info.ahead })}</span>
      {pb && <span class={`badge ${pb.cls}`}>{pb.text}</span>}
      {info.files.length > 0 && (
        <span class="mut small">
          {tr('issue.fileCount', { count: info.files.length })}{' '}
          {(totals.adds > 0 || totals.dels > 0) && <PlusMinus adds={totals.adds} dels={totals.dels} />}
        </span>
      )}
      {info.worktree !== undefined && wtN > 0 && <span class="mut small">{tr('issue.uncommittedFiles', { count: wtN })}</span>}
      {info.source === 'snapshot' && <span class="badge b-gray">{tr('issue.snapshot')}</span>}
    </>
  );
}

/** 改动 tab 状态头单行（#101 紧凑化）：分支 → 基线 + 状态段 + 刷新钮，窄屏靠 flex-wrap 折行 */
function IssueGitHead({ info, onRefresh }: { info: IssueGitInfo; onRefresh: () => void }) {
  return (
    <div class="wb-githead">
      <span class="badge b-blue mono">⎇ {info.branch}</span>
      {/* 固定/共享分支：改动是本 issue 自己的提交（自起点 sha 起），而非整条分支相对 base */}
      {info.startSha ? (
        <span class="mut small">
          {tr('issue.sinceCommit', { sha: info.startSha.slice(0, 7) })}
        </span>
      ) : (
        <span class="mut small">→ {info.base}</span>
      )}
      <IssueGitStatus info={info} />
      <button class="linkbtn" style={{ marginLeft: 'auto' }} onClick={onRefresh}>
        ↻ {tr('ui.refresh')}
      </button>
    </div>
  );
}

// ---------- 详情 tab ----------

function DetailTab({
  issue,
  pid,
  images,
  subs,
  doneN,
  analyzing,
  approvals,
  onOpenImage,
  onSaveSubtask,
}: {
  issue: Issue;
  pid: number;
  images: string[];
  subs: Subtask[];
  doneN: number;
  analyzing: boolean;
  approvals: ApprovalLogRow[];
  onOpenImage: (path: string) => void;
  onSaveSubtask: (index: number, text: string) => Promise<void>;
}) {
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const cancelSubtaskEdit = (): void => {
    if (saving) return;
    setEditIndex(null);
    setDraft('');
    setEditError('');
  };

  const saveSubtaskText = async (): Promise<void> => {
    if (editIndex === null || saving) return;
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    setEditError('');
    try {
      await onSaveSubtask(editIndex, text);
      setEditIndex(null);
      setDraft('');
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="id-scroll wb-detail">
      <IssueGitBranchSummary issue={issue} />
      {issue.body && <div class="id-body">{issue.body}</div>}
      {images.length > 0 && (
        <div class="id-imgs">
          {images.map((p) => (
            <ImgThumb key={p} pid={pid} path={p} onOpen={onOpenImage} />
          ))}
        </div>
      )}
      {issue.resultSummary && (
        <div class="id-agentblock">
          <div class="h2" style={{ margin: '2px 0 4px' }}>
            📋 {tr('issue.executionSummary')}{issue.status === 'blocked' ? tr('issue.blockedProgress') : ''}
          </div>
          <div class="gate-box">{issue.resultSummary}</div>
        </div>
      )}
      {(issue.clarifyFeedback || analyzing) && (
        <div class="id-agentblock">
          <div class="h2" style={{ margin: '2px 0 4px' }}>
            🤖 {tr('issue.agentFeedback')}
          </div>
          {analyzing && (
            <div class="mut small" style={{ margin: '0 0 4px' }}>
              🔄 {tr('issue.agentReanalyzingInline')}
              {issue.clarifyFeedback ? tr('issue.autoAfterDone') : tr('issue.showAfterDone')}
            </div>
          )}
          {issue.clarifyFeedback && <div class="gate-box">{issue.clarifyFeedback}</div>}
        </div>
      )}
      {subs.length > 0 && (
        <div class="plan">
          <div class="h2" style={{ margin: '2px 0 4px' }}>
            {tr('issue.planProgress', { done: doneN, total: subs.length })}
          </div>
          {/* 与执行顶栏进度链同一状态源/同一套配色（#104）：done/cur/blocked/cancelled 圆点齐平 */}
          {execProgressState(subs, issue.subIndex, issue.status).steps.map((step, index) => {
            const editable = canEditSubtask(subs[index]!, index, issue.subIndex, issue.status, issue.implMode);
            const editingSubtask = editIndex === index && editable;
            return (
              <div key={step.n} class={`plan-i ${step.state}`}>
                <span class={`ck ep-n ${step.state}`}>{stepGlyph(step)}</span>
                {editingSubtask ? (
                  <form
                    class="plan-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveSubtaskText();
                    }}
                  >
                    <input
                      autoFocus
                      maxLength={500}
                      aria-label={tr('issue.subtaskText')}
                      value={draft}
                      onInput={(event) => setDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void saveSubtaskText();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelSubtaskEdit();
                        }
                      }}
                    />
                    <div class="plan-editor-actions">
                      <button class="btn sm primary" type="submit" disabled={saving || !draft.trim()}>
                        {saving ? tr('ui.saving') : tr('ui.save')}
                      </button>
                      <button class="btn sm ghost" type="button" disabled={saving} onClick={cancelSubtaskEdit}>
                        {tr('ui.cancel')}
                      </button>
                    </div>
                    {editError && <div class="err small plan-edit-error">{editError}</div>}
                  </form>
                ) : (
                  <>
                    <span class="tx">{step.text}</span>
                    {editable && (
                      <button
                        class="btn sm ghost plan-edit"
                        type="button"
                        title={tr('issue.editSubtask', { number: step.n })}
                        aria-label={tr('issue.editSubtask', { number: step.n })}
                        onClick={() => {
                          setEditIndex(index);
                          setDraft(step.text);
                          setEditError('');
                        }}
                      >
                        {tr('issue.edit')}
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <ApprovalLog rows={approvals} />
    </div>
  );
}

/**
 * 弹窗自动批复记录（issue #91）：执行中每个权限/选择弹窗是被哪条策略点掉的、还是交了人工，
 * 一眼可查。没有任何弹窗记录时整块不渲染，不给常规 issue 添噪音。
 */
function ApprovalLog({ rows }: { rows: ApprovalLogRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div class="id-agentblock">
      <div class="h2" style={{ margin: '2px 0 4px' }}>
        🤖 {tr('issue.approvalLog', { count: rows.length })}
      </div>
      {rows.map((r) => (
        <div key={r.id} class="apv-i">
          <span class={`apv-tag${r.auto ? ' auto' : ' esc'}`}>{r.auto ? tr('issue.automatic') : tr('issue.escalated')}</span>
          {r.ruleLabel && <span class="apv-rule">{r.ruleLabel}</span>}
          <span class="apv-detail">{r.detail}</span>
          <span class="mut small apv-ts">{timeAgo(r.ts)}</span>
          {r.context && <span class="mut small apv-ctx">{r.context}</span>}
        </div>
      ))}
    </div>
  );
}

// ---------- 执行 tab（对话 / 原生 二选一） ----------

function ExecTab({
  pid,
  issue,
  conversationSegments,
  subs,
  gateBar,
  busy,
  onAutoApprove,
  onTerminate,
  onUnblock,
}: {
  pid: number;
  issue: Issue;
  conversationSegments: ConversationSegment[];
  /** 子任务计划（详情接口返回）：顶栏进度链用，空数组则整块不渲染 */
  subs: { text: string; done: boolean }[];
  gateBar: JSX.Element | null;
  busy: boolean;
  /** 改自动批准档位（父层乐观更新 + 调接口） */
  onAutoApprove: (level: AutoApproveLevel) => void;
  /** 终止：取消整个 issue（带二次确认，父层实现） */
  onTerminate: () => void;
  /** 受阻重试：解除阻塞重跑（父层实现） */
  onUnblock: () => void;
}) {
  const [mode, setMode] = useState<NativeMode>('chat');
  // 已收尾（done/cancelled）不会再有弹窗，档位锁死（#111）。受阻(blocked)仍可改——重试前调档正是它的用法
  const aaLocked = issue.status === 'done' || issue.status === 'cancelled';
  // 顶栏行首插槽：切换钮 + 子任务进度链（对话/原生两种模式共用同一段，见 ExecNative）
  const seg = (
    <>
      <NativeModeSwitch mode={mode} onChange={setMode} />
      <AutoApproveSwitch
        level={issue.autoApprove ?? 'medium'}
        onChange={onAutoApprove}
        disabled={aaLocked}
        disabledHint={tr('issue.approvalLocked')}
      />
      <ExecProgress subs={subs} subIndex={issue.subIndex} status={issue.status} />
    </>
  );
  return (
    <div class="wb-exec">
      <div class="wb-exec-body">
        {mode === 'chat' ? (
          issue.convId ? (
            <ChatPane
              pid={pid}
              conv={issue.convId}
              gateBar={gateBar}
              headerLeading={seg}
              runCtl={{
                status: issue.status,
                busy,
                onTerminate,
                onUnblock,
              }}
              conversationSegments={conversationSegments}
              currentIssueId={issue.id}
            />
          ) : (
            <div class="fullcol">
              <div class="runctl">{seg}</div>
              <div class="empty" style={{ flex: 1 }}>
                {tr('issue.noConversation')}
              </div>
              {gateBar}
            </div>
          )
        ) : (
          <ExecNative pid={pid} issue={issue} seg={seg} />
        )}
      </div>
    </div>
  );
}

type TermPaneComp = typeof import('../components/TermPane').TermPane;

function nativeUnavailableReason(issue: Issue): string | null {
  if (!issue.convId) return tr('issue.nativeNotStarted');
  if (issue.status === 'done' || issue.status === 'cancelled' || issue.status === 'blocked') {
    return tr('issue.nativeEnded');
  }
  if (!['planning', 'implementing', 'testing'].includes(issue.status)) {
    return tr('issue.nativeInactive');
  }
  return null;
}

/** 当前 issue 的真实代理 tmux（xterm 懒加载）；绝不回退到项目 Bash 或共享模块里的其他 issue。 */
function ExecNative({ pid, issue, seg }: { pid: number; issue: Issue; seg: JSX.Element }) {
  const [Comp, setComp] = useState<TermPaneComp | null>(null);
  const [st, setSt] = useState<TermStatus>('connecting');
  const unavailable = nativeUnavailableReason(issue);
  useEffect(() => {
    if (unavailable) return;
    import('../components/TermPane')
      .then((m) => setComp(() => m.TermPane))
      .catch(onLazyLoadError);
  }, [unavailable]);
  return (
    <div class="wb-term">
      <div class="runctl">
        {seg}
        <span class="rc-status mut small">
          {unavailable ? tr('issue.nativeUnavailable') : st === 'open' ? `🟢 ${tr('ui.connected')}` : st === 'connecting' ? tr('ui.connecting') : st === 'exit' ? tr('view.ended') : tr('ui.disconnected')}
        </span>
      </div>
      <div class="wb-term-body">
        {unavailable ? (
          <div class="empty">{unavailable}</div>
        ) : Comp ? (
          <Comp
            pid={pid}
            target={{ kind: 'issue', issueId: issue.id }}
            onStatus={setSt}
            closedMessage={tr('issue.nativeSessionUnavailable')}
          />
        ) : (
          <div class="empty">{tr('issue.loadingNative')}</div>
        )}
      </div>
    </div>
  );
}

// ---------- 改动 tab（提交併入：状态头 + 未提交树 + 已提交树 + 提交记录，issue #80） ----------

/**
 * 改动 tab 的选中项：range=已提交范围内文件（本 issue diff 端点），
 * wt=工作区未提交（项目级 worktree diff 端点，untracked 由码 '?' 判定）。
 * 两者都已归一成 ChangeLeaf（树的叶子）。
 */
type ChangeSel = { kind: 'range' | 'wt'; leaf: ChangeLeaf };

function IssueChangesTab({
  pid,
  iid,
  info,
  err,
  onRefresh,
}: {
  pid: number;
  iid: number;
  info: IssueGitInfo | null;
  err: string;
  onRefresh: () => void;
}) {
  // 选中提交（窄屏全屏 CommitPanel / 宽屏右栏展开）；与选中文件互斥
  const [sha, setSha] = useState<string | null>(null);
  const fd = useFileDiff<ChangeSel>((s) => {
    const q = new URLSearchParams({ path: s.leaf.path });
    if (s.leaf.oldPath) q.set('old', s.leaf.oldPath);
    if (s.kind === 'wt') {
      if (s.leaf.code === '?') q.set('untracked', '1');
      return `/api/projects/${pid}/git/worktree/diff?${q}`;
    }
    return `/api/projects/${pid}/issues/${iid}/git/diff?${q}`;
  });
  // 宽屏（≥960px）左右分栏：左列树+提交记录（可拖宽，宽度偏好与文件页文件树共享），
  // 右栏展开 diff / 提交详情；窄屏维持点击全屏钻入。
  const wide = useWide();
  const treeW = useTreeWidth();
  const splitRef = useRef<HTMLDivElement>(null);

  const openLeaf = (kind: 'range' | 'wt', leaf: ChangeLeaf): void => {
    setSha(null); // 文件与提交互斥选中
    fd.open({ kind, leaf });
  };
  const openCommit = (c: string): void => {
    fd.close();
    setSha(c);
  };

  // 树叶子（hooks 在早退之前）：worktree 两列码按路径归一；range 文件带增删行
  const wtLeaves = useMemo<ChangeLeaf[]>(
    () =>
      dedupWorktree(info?.worktree ?? []).map((w) => {
        const l: ChangeLeaf = { key: `wt:${w.path}`, path: w.path, code: w.code };
        if (w.oldPath) l.oldPath = w.oldPath;
        return l;
      }),
    [info],
  );
  const rangeLeaves = useMemo<ChangeLeaf[]>(
    () =>
      (info?.files ?? []).map((f) => {
        const l: ChangeLeaf = {
          key: `range:${f.path}`,
          path: f.path,
          code: f.status[0] ?? 'M',
          adds: f.adds,
          dels: f.dels,
        };
        if (f.oldPath) l.oldPath = f.oldPath;
        return l;
      }),
    [info],
  );

  if (err) return <div class="empty">{err}</div>;
  if (!info) return <Loading />;
  if (info.ok === false) return <div class="empty">{info.error ?? tr('ui.loadFailed')}</div>;

  // 窄屏钻入态：点提交/文件 → 全屏展开（返回回列表）；宽屏走右栏，不进这两个分支
  if (!wide && sha) {
    return (
      <div class="wb-gitdetail">
        <div class="wb-sub-hd">
          <button class="back" onClick={() => setSha(null)}>
            ‹
          </button>
          <span class="mut small">{tr('issue.backChanges')}</span>
        </div>
        <div class="wb-commitpanel">
          <CommitPanel key={sha} pid={pid} sha={sha} onJump={setSha} />
        </div>
      </div>
    );
  }

  if (!wide && fd.file) {
    const s = fd.file;
    return (
      <div class="wb-gitdetail">
        <div class="wb-sub-hd">
          <button class="back" onClick={fd.close}>
            ‹
          </button>
          <StatusChip code={s.leaf.code} />
          <PathText path={s.leaf.path} oldPath={s.leaf.oldPath} />
          {s.kind === 'wt' && <span class="mut small">{tr('issue.uncommitted')}</span>}
        </div>
        <DiffContent
          code={s.leaf.code}
          path={s.leaf.path}
          oldPath={s.leaf.oldPath}
          imageUrls={gitImageUrls(
            s.kind === 'wt'
              ? `/api/projects/${pid}/git/worktree/raw`
              : `/api/projects/${pid}/issues/${iid}/git/raw`,
            s.leaf.path,
            s.leaf.oldPath,
            s.leaf.code,
          )}
          d={fd.diff}
          error={fd.err}
        />
      </div>
    );
  }

  // 后端只对活跃（执行中/评审中）issue 附带 worktree —— 有该字段即「正在进行」视角
  const active = info.worktree !== undefined;
  const hasAny = wtLeaves.length > 0 || info.files.length > 0 || info.commits.length > 0;

  // 列表区（窄屏整页 / 宽屏左列共用）：未提交树 + 已提交树 + 提交记录
  const lists = (
    <>
      {wtLeaves.length > 0 && (
        <>
          <div class="wb-sect">⏳ {tr('issue.runningUncommitted')}</div>
          <ChangeTree leaves={wtLeaves} selKey={fd.file?.leaf.key} onOpen={(l) => openLeaf('wt', l)} />
        </>
      )}
      {rangeLeaves.length > 0 && (
        <>
          <div class="wb-sect">✅ {tr('issue.committed')}</div>
          <ChangeTree leaves={rangeLeaves} selKey={fd.file?.leaf.key} onOpen={(l) => openLeaf('range', l)} />
        </>
      )}
      {info.commits.length > 0 && (
        <>
          <div class="wb-sect">🧾 {tr('issue.commitHistory', { count: info.commits.length })}</div>
          <div class="wb-commits">
            {info.commits.map((c) => (
              <button
                key={c.sha}
                class={`wb-commit${wide && sha === c.sha ? ' on' : ''}`}
                onClick={() => openCommit(c.sha)}
              >
                <div class="wb-commit-r1">
                  <RefBadges refs={c.refs} />
                  <span class="git-subj">{c.subject}</span>
                </div>
                <div class="wb-commit-r2 mut">
                  <span class="mono">{c.short}</span>
                  <span>{c.author}</span>
                  <span>{timeAgo(c.ts)}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      {!hasAny && (
        <div class="empty">
          {active
            ? tr('issue.noChangesRunning')
            : !info.exists
              ? tr('issue.noChanges')
              : tr('issue.mergedNoChanges', { base: info.base })}
        </div>
      )}
    </>
  );

  if (!wide) {
    return (
      <div class="id-scroll">
        <IssueGitHead info={info} onRefresh={onRefresh} />
        {lists}
      </div>
    );
  }

  // 宽屏：状态头整宽，下方左右分栏（左列可拖宽，宽度偏好与文件页文件树共享）。
  // 注意容器不能用 .fullcol（absolute inset:0 会脱出 .wb-body 盖住头部/tab 栏），
  // 用普通纵向弹性列 .wb-gitwide 填满 tab 体。
  return (
    <div class="wb-gitwide">
      <IssueGitHead info={info} onRefresh={onRefresh} />
      <div class="wb-split" ref={splitRef}>
        <div
          class="wb-list-col"
          style={treeW.width != null ? { width: treeW.width, maxWidth: treeW.width } : undefined}
        >
          <div class="id-scroll" style={{ padding: '0 8px 12px' }}>
            {lists}
          </div>
        </div>
        <ListSplitter containerRef={splitRef} list={treeW} label={tr('issue.changeTreeWidth')} />
        <div class="wb-main">
          {sha ? (
            <div class="wb-commitpanel">
              <CommitPanel key={sha} pid={pid} sha={sha} onJump={setSha} />
            </div>
          ) : fd.file ? (
            <div class="wb-gitdetail">
              <div class="wb-sub-hd">
                <StatusChip code={fd.file.leaf.code} />
                <PathText path={fd.file.leaf.path} oldPath={fd.file.leaf.oldPath} />
                {fd.file.kind === 'wt' && <span class="mut small">{tr('issue.uncommitted')}</span>}
                <button class="gs-x" title={tr('issue.collapseDiff')} onClick={fd.close}>
                  ✕
                </button>
              </div>
              <DiffContent
                code={fd.file.leaf.code}
                path={fd.file.leaf.path}
                oldPath={fd.file.leaf.oldPath}
                imageUrls={gitImageUrls(
                  fd.file.kind === 'wt'
                    ? `/api/projects/${pid}/git/worktree/raw`
                    : `/api/projects/${pid}/issues/${iid}/git/raw`,
                  fd.file.leaf.path,
                  fd.file.leaf.oldPath,
                  fd.file.leaf.code,
                )}
                d={fd.diff}
                error={fd.err}
              />
            </div>
          ) : (
            <div class="gd-empty">← {tr('issue.chooseChange')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 卡点操作面（底部拇指区 / 工作台底条） ----------

function GateBar(props: {
  issue: Issue;
  gate: Gate | null;
  note: string;
  setNote: (s: string) => void;
  busy: boolean;
  actErr: string;
  blockedReason: string;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
  onStart: () => void;
  onCancel: () => void;
  onUnblock: () => void;
}) {
  const { issue, gate, note, setNote, busy, actErr } = props;
  const st = issue.status;

  if (st === 'plan_review' || st === 'merge_review') {
    return (
      <div class="gatebar">
        <div class="gate-hd">⚠ {st === 'plan_review' ? tr('issue.planReview') : tr('issue.mergeReview')}</div>
        {gate ? (
          <>
            {st === 'plan_review' ? <PlanGateBody gate={gate} /> : <MergeGateBody gate={gate} />}
            <textarea
              rows={2}
              value={note}
              placeholder={tr('issue.feedbackPlaceholder')}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
            <div class="gate-row">
              <button class="btn danger" disabled={busy} onClick={props.onReject}>
                {tr('issue.rejectWithFeedback')}
              </button>
              <button class="btn danger ghost" disabled={busy} onClick={props.onCancel}>
                {tr('issue.cancelTask')}
              </button>
              <button class="btn ok" disabled={busy} onClick={props.onApprove}>
                {st === 'plan_review' ? `✓ ${tr('issue.approvePlan')}` : `✓ ${tr('issue.approveMerge')}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div class="err">{tr('issue.gateFailed')}</div>
            <div class="gate-row">
              <button class="btn" disabled={busy} onClick={props.onRetry}>
                {tr('issue.regenerateReview')}
              </button>
              <button class="btn danger" disabled={busy} onClick={props.onCancel}>
                {tr('issue.cancelTask')}
              </button>
            </div>
          </>
        )}
        {actErr && <div class="err">{actErr}</div>}
      </div>
    );
  }

  if (st === 'blocked') {
    return (
      <div class="gatebar">
        <div class="gate-hd" style={{ color: '#dc2626' }}>
          ⛔ {tr('issue.blocked')}
        </div>
        <div class="block-box">{props.blockedReason}</div>
        {actErr && <div class="err">{actErr}</div>}
        <div class="gate-row">
          <button class="btn" disabled={busy} onClick={props.onCancel}>
            {tr('issue.cancelIssue')}
          </button>
          <button class="btn ok" disabled={busy} onClick={props.onUnblock}>
            {tr('issue.unblockRerun')}
          </button>
        </div>
      </div>
    );
  }

  if (st === 'clarifying') {
    // 澄清问答已上移到顶部常驻面板（ClarifyPanel）；这里只留取消入口（clarifying 为存量兼容态）
    return (
      <div class="gatebar">
        <div class="gate-hd">❓ {tr('issue.clarifyAbove')}</div>
        {actErr && <div class="err">{actErr}</div>}
        <div class="gate-row">
          <button class="btn" disabled={busy} onClick={props.onCancel}>
            {tr('ui.cancel')}
          </button>
        </div>
      </div>
    );
  }

  if (st === 'pending') {
    // 澄清问题/答复由顶部 ClarifyPanel 承接；卡点条只保留启动
    return (
      <div class="gatebar">
        {actErr && <div class="err">{actErr}</div>}
        <div class="gate-row">
          <button class="btn primary" disabled={busy} onClick={props.onStart}>
            ▶ {tr('issue.start')}
          </button>
        </div>
      </div>
    );
  }

  return null; // 驱动中（输入条在 ChatPane）/ done / cancelled（只读提示）：无卡点面板
}

/**
 * 顶部紧凑澄清提示条（#103）：一行状态 + 问题数，点击弹窗回答——不再整面板常驻挤占 tab 内容。
 * awaiting（代理停在这儿等你）时整条转实心橙白字 + 呼吸光圈（#110 样式在 .clarify-bar.awaiting）：
 * 之前淡黄条在满屏暖色里根本看不出来，卡了一夜都不知道。仍然只是提示——点了才弹窗，不自动弹。
 */
function ClarifyBar(props: { awaiting: boolean; analyzing: boolean; count: number; onOpen: () => void }) {
  const analyzingOnly = props.analyzing && props.count === 0 && !props.awaiting;
  return (
    <button
      class={`clarify-bar${props.awaiting ? ' awaiting' : ''}`}
      title={props.awaiting ? tr('issue.agentPaused') : tr('issue.openToAnswer')}
      onClick={props.onOpen}
    >
      <span class="clarify-bar-t">
        {props.awaiting
          ? `⏳ ${tr('status.awaitingClarify')} — ${tr('issue.agentPaused')}`
          : analyzingOnly
            ? `🔄 ${tr('issue.agentReanalyzing')}`
            : `❓ ${tr('issue.questionsPending')}`}
        {props.count > 0 && <span class="badge b-amber">{tr('issue.questionCount', { count: props.count })}</span>}
      </span>
      <span class="clarify-bar-go">
        {analyzingOnly ? tr('issue.detailsLink') : props.awaiting ? tr('issue.answerNow') : tr('issue.answer')}
      </span>
    </button>
  );
}

/**
 * 澄清弹窗（#103 由常驻面板改造）：有未回答的澄清问题（创建时/执行中）时从提示条点开——
 * 问题清单（完整展示，弹窗整体滚动）+ 回答框 + 提交 → POST /clarify（pending 并入需求；
 * 驱动态直达代理会话），提交即关窗；答完（父组件轮询到 clarifyQuestions 清空/awaiting 消失）
 * 提示条自动收起。awaiting=true 时代理已暂停、文案更紧迫。
 * analyzing=true 时代理正在（重新）分析：答复/改正文已触发重析——没有可答的问题时只显示
 * 进度占位（收起输入框），分析落定（新问题/无问题）由轮询自动接管展开或收起。
 * text（#110）= 代理原话全文：有就整段原样展示（保留换行缩进/子选项），没有（旧事件）才回退
 * 编号清单——清单是抽取产物，交代前提的散文与 A/B/C 子选项都不在里面，只看它就是「显示不全」。
 */
function ClarifyPanel(props: {
  questions: string[];
  /** 代理原话全文（空 = 旧事件，回退 questions 清单） */
  text: string;
  awaiting: boolean;
  analyzing: boolean;
  busy: boolean;
  /** 原始需求上下文：标题常显 + 正文可折叠——答问题时看得到自己在答什么 */
  title: string;
  body: string | null;
  onClose: () => void;
  onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const raw = props.text.trim();
  const hasQ = props.questions.length > 0 || raw.length > 0;
  // 只在「分析中且无可回答的问题」时收起输入框——有问题在身仍可边分析边答
  const analyzingOnly = props.analyzing && !hasQ && !props.awaiting;
  return (
    <Modal title={tr('issue.clarification')} onClose={props.onClose}>
      <div class="clarify-hd">
        {props.awaiting
          ? `⏳ ${tr('status.awaitingClarify')} — ${tr('issue.agentPaused')}`
          : analyzingOnly
            ? `🔄 ${tr('issue.agentReanalyzing')}`
            : `❓ ${tr('issue.questionsOptional')}`}
      </div>
      <div class="clarify-ctx">
        <div class="clarify-ctx-t">「{props.title}」</div>
        {props.body?.trim() && (
          <details class="clarify-ctx-b">
            <summary>{tr('issue.originalRequest')}</summary>
            <pre>{props.body}</pre>
          </details>
        )}
      </div>
      {raw ? (
        <div class="clarify-raw">{raw}</div>
      ) : hasQ ? (
        <ol class="clarify-qs">
          {props.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>
      ) : analyzingOnly ? (
        <div class="mut small">{tr('issue.reanalyzingHelp')}</div>
      ) : (
        <div class="mut small">{tr('issue.agentWaitingExecution')}</div>
      )}
      {!analyzingOnly && (
        <>
          <textarea
            rows={4}
            value={answer}
            placeholder={tr('issue.answerPlaceholder')}
            onInput={(e) => setAnswer(e.currentTarget.value)}
          />
          <div class="clarify-row">
            <button
              class="btn primary"
              disabled={props.busy || !answer.trim()}
              onClick={() => {
                props.onSubmit(answer.trim());
                setAnswer('');
              }}
            >
              {tr('issue.submitClarification')}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function PlanGateBody({ gate }: { gate: Gate }) {
  const p = tryJson<PlanGatePayload>(gate.payloadJson);
  const subtasks = p?.subtasks ?? [];
  return (
    <div class="gate-box">
      {subtasks.length > 0
        ? subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : tr('issue.emptyPlan')}
      {p?.implMode === 'team' ? `\n\n${tr('issue.teamParallel')}` : ''}
    </div>
  );
}

function MergeGateBody({ gate }: { gate: Gate }) {
  const [showDiff, setShowDiff] = useState(false);
  const p = tryJson<MergeGatePayload>(gate.payloadJson);
  if (!p) return <div class="mut small">{tr('issue.noDiffData')}</div>;
  return (
    <div class="diffwrap">
      <pre class="diffstat">
        {`⎇ ${p.branch ?? '?'} → ${p.base ?? 'main'}\n`}
        {p.gitError ? `${tr('issue.gitError', { error: p.gitError })}\n` : ''}
        {p.stat ?? tr('issue.noStat')}
      </pre>
      {showDiff ? (
        <DiffView diff={p.diff ?? ''} truncated={p.diffTruncated === true} />
      ) : (
        <button class="linkbtn" style={{ padding: '9px' }} onClick={() => setShowDiff(true)}>
          {tr('issue.fullDiff')}{p.diffTruncated ? ` (${tr('issue.truncated')})` : ''} ▾
        </button>
      )}
    </div>
  );
}

function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  const lines = diff.split('\n');
  return (
    <pre class="diff">
      {lines.map((ln, i) => {
        const cls = ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff --git')
          ? 'fhead'
          : ln.startsWith('@@')
            ? 'hunk'
            : ln.startsWith('+')
              ? 'add'
              : ln.startsWith('-')
                ? 'del'
                : '';
        return (
          <div key={i} class={`ln ${cls}`}>
            {ln || ' '}
          </div>
        );
      })}
      {truncated && <div class="ln hunk">…{tr('issue.diffTruncated')}…</div>}
    </pre>
  );
}
