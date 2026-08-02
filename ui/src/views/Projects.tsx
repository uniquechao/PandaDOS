/**
 * 项目列表 + 建项目（空白/git clone）+ 导入现有 tmux 会话。
 * - GET /api/projects（普通用户只见自己的；admin 全量）
 * - GET /api/executors（登录即可见的极简执行机列表 → 下拉）
 * - GET /api/executors/:id/os-users（admin；Linux 用户下拉）
 * - GET /api/executors/:id/fs?path=（建项目 cwd 目录浏览）
 * - POST /api/executors/:id/fs/mkdir（新建目录）
 * - GET /api/executors/:id/tmux-sessions（导入候选 + 托管/已导入/越权标注）
 * - POST /api/projects {name?, executorId, gitUrl?, goal?, cwd?, runUser?, withConversation?}
 * - POST /api/projects/import {executorId, session, name?, goal?, runUser?}
 */
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import { nav } from '../lib/router';
import { timeAgo } from '../lib/fmt';
import { aggregateSummary } from '../lib/summary';
import { projAvatar } from '../lib/projcolor';
import { removeFavorite, useFavorites } from '../lib/favorites';
import { removeRecent } from '../lib/recent';
import { isAsyncMode, SUMMARY_MODELS, type SummaryMode } from '../lib/summaryModes';
import { pollProjectSummary } from '../lib/pollSummary';
import { SummaryButton } from '../components/SummaryButton';
import type {
  ExecutorLite,
  Me,
  OsUser,
  Project,
  ProjectIssueSummary,
  ProjectsSummary,
  TmuxSessionInfo,
} from '../lib/types';
import { Modal } from '../components/Modal';
import { SkeletonCards } from '../components/Loaders';
import { toast } from '../lib/toast';
import { DirPicker } from '../components/DirPicker';
import { tr } from '../i18n/runtime';

/** 与后端 projectSlug 同规则（默认 cwd 预览用） */
function slug(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return s || 'proj';
}

/** 执行机下拉（登录即可用；空列表回退数字输入） */
function useExecutors(): ExecutorLite[] | null {
  const [executors, setExecutors] = useState<ExecutorLite[] | null>(null);
  useEffect(() => {
    api<ExecutorLite[]>('/api/executors')
      .then(setExecutors)
      .catch(() => setExecutors([]));
  }, []);
  return executors;
}

/** admin 才拉 os-users（普通用户接口 403，也不展示下拉） */
function useOsUsers(isAdmin: boolean, executorId: string): OsUser[] {
  const [users, setUsers] = useState<OsUser[]>([]);
  useEffect(() => {
    const eid = Number(executorId);
    if (!isAdmin || !Number.isInteger(eid) || eid <= 0) {
      setUsers([]);
      return;
    }
    api<{ ok: boolean; users: OsUser[] }>(`/api/executors/${eid}/os-users`)
      .then((r) => setUsers(r.users ?? []))
      .catch(() => setUsers([]));
  }, [isAdmin, executorId]);
  return users;
}

