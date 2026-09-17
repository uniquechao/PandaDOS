import { SkillPolicyEditor } from '../components/SkillPolicyEditor';
/**
 * Issue 工作台（2026-07-15 重构：看板→主从工作台的右栏）。
 * 一个 issue 的三视图（tab，2026-07-24 issue #80 提交併入改动）：
 *  - 详情：body / 截图 / 计划(子任务)；
 *  - 执行：执行现场——「对话」(ChatPane 钉住 issue conv，含菜单/输入) 与「原生」(真实代理 tmux) 二选一；
 *  - 改动：合并本 issue 已提交与执行中未提交的文件，按路径去重后显示一棵 ChangeTree；
 *         点文件 → 对应范围内/工作区单文件 diff。
 *         范围：固定/共享分支取 impl_base 起点 start..tip，否则 base..branch。
 * 卡点操作（GateBar：plan/merge review、blocked、clarifying、pending 启动）：
 *  - 执行 tab 落在 ChatPane 底部拇指区（承接 CC 菜单同一操作区）；
 *  - 其余 tab 作为工作台底部常驻条 —— 让开发者看着详情或 diff 就地拍板。
 * embedded=true：作为看板右栏嵌入（无返回键，左栏列表即导航）；
 * embedded=false：窄屏整页（顶部返回键回项目看板）。
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { api, ApiError, getProjectExecutorAgents, setIssueAutoApprove } from '../lib/api';
import { nav } from '../lib/router';
import { timeAgo, truncate, tryJson } from '../lib/fmt';
import { fmtDuration } from '../lib/runstream';
import { onLazyLoadError } from '../lib/updatePrompt';
import { ChatPane } from '../components/ChatPane';
import type { TermStatus } from '../components/TermPane';
import { AgentLogo } from '../components/AgentLogo';
import { AutoApproveSwitch } from '../components/AutoApproveSwitch';
import { reconcileAgent } from '../components/AgentPicker';
import { NativeModeSwitch, type NativeMode } from '../components/NativeModeSwitch';
import { canEditSubtask, ExecProgress, execProgressState, stepGlyph } from '../components/ExecProgress';
import type {
  AgentKind,
  AutoApproveLevel,
  CompletionReport,
  ConversationSegment,
  Gate,
  Issue,
  IssueCategory,
  IssueDetail,
  IssueEvent,
  IssueGitInfo,
  IssueWorkflowRuntime,
  MergeGatePayload,
  PlanGatePayload,
  ProjectModule,
  ReasoningEffort,
  ReasoningInfo,
  MergedFromInfo,
  Subtask,
  UnblockRequest,
  ValidationInfo,
} from '../lib/types';
import { AttentionBadge, CatBadge, ModelBadge, StatusBadge } from '../components/badges';
import { useConvModel } from '../lib/useConvModel';
import { clarifyPanelState, pushFailureState, retryPlan } from '../lib/issueStatus';
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
  DiffContent,
  PathText,
  StatusChip,
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
import { parseBlockedNote } from '../../../shared/blocked';
import { WorkflowGraph } from '../components/WorkflowGraph';
import { issueWorkflowStatusKey, workflowNodeStatusKey, workflowWorktreeStatusKey } from '../lib/workflow';

const POLL_MS = 5000;

export function completionReportState(
  report: CompletionReport | null,
  _hasLegacySummary: boolean,
  status: Issue['status'],
): { tone: 'success' | 'warning' | 'legacy'; canContinue: boolean } {
  if (!report) return { tone: 'legacy', canContinue: ['done', 'blocked'].includes(status) };
  const incomplete = report.outcome !== 'complete' || report.unmetGoals.length > 0 || report.remainingWork.length > 0;
  return {
    tone: incomplete ? 'warning' : 'success',
    canContinue: incomplete && ['done', 'blocked'].includes(status),
  };
}

type WbTab = 'detail' | 'workflow' | 'exec' | 'changes';

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
  const [returnToRecovery, setReturnToRecovery] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryGuidance, setRecoveryGuidance] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [doneReopenOpen, setDoneReopenOpen] = useState(false);
  const [doneReopenGuidance, setDoneReopenGuidance] = useState('');
  const [doneReopenError, setDoneReopenError] = useState('');
  const [subtaskEditRequest, setSubtaskEditRequest] = useState<{ index: number; nonce: number } | null>(null);
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
    setReturnToRecovery(false);
    setRecoveryOpen(false);
    setRecoveryGuidance('');
    setRecoveryError('');
    setDoneReopenOpen(false);
    setDoneReopenGuidance('');
    setDoneReopenError('');
    setSubtaskEditRequest(null);
    setLightbox(null); // 切换 issue 时收起灯箱
    load();
    pollRef.current = window.setInterval(load, POLL_MS);
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, iid]);

  const issue = detail?.issue ?? null;

  useEffect(() => {
    if (detail && tab === 'workflow' && !detail.workflowRuntime) setTab('detail');
  }, [detail, tab]);

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
      if (d?.to === 'blocked' || d?.to === 'paused') return d.note ?? tr('issue.noReason');
    }
    return tr('issue.noReason');
  }, [issue, events]);

  /** 弹窗自动批复记录（issue #91）：events 已在手，纯本地归约，不额外请求 */
  const approvals = useMemo(() => toApprovalLog(events), [events]);

  /** 「已完成但未推送」标记（#272）：同样是纯本地归约，推成功后自动消失 */
  const pushFailure = useMemo(() => pushFailureState(events), [events]);

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

  /**
   * 改本 issue 的推理档覆盖（#281 / I-04）：'' = 继承模块。
   * codex 的 effort 是**进程启动参数**，所以这里改完只对**下次启动的会话**生效——
   * 不做乐观更新也不重启会话，等接口回来刷新详情即可。
   */
  const changeReasoning = (value: string): void => {
    const next = value === '' ? null : (value as ReasoningEffort);
    void api(`/api/projects/${pid}/issues/${iid}`, 'PATCH', { reasoningEffort: next })
      .then(() => load())
      .catch((e: unknown) => setActErr(e instanceof ApiError ? e.message : String(e)));
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

  /** 一键拆回智能合并（#289）：把宿主与被并项都按快照还原 */
  const unmerge = (): void => {
    void api(`/api/projects/${pid}/issues/${iid}/unmerge`, 'POST', {})
      .then(() => load())
      .catch((e: unknown) => setActErr(e instanceof ApiError ? e.message : String(e)));
  };

  /** 撤销「已排队等待恢复」（#283）：排错了/改主意了要能收回来 */
  const cancelUnblockQueue = (): void => {
    void api(`/api/projects/${pid}/issues/${iid}/unblock/cancel`, 'POST', {})
      .then(() => load())
      .catch((e: unknown) => setActErr(e instanceof ApiError ? e.message : String(e)));
  };

  const openRecovery = (): void => {
    if (!['blocked', 'paused'].includes(issue?.status ?? '')) return;
    setRecoveryError('');
    setRecoveryOpen(true);
  };

  const submitRecovery = async (): Promise<void> => {
    if (busy || !recoveryGuidance.trim()) {
      if (!recoveryGuidance.trim()) setRecoveryError(tr('issue.recoveryGuidanceRequired'));
      return;
    }
    setBusy(true);
    setRecoveryError('');
    setActErr('');
    try {
      await api(`/api/projects/${pid}/issues/${iid}/unblock`, 'POST', { guidance: recoveryGuidance.trim() });
      setRecoveryOpen(false);
      setRecoveryGuidance('');
      load();
    } catch (error) {
      setRecoveryError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const submitDoneReopen = async (): Promise<void> => {
    if (busy || !doneReopenGuidance.trim()) {
      if (!doneReopenGuidance.trim()) setDoneReopenError(tr('issue.continueGuidanceRequired'));
      return;
    }
    setBusy(true);
    setDoneReopenError('');
    setActErr('');
    try {
      await api(`/api/projects/${pid}/issues/${iid}/reopen`, 'POST', {
        guidance: doneReopenGuidance.trim(),
      });
      setDoneReopenOpen(false);
      setDoneReopenGuidance('');
      load();
    } catch (error) {
      setDoneReopenError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
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
  const blockedSubtaskIndex =
    issue && ['blocked', 'paused'].includes(issue.status)
      ? subs.findIndex((subtask, index) =>
          canEditSubtask(subtask, index, issue.subIndex, issue.status, issue.implMode),
        )
      : -1;

  const openIssueEditor = (fromRecovery = false): void => {
    setReturnToRecovery(fromRecovery);
    setRecoveryOpen(false);
    setEditing(true);
  };

  const closeIssueEditor = (): void => {
    setEditing(false);
    if (returnToRecovery && ['blocked', 'paused'].includes(issue?.status ?? '')) setRecoveryOpen(true);
    setReturnToRecovery(false);
  };

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
    ['plan_review', 'merge_review', 'blocked', 'paused', 'clarifying', 'pending'].includes(issue.status);
  const gateBar: JSX.Element | null = closed ? (
    issue!.status === 'cancelled' ? (
      // 取消不是死路（#93）：改完需求可以就地复活重跑，不用重开一条丢掉历史与模块绑定
      <div class="ro-note reopen-bar">
        <span class="reopen-txt">
          🚫 {tr('issue.cancelledCanRerun')}
          <span class="mut small"> {tr('issue.queueImmediately')}</span>
        </span>
        <button class="btn sm" disabled={busy} onClick={() => openIssueEditor()}>
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
      onUnblock={openRecovery}
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
              {/* #275：统一的「在等什么」徽标，替掉原来的 WaitingBadge */}
              <AttentionBadge kind={issue.attentionKind} />
              {subs.length > 0 && (
                <span class="badge b-green">
                  {doneN}/{subs.length}
                </span>
              )}
              {issue.module && <span class="badge b-gray">{issue.module}</span>}
              <details class="mut small"><summary>{tr('status.executionDetails')}</summary>
                <dl>{([
                  ['status.injections','injected'],['status.validationRuns','validation_started'],
                  ['status.validationReuse','validation_reused'],['status.reportRepairs','completion_report_retry'],
                  ['status.skillUsage','skill_invoked'],
                ] as const).map(([label,kind])=><div><dt>{tr(label)}</dt><dd>{events.filter(e=>e.kind===kind).length}</dd></div>)}</dl>
                {events.filter(e=>['execution_route','skill_visibility','validation_passed','validation_failed','validation_reused'].includes(e.kind)).map(e=>{
                  let data: Record<string,unknown>={};try{data=JSON.parse(e.dataJson ?? '{}');}catch{}
                  return <div><time>{new Date(e.ts).toLocaleTimeString()}</time> {e.kind}
                    {typeof data.reason==='string' && <p>{data.reason}</p>}
                    {typeof data.durationMs==='number' && <span> {tr('status.durationSeconds',{value:Math.round(data.durationMs/1000)})}</span>}
                    {Array.isArray(data.limitations) && data.limitations.map(v=><p>{String(v)}</p>)}
                    {Array.isArray(data.inventory) && <ul>{data.inventory.map((v: {name:string;mode:string;source?:string;version?:string})=><li>{v.name} · {v.mode} {v.source} {v.version}</li>)}</ul>}
                  </div>;
                })}
              </details>
              <span class="badge">{tr(issue.executionMode === 'direct' ? 'status.direct' : 'status.planned')}</span>
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
            {issue && (issue.status === 'pending' || ['blocked', 'paused'].includes(issue.status)) && (
              <button class="btn sm" disabled={busy} onClick={() => openIssueEditor()}>
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

      {/* 「已完成但未推送」警示条（#272）：与澄清条同层常驻，直到有一次 auto_push 成功 */}
      {pushFailure && <PushFailedBar branch={pushFailure.branch} detail={pushFailure.detail} />}

      {/* 「由多条 issue 合并而来」（#289）：给拆回入口，开跑后置灰并说明原因 */}
      {detail?.mergedFrom && <MergedFromBar info={detail.mergedFrom} onUnmerge={unmerge} />}

      {/* 「已排队等待恢复」（#283）：用户点过继续运行、项目当时忙，接力会自动接手 */}
      {detail?.unblockRequest && (
        <UnblockQueuedBar request={detail.unblockRequest} onCancel={cancelUnblockQueue} />
      )}

      {/* iOS 分段控件（#113）：外层类名保留（测试/布局锚点），三枚 tab 收进 .seg 轨道 */}
      <div class="id-tabs wb-tabs">
        <div class="seg wb-tabseg">
          <button class={`seg-btn${tab === 'detail' ? ' on' : ''}`} onClick={() => setTab('detail')}>
            {tr('issue.detailsTab')}
          </button>
          {detail?.workflowRuntime && (
            <button class={`seg-btn${tab === 'workflow' ? ' on' : ''}`} onClick={() => setTab('workflow')}>
              {tr('workflow.issueTab')}
            </button>
          )}
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
            editRequest={subtaskEditRequest}
            onContinue={() => {
              if (['blocked', 'paused'].includes(issue.status)) openRecovery();
              else if (issue.status === 'done') {
                setDoneReopenError('');
                setDoneReopenOpen(true);
              }
            }}
          />
        )}
        {issue && tab === 'exec' && (
          <ExecTab
            key={iid}
            pid={pid}
            issue={issue}
            conversationSegments={detail?.conversationSegments ?? []}
            moduleSegments={detail?.moduleSegments ?? []}
            validation={detail?.validation ?? null}
            reasoning={detail?.reasoning ?? null}
            onReasoning={changeReasoning}
            subs={subs}
            gateBar={gateBar}
            busy={busy}
            onAutoApprove={changeAutoApprove}
            onTerminate={() => {
              if (confirm(tr('issue.terminateConfirm'))) void post(`/api/projects/${pid}/issues/${iid}/cancel`);
            }}
            onUnblock={openRecovery}
          />
        )}
        {issue && tab === 'workflow' && detail?.workflowRuntime && (
          <WorkflowRuntimePanel runtime={detail.workflowRuntime} />
        )}
        {issue && tab === 'changes' && (
          <IssueChangesTab key={iid} pid={pid} iid={iid} info={git.info} err={git.err} onRefresh={git.refresh} />
        )}
      </div>

      {/* 执行 tab 的卡点条在 ChatPane 内；其余 tab 常驻底部，看着 diff/提交就地拍板 */}
      {tab !== 'exec' && gateBar}

      {recoveryOpen && ['blocked', 'paused'].includes(issue?.status ?? '') && (
        <BlockedRecoveryModal
          blockedReason={blockedReason}
          guidance={recoveryGuidance}
          error={recoveryError}
          busy={busy}
          canEditSubtask={blockedSubtaskIndex >= 0}
          onGuidanceChange={(value) => {
            setRecoveryGuidance(value);
            if (value.trim()) setRecoveryError('');
          }}
          onClose={() => {
            if (!busy) setRecoveryOpen(false);
          }}
          onEditIssue={() => openIssueEditor(true)}
          onEditSubtask={() => {
            if (blockedSubtaskIndex < 0) return;
            setTab('detail');
            setSubtaskEditRequest({ index: blockedSubtaskIndex, nonce: Date.now() });
            setRecoveryOpen(false);
          }}
          onSubmit={() => void submitRecovery()}
        />
      )}

      {doneReopenOpen && issue?.status === 'done' && (
        <ContinueProcessingModal
          guidance={doneReopenGuidance}
          error={doneReopenError}
          busy={busy}
          onGuidanceChange={(value) => {
            setDoneReopenGuidance(value);
            if (value.trim()) setDoneReopenError('');
          }}
          onClose={() => {
            if (!busy) setDoneReopenOpen(false);
          }}
          onSubmit={() => void submitDoneReopen()}
        />
      )}

      {editing && issue && (
        <EditIssueModal
          pid={pid}
          issue={issue}
          onClose={closeIssueEditor}
          onSaved={() => {
            closeIssueEditor();
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

// ---------- 编辑 issue（pending / blocked / cancelled；保存不改变状态） ----------

function BlockedRecoveryModal(props: {
  blockedReason: string;
  guidance: string;
  error: string;
  busy: boolean;
  canEditSubtask: boolean;
  onGuidanceChange: (value: string) => void;
  onClose: () => void;
  onEditIssue: () => void;
  onEditSubtask: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal title={tr('issue.recoveryTitle')} onClose={props.onClose}>
      <form
        class="blocked-recovery"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <section class="recovery-reason" aria-label={tr('issue.recoveryReason')}>
          <div class="recovery-label">{tr('issue.recoveryReason')}</div>
          <BlockedReason reason={props.blockedReason} />
        </section>
        <p class="recovery-help">{tr('issue.recoveryHelp')}</p>
        <label class="field recovery-guidance">
          {tr('issue.recoveryGuidance')}
          <textarea
            autoFocus
            rows={5}
            maxLength={4000}
            value={props.guidance}
            placeholder={tr('issue.recoveryGuidancePlaceholder')}
            aria-invalid={props.error ? 'true' : undefined}
            onInput={(event) => props.onGuidanceChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                props.onSubmit();
              }
            }}
          />
          <span class="mut small recovery-count">
            {tr('issue.recoveryLength', { current: props.guidance.length, max: 4000 })}
          </span>
        </label>
        <div class="recovery-tools">
          <button class="recovery-tool" type="button" disabled={props.busy} onClick={props.onEditIssue}>
            <span aria-hidden="true">✏️</span>
            <span><b>{tr('issue.editBlockedIssue')}</b><small>{tr('issue.editBlockedIssueHint')}</small></span>
          </button>
          <button
            class="recovery-tool"
            type="button"
            disabled={props.busy || !props.canEditSubtask}
            onClick={props.onEditSubtask}
          >
            <span aria-hidden="true">☑</span>
            <span>
              <b>{tr('issue.editBlockedSubtask')}</b>
              <small>{props.canEditSubtask ? tr('issue.editBlockedSubtaskHint') : tr('issue.noEditableBlockedSubtask')}</small>
            </span>
          </button>
        </div>
        {props.error && <div class="err" role="alert">{props.error}</div>}
        <div class="recovery-queue-hint">{tr('issue.recoveryQueueHint')}</div>
        <div class="mbtns">
          <button class="btn" type="button" disabled={props.busy} onClick={props.onClose}>
            {tr('ui.cancel')}
          </button>
          <button class="btn primary" type="submit" disabled={props.busy || !props.guidance.trim()}>
            {props.busy ? tr('ui.saving') : tr('issue.confirmRecovery')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ContinueProcessingModal(props: {
  guidance: string;
  error: string;
  busy: boolean;
  onGuidanceChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal title={tr('issue.continueProcessingTitle')} onClose={props.onClose}>
      <form
        class="blocked-recovery"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <div class="completion-report-alert" role="alert">
          <strong>{tr('issue.continueProcessingWarningTitle')}</strong>
          <span>{tr('issue.continueProcessingWarning')}</span>
        </div>
        <label class="field recovery-guidance">
          {tr('issue.continueGuidance')}
          <textarea
            autoFocus
            rows={5}
            maxLength={4000}
            value={props.guidance}
            placeholder={tr('issue.continueGuidancePlaceholder')}
            aria-invalid={props.error ? 'true' : undefined}
            onInput={(event) => props.onGuidanceChange(event.currentTarget.value)}
          />
          <span class="mut small recovery-count">
            {tr('issue.recoveryLength', { current: props.guidance.length, max: 4000 })}
          </span>
        </label>
        {props.error && <div class="err">{props.error}</div>}
        <div class="mbtns">
          <button type="button" class="btn" disabled={props.busy} onClick={props.onClose}>
            {tr('ui.cancel')}
          </button>
          <button type="submit" class="btn primary" disabled={props.busy || !props.guidance.trim()}>
            {props.busy ? tr('ui.saving') : tr('issue.confirmContinueProcessing')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

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

/** 改动 tab 只呈现本 issue 的文件视角，不暴露提交、推送或分支状态。 */
function IssueGitHead({ count, onRefresh }: { count: number; onRefresh: () => void }) {
  return (
    <div class="wb-githead">
      <span class="btitle">{tr('issue.changesTab')}</span>
      <span class="mut small">{tr('issue.fileCount', { count })}</span>
      <button class="linkbtn" style={{ marginLeft: 'auto' }} onClick={onRefresh}>
        ↻ {tr('ui.refresh')}
      </button>
    </div>
  );
}

// ---------- 详情 tab ----------

export function workflowParallelProgress(runtime: IssueWorkflowRuntime): { key: string; done: number; total: number }[] {
  const groups = new Map<string, Map<string, boolean>>();
  for (const run of runtime.runs) {
    if (!run.parallelGroupKey) continue;
    const nodes = groups.get(run.parallelGroupKey) ?? new Map<string, boolean>();
    const done = run.status === 'succeeded' || run.status === 'skipped' || run.status === 'cancelled';
    nodes.set(run.nodeKey, done || (nodes.get(run.nodeKey) ?? false));
    groups.set(run.parallelGroupKey, nodes);
  }
  return [...groups].map(([key, nodes]) => ({
    key,
    done: [...nodes.values()].filter(Boolean).length,
    total: nodes.size,
  }));
}

export function workflowConflictFiles(details: string | null): string[] {
  if (!details) return [];
  try {
    const parsed = JSON.parse(details) as { files?: unknown; conflictedFiles?: unknown };
    const files = Array.isArray(parsed.files) ? parsed.files : parsed.conflictedFiles;
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
  } catch {
    return [];
  }
}

function WorkflowRuntimePanel({ runtime }: { runtime: IssueWorkflowRuntime }) {
  const nodeByKey = new Map(runtime.workflow.graph.nodes.map((node) => [node.key, node]));
  const parallel = workflowParallelProgress(runtime);
  const worktrees = runtime.worktrees.filter((item) => item.status !== 'cleaned');
  const conflicts = runtime.worktrees.filter((item) => item.conflictDetails || item.status === 'resolving' || item.status === 'paused' || item.status === 'failed');
  const orderedRuns = [...runtime.runs].sort((a, b) => b.id - a.id);

  return (
    <div class="wfr">
      <header class="wfr-head">
        <div>
          <span class="eyebrow">{tr('workflow.runtimeTitle')}</span>
          <h3>{runtime.workflow.templateName}</h3>
          <p class="mut small">{tr('workflow.runtimeMeta', { version: runtime.workflow.templateVersion, loops: runtime.workflow.maxLoopIterations })}</p>
        </div>
        <span class={`wfr-status status-${runtime.workflow.status}`}>{tr(issueWorkflowStatusKey(runtime.workflow.status))}</span>
      </header>

      {runtime.workflow.status === 'paused' && (
        <section class="wfr-alert" role="status">
          <div><strong>{tr('workflow.pausedTitle')}</strong><p>{runtime.workflow.pauseReason || tr('workflow.pauseReasonUnknown')}</p></div>
          <span>{tr('workflow.pausedHelp')}</span>
        </section>
      )}

      <WorkflowGraph graph={runtime.workflow.graph} runs={runtime.runs} />

      {(parallel.length > 0 || worktrees.length > 0) && (
        <div class="wfr-progress-grid">
          {parallel.map((group) => (
            <section key={group.key} class="wfr-progress-card">
              <span class="eyebrow">{tr('workflow.parallelProgress')}</span>
              <strong>{tr('workflow.parallelGroupValue', { key: group.key })}</strong>
              <progress
                value={group.done}
                max={Math.max(1, group.total)}
                aria-label={tr('workflow.parallelProgressAria', { key: group.key, done: group.done, total: group.total })}
              />
              <small>{tr('workflow.progressValue', { done: group.done, total: group.total })}</small>
            </section>
          ))}
          {worktrees.map((worktree) => (
            <section key={worktree.id} class="wfr-progress-card" aria-label={tr('workflow.worktreeAria', { branch: worktree.branch, status: tr(workflowWorktreeStatusKey(worktree.status)) })}>
              <span class="eyebrow">{tr('workflow.mergeProgress')}</span>
              <strong class="mono">{worktree.branch}</strong>
              <span class={`wfr-mini-status status-${worktree.status}`}>{tr(workflowWorktreeStatusKey(worktree.status))}</span>
            </section>
          ))}
        </div>
      )}

      {conflicts.map((worktree) => {
        const files = workflowConflictFiles(worktree.conflictDetails);
        return (
          <section key={`conflict-${worktree.id}`} class="wfr-conflict" aria-label={tr('workflow.conflictAria', { branch: worktree.branch })}>
            <div class="wfr-conflict-title"><strong>{tr('workflow.conflictTitle')}</strong><span class="mono">{worktree.branch}</span></div>
            {files.length > 0 && <div class="wfr-file-list">{files.map((file) => <code key={file}>{file}</code>)}</div>}
            {worktree.conflictDetails && <details><summary>{tr('workflow.conflictDiagnostics')}</summary><pre>{worktree.conflictDetails}</pre></details>}
            {worktree.resolutionConversationId && <small>{tr('workflow.autoResolving')}</small>}
          </section>
        );
      })}

      <section class="wfr-runs">
        <div class="wfr-section-title"><h3>{tr('workflow.nodeRuns')}</h3><span>{tr('workflow.runCount', { value: runtime.runs.length })}</span></div>
        {orderedRuns.length === 0 ? <div class="empty">{tr('workflow.noRuns')}</div> : orderedRuns.map((run) => {
          const node = nodeByKey.get(run.nodeKey);
          const routeReason = run.routeReason ?? runtime.transitions.find((transition) => transition.fromRunId === run.id)?.decisionText ?? null;
          return (
            <article key={run.id} class={`wfr-run status-${run.status}`} aria-label={tr('workflow.runAria', { title: node?.title ?? run.nodeKey, status: tr(workflowNodeStatusKey(run.status)), iteration: run.iteration, attempt: run.attempt })}>
              <div class="wfr-run-main">
                <span class="wfr-run-dot" aria-hidden="true" />
                <div>
                  <strong>{node?.title ?? run.nodeKey}</strong>
                  <span>{run.agent ? <AgentLogo agent={run.agent} size="xs" /> : tr(`workflow.nodeKind.${node?.kind ?? 'issue'}`)} · {tr('workflow.iterationAttempt', { iteration: run.iteration, attempt: run.attempt })}</span>
                </div>
                <span class="wfr-mini-status">{tr(workflowNodeStatusKey(run.status))}</span>
              </div>
              {routeReason && <div class="wfr-run-detail" aria-label={tr('workflow.routeReasonAria', { title: node?.title ?? run.nodeKey })}><b>{tr('workflow.routeReason')}</b><p>{routeReason}</p></div>}
              {run.outputText && <details><summary>{tr('workflow.nodeOutput')}</summary><pre>{run.outputText}</pre></details>}
              {(run.errorDetails || run.errorCode) && <div class="err small">{run.errorDetails || run.errorCode}</div>}
              <time>{timeAgo(run.updatedTs)}</time>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function ReportList({ items }: { items: string[] }) {
  if (items.length === 0) return <div class="mut small">{tr('ui.none')}</div>;
  return (
    <ul class="completion-report-list">
      {items.map((item, index) => <li key={index}>{item}</li>)}
    </ul>
  );
}

function CompletionReportCard({ issue, onContinue }: { issue: Issue; onContinue: () => void }) {
  const report = issue.completionReport;
  const state = completionReportState(report, !!issue.resultSummary, issue.status);
  const outcomeKey = report?.outcome === 'complete'
    ? 'issue.reportOutcomeComplete'
    : report?.outcome === 'partial'
      ? 'issue.reportOutcomePartial'
      : report?.outcome === 'blocked'
        ? 'issue.reportOutcomeBlocked'
        : 'issue.reportOutcomeUnverified';
  return (
    <section class={`completion-report ${state.tone}`} aria-label={tr('issue.completionReport')}>
      <header class="completion-report-head">
        <div>
          <div class="completion-report-kicker">{tr('issue.completionReport')}</div>
          <div class="completion-report-title">{tr(outcomeKey)}</div>
        </div>
        <span class={`completion-report-badge ${state.tone}`}>{tr(outcomeKey)}</span>
      </header>
      {!report ? (
        <div class="completion-report-alert" role="alert">
          <strong>{tr('issue.reportLegacyWarningTitle')}</strong>
          <span>{tr('issue.reportLegacyWarning')}</span>
          {issue.resultSummary && <div class="completion-report-legacy">{issue.resultSummary}</div>}
        </div>
      ) : (
        <div class="completion-report-body">
          <section class="completion-report-section wide">
            <h3>{tr('issue.reportObjective')}</h3>
            <p>{report.objective}</p>
          </section>
          <section class="completion-report-section">
            <h3>{tr('issue.reportImplementation')}</h3>
            <ReportList items={report.implementation} />
          </section>
          <section class="completion-report-section">
            <h3>{tr('issue.reportVerification')}</h3>
            <ReportList items={report.verification} />
          </section>
          <section class="completion-report-section">
            <h3>{tr('issue.reportAdvantages')}</h3>
            <ReportList items={report.advantages} />
          </section>
          <section class="completion-report-section">
            <h3>{tr('issue.reportDisadvantages')}</h3>
            <ReportList items={report.disadvantages} />
          </section>
          <section class="completion-report-section wide completion-report-status">
            <h3>{tr('issue.reportCompletion')}</h3>
            <p>{report.completion}</p>
          </section>
          {/* #301：未达目标/后续动作只是告知——issue 已按现状收尾，系统不会因此停下，
              也不需要用户动手。所以这里既不是 role="alert" 也不用受阻那套红档：
              「告知」标记 + 一句话说明 + 中性 tint，与受阻面板一眼分得开。 */}
          {!!report.optionalFollowUps?.length && <section><h4>{tr('status.optionalFollowUps')}</h4><ReportList items={report.optionalFollowUps} /></section>}
          {(report.unmetGoals.length > 0 || report.remainingWork.length > 0) && (
            <div class="completion-report-note wide">
              <div class="crn-hd">
                <span class="crn-fyi">{tr('issue.reportAttentionFyi')}</span>
                <strong>{tr('issue.reportAttentionTitle')}</strong>
              </div>
              <p class="crn-note">{tr('issue.reportAttentionNote')}</p>
              {report.unmetGoals.length > 0 && (
                <section>
                  <h3>{tr('issue.reportUnmetGoals')}</h3>
                  <ReportList items={report.unmetGoals} />
                </section>
              )}
              {report.remainingWork.length > 0 && (
                <section>
                  <h3>{tr('issue.reportRemainingWork')}</h3>
                  <ReportList items={report.remainingWork} />
                </section>
              )}
            </div>
          )}
        </div>
      )}
      {state.canContinue && (
        <div class="completion-report-actions">
          <button class="btn primary" onClick={onContinue}>{tr('issue.continueProcessing')}</button>
        </div>
      )}
    </section>
  );
}

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
  editRequest,
  onContinue,
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
  editRequest: { index: number; nonce: number } | null;
  onContinue: () => void;
}) {
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  useEffect(() => {
    if (!editRequest) return;
    const subtask = subs[editRequest.index];
    if (!subtask || !canEditSubtask(subtask, editRequest.index, issue.subIndex, issue.status, issue.implMode)) return;
    setEditIndex(editRequest.index);
    setDraft(subtask.text);
    setEditError('');
  }, [editRequest?.nonce]);

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
      <SkillPolicyEditor pid={pid} issueId={issue.id} />
      {issue.body && <div class="id-body">{issue.body}</div>}
      {images.length > 0 && (
        <div class="id-imgs">
          {images.map((p) => (
            <ImgThumb key={p} pid={pid} path={p} onOpen={onOpenImage} />
          ))}
        </div>
      )}
      {(issue.completionReport || issue.resultSummary || issue.status === 'done') && (
        <CompletionReportCard issue={issue} onContinue={onContinue} />
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
                        class="btn sm plan-edit"
                        type="button"
                        title={tr('issue.editSubtask', { number: step.n })}
                        aria-label={tr('issue.editSubtask', { number: step.n })}
                        onClick={() => {
                          setEditIndex(index);
                          setDraft(step.text);
                          setEditError('');
                        }}
                      >
                        <svg class="plan-edit-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                          <path d="M4 13.8V16h2.2L15 7.2 12.8 5 4 13.8Z" />
                          <path d="m11.7 6.1 2.2 2.2M10.5 16H16" />
                        </svg>
                        <span>{tr('issue.edit')}</span>
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
  moduleSegments,
  validation,
  reasoning,
  onReasoning,
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
  /** 本模块跨会话的全部分段（#277）：轮换之后历史仍在，执行页据此列出时间线 */
  moduleSegments: ConversationSegment[];
  /** 门禁范围与最近一次结果（#279）：只读展示，不给按钮 */
  validation: ValidationInfo | null;
  /** 生效推理档与来源（#281） */
  reasoning: ReasoningInfo | null;
  /** 改本 issue 的推理档覆盖（'' = 继承模块） */
  onReasoning: (value: string) => void;
  /** 子任务计划（详情接口返回）：顶栏进度链用，空数组则整块不渲染 */
  subs: { text: string; done: boolean }[];
  gateBar: JSX.Element | null;
  busy: boolean;
  /** 改自动批准档位（父层乐观更新 + 调接口） */
  onAutoApprove: (level: AutoApproveLevel) => void;
  /** 终止：取消整个 issue（带二次确认，父层实现） */
  onTerminate: () => void;
  /** 受阻恢复：解除阻塞并从原阶段继续（父层实现） */
  onUnblock: () => void;
}) {
  const [mode, setMode] = useState<NativeMode>('chat');
  // 已收尾（done/cancelled）不会再有弹窗，档位锁死（#111）。受阻(blocked)仍可改——恢复执行前可调整档位
  const aaLocked = issue.status === 'done' || issue.status === 'cancelled';
  // 顶栏行首插槽（#300 合成一行）：切换钮 + 审批档 + 门禁 + 推理档 + 子任务进度链。
  // 门禁/推理档原本各占一整行（.val-line 带下边框），执行现场因此被三条横条切掉一大截高度——
  // 它们都是「低频只读/低频微调」的元信息，内联进 .runctl 与运行操作同行即可，行放不下由该行横向滚动兜住。
  // 对话与原生两种模式共用同一段（见 ExecNative），convId 为空的兜底分支也走这里。
  const seg = (
    <>
      <NativeModeSwitch mode={mode} onChange={setMode} />
      <AutoApproveSwitch
        level={issue.autoApprove ?? 'medium'}
        onChange={onAutoApprove}
        disabled={aaLocked}
        disabledHint={tr('issue.approvalLocked')}
      />
      <ValidationLine validation={validation} />
      <ReasoningLine reasoning={reasoning} onChange={onReasoning} />
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
              moduleSegments={moduleSegments}
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
  if (issue.status === 'done' || issue.status === 'cancelled' || ['blocked', 'paused'].includes(issue.status)) {
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

// ---------- 改动 tab（本 issue 改动文件树） ----------

/**
 * 同一路径若同时存在于已提交范围和工作区，工作区状态优先，增删统计沿用已提交范围；
 * source 决定单文件 diff 使用本 issue 范围还是当前工作区端点。
 */
type IssueChangeLeaf = ChangeLeaf & { source: 'range' | 'wt' };

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
  const fd = useFileDiff<IssueChangeLeaf>((leaf) => {
    const q = new URLSearchParams({ path: leaf.path });
    if (leaf.oldPath) q.set('old', leaf.oldPath);
    if (leaf.source === 'wt') {
      if (leaf.code === '?') q.set('untracked', '1');
      return `/api/projects/${pid}/git/worktree/diff?${q}`;
    }
    return `/api/projects/${pid}/issues/${iid}/git/diff?${q}`;
  });
  // 宽屏（≥960px）左右分栏：左列文件树可拖宽，右栏展开 diff；窄屏点击后全屏钻入。
  const wide = useWide();
  const treeW = useTreeWidth();
  const splitRef = useRef<HTMLDivElement>(null);

  // 已提交与工作区合成一棵树；同一路径仅显示一次，工作区状态和 diff 端点优先。
  const leaves = useMemo<IssueChangeLeaf[]>(() => {
    const byPath = new Map<string, IssueChangeLeaf>();
    for (const f of info?.files ?? []) {
      const leaf: IssueChangeLeaf = {
        key: `issue:${f.path}`,
        path: f.path,
        code: f.status[0] ?? 'M',
        adds: f.adds,
        dels: f.dels,
        source: 'range',
      };
      if (f.oldPath) leaf.oldPath = f.oldPath;
      byPath.set(f.path, leaf);
    }
    for (const w of dedupWorktree(info?.worktree ?? [])) {
      const previous = byPath.get(w.path);
      const leaf: IssueChangeLeaf = {
        ...(previous ?? { key: `issue:${w.path}`, path: w.path }),
        code: w.code,
        source: 'wt',
      };
      if (w.oldPath) leaf.oldPath = w.oldPath;
      byPath.set(w.path, leaf);
    }
    return [...byPath.values()];
  }, [info]);

  if (err) return <div class="empty">{err}</div>;
  if (!info) return <Loading />;
  if (info.ok === false) return <div class="empty">{info.error ?? tr('ui.loadFailed')}</div>;

  // 窄屏钻入态：点文件 → 全屏展开；宽屏走右栏。
  if (!wide && fd.file) {
    const leaf = fd.file;
    return (
      <div class="wb-gitdetail">
        <div class="wb-sub-hd">
          <button class="back" onClick={fd.close}>
            ‹
          </button>
          <StatusChip code={leaf.code} />
          <PathText path={leaf.path} oldPath={leaf.oldPath} />
        </div>
        <DiffContent
          code={leaf.code}
          path={leaf.path}
          oldPath={leaf.oldPath}
          imageUrls={gitImageUrls(
            leaf.source === 'wt'
              ? `/api/projects/${pid}/git/worktree/raw`
              : `/api/projects/${pid}/issues/${iid}/git/raw`,
            leaf.path,
            leaf.oldPath,
            leaf.code,
          )}
          d={fd.diff}
          error={fd.err}
        />
      </div>
    );
  }

  // 后端只对活跃（执行中/评审中）issue 附带 worktree —— 有该字段即「正在进行」视角
  const active = info.worktree !== undefined;
  const hasAny = leaves.length > 0;

  // 列表区由窄屏整页与宽屏左列共用。
  const lists = (
    <>
      <ChangeTree
        leaves={leaves}
        selKey={fd.file?.key}
        onOpen={(leaf) => fd.open(leaf as IssueChangeLeaf)}
      />
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
        <IssueGitHead count={leaves.length} onRefresh={onRefresh} />
        {lists}
      </div>
    );
  }

  // 宽屏：状态头整宽，下方左右分栏（左列可拖宽，宽度偏好与文件页文件树共享）。
  // 注意容器不能用 .fullcol（absolute inset:0 会脱出 .wb-body 盖住头部/tab 栏），
  // 用普通纵向弹性列 .wb-gitwide 填满 tab 体。
  return (
    <div class="wb-gitwide">
      <IssueGitHead count={leaves.length} onRefresh={onRefresh} />
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
          {fd.file ? (
            <div class="wb-gitdetail">
              <div class="wb-sub-hd">
                <StatusChip code={fd.file.code} />
                <PathText path={fd.file.path} oldPath={fd.file.oldPath} />
                <button class="gs-x" title={tr('issue.collapseDiff')} onClick={fd.close}>
                  ✕
                </button>
              </div>
              <DiffContent
                code={fd.file.code}
                path={fd.file.path}
                oldPath={fd.file.oldPath}
                imageUrls={gitImageUrls(
                  fd.file.source === 'wt'
                    ? `/api/projects/${pid}/git/worktree/raw`
                    : `/api/projects/${pid}/issues/${iid}/git/raw`,
                  fd.file.path,
                  fd.file.oldPath,
                  fd.file.code,
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

/**
 * 受阻原因（#301）。
 *
 * 代理按「在做什么｜卡在哪｜要我做什么」三段写（见 issues/prompts.ts 的 sentinelBoundary），
 * 这里拆成三行带标签展示，最后一行单独强调——用户的原话是「显示受阻但不知道我需要做什么」，
 * 缺的就是那行行动指引。
 *
 * 解析不出来一律原样显示那句话：老 issue 没有三段，引擎自己判的受阻（止损、工作区不可用、
 * Git 失败）也不会有——宁可少一层加工，也不猜着给用户编行动指引。
 */
function BlockedReason({ reason }: { reason: string }) {
  const parts = parseBlockedNote(reason);
  if (!parts) return <div class="block-box">{reason}</div>;
  const rows: Array<[string, string, boolean]> = [
    [tr('issue.blockedDoing'), parts.doing, false],
    [tr('issue.blockedStuck'), parts.stuck, false],
    [tr('issue.blockedAction'), parts.action, true],
  ];
  return (
    <div class="block-box block-lines">
      {rows.map(([label, value, act]) => (
        <div key={label} class={act ? 'block-line act' : 'block-line'}>
          <span class="block-line-k">{label}</span>
          <span class="block-line-v">{value}</span>
        </div>
      ))}
    </div>
  );
}

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

  if (st === 'blocked' || st === 'paused') {
    return (
      <div class="gatebar">
        <div class="gate-hd" style={{ color: '#dc2626' }}>
          {st === 'paused' ? tr('status.paused') : tr('issue.blockedNeedsYou')}
        </div>
        {st === 'blocked' && <div class="gate-note">{tr('issue.blockedNeedsYouHint')}</div>}
        <BlockedReason reason={props.blockedReason} />
        {actErr && <div class="err">{actErr}</div>}
        <div class="gate-row">
          <button class="btn" disabled={busy} onClick={props.onCancel}>
            {tr('issue.cancelIssue')}
          </button>
          <button class="btn ok" disabled={busy} onClick={props.onUnblock}>
            {tr('issue.openRecovery')}
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
/**
 * 「已完成但未推送到远端」警示条（#272 / B-02）。
 *
 * 引擎自动收尾时 push 重试后仍失败**不阻止 issue 完成**（改动已经在本地提交了），
 * 但也不能就这么静默 done——否则用户以为交付了，代码其实还在这台机器上。所以留一条
 * 常驻警示：说清「完成了但没推上去」、是哪条分支、git 原话是什么，以及下一步该干嘛。
 *
 * 不做成按钮：这里没有一键能替用户解决的动作（多半要人去看冲突/权限），
 * 假装可点只会让人白点一次。git 的报错原样展示，不翻译。
 */
/**
 * 「由多条 issue 合并而来」提示条（#289 / B-14）。
 *
 * 合并会改写宿主正文（摘要在前、原文分节追加），所以必须让人看得见「这是并出来的」并能一键拆回。
 * **开跑之后不给拆**：会话里已经按合并后的正文干过活，这时候换回去只会让代理和人各看各的版本——
 * 按钮置灰并说明原因，比让人点了报错强。
 */
function MergedFromBar({ info, onUnmerge }: { info: MergedFromInfo; onUnmerge: () => void }) {
  return (
    <div class="push-failed-bar" role="status">
      <span class="push-failed-t">
        <span aria-hidden="true">🧩</span>
        {tr('issue.mergedFrom')}
        <span class="mut small">{info.members.map((m) => `#${m.id}`).join(' + ')}</span>
      </span>
      <button
        class="btn sm"
        disabled={!info.canUnmerge}
        title={info.canUnmerge ? tr('issue.unmerge') : tr('issue.unmergeLocked')}
        onClick={onUnmerge}
      >
        {tr('issue.unmerge')}
      </button>
      {!info.canUnmerge && <span class="mut small">{tr('issue.unmergeLocked')}</span>}
    </div>
  );
}

/**
 * 「已排队等待恢复」提示条（#283 / B-10）。
 *
 * 用户点过「继续运行」但项目当时忙——旧行为是直接报错让他等会儿再点一次，现在意图已经排上队，
 * 接力会在项目空闲时自动恢复。这里要把两件事说清楚：**不用再点第二次**，以及**可以反悔**。
 */
function UnblockQueuedBar({ request, onCancel }: { request: UnblockRequest; onCancel: () => void }) {
  return (
    <div class="push-failed-bar" role="status">
      <span class="push-failed-t">
        <span aria-hidden="true">⏳</span>
        {tr('issue.unblockQueued')}
        <span class="mut small">{timeAgo(request.ts)}</span>
      </span>
      <span class="mut small" title={request.guidance}>{truncate(request.guidance, 60)}</span>
      <button class="btn sm" onClick={onCancel}>{tr('issue.unblockQueuedCancel')}</button>
    </div>
  );
}

/**
 * 推理档（#281 / I-04；#300 起内联进 .runctl 工具条）：选本 issue 的覆盖档，并显示当前生效档与它来自哪一层。
 *
 * codex 的 `model_reasoning_effort` 是**进程启动参数**，改完只对下次启动的会话生效——
 * 界面必须把这句说出来，否则用户会以为改了立刻就省钱/立刻就变聪明。claude 没有这个开关。
 */
function ReasoningLine({
  reasoning,
  onChange,
}: {
  reasoning: ReasoningInfo | null;
  onChange: (value: string) => void;
}) {
  if (!reasoning) return null;
  // 工具条里只留生效档值本身（#300）：「生效：X（来自 Y）」整句 + 「仅 codex 生效」的提醒
  // 都塞进 title / aria-label——来源这层信息一年也用不到几次，不值得在常驻工具条上占一句话。
  const effective = tr('issue.reasoningEffective', { effort: reasoning.effort, source: reasoning.source });
  const hint = `${effective} · ${tr('ui.reasoningCodexOnly')}`;
  return (
    <div class="val-line mut" title={hint}>
      <span>{tr('ui.reasoningEffort')}</span>
      <select
        class="rc-sel"
        value={reasoning.override ?? ''}
        aria-label={tr('ui.reasoningEffort')}
        onChange={(e) => onChange(e.currentTarget.value)}
      >
        <option value="">{tr('ui.reasoningInherit')}</option>
        {(['low', 'medium', 'high'] as const).map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
      <span class="val-scope" title={effective} aria-label={effective}>{reasoning.effort}</span>
    </div>
  );
}

/**
 * 门禁（#279 / I-03；#300 起内联进 .runctl 工具条）：范围（定向/全量）+ 最近一次结果 + 耗时。
 *
 * **只读、不给按钮**：门禁由引擎在会话外自己跑，这里给的是「刚才跑了什么、结果如何」。
 * 放一个「重跑」按钮只会让人手动制造重复执行——那正是本条要消灭的开销。
 */
function ValidationLine({ validation }: { validation: ValidationInfo | null }) {
  if (!validation || (!validation.scope && !validation.last)) return null;
  const last = validation.last;
  const scopeKind = last?.scope ?? validation.scope?.kind ?? null;
  const scopeText = scopeKind === 'targeted'
    ? tr('issue.validationTargeted', { files: validation.scope?.files.length ?? 0 })
    : scopeKind === 'full' ? tr('issue.validationFull') : '';
  const outcome = !last
    ? tr('issue.validationPending')
    : last.outcome === 'passed'
      ? tr('issue.validationPassed')
      : last.outcome === 'skipped'
        ? tr('issue.validationSkipped')
        : tr('issue.validationFailed', { label: last.label ?? '', code: last.code ?? 0 });
  const tone = !last ? 'b-gray' : last.outcome === 'passed' ? 'b-blue' : last.outcome === 'failed' ? 'b-red' : 'b-gray';
  return (
    <div class="val-line mut" title={validation.scope?.reason ?? ''}>
      <span>{tr('issue.validation')}</span>
      {scopeText && <span class="val-scope">{scopeText}</span>}
      <span class={`badge ${tone}`}>{outcome}</span>
      {last?.durationMs != null && <span class="val-dur">{fmtDuration(last.durationMs)}</span>}
    </div>
  );
}

function PushFailedBar(props: { branch: string; detail: string }) {
  return (
    <div class="push-failed-bar" role="alert">
      <span class="push-failed-t">
        <span aria-hidden="true">⚠️</span>
        {tr('issue.pushFailedTitle')}
        {props.branch && (
          <span class="badge b-red" title={tr('issue.pushFailedBranch', { branch: props.branch })}>
            {props.branch}
          </span>
        )}
      </span>
      <span class="push-failed-h">{tr('issue.pushFailedHint')}</span>
      {props.detail && <code class="push-failed-d">{props.detail}</code>}
    </div>
  );
}

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
