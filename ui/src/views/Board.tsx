/**
 * 项目工作台（2026-07-15 重构：看板 → 主从工作台）。
 * 左栏（宽屏约 1/4）：issue 列表按状态分组（待确认→进行中→待办→完成），一眼триаж；
 * 右栏：选中 issue 的工作台（详情 / 执行 / 提交 / 改动，见 IssueWorkbench）。
 * 宽屏（≥960px）左右并排、点行即换右栏（URL 落 #/p/:pid/issue/:iid，可深链/自动选优先项）；
 * 窄屏（手机）：整页只显列表，点 issue 进整页工作台（顶部返回键回列表）。
 * 建 issue：category task/design/debug + 截图（rel path 附 images）。
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addMember,
  api,
  ApiError,
  getProjectExecutorAgents,
  listMemberCandidates,
  listMembers,
  removeMember,
  transferOwner,
} from '../lib/api';
import { nav } from '../lib/router';
import { fmtTime, timeAgo } from '../lib/fmt';
import type {
  AgentKind,
  AutoApproveLevel,
  Issue,
  IssueCategory,
  IssueStatus,
  Me,
  MemberCandidate,
  Project,
  ProjectModule,
  ProjectMember,
  Subscription,
} from '../lib/types';
import { isAsyncMode, SUMMARY_MODELS, type SummaryMode } from '../lib/summaryModes';
import { pollProjectSummary } from '../lib/pollSummary';
import { resolveSelIid } from '../lib/seliid';
import { filterIssueList, pageSlice, sortBoardGroup, type BoardGroupKey } from '../lib/issueOrdering';
import { SummaryButton } from '../components/SummaryButton';
import { StatusBadge, WaitingBadge } from '../components/badges';
import { Modal } from '../components/Modal';
import { ModulesPanel } from '../components/ModulesPanel';
import { ModuleSelect } from '../components/ModuleSelect';
import { hasPendingSuggestion, readOrganizeDismissedTs, type OrganizeStatus } from '../lib/organize';
import { AutoApproveSwitch } from '../components/AutoApproveSwitch';
import { readNewIssueAutoApprove, writeNewIssueAutoApprove } from '../lib/newIssuePrefs';
import { ImageAttach, type AttachedImage } from '../components/ImageAttach';
import { IssueGitBranchFields } from '../components/IssueGitBranchFields';
import { Loading } from '../components/Loaders';
import { ListSplitter } from '../components/ListSplitter';
import { toast } from '../lib/toast';
import { useWide } from '../lib/useWide';
import { useListWidth } from '../lib/listwidth';
import {
  issueGitBranchPayload,
  type IssueGitBranchValue,
} from '../lib/issuegitbranch';
import { ChatView } from './Chat';
import { IssueWorkbench } from './IssueDetail';
import { reconcileAgent } from '../components/AgentPicker';

const POLL_MS = 5000;

/** 列表分组（顺序即视觉优先级：待确认最先，等你拍板；收尾三组殿后）。
 * #105：完成混桶拆开——受阻要被看见排收尾组最前，已取消最沉底；空组不渲染（有才出现）。
 * paged=50/页分页，searchable=组内搜索框（完成组条目多才需要）。 */
const GROUPS: {
  key: BoardGroupKey;
  label: string;
  statuses: IssueStatus[];
  tone: string;
  paged?: boolean;
  searchable?: boolean;
}[] = [
  // clarifying 在等发起人回答——归待确认组（别装成还没开始）
  { key: 'review', label: '待确认', statuses: ['clarifying', 'plan_review', 'merge_review'], tone: 'review' },
  { key: 'doing', label: '进行中', statuses: ['planning', 'implementing', 'testing', 'merging'], tone: 'doing' },
  { key: 'todo', label: '待办', statuses: ['pending'], tone: 'todo' },
  { key: 'blocked', label: '受阻', statuses: ['blocked'], tone: 'blocked', paged: true },
  { key: 'finished', label: '完成', statuses: ['done'], tone: 'finished', paged: true, searchable: true },
  { key: 'cancelled', label: '已取消', statuses: ['cancelled'], tone: 'cancelled', paged: true },
];