function ExecutorSelect({
  executors,
  value,
  onChange,
}: {
  executors: ExecutorLite[] | null;
  value: string;
  onChange: (v: string) => void;
}) {
  if (executors !== null && executors.length > 0) {
    return (
      <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {executors.map((x) => (
          <option key={x.id} value={String(x.id)} disabled={!x.availableForProjects}>
            {x.name} · {x.supportedAgents.join(' / ') || tr('project.noAgent')}
            {x.status === 'online' ? ` · ${tr('status.online')}` : ''}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      inputMode="numeric"
      value={value}
      onInput={(e) => onChange(e.currentTarget.value)}
      placeholder={tr('project.executorIdPlaceholder')}
    />
  );
}

function RunUserSelect({
  osUsers,
  value,
  onChange,
}: {
  osUsers: OsUser[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (osUsers.length === 0) return null;
  return (
    <label class="field">
      {tr('project.linuxUser')}
      <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">{tr('project.followExecutor')}</option>
        {osUsers.map((u) => (
          <option key={u.name} value={u.name}>
            {u.name}（{u.home}）
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * 迁移工程目录（admin 专属）：POST /api/projects/:id/cwd-migrate。
 * 目标 = 「父目录（复用 DirPicker 浏览选定）+ 目录名」——后端要求目标不存在，
 * 所以不让直接选既有目录；嵌套/已存在/执行中 issue 等前置校验错误由后端返回原样展示。
 */
function CwdMigrateModal({
  p,
  onClose,
  onMigrated,
}: {
  p: Project;
  onClose: () => void;
  onMigrated: (proj: Project) => void;
}) {
  const cwd = p.cwd.replace(/\/+$/, '') || '/';
  const cut = cwd.lastIndexOf('/');
  const [parent, setParent] = useState(cut > 0 ? cwd.slice(0, cut) : '/');
  const [name, setName] = useState(cwd.slice(cut + 1));
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const dest = `${parent === '/' ? '' : parent}/${name.trim()}`;
  const canGo = !!name.trim() && !busy;

  const go = async (): Promise<void> => {
    if (!canGo) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ ok: boolean; project: Project; killedSessions: string[] }>(
        `/api/projects/${p.id}/cwd-migrate`,
        'POST',
        { dest },
      );
      toast.success(tr('project.migratedTo', {
        cwd: r.project.cwd,
        sessions: r.killedSessions.length ? tr('project.closedSessions', { count: r.killedSessions.length }) : '',
      }));
      onMigrated(r.project);
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={tr('project.migrateWorkspace')} onClose={onClose}>
      <div class="formcol">
        <div class="mut small">
          {tr('project.currentDirectory')} <code style={{ wordBreak: 'break-all' }}>{cwd}</code>
        </div>
        <div class="row" style={{ gap: 6, alignItems: 'center' }}>
          <code class="grow" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {parent}
          </code>
          <button class="btn sm" onClick={() => setPicking(true)}>
            {tr('project.browse')}…
          </button>
        </div>
        <input
          class="grow"
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
          placeholder={tr('project.targetDirectoryName')}
        />
        <div class="mut small">
          {tr('project.moveTo')} <code style={{ wordBreak: 'break-all' }}>{dest}</code>
        </div>
        <div class="mut small">
          ⚠️ {tr('project.migrateWarning')}
        </div>
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          {tr('ui.cancel')}
        </button>
        <button class="btn primary" disabled={!canGo} onClick={() => void go()}>
          {busy ? tr('project.migrating') : tr('project.startMigration')}
        </button>
      </div>
      {picking && (
        <DirPicker
          executorId={p.executorId}
          start={parent}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setParent(path.replace(/\/+$/, '') || '/');
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}

type ProjFilter = 'all' | 'active' | 'archived';

export function ProjectsView({ me }: { me: Me }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [sum, setSum] = useState<Record<string, ProjectIssueSummary>>({});
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ProjFilter>('active');
  const [summaryBusy, setSummaryBusy] = useState<Set<number>>(new Set());
  const [migrating, setMigrating] = useState<Project | null>(null);
  // 空闲时的每日欢迎语：默认静态兜底，挂载后拉 LLM 生成的当天欢迎语覆盖（失败/加载中仍用兜底）
  const [greeting, setGreeting] = useState(() => tr('project.greeting'));
  const { isFav, toggle: toggleFav } = useFavorites();
  const executors = useExecutors();

  const load = (): void => {
    api<Project[]>('/api/projects')
      .then(setProjects)
      .catch((e: Error) => setErr(e.message));
    api<ProjectsSummary>('/api/projects/summary')
      .then((r) => setSum(r.projects))
      .catch(() => {}); // 角标是锦上添花，挂了不挡列表
    api<{ text: string }>('/api/greeting')
      .then((r) => r.text && setGreeting(r.text))
      .catch(() => {}); // 欢迎语拉不到就用静态兜底
  };
  useEffect(load, []);

  // 就地替换列表里某项目（轮询回调/生成完成后刷新卡片简介与状态）
  const patchProject = (id: number, patch: Partial<Project>): void =>
    setProjects((prev) => (prev ? prev.map((x) => (x.id === id ? { ...x, ...patch } : x)) : prev));

  // 手动「更新简介」：llm 同步（驱动大模型 读 README）；claude/codex 启动后台 Agent 认知总结并轮询。
  const updateSummary = async (p: Project, mode: SummaryMode): Promise<void> => {
    setSummaryBusy((s) => new Set(s).add(p.id));
    try {
      const r = await api<{ ok: boolean; summary?: string; project: Project }>(
        `/api/projects/${p.id}/readme-summary`,
        'POST',
        { mode },
      );
      if (isAsyncMode(mode)) {
        patchProject(p.id, r.project); // 落 running 态
        toast.info(tr('project.startedSummary', { mode }));
        const final = await pollProjectSummary(p.id, { onTick: (pp) => patchProject(p.id, pp) });
        if (final.summaryStatus === 'done') toast.success(tr('project.knowledgeUpdated'));
        else if (final.summaryStatus === 'error') toast.error(final.summaryError ?? tr('project.generationFailed'));
      } else {
        patchProject(p.id, { readmeSummary: r.summary ?? p.readmeSummary });
        toast.success(tr('project.summaryUpdated'));
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSummaryBusy((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
    }
  };

  // 项目级管理面（归档/启用）仅属主/admin 可见——与后端 auth:'project-owner' 口径一致
  const canManage = (p: Project): boolean => me.role === 'admin' || p.ownerUserId === me.id;

  // 归档/启用：PATCH status + 确认；归档同时清收藏与最近访问（本地入口不再指向归档项目）
  const setArchived = async (p: Project, archived: boolean): Promise<void> => {
    const verb = archived ? tr('project.archiveVerb') : tr('project.enableVerb');
    const hint = archived ? tr('project.archiveHint') : '';
    if (!confirm(tr('project.archiveConfirm', { verb, name: p.name, hint }))) return;
    try {
      const r = await api<{ ok: boolean; project: Project }>(`/api/projects/${p.id}`, 'PATCH', {
        status: archived ? 'archived' : 'active',
      });
      patchProject(p.id, r.project);
      if (archived) {
        removeFavorite(p.id);
        removeRecent(p.id);
      }
      toast.success(tr('project.archiveSuccess', { verb, name: p.name }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const all = projects ?? [];
  const activeProjects = all.filter((p) => p.status === 'active');
  const activeCount = activeProjects.length;
  const archivedCount = all.filter((p) => p.status === 'archived').length;
  // 统计卡口径：进行中/待确认任务总数按活跃项目聚合（归档不计）
  const agg = aggregateSummary(sum, activeProjects.map((p) => p.id));
  const FILTERS: { key: ProjFilter; label: string; n: number }[] = [
    { key: 'all', label: tr('shell.all'), n: all.length },
    { key: 'active', label: tr('project.statusDoing'), n: activeCount },
    { key: 'archived', label: tr('project.archived'), n: archivedCount },
  ];

  // 状态筛选 → 搜索 → 收藏排前：驱动下方网格。全部时活跃在前、归档在后。
  const q = search.trim().toLowerCase();
  const match = (p: Project): boolean =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    (p.goal ?? '').toLowerCase().includes(q) ||
    (p.cwd ?? '').toLowerCase().includes(q);

  const list = filter === 'all' ? all.slice() : all.filter((p) => p.status === filter);
  if (filter === 'all') {
    list.sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
  }
  // 收藏排前（稳定排序：同档保留原序）
  const shown = list.filter(match).sort((a, b) => (isFav(a.id) ? 0 : 1) - (isFav(b.id) ? 0 : 1));
  // 「进行中」筛选下，归档走底部折叠区（其它筛选已把归档并入主网格）
  const archivedShown = all.filter((p) => p.status === 'archived' && match(p));

  // 单张项目卡：色块图标 + 状态点 + 语义标签 + 描述 + cwd + 时间 + hover 快捷操作 + 右上收藏星
  const card = (p: Project) => {
    const s = sum[p.id];
    const av = projAvatar(p);
    const fav = isFav(p.id);
    const doingN = s?.doing ?? 0;
    const summarizing = summaryBusy.has(p.id);
    return (
      <div
        key={p.id}
        class={'pcard' + (p.status === 'archived' ? ' archived' : '')}
        onClick={() => nav(p.kind === 'chat' ? `/p/${p.id}/chat` : `/p/${p.id}`)}
      >
        <div class="pcard-top">
          <span class="pcard-ic" style={{ background: av.bg, color: av.fg }}>
            {av.initial}
          </span>
          <div class="pcard-hd">
            <div class="pcard-nm">
              <span
                class={'pcard-dot' + (doingN > 0 ? ' run' : '')}
                title={doingN > 0 ? tr('shell.runningCount', { count: doingN }) : tr('status.online')}
              />
              <b>{p.name}</b>
            </div>
            <div class="pcard-badges">
              {p.kind === 'chat' && <span class="badge b-purple">{tr('view.conversation')}</span>}
              {p.status === 'archived' && <span class="badge b-gray">{tr('project.archived')}</span>}
              {!!s && s.review > 0 && <span class="badge b-amber">{tr('project.statusReview')} {s.review}</span>}
              {!!s && s.doing > 0 && <span class="badge b-green">{tr('project.statusDoing')} {s.doing}</span>}
              {!!s && s.todo > 0 && <span class="badge b-gray">{tr('project.statusTodo')} {s.todo}</span>}
              {!!s && s.blocked > 0 && <span class="badge b-red">{tr('project.statusBlocked')} {s.blocked}</span>}
              {p.runUser && <span class="badge b-blue">@{p.runUser}</span>}
            </div>
          </div>
          <span
            class={'pcard-star' + (fav ? ' on' : '')}
            role="button"
            title={fav ? tr('shell.unfavorite') : tr('shell.favorite')}
            onClick={(e) => {
              e.stopPropagation();
              toggleFav(p.id);
            }}
          >
            {fav ? '★' : '☆'}
          </span>
        </div>
        {p.goal && <div class="pcard-desc">{p.goal}</div>}
        {p.readmeSummary && <div class="pcard-desc sub">{p.readmeSummary}</div>}
        <div class="pcard-cwd">{p.cwd}</div>
        <div class="pcard-ft">
          <span class="pcard-time">{timeAgo(p.createdTs)}</span>
          <div class="pcard-acts">
            <SummaryButton
              status={p.summaryStatus}
              busy={summarizing}
              btnClass="pcard-act"
              onPick={(mode) => void updateSummary(p, mode)}
              models={SUMMARY_MODELS.filter((m) => {
                if (m.mode === 'llm') return true;
                const ex = executors?.find((x) => x.id === p.executorId);
                return ex?.supportedAgents.includes(m.mode as 'claude' | 'codex') ?? false;
              })}
            />
            {/* issue 项目：项目级自由对话入口（chat 项目整卡即进对话，无需此按钮） */}
            {p.kind !== 'chat' && (
              <button
                class="pcard-act"
                onClick={(e) => {
                  e.stopPropagation();
                  nav(`/p/${p.id}/chat`);
                }}
              >
                {tr('view.conversation')}
              </button>
            )}
            <button
              class="pcard-act"
              onClick={(e) => {
                e.stopPropagation();
                nav(`/p/${p.id}/term`);
              }}
            >
              {tr('view.nativeBash')}
            </button>
            <button
              class="pcard-act"
              onClick={(e) => {
                e.stopPropagation();
                nav(`/p/${p.id}/files`);
              }}
            >
              {tr('view.files')}
            </button>
            <button
              class="pcard-act"
              onClick={(e) => {
                e.stopPropagation();
                nav(`/p/${p.id}/git`);
              }}
            >
              Git
            </button>
            {canManage(p) && (
              <button
                class="pcard-act"
                onClick={(e) => {
                  e.stopPropagation();
                  void setArchived(p, p.status !== 'archived');
                }}
              >
                {p.status === 'archived' ? tr('project.enableVerb') : tr('project.archiveVerb')}
              </button>
            )}
            {me.role === 'admin' && (
              <button
                class="pcard-act"
                title={tr('project.migrateAdmin')}
                onClick={(e) => {
                  e.stopPropagation();
                  setMigrating(p);
                }}
              >
                {tr('project.migrateWorkspace')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div class="page">
      <div class="ph-head">
        <h1 class="ph-title">{tr('shell.projects')}</h1>
        <input
          class="ph-search"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
          placeholder={tr('shell.searchProjects')}
          aria-label={tr('shell.searchProjects')}
        />
        <div class="ph-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              class={'subtab' + (filter === f.key ? ' on' : '')}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span class="cnt">{f.n}</span>
            </button>
          ))}
        </div>
        <div class="ph-acts">
          <button class="btn sm" onClick={() => setImporting(true)}>
            {tr('project.importTmuxShort')}
          </button>
          <button class="btn primary sm" onClick={() => setCreating(true)}>
            ＋ {tr('project.newProject')}
          </button>
        </div>
      </div>
      {err && <div class="err">{err}</div>}
      {projects === null && !err && <SkeletonCards count={4} />}
      {projects !== null && all.length > 0 && (
        <div class="ph-hero">
          <div class="ph-welcome">
            <span class="avatar ph-welcome-av">{(me.username[0] ?? '?').toUpperCase()}</span>
            <div class="ph-welcome-tx">
              <div class="ph-welcome-hi">{tr('project.welcomeBack', { name: me.username })}</div>
              <div class="ph-welcome-sub">
                {agg.review > 0
                  ? tr('project.reviewAttention', { count: agg.review })
                  : agg.doing > 0
                    ? tr('project.tasksRunning', { count: agg.doing })
                    : greeting}
              </div>
            </div>
          </div>
          <div class="ph-stats">
            <div class="ph-stat">
              <span class="ph-stat-ic">📁</span>
              <div>
                <div class="ph-stat-n">{activeCount}</div>
                <div class="ph-stat-l">{tr('shell.projects')}</div>
              </div>
            </div>
            <div class="ph-stat run">
              <span class="ph-stat-ic">⚙️</span>
              <div>
                <div class="ph-stat-n">{agg.doing}</div>
                <div class="ph-stat-l">{tr('project.statusDoing')}</div>
              </div>
            </div>
            <div class="ph-stat rv">
              <span class="ph-stat-ic">🔔</span>
              <div>
                <div class="ph-stat-n">{agg.review}</div>
                <div class="ph-stat-l">{tr('project.statusReview')}</div>
              </div>
            </div>
          </div>
        </div>
      )}
      {projects !== null && all.length === 0 && (
        <div class="empty">
          {tr('project.noProjects')}
          <br />
          {tr('project.noProjectsHelp')}
        </div>
      )}
      {projects !== null &&
        all.length > 0 &&
        shown.length === 0 &&
        !(filter === 'active' && archivedShown.length > 0) && (
          <div class="empty">{tr('project.noMatches', { query: q ? tr('project.searchSuffix', { query: search.trim() }) : '' })}</div>
        )}
      <div class="ph-grid stagger">{shown.map(card)}</div>
      {filter === 'active' && archivedShown.length > 0 && (
        <details class="ph-archived">
          <summary>{tr('project.archivedCount', { count: archivedShown.length })}</summary>
          <div class="ph-grid">{archivedShown.map(card)}</div>
        </details>
      )}
      {creating && (
        <CreateProjectModal
          isAdmin={me.role === 'admin'}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            load();
            nav(`/p/${p.id}`);
          }}
        />
      )}
      {importing && (
        <ImportTmuxModal
          isAdmin={me.role === 'admin'}
          onClose={() => setImporting(false)}
          onImported={(p) => {
            setImporting(false);
            load();
            nav(`/p/${p.id}`);
          }}
        />
      )}
      {migrating && (
        <CwdMigrateModal
          p={migrating}
          onClose={() => setMigrating(null)}
          onMigrated={(proj) => patchProject(proj.id, proj)}
        />
      )}
    </div>
  );
}

function CreateProjectModal({
  isAdmin,
  onClose,
  onCreated,
}: {
  isAdmin: boolean;
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [kind, setKind] = useState<'issue' | 'chat'>('issue');
  const [source, setSource] = useState<'blank' | 'git'>('blank');
  const [gitUrl, setGitUrl] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [cwd, setCwd] = useState('');
  const [workBranch, setWorkBranch] = useState('');
  const [picking, setPicking] = useState(false);
  const executors = useExecutors();
  const [executorId, setExecutorId] = useState('');
  const [runUser, setRunUser] = useState('');
  const [withConv, setWithConv] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const osUsers = useOsUsers(isAdmin, executorId);

  useEffect(() => {
    if (executors && !executorId) {
      const preferred = executors.find((x) => x.availableForProjects);
      if (preferred) setExecutorId(String(preferred.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executors]);

  // git 源：未手动改过项目名时，用仓库地址 basename 自动填（basename 去 .git，过 slug）
  const repoName = (): string => {
    const seg = gitUrl.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
    return slug(seg.replace(/\.git$/i, '') || 'repo');
  };
  const effName = name.trim() || (source === 'git' && gitUrl.trim() ? repoName() : '');

  // 选了 Linux 用户且没手填 cwd → 项目落到该用户家目录下（预览即实发值）
  const runHome = osUsers.find((u) => u.name === runUser)?.home ?? '';
  const anchoredCwd = runUser && runHome && !cwd.trim() ? `${runHome}/${slug(effName || 'proj')}` : '';

  const submit = async (): Promise<void> => {
    const eid = Number(executorId);
    if (!effName || !Number.isInteger(eid) || eid <= 0 || busy) return;
    if (source === 'git' && !gitUrl.trim()) {
      setErr(tr('project.gitRequired'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ ok: boolean; project: Project; cloned?: boolean; warnings?: string[] }>(
        '/api/projects',
        'POST',
        {
          ...(name.trim() ? { name: name.trim() } : {}),
          executorId: eid,
          ...(source === 'git' && gitUrl.trim() ? { gitUrl: gitUrl.trim() } : {}),
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          kind,
          ...(cwd.trim() ? { cwd: cwd.trim() } : anchoredCwd ? { cwd: anchoredCwd } : {}),
          ...(runUser ? { runUser } : {}),
          // 对话模式无 issue 分支概念，也不在这里建（issue 型）对话——对话在对话视图里建
          ...(kind === 'chat' ? {} : workBranch.trim() ? { workBranch: workBranch.trim() } : {}),
          withConversation: kind === 'chat' ? false : withConv,
        },
      );
      if (r.cloned) toast.success(tr('project.clonedCreated'));
      if (r.warnings?.length) toast.warn(tr('project.createdWarnings', { warnings: r.warnings.join('\n') }));
      onCreated(r.project);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  const eid = Number(executorId);
  const canBrowse = Number.isInteger(eid) && eid > 0;

  return (
    <Modal title={tr('project.newProject')} onClose={onClose}>
      <div class="formcol">
        <label class="field">
          {tr('project.projectType')}
          <div class="seg" role="tablist">
            <button class={`seg-btn ${kind === 'issue' ? 'on' : ''}`} onClick={() => setKind('issue')}>
              {tr('project.issueBoard')}
            </button>
            <button class={`seg-btn ${kind === 'chat' ? 'on' : ''}`} onClick={() => setKind('chat')}>
              {tr('view.conversation')}
            </button>
          </div>
        </label>
        {kind === 'chat' && (
          <div class="mut small">{tr('project.chatModeHelp')}</div>
        )}
        <div class="seg" role="tablist">
          <button
            class={`seg-btn ${source === 'blank' ? 'on' : ''}`}
            onClick={() => setSource('blank')}
          >
            {tr('project.blankProject')}
          </button>
          <button class={`seg-btn ${source === 'git' ? 'on' : ''}`} onClick={() => setSource('git')}>
            {tr('project.cloneFromGit')}
          </button>
        </div>
        {source === 'git' && (
          <label class="field">
            {tr('project.gitUrl')}
            <input
              value={gitUrl}
              onInput={(e) => setGitUrl(e.currentTarget.value)}
              placeholder={tr('project.gitUrlPlaceholder')}
            />
          </label>
        )}
        <label class="field">
          {tr('project.projectName')}{source === 'git' && !nameTouched ? tr('project.repoNameDefault') : ''}
          <input
            value={name}
            onInput={(e) => {
              setNameTouched(true);
              setName(e.currentTarget.value);
            }}
            placeholder={source === 'git' && gitUrl.trim() ? repoName() : 'my-project'}
          />
        </label>
        <label class="field">
          {tr('project.executor')}
          <ExecutorSelect executors={executors} value={executorId} onChange={setExecutorId} />
        </label>
        {isAdmin && <RunUserSelect osUsers={osUsers} value={runUser} onChange={setRunUser} />}
        <label class="field">
          {tr('project.goalOptional')}
          <textarea rows={2} value={goal} onInput={(e) => setGoal(e.currentTarget.value)} />
        </label>
        <label class="field">
          {tr('project.locationOptional', { target: source === 'git' ? tr('project.cloneTo') : 'cwd', home: runUser ? tr('project.selectedUserHome') : tr('project.yourWorkspace') })}
          <div class="row" style={{ gap: 6 }}>
            <input
              class="grow"
              value={cwd}
              onInput={(e) => setCwd(e.currentTarget.value)}
              placeholder={anchoredCwd || tr('project.pickDirectory')}
            />
            <button
              type="button"
              class="btn sm"
              disabled={!canBrowse}
              onClick={() => setPicking(true)}
            >
              {tr('project.browse')}
            </button>
          </div>
        </label>
        {kind !== 'chat' && (
          <label class="field">
            {tr('project.workBranch')}
            <input
              value={workBranch}
              onInput={(e) => setWorkBranch(e.currentTarget.value)}
              placeholder={tr('project.branchFallbackHelp')}
            />
          </label>
        )}
        {kind !== 'chat' && (
          <label class="chkrow">
            <input type="checkbox" checked={withConv} onChange={(e) => setWithConv(e.currentTarget.checked)} />
            {tr('project.createConversation')}
          </label>
        )}
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          {tr('ui.cancel')}
        </button>
        <button
          class="btn primary"
          disabled={busy || !effName || !executorId || (source === 'git' && !gitUrl.trim())}
          onClick={submit}
        >
          {busy ? (source === 'git' ? tr('project.cloning') : tr('ui.creating')) : source === 'git' ? tr('project.cloneCreate') : tr('ui.create')}
        </button>
      </div>
      {picking && canBrowse && (
        <DirPicker
          executorId={eid}
          start={cwd.trim()}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setCwd(p);
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}

// ---------- 导入现有 tmux 会话 ----------

function sessionBadge(s: TmuxSessionInfo) {
  if (s.managedProjectId !== null) return <span class="badge b-gray">{tr('project.managed', { id: s.managedProjectId })}</span>;
  if (s.importedProjectId !== null) return <span class="badge b-green">{tr('project.imported', { id: s.importedProjectId })}</span>;
  if (!s.allowed) return <span class="badge b-gray">{tr('project.noPermission')}</span>;
  if (s.sameCwdProjectId !== null) return <span class="badge b-amber">{tr('project.mergeInto', { id: s.sameCwdProjectId })}</span>;
  return null;
}

function ImportTmuxModal({
  isAdmin,
  onClose,
  onImported,
}: {
  isAdmin: boolean;
  onClose: () => void;
  onImported: (p: Project) => void;
}) {
  const executors = useExecutors();
  const [executorId, setExecutorId] = useState('');
  const [sessions, setSessions] = useState<TmuxSessionInfo[] | null>(null);
  const [picked, setPicked] = useState<TmuxSessionInfo | null>(null);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [runUser, setRunUser] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const osUsers = useOsUsers(isAdmin, executorId);

  useEffect(() => {
    if (executors && !executorId) {
      const preferred = executors.find((x) => x.availableForProjects);
      if (preferred) setExecutorId(String(preferred.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executors]);

  useEffect(() => {
    const eid = Number(executorId);
    if (!Number.isInteger(eid) || eid <= 0) return;
    setSessions(null);
    setPicked(null);
    setErr('');
    api<{ ok: boolean; sessions: TmuxSessionInfo[] }>(`/api/executors/${eid}/tmux-sessions`)
      .then((r) => setSessions(r.sessions))
      .catch((e: Error) => {
        setSessions([]);
        setErr(e.message);
      });
  }, [executorId]);

  const pick = (s: TmuxSessionInfo): void => {
    if (s.managedProjectId !== null || !s.allowed) return;
    if (s.importedProjectId !== null) {
      onImported({ id: s.importedProjectId } as Project); // 已导入 → 直接进项目
      return;
    }
    setPicked(s);
    setName(s.name);
    // 会话 cwd 落在某 Linux 用户家目录 → 预选该用户
    const owner = s.cwd ? osUsers.find((u) => s.cwd === u.home || s.cwd!.startsWith(u.home + '/')) : undefined;
    setRunUser(owner && owner.uid !== 0 ? owner.name : '');
  };

  const submit = async (): Promise<void> => {
    const eid = Number(executorId);
    if (!picked || busy || !Number.isInteger(eid) || eid <= 0) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ ok: boolean; project: Project; created: boolean; warnings?: string[] }>(
        '/api/projects/import',
        'POST',
        {
          executorId: eid,
          session: picked.name,
          ...(name.trim() && name.trim() !== picked.name ? { name: name.trim() } : {}),
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          ...(runUser ? { runUser } : {}),
        },
      );
      if (r.warnings?.length) toast.warn(tr('project.importedWarnings', { warnings: r.warnings.join('\n') }));
      if (!r.created) toast.info(tr('project.mergedExisting', { name: r.project.name }));
      onImported(r.project);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
      setBusy(false);
    }
  };

  const importable = (s: TmuxSessionInfo): boolean => s.managedProjectId === null && s.allowed;

  return (
    <Modal title={tr('project.importTmux')} onClose={onClose}>
      <div class="formcol">
        <label class="field">
          {tr('project.executor')}
          <ExecutorSelect executors={executors} value={executorId} onChange={setExecutorId} />
        </label>
        {sessions === null && <div class="mut small">{tr('project.readingSessions')}</div>}
        {sessions !== null && sessions.length === 0 && !err && <div class="empty">{tr('project.noTmuxSessions')}</div>}
        {sessions !== null && sessions.length > 0 && (
          <div style={{ maxHeight: '38vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sessions.map((s) => (
              <div
                key={s.name}
                class={`card ${importable(s) || s.importedProjectId !== null ? 'click' : ''}`}
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  ...(picked?.name === s.name ? { outline: '2px solid var(--accent)' } : {}),
                  ...(importable(s) || s.importedProjectId !== null ? {} : { opacity: 0.55 }),
                }}
                onClick={() => pick(s)}
              >
                <div class="row">
                  <b class="grow" style={{ fontSize: 13 }}>
                    {s.attached ? '🟢 ' : ''}
                    {s.name}
                  </b>
                  {s.command && <span class="badge b-blue">{s.command}</span>}
                  {sessionBadge(s)}
                </div>
                <div class="mut small" style={{ wordBreak: 'break-all' }}>
                  {s.cwd ?? tr('project.cwdUnavailable')} · {timeAgo(s.createdTs * 1000)}
                </div>
              </div>
            ))}
          </div>
        )}
        {picked && (
          <>
            <label class="field">
              {tr('project.projectName')}
              <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
            </label>
            {isAdmin && <RunUserSelect osUsers={osUsers} value={runUser} onChange={setRunUser} />}
            <label class="field">
              {tr('project.goal')}
              <textarea rows={2} value={goal} onInput={(e) => setGoal(e.currentTarget.value)} />
            </label>
            {picked.sameCwdProjectId !== null && (
              <div class="mut small">{tr('project.sameDirectory', { id: picked.sameCwdProjectId })}</div>
            )}
          </>
        )}
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>
          {tr('ui.cancel')}
        </button>
        <button class="btn primary" disabled={busy || !picked || !name.trim()} onClick={submit}>
          {busy ? tr('project.importing') : tr('project.import')}
        </button>
      </div>
    </Modal>
  );
}
