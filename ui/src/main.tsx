/**
 * PandaDOS v2 前端壳（spec §9）：
 * 登录（POST /api/login → GET /api/me）→ hash 路由分发到
 * 项目列表 / 看板 / issue 详情 / 对话 / 终端 / 我的设定 / admin。
 * 401（cookie 失效）任意请求触发全局回登录页。
 */
import { render, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './style.css';
import { api, setOnUnauthorized } from './lib/api';
import { nav, useRoute } from './lib/router';
import type { LlmStatus, Me, Project, ProjectIssueSummary, ProjectsSummary } from './lib/types';
import { llmConfigGuidance } from './lib/llmConfig';
import { aggregateSummary } from './lib/summary';
import { useFavorites } from './lib/favorites';
import { useRecent } from './lib/recent';
import { toast, Toaster } from './lib/toast';
import { onLazyLoadError } from './lib/updatePrompt';
import { Spinner } from './components/Loaders';
import { LoginView } from './views/Login';
import { ProjectsView } from './views/Projects';
import { BoardView } from './views/Board';
import { ChatView } from './views/Chat';
import { FilesView } from './views/Files';
import { GitView } from './views/Git';
import { SkillsView } from './views/Skills';
import { SettingsView } from './views/Settings';
import { ProjectSettingsView } from './views/ProjectSettings';
import { ExternalIssuesView } from './views/ExternalIssues';
import { DesignsView } from './views/Designs';
import { WorkflowTemplatesView } from './views/WorkflowTemplates';
import { AdminView } from './views/Admin';
import { I18nProvider, useI18n } from './i18n/provider';
import packageInfo from '../../package.json';

const APP_VERSION = `v${packageInfo.version}`;

/** 终端视图懒加载（xterm ~300KB，别拖累手机首屏；vite 自动 code-split） */
function LazyTerm({ pid }: { pid: number }) {
  const { t } = useI18n();
  const [Comp, setComp] = useState<((p: { pid: number }) => JSX.Element) | null>(null);
  useEffect(() => {
    import('./views/Term')
      .then((m) => setComp(() => m.TermView))
      .catch(onLazyLoadError);
  }, []);
  return Comp ? <Comp pid={pid} /> : <div class="boot">{t('shell.loadingTerminal')}</div>;
}

/**
 * 侧栏「项目」条目 + 可展开的项目子列表（v1 侧栏式：一眼状态、点击即切换）。
 * - 展开态记 localStorage（默认展开）；窄屏顶部条放不下，CSS 隐藏子列表（走项目页卡片）。
 * - 分组：⭐收藏（置顶，带星标）→ 🕘最近访问 → 全部；默认只露 5–7 个（收藏全展示，余下按预算填充），可「展开全部」。
 * - 搜索：>5 个项目时露搜索框，输入即扁平过滤（忽略分组/截断）。
 * - 状态点：活跃即在线（绿点）；有进行中（AI 执行中）→ 绿点缓慢呼吸。待确认/受阻/待办 走右侧角标。
 * - 收藏/最近来自 localStorage（lib/favorites、lib/recent），侧栏与首页同一份、即时同步。
 * - 刷新：始终 30s 轮询（收起时也要维持聚合角标）+ 切项目/回列表页即刷（新建/归档后自然带动）。
 */
function SideProjectsNav({
  routeName,
  curPid,
  collapsed,
}: {
  routeName: string;
  curPid: number | null;
  collapsed: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => localStorage.getItem('panda.sideProjOpen') !== '0');
  const [showAll, setShowAll] = useState(() => localStorage.getItem('panda.sideProjShowAll') === '1');
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [sum, setSum] = useState<Record<string, ProjectIssueSummary>>({});
  const { isFav, toggle: toggleFav } = useFavorites();
  const recent = useRecent();

  const onList = routeName === 'projects';
  useEffect(() => {
    // 收起/窄屏时子列表不渲染，但聚合角标仍需数据 → 始终拉取。
    const load = (): void => {
      api<Project[]>('/api/projects')
        .then((ps) => setProjects(ps.filter((p) => p.status === 'active')))
        .catch(() => {});
      api<ProjectsSummary>('/api/projects/summary')
        .then((r) => setSum(r.projects))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [open, curPid, onList]);

  const toggle = (e: Event): void => {
    e.stopPropagation();
    setOpen((o) => {
      localStorage.setItem('panda.sideProjOpen', o ? '0' : '1');
      return !o;
    });
  };
  const toggleShowAll = (): void => {
    setShowAll((s) => {
      localStorage.setItem('panda.sideProjShowAll', s ? '0' : '1');
      return !s;
    });
  };

  // 顶层聚合角标：仅统计当前可见的活跃项目（归档不计），排除「进行中/待办」以免喧宾夺主。
  const agg = aggregateSummary(sum, (projects ?? []).map((p) => p.id));
  // 列表页高亮顶级按钮；进了某项目则高亮子项（收起时退回高亮顶级按钮）
  const on = onList || (curPid !== null && !open);

  // 单行渲染（状态点 + 名称 + 角标 + 收藏星）——星用 span(role=button) 避免 button 套 button。
  const row = (p: Project): JSX.Element => {
    const s = sum[p.id];
    const fav = isFav(p.id);
    const doingN = s?.doing ?? 0;
    // 三数字：待确认(review，含创建时/执行中澄清待答，后端已并入) / 进行中(doing) / 待运行(待办+受阻)。
    const reviewN = s?.review ?? 0;
    const waitN = (s?.todo ?? 0) + (s?.blocked ?? 0);
    return (
      <button
        key={p.id}
        class={'sproj-it' + (p.id === curPid ? ' on' : '')}
        title={p.name + (p.goal ? `｜${p.goal}` : '')}
        onClick={() => nav(p.kind === 'chat' ? `/p/${p.id}/chat` : `/p/${p.id}`)}
      >
        <span
          class={'sproj-dot' + (doingN > 0 ? ' run' : '')}
          title={doingN > 0 ? t('shell.runningCount', { count: doingN }) : t('shell.online')}
        />
        <span class="sproj-nm">{p.name}</span>
        {reviewN > 0 && (
          <span class="sproj-b rv" title={t('shell.reviewCount', { count: reviewN })}>{reviewN}</span>
        )}
        {doingN > 0 && (
          <span class="sproj-b dg" title={t('shell.runningCount', { count: doingN })}>{doingN}</span>
        )}
        {waitN > 0 && <span class="sproj-b td" title={t('shell.waitingCount', { count: waitN })}>{waitN}</span>}
        {/* issue 项目：项目级自由对话入口（chat 项目行本身即进对话，不再重复） */}
        {p.kind !== 'chat' && (
          <span
            class="sproj-chat"
            role="button"
            title={t('shell.chat')}
            onClick={(e) => {
              e.stopPropagation();
              nav(`/p/${p.id}/chat`);
            }}
          >
            💬
          </span>
        )}
        <span
          class={'sproj-star' + (fav ? ' on' : '')}
          role="button"
          title={fav ? t('shell.unfavorite') : t('shell.favorite')}
          onClick={(e) => {
            e.stopPropagation();
            toggleFav(p.id);
          }}
        >
          {fav ? '★' : '☆'}
        </span>
      </button>
    );
  };

  const active = projects ?? [];
  const byId = new Map(active.map((p) => [p.id, p] as const));
  const query = q.trim().toLowerCase();
  const filtered = query ? active.filter((p) => p.name.toLowerCase().includes(query)) : [];

  // 分组：收藏（活跃）→ 最近（活跃、非收藏，≤5）→ 其余活跃
  const favProjects = active.filter((p) => isFav(p.id));
  const favIds = new Set(favProjects.map((p) => p.id));
  const recentProjects = recent
    .map((id) => byId.get(id))
    .filter((p): p is Project => !!p && !favIds.has(p.id))
    .slice(0, 5);
  const recentIds = new Set(recentProjects.map((p) => p.id));
  const restProjects = active.filter((p) => !favIds.has(p.id) && !recentIds.has(p.id));

  // 默认 5–7 个：收藏全展示，余下（先最近后其余）按预算填充；超出的走「展开全部」。
  const LIMIT = 7;
  let budget = Math.max(0, LIMIT - favProjects.length);
  const recentVisible = showAll ? recentProjects : recentProjects.slice(0, budget);
  budget -= recentVisible.length;
  const restVisible = showAll ? restProjects : restProjects.slice(0, budget);
  const hidden = recentProjects.length - recentVisible.length + (restProjects.length - restVisible.length);
  const collapsible = hidden > 0 || (showAll && active.length > LIMIT);
  const grouped = favProjects.length > 0 || recentVisible.length > 0;

  return (
    <>
      <button class={on ? 'on' : ''} title={collapsed ? t('shell.projects') : undefined} onClick={() => nav('/')}>
        <span class="snav-ic">📁</span>
        <span class="snav-tx">{t('shell.projects')}</span>
        {/* 始终渲染（含空态）以吃掉 margin-left:auto，让箭头稳定靠右 */}
        <span class="snav-agg">
          {agg.review > 0 && (
            <span class="snav-agg-b rv" title={t('shell.reviewCount', { count: agg.review })}>
              {agg.review}
            </span>
          )}
          {agg.blocked > 0 && (
            <span class="snav-agg-b bk" title={t('shell.waitingCount', { count: agg.blocked })}>
              {agg.blocked}
            </span>
          )}
        </span>
        <span
          class={'snav-arr' + (open ? ' open' : '')}
          role="button"
          title={open ? t('shell.collapseProjectList') : t('shell.expandProjectList')}
          onClick={toggle}
        >
          ▾
        </span>
      </button>
      {open && projects !== null && (
        <>
          {active.length > 5 && (
            <input
              class="sproj-search"
              value={q}
              onInput={(e) => setQ(e.currentTarget.value)}
              placeholder={t('shell.searchProjects')}
              aria-label={t('shell.searchProjects')}
            />
          )}
          <div class="sproj">
            {active.length === 0 && <span class="sproj-empty">{t('shell.noProjects')}</span>}
            {query ? (
              filtered.length > 0 ? (
                filtered.map(row)
              ) : (
                <span class="sproj-empty">{t('shell.noMatches')}</span>
              )
            ) : (
              <>
                {favProjects.length > 0 && (
                  <div class="sproj-group">
                    <div class="sproj-group-hd">⭐ {t('shell.favorites')}</div>
                    {favProjects.map(row)}
                  </div>
                )}
                {recentVisible.length > 0 && (
                  <div class="sproj-group">
                    <div class="sproj-group-hd">🕘 {t('shell.recent')}</div>
                    {recentVisible.map(row)}
                  </div>
                )}
                {restVisible.length > 0 && (
                  <div class="sproj-group">
                    {grouped && <div class="sproj-group-hd">{t('shell.all')}</div>}
                    {restVisible.map(row)}
                  </div>
                )}
                {collapsible && (
                  <button class="sproj-more" onClick={toggleShowAll}>
                    {showAll ? t('shell.collapse') : t('shell.expandAll', { count: active.length })}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

/**
 * 底部用户卡：点击向上展开菜单——账户信息（用户名 / 角色 / 飞书绑定）、主题入口（占位）、退出。
 * 点卡外或按 Esc 收起；窄屏顶部条里改为向下弹出（CSS 处理）。
 */
function UserCard({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      if (!(e.target as HTMLElement).closest('.side-user-wrap')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initial = (me.username[0] ?? '?').toUpperCase();
  const roleText = me.role === 'admin' ? t('shell.roleAdmin') : t('shell.roleMember');

  return (
    <div class="side-user-wrap">
      {open && (
        <div class="user-menu" role="menu">
          <div class="user-menu-hd">
            <span class="avatar">{initial}</span>
            <div class="user-menu-id">
              <div class="user-menu-nm">{me.username}</div>
              <div class="user-menu-role">
                {roleText}
                {me.feishuOpenid ? ` · ${t('shell.feishuBound')}` : ''}
              </div>
            </div>
          </div>
          <div class="user-menu-sep" />
          <button
            class="user-menu-it"
            role="menuitem"
            onClick={() => toast.info(t('shell.lightThemeNotice'))}
          >
            <span class="user-menu-ic">🌗</span>
            <span class="grow">{t('shell.theme')}</span>
            <span class="badge b-gray">{t('shell.lightTheme')}</span>
          </button>
          <button
            class="user-menu-it danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <span class="user-menu-ic">🚪</span>
            <span class="grow">{t('shell.signOut')}</span>
          </button>
        </div>
      )}
      <button
        class={'side-user' + (open ? ' on' : '')}
        title={me.username}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="avatar">{initial}</span>
        <span class="who">{me.username}</span>
        <span class="side-user-caret">▾</span>
      </button>
    </div>
  );
}

/**
 * 全局后台任务状态区（侧栏底部，跨所有页面常驻）：
 * 后台任务在执行机上跑，离开页面也会继续——这里汇总「进行中」总数，点开列出运行中的项目与入口。
 * 仅在有进行中任务时出现；30s 轮询 /api/projects/summary（与侧栏项目区各自取数，互不影响）。
 */
function RunningTasks() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sum, setSum] = useState<Record<string, ProjectIssueSummary>>({});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const load = (): void => {
      api<Project[]>('/api/projects')
        .then((ps) => setProjects(ps.filter((p) => p.status === 'active')))
        .catch(() => {});
      api<ProjectsSummary>('/api/projects/summary')
        .then((r) => setSum(r.projects))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      if (!(e.target as HTMLElement).closest('.bgtasks')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const running = projects
    .map((p) => ({ p, n: sum[p.id]?.doing ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const total = running.reduce((s, x) => s + x.n, 0);
  if (total === 0) return null;

  return (
    <div class="bgtasks">
      {open && (
        <div class="bgtasks-menu" role="menu">
          <div class="bgtasks-hd">{t('shell.backgroundRunning')}</div>
          {running.map(({ p, n }) => (
            <button
              key={p.id}
              class="bgtasks-it"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                nav(`/p/${p.id}`);
              }}
            >
              <span class="sproj-dot run" />
              <span class="grow">{p.name}</span>
              <span class="badge b-green">{n}</span>
            </button>
          ))}
        </div>
      )}
      <button
        class="bgtasks-chip"
        title={t('shell.backgroundTasks')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="bgtasks-dot" />
        <b class="bgtasks-n">{total}</b>
        <span class="bgtasks-tx">{t('shell.running')}</span>
      </button>
    </div>
  );
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const { t } = useI18n();
  const route = useRoute();
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  useEffect(() => {
    api<LlmStatus>('/api/llm-status').then(setLlmStatus).catch(() => {});
  }, []);
  const llmGuidance = llmConfigGuidance(me.role, llmStatus?.configured ?? true);

  let view;
  switch (route.name) {
    case 'board':
      // key=pid：切项目即重挂 BoardView，issues 从 null 起（加载中→直接新项目，消除旧列表闪现）。
      // 同项目内 board↔issue 切换 key 不变 → 不重挂、不重拉列表。
      view = <BoardView key={route.pid} pid={route.pid} />;
      break;
    case 'issue':
      // issue 详情并入工作台：宽屏在看板右栏展开，窄屏整页（BoardView 按屏宽定夺）
      view = <BoardView key={route.pid} pid={route.pid} selIid={route.iid} />;
      break;
    case 'designs':
      view = <DesignsView key={route.pid} pid={route.pid} me={me} />;
      break;
    case 'design':
      view = <DesignsView key={route.pid} pid={route.pid} selDid={route.did} me={me} />;
      break;
    case 'chat':
      // 对话模式视图（chat 项目的落地页 / issue 项目的项目级自由对话入口）
      view = <ChatView key={route.pid} pid={route.pid} />;
      break;
    case 'term':
      view = <LazyTerm pid={route.pid} />;
      break;
    case 'files':
      view = <FilesView pid={route.pid} />;
      break;
    case 'git':
      view = <GitView pid={route.pid} />;
      break;
    case 'skills':
      view = <SkillsView pid={route.pid} me={me} />;
      break;
    case 'project-settings':
      view = <ProjectSettingsView key={route.pid} pid={route.pid} me={me} />;
      break;
    case 'external-issues':
      view = <ExternalIssuesView key={route.pid} pid={route.pid} />;
      break;
    case 'workflows':
      view = <WorkflowTemplatesView key={route.pid} pid={route.pid} />;
      break;
    case 'settings':
      view = <SettingsView me={me} onLogout={onLogout} />;
      break;
    case 'admin':
      view = me.role === 'admin'
        ? <AdminView initialTab={route.section === 'llm' ? 'llm' : 'users'} />
        : <ProjectsView me={me} />;
      break;
    default:
      view = <ProjectsView me={me} />;
  }

  const tab = route.name === 'settings' ? 'settings' : route.name === 'admin' ? 'admin' : 'projects';
  const curPid = 'pid' in route ? route.pid : null;
  const menu = [
    { key: 'settings', ic: '⚙️', tx: t('shell.settings'), to: '/settings' },
    ...(me.role === 'admin' ? [{ key: 'admin', ic: '🛡️', tx: t('shell.admin'), to: '/admin' }] : []),
  ];

  // 宽屏侧栏折叠 248⇄72（记 localStorage；窄屏顶部条不受影响，CSS 里限定 min-width:720px）
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('panda.sideCollapsed') === '1');
  const toggleCollapsed = (): void => {
    setCollapsed((c) => {
      localStorage.setItem('panda.sideCollapsed', c ? '0' : '1');
      return !c;
    });
  };

  return (
    <div class="shell">
      {/* 背景圆点缀：只在奶油色留白区露出 */}
      <div class="deco" aria-hidden="true">
        <i class="dc1" /><i class="dc2" /><i class="dc3" /><i class="dc4" /><i class="dc5" />
      </div>
      <aside class={'sidebar' + (collapsed ? ' collapsed' : '')}>
        <button type="button" class="brand" title="PandaDOS" onClick={() => nav('/')}>
          <img class="brand-logo" src="/logo-mark.png" alt="PandaDOS" />
          <span class="brand-copy">
            <span class="brand-tx">
              Panda<span class="brand-ai">DOS</span>
            </span>
            <span class="brand-version">{APP_VERSION}</span>
          </span>
        </button>
        <nav class="snav">
          <SideProjectsNav routeName={route.name} curPid={curPid} collapsed={collapsed} />
        </nav>
        <nav class="snav snav-foot">
          <button
            class="snav-collapse"
            title={collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
            onClick={toggleCollapsed}
          >
            <span class="snav-ic">{collapsed ? '»' : '«'}</span>
            <span class="snav-tx">{t('shell.collapse')}</span>
          </button>
          {menu.map((it) => (
            <button
              key={it.key}
              class={tab === it.key ? 'on' : ''}
              title={collapsed ? it.tx : undefined}
              onClick={() => nav(it.to)}
            >
              <span class="snav-ic">{it.ic}</span>
              <span class="snav-tx">{it.tx}</span>
            </button>
          ))}
        </nav>
        <RunningTasks />
        <UserCard me={me} onLogout={onLogout} />
      </aside>
      <main class="main">
        {llmGuidance && (
          <div class="llm-config-banner" role="status">
            <span>{llmGuidance.message}</span>
            {llmGuidance.actionPath && (
              <button class="btn sm" onClick={() => nav(llmGuidance.actionPath!)}>
                {t('shell.goToConfiguration')}
              </button>
            )}
          </div>
        )}
        <div class="viewport">{view}</div>
      </main>
    </div>
  );
}

/**
 * 飞书 OAuth 回调的一次性提示（callback 302 回 /?feishu=bound / /?feishu_err=<msg>）：
 * 模块加载时立即读取并从地址栏抹掉（防刷新重复提示），渲染后 toast/登录页展示。
 */
const feishuFlash = (() => {
  const q = new URLSearchParams(location.search);
  const bound = q.get('feishu') === 'bound';
  const err = q.get('feishu_err');
  if (bound || err) {
    q.delete('feishu');
    q.delete('feishu_err');
    const rest = q.toString();
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  }
  return { bound, err };
})();

function LocalizedAppBody({
  me,
  refresh,
  logout,
}: {
  me: Me | null | undefined;
  refresh: () => void;
  logout: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    if (feishuFlash.bound) toast.success(t('shell.feishuBindSuccess'));
    else if (feishuFlash.err) toast.error(feishuFlash.err, 8000);
  }, []);
  let body;
  if (me === undefined)
    body = (
      <div class="boot">
        <Spinner /> {t('common.loading')}
      </div>
    );
  else if (me === null) body = <LoginView onLogin={refresh} initErr={feishuFlash.err ?? ''} />;
  else body = <Shell me={me} onLogout={logout} />;

  return (
    <>
      {body}
      <Toaster />
    </>
  );
}

function App() {
  // undefined=启动探测中；null=未登录
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const refresh = (): void => {
    api<Me>('/api/me', 'GET', undefined, { silent401: true })
      .then(setMe)
      .catch(() => setMe(null));
  };

  useEffect(() => {
    setOnUnauthorized(() => setMe(null));
    refresh();
  }, []);

  const logout = (): void => {
    void api('/api/logout', 'POST', {}).catch(() => {});
    setMe(null);
    nav('/');
  };

  return (
    <I18nProvider me={me}>
      <LocalizedAppBody me={me} refresh={refresh} logout={logout} />
    </I18nProvider>
  );
}

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');
render(<App />, root);