export function BoardView({ pid, selIid }: { pid: number; selIid?: number }) {
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  // 整理方案角标：挂载时拉一次（面板内会再拉最新）；忽略过/全执行完的同批不亮
  const [orgStatus, setOrgStatus] = useState<OrganizeStatus | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ finished: true, cancelled: true });
  // 收尾组分页（#105）按组各记；搜索（#106）：完成组头 🔍 点开，查询作用于全部分组，输入即重置各组页码
  const [groupPage, setGroupPage] = useState<Record<string, number>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [supportedAgents, setSupportedAgents] = useState<AgentKind[]>([]);
  const wide = useWide();
  const listW = useListWidth(); // 宽屏左栏（任务列表）宽度：拖拽持久化，未设则回落 CSS 默认
  const splitRef = useRef<HTMLDivElement>(null); // .wb-split 容器 ref，供分隔条换算左栏像素宽

  const load = (): void => {
    api<Project>(`/api/projects/${pid}`).then(setProject).catch((e: Error) => setErr(e.message));
    api<Issue[]>(`/api/projects/${pid}/issues`)
      .then(setIssues)
      .catch((e: Error) => setErr(e.message));
  };

  useEffect(() => {
    setProject(null);
    setIssues(null);
    setErr('');
    load();
    const t = window.setInterval(() => {
      api<Issue[]>(`/api/projects/${pid}/issues`).then(setIssues).catch(() => {});
    }, POLL_MS);
    api<Subscription[]>('/api/me/subscriptions')
      .then((subs) => setSubscribed(subs.some((s) => s.scope === 'project' && s.targetId === pid)))
      .catch(() => {});
    api<OrganizeStatus>(`/api/projects/${pid}/modules/organize`)
      .then(setOrgStatus)
      .catch(() => {});
    void getProjectExecutorAgents(pid).then(setSupportedAgents).catch(() => setSupportedAgents([]));
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const byGroup = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const g of GROUPS) {
      const items = (issues ?? []).filter((i) => g.statuses.includes(i.status));
      // 每组使用明确策略；待办直接复用引擎完整队列顺序，避免展示与实际调度漂移。
      m.set(g.key, sortBoardGroup(g.key, items, issues ?? []));
    }
    return m;
  }, [issues]);

  // 宽屏默认落在最需要处理的一条：待确认 > 进行中 > 待办 > 任意
  const defaultIid = useMemo(() => {
    const list = issues ?? [];
    const pick = (sts: IssueStatus[]): number | undefined => list.find((i) => sts.includes(i.status))?.id;
    return (
      list.find((i) => i.waitingInput)?.id ?? // 弹窗等人工选择的最优先
      pick(['clarifying', 'plan_review', 'merge_review']) ??
      pick(['planning', 'implementing', 'testing', 'merging']) ??
      pick(['pending']) ??
      list[0]?.id ??
      null
    );
  }, [issues]);

  // 深链校验：URL 指定优先，但仅当它属于本项目（issues 加载完后校验）。失效/跨项目的旧深链
  // → 回退自动选优先项 + 清掉 URL 里的坏 iid（否则每 5s 轮询刷 404）。issues=null 视为未加载。
  // 切项目由 Shell 的 key={pid} 强制重挂（issues 从 null 起），本组件生命周期内 pid 恒定，
  // 故 issues!==null 即「本项目已加载可判定」，无需再比对 loadedPid。
  const sel = resolveSelIid(selIid, issues, issues !== null);
  const selectedId = sel.effectiveIid ?? (wide ? defaultIid : null);
  useEffect(() => {
    if (sel.stale) nav(`/p/${pid}`, { replace: true });
  }, [sel.stale, pid]);

  const toggleSub = async (): Promise<void> => {
    if (subscribed === null) return;
    try {
      if (subscribed) {
        await api('/api/subscriptions', 'DELETE', { scope: 'project', targetId: pid });
        setSubscribed(false);
        toast.info('已退订本项目');
      } else {
        await api('/api/subscriptions', 'POST', { scope: 'project', targetId: pid });
        setSubscribed(true);
        toast.success('已订阅，有进展会通知你');
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  // 手动「更新简介」：llm 同步（驱动大模型 读 README）；claude/codex 启动后台 Agent 认知总结。
  const updateSummary = async (mode: SummaryMode): Promise<void> => {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const r = await api<{ ok: boolean; summary?: string; project: Project }>(
        `/api/projects/${pid}/readme-summary`,
        'POST',
        { mode },
      );
      if (isAsyncMode(mode)) {
        // 202 running：落 running 态，下面的 effect 会接管轮询直到收敛
        setProject(r.project);
        toast.info(`已用 ${mode} 开始生成，稍候…`);
      } else {
        setProject((prev) => (prev ? { ...prev, readmeSummary: r.summary ?? prev.readmeSummary } : prev));
        toast.success('简介已更新');
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSummarizing(false);
    }
  };

  // 后台任务收敛前一直轮询（自己触发的、或重进页面时发现已在 running 的都能续上）。
  const pollingRef = useRef(false);
  useEffect(() => {
    if (project?.summaryStatus !== 'running' || pollingRef.current) return;
    pollingRef.current = true;
    pollProjectSummary(pid, { onTick: (p) => setProject(p) })
      .then((final) => {
        if (final.summaryStatus === 'done') toast.success('认知总结已更新');
        else if (final.summaryStatus === 'error') toast.error(final.summaryError ?? '生成失败');
      })
      .catch(() => {})
      .finally(() => {
        pollingRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.summaryStatus, pid]);

  const toggleGroup = (key: string): void => setCollapsed((c) => ({ ...c, [key]: !(c[key] ?? false) }));

  // 置顶/取消置顶（仅 pending 有效）：改完刷新列表，行按新顺序重排
  const pinIssue = async (iid: number, pinned: boolean): Promise<void> => {
    try {
      await api(`/api/projects/${pid}/issues/${iid}/pin`, 'POST', { pinned });
      toast.success(pinned ? '已置顶，优先调度' : '已取消置顶');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  // chat 类型项目：没有 issue 看板，整页渲染对话视图（直链 /p/:pid 落到这里时也隐藏看板）
  if (project?.kind === 'chat') return <ChatView pid={pid} />;

  // 窄屏且已选中 → 整页工作台（顶部返回键回列表）
  if (!wide && selectedId != null) {
    return <IssueWorkbench key={selectedId} pid={pid} iid={selectedId} />;
  }

  const list = (
    <div class="wb-issuelist">
      <div class="wb-list-hd">
        <span class="wb-list-t">任务{issues ? ` · ${issues.length}` : ''}</span>
        <button class="btn sm primary" onClick={() => setCreating(true)}>
          ＋ 新建
        </button>
      </div>
      <div class="wb-groups">
        {issues === null && <Loading />}
        {issues !== null && issues.length === 0 && (
          <div class="empty">还没有 issue，点「＋ 新建」开始。</div>
        )}
        {issues !== null &&
          GROUPS.map((g) => {
            const items = byGroup.get(g.key) ?? [];
            if (items.length === 0) return null;
            // 搜索（#106）：查询非空时全部分组都过滤——零命中组整组隐藏，命中组无视折叠态
            // 强制展开；完成组是搜索入口宿主，零命中也留头（否则清不掉查询）。
            const searching = searchOpen && searchQ.trim() !== '';
            const searched = searching ? filterIssueList(items, searchQ) : items;
            if (searching && searched.length === 0 && !g.searchable) return null;
            const isCollapsed = searching ? false : (collapsed[g.key] ?? false);
            const { rows, page, pages } = g.paged
              ? pageSlice(searched, groupPage[g.key] ?? 0)
              : { rows: searched, page: 0, pages: 1 };
            const setPage = (p: number): void => setGroupPage((m) => ({ ...m, [g.key]: p }));
            return (
              <div class={`wb-group ${g.tone}`} key={g.key}>
                <div class="wb-group-hd">
                  <button class="wb-group-tg" onClick={() => toggleGroup(g.key)}>
                    <span class="wb-group-caret">{isCollapsed ? '▸' : '▾'}</span>
                    <span class="wb-group-nm">{g.label}</span>
                  </button>
                  {g.searchable && (
                    <button
                      class={`wb-group-srch${searchOpen ? ' on' : ''}`}
                      title="搜索全部 issue"
                      onClick={() => {
                        if (searchOpen) {
                          setSearchOpen(false);
                          setSearchQ(''); // 收起即退出搜索态，各组恢复原样
                        } else {
                          setSearchOpen(true);
                          setCollapsed((m) => ({ ...m, [g.key]: false })); // 展开宿主组，输入框可见
                        }
                      }}
                    >
                      🔍
                    </button>
                  )}
                  <span class="wb-group-cnt">{searching ? searched.length : items.length}</span>
                </div>
                {g.searchable && searchOpen && (
                  <input
                    class="wb-group-search"
                    type="search"
                    placeholder="搜全部 issue：标题 / #编号 / 模块"
                    value={searchQ}
                    autofocus
                    onInput={(e) => {
                      setSearchQ(e.currentTarget.value);
                      setGroupPage({}); // 所有组重新过滤，页码一起回第一页
                    }}
                  />
                )}
                {!isCollapsed && (
                  <>
                    {rows.map((i) => (
                      <IssueRow
                        key={i.id}
                        issue={i}
                        active={i.id === selectedId}
                        onOpen={() => nav(`/p/${pid}/issue/${i.id}`)}
                        onPin={(p) => void pinIssue(i.id, p)}
                      />
                    ))}
                    {searching && g.searchable && searched.length === 0 && (
                      <div class="wb-group-empty mut small">本组没有匹配「{searchQ.trim()}」的 issue</div>
                    )}
                    {pages > 1 && (
                      <div class="wb-group-pager">
                        <button class="linkbtn" disabled={page === 0} onClick={() => setPage(page - 1)}>
                          ‹ 上一页
                        </button>
                        <span class="mut small">
                          {page + 1}/{pages}
                        </span>
                        <button class="linkbtn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                          下一页 ›
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );

  return (
    <div class="fullcol wb-board">
      <div class="bhead">
        <div class="bhead-row">
          <button class="back" onClick={() => nav('/')}>
            ‹
          </button>
          <span class="btitle">{project?.name ?? `项目 #${pid}`}</span>
          <div class="bacts">
            {/* 项目对话模式入口：切到 chat 视图（chat 类型项目已在上方整页渲染，不会走到这里） */}
            <button class="btn sm" onClick={() => nav(`/p/${pid}/chat`)}>
              对话
            </button>
            <button class="btn sm" onClick={toggleSub} disabled={subscribed === null}>
              {subscribed ? '已订阅 ✓' : '订阅'}
            </button>
            <button class="btn sm" onClick={() => setMembersOpen(true)}>
              成员
            </button>
            <button class="btn sm" onClick={() => setModulesOpen(true)}>
              模块
              {hasPendingSuggestion(orgStatus, readOrganizeDismissedTs(pid)) && (
                <span class="merge-dot" title="有模块整理方案待确认">
                  ✨
                </span>
              )}
            </button>
            <SummaryButton
              status={project?.summaryStatus}
              busy={summarizing}
              onPick={(mode) => void updateSummary(mode)}
              models={SUMMARY_MODELS.filter(
                (m) => m.mode === 'llm' || supportedAgents.includes(m.mode as AgentKind),
              )}
            />
            <button class="btn sm" onClick={() => nav(`/p/${pid}/term`)}>
              原生 Bash
            </button>
            <button class="btn sm" onClick={() => nav(`/p/${pid}/files`)}>
              文件
            </button>
            <button class="btn sm" onClick={() => nav(`/p/${pid}/git`)}>
              Git
            </button>
            <button class="btn sm" onClick={() => nav(`/p/${pid}/skills`)}>
              技能
            </button>
          </div>
        </div>
        {project?.goal && <div class="bgoal">🎯 {project.goal}</div>}
        {project?.readmeSummary && <div class="bgoal">📖 {project.readmeSummary}</div>}
        {project?.understanding && (
          <details class="understanding">
            <summary>
              🧠 认知总结
              {project.understandingAgent ? `（${project.understandingAgent}）` : ''}
            </summary>
            <div class="understanding-body">{project.understanding}</div>
          </details>
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
          <ListSplitter containerRef={splitRef} list={listW} label="任务列表栏宽" />
          <div class="wb-main">
            {selectedId != null ? (
              <IssueWorkbench key={selectedId} pid={pid} iid={selectedId} embedded />
            ) : (
              <div class="gd-empty">← 选择一个 issue 开工</div>
            )}
          </div>
        </div>
      ) : (
        <div class="wb-list-full">{list}</div>
      )}

      {creating && (
        <NewIssueModal
          pid={pid}
          supportedAgents={supportedAgents}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}

      {membersOpen && <MembersModal pid={pid} onClose={() => setMembersOpen(false)} />}

      {modulesOpen && (
        <ModulesPanel
          pid={pid}
          supportedAgents={supportedAgents}
          issues={issues ?? []}
          onChanged={() => {
            load();
            api<OrganizeStatus>(`/api/projects/${pid}/modules/organize`)
              .then(setOrgStatus)
              .catch(() => {});
          }}
          onClose={() => setModulesOpen(false)}
        />
      )}
    </div>
  );
}

function IssueRow({
  issue,
  active,
  onOpen,
  onPin,
}: {
  issue: Issue;
  active: boolean;
  onOpen: () => void;
  onPin?: (pinned: boolean) => void;
}) {
  const review = issue.status === 'plan_review' || issue.status === 'merge_review';
  // 等待你澄清压过其它色带（#110）：这条不是在跑，是停下来等你——列表上必须一眼分得出来
  const tone = issue.awaitingClarify
    ? ' clarify'
    : review
      ? ' review'
      : issue.status === 'blocked'
        ? ' blocked'
        : ['planning', 'implementing', 'testing', 'merging'].includes(issue.status)
          ? ' doing'
          : '';
  const pinned = issue.pinnedTs != null;
  const canPin = issue.status === 'pending'; // 置顶只影响待办排队
  return (
    <button class={`wb-row${tone}${active ? ' on' : ''}${pinned ? ' pinned' : ''}`} onClick={onOpen}>
      <div class="wb-row-t">
        {pinned && canPin && <span class="wb-pin-flag" title="已置顶">📌</span>}
        <span class="wb-row-id mono">#{issue.id}</span> {issue.title}
      </div>
      <div class="wb-row-m">
        <StatusBadge status={issue.status} awaitingClarify={issue.awaitingClarify} />
        {issue.waitingInput && <WaitingBadge />}
        {/* awaitingClarify 已由状态徽标覆盖显示，这里不再重复挂一个「澄清待答」 */}
        {issue.clarifyPending && !issue.awaitingClarify && (
          <span class="badge b-amber" title="执行代理分析后有问题想确认（不回也不影响排队执行）">
            ❓ 澄清待答
          </span>
        )}
        {issue.module && <span class="badge b-gray">{issue.module}</span>}
        {issue.agent === 'codex' && <span class="badge b-ai">codex</span>}
        <span class="badge b-gray" title={`创建者：${issue.createdByName || '—'}`}>
          👤 {issue.createdByName || '—'}
        </span>
        <span class="wb-row-time">{timeAgo(issue.createdTs)}</span>
        {canPin && onPin && (
          <span
            class={`wb-pin${pinned ? ' on' : ''}`}
            role="button"
            title={pinned ? '取消置顶' : '置顶（优先调度）'}
            onClick={(e) => {
              e.stopPropagation();
              onPin(!pinned);
            }}
          >
            {pinned ? '📌 取消置顶' : '📌 置顶'}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * 项目成员管理弹窗（#99 重设计，wide + .memrow 紧凑行）：列出属主 + 成员，每行带
 * 活跃时间（最近登录/最后使用）与项目内 issue 统计；属主/admin 可「候选下拉添加」、
 * 「设为属主」（转让，原属主降为成员）与「移除」，其余只读查看。
 * canManage 由当前用户与属主行对比得出（无需父级传 me）。
 */
function MembersModal({ pid, onClose }: { pid: number; onClose: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [cands, setCands] = useState<MemberCandidate[]>([]);
  const [sel, setSel] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    listMembers(pid)
      .then((r) => setMembers(r.members))
      .catch((e: Error) => setErr(e.message));
  };
  useEffect(() => {
    api<Me>('/api/me')
      .then(setMe)
      .catch(() => {});
    load();
  }, [pid]);

  const owner = members?.find((m) => m.role === 'owner');
  const canManage = !!me && !!owner && (me.role === 'admin' || me.id === owner.userId);

  // 候选名单（下拉添加用；接口 project-owner 级，只有能管理的人才拉）；成员变动后重拉
  useEffect(() => {
    if (!canManage) return;
    listMemberCandidates(pid)
      .then((r) => setCands(r.candidates))
      .catch(() => setCands([]));
  }, [pid, canManage, members]);

  const add = async (): Promise<void> => {
    const u = sel.trim();
    if (!u || busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await addMember(pid, u);
      setSel('');
      if (r.added) toast.success(`已添加成员 ${r.member.username}`);
      else toast.info(`${r.member.username} 已是成员`);
      load();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: ProjectMember): Promise<void> => {
    if (busy || !confirm(`移除成员 ${m.username}？`)) return;
    setBusy(true);
    setErr('');
    try {
      await removeMember(pid, m.userId);
      toast.success(`已移除 ${m.username}`);
      load();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  const makeOwner = async (m: ProjectMember): Promise<void> => {
    if (busy || !confirm(`把属主转让给 ${m.username}？原属主将降为成员。`)) return;
    setBusy(true);
    setErr('');
    try {
      await transferOwner(pid, m.userId);
      toast.success(`已把属主转让给 ${m.username}`);
      load();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  // 活跃时间：一行小字（挤压省略），完整时刻放 title
  const actLine = (m: ProjectMember): string =>
    `登录 ${m.lastLoginTs ? timeAgo(m.lastLoginTs) : '从未'} · 活跃 ${m.lastSeenTs ? timeAgo(m.lastSeenTs) : '从未'}`;
  const actTitle = (m: ProjectMember): string =>
    `最近登录：${m.lastLoginTs ? fmtTime(m.lastLoginTs) : '从未'}\n最后使用：${m.lastSeenTs ? fmtTime(m.lastSeenTs) : '从未'}`;

  return (
    <Modal title="项目成员" wide onClose={onClose}>
      <div class="formcol">
        {members === null ? (
          <div class="mut">加载中…</div>
        ) : (
          <div class="memlist">
            {members.map((m) => (
              <div class="memrow" key={m.userId}>
                <div class="memrow-main">
                  <span class="memrow-name">👤 {m.username}</span>
                  <span class={`badge ${m.role === 'owner' ? 'b-amber' : 'b-gray'}`}>
                    {m.role === 'owner' ? '属主' : '成员'}
                  </span>
                </div>
                <span class="memrow-meta" title={actTitle(m)}>
                  {actLine(m)}
                </span>
                <span class="memrow-stat" title="本项目内创建的 issue（完成/总数）">
                  issue {m.issueDone}/{m.issueTotal}
                </span>
                {canManage && m.role === 'member' && (
                  <div class="memrow-acts">
                    <button class="memrow-act" disabled={busy} onClick={() => void makeOwner(m)}>
                      设为属主
                    </button>
                    <button class="memrow-act danger" disabled={busy} onClick={() => void remove(m)}>
                      移除
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {canManage ? (
          <div class="row">
            <select class="grow" value={sel} onChange={(e) => setSel(e.currentTarget.value)}>
              <option value="">{cands.length ? '选择要添加的用户…' : '（没有可添加的用户）'}</option>
              {cands.map((c) => (
                <option key={c.id} value={c.username}>
                  {c.username}
                </option>
              ))}
            </select>
            <button class="btn primary" disabled={busy || !sel} onClick={() => void add()}>
              添加
            </button>
          </div>
        ) : (
          members !== null && <div class="mut small">仅项目属主或管理员可增删成员。</div>
        )}
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}

function NewIssueModal({
  pid,
  supportedAgents,
  onClose,
  onCreated,
}: {
  pid: number;
  supportedAgents: AgentKind[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<IssueCategory>('task');
  const [module, setModule] = useState('');
  const [modules, setModules] = useState<ProjectModule[]>([]);
  const [agent, setAgent] = useState<AgentKind>('claude');
  // 批准档位（#115）：初值 = 本机上次新建用的那档（没记录 → medium）
  const [autoApprove, setAutoApprove] = useState<AutoApproveLevel>(readNewIssueAutoApprove);
  const [team, setTeam] = useState(false);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [gitBranch, setGitBranch] = useState<IssueGitBranchValue>({
    targetBranch: '',
    sourceRef: '',
  });
  const [gitBranchLoading, setGitBranchLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const uploading = images.some((im) => im.rel === null && !im.error);
  const selectedModule = modules.find((m) => m.slug === module.trim() || m.displayName === module.trim());
  const effectiveAgent = selectedModule?.agent ?? agent;
  const agentUnavailable = !supportedAgents.includes(effectiveAgent);

  useEffect(() => {
    const next = reconcileAgent(agent, supportedAgents);
    if (next) setAgent(next);
  }, [supportedAgents]);

  useEffect(() => {
    void api<{ modules: ProjectModule[] }>(`/api/projects/${pid}/modules`)
      .then((r) => setModules(r.modules))
      .catch(() => setModules([]));
  }, [pid]);

  const submit = async (): Promise<void> => {
    if (!title.trim() || busy || gitBranchLoading || uploading || agentUnavailable) return;
    setBusy(true);
    setErr('');
    try {
      await api(`/api/projects/${pid}/issues`, 'POST', {
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        category,
        ...(selectedModule
          ? { moduleId: selectedModule.id }
          : module.trim()
            ? { moduleName: module.trim() }
            : {}),
        implMode: team ? 'team' : 'seq',
        agent,
        autoApprove,
        ...issueGitBranchPayload(gitBranch),
        images: images.map((im) => im.rel).filter((r): r is string => r !== null),
      });
      writeNewIssueAutoApprove(autoApprove); // 建成了才记：改了档又取消的不算「上次选的」
      onCreated();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  return (
    <Modal title="新建 issue" onClose={onClose}>
      <div class="formcol">
        <label class="field">
          标题
          <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} placeholder="要做什么？" />
        </label>
        <label class="field">
          详情（可选）
          <textarea rows={3} value={body} onInput={(e) => setBody(e.currentTarget.value)} placeholder="背景 / 验收标准 / 复现步骤…" />
        </label>
        <div class="row">
          <label class="field grow">
            类别
            <select value={category} onChange={(e) => setCategory(e.currentTarget.value as IssueCategory)}>
              <option value="task">任务</option>
              <option value="design">设计</option>
              <option value="debug">DEBUG</option>
            </select>
          </label>
          <label class="field grow">
            模块（可选）
            <ModuleSelect
              modules={modules}
              value={module}
              onChange={(value) => {
                setModule(value);
                const picked = modules.find((m) => m.slug === value.trim() || m.displayName === value.trim());
                if (picked) setAgent(picked.agent);
              }}
              placeholder="留空自动归类，或选择模块"
            />
          </label>
        </div>
        <label class="field">
          执行代理
          <select
            value={selectedModule?.agent ?? agent}
            disabled={Boolean(selectedModule)}
            onChange={(e) => setAgent(e.currentTarget.value as AgentKind)}
          >
            {supportedAgents.map((a) => (
              <option key={a} value={a}>{a === 'claude' ? 'Claude Code' : 'Codex'}</option>
            ))}
          </select>
          {selectedModule && <span class="mut small">该模块固定使用 {selectedModule.agent}</span>}
          {agentUnavailable && <span class="err small">该模块/Agent 未在项目执行机上启用</span>}
        </label>
        <IssueGitBranchFields
          pid={pid}
          value={gitBranch}
          onChange={setGitBranch}
          onLoadingChange={setGitBranchLoading}
        />
        {/* 批准档位（#115）：与执行页顶栏同一个切换钮，档位说明也一并复用，建完还能在详情页改 */}
        <div class="nia-aa">
          <AutoApproveSwitch level={autoApprove} onChange={setAutoApprove} />
          <span class="mut small">记住这台设备上次选的档位</span>
        </div>
        <label class="chkrow">
          <input type="checkbox" checked={team} onChange={(e) => setTeam(e.currentTarget.checked)} />
          团队模式（子任务并行，默认串行）
        </label>
        <ImageAttach projectId={pid} images={images} onChange={setImages} />
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          取消
        </button>
        <button
          class="btn primary"
          disabled={busy || gitBranchLoading || uploading || !title.trim() || agentUnavailable}
          onClick={submit}
        >
          {busy
            ? '创建中…'
            : gitBranchLoading
              ? '读取分支中…'
              : uploading
                ? '图片上传中…'
                : '创建'}
        </button>
      </div>
    </Modal>
  );
}
