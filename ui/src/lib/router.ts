/**
 * ui/lib/router —— hash 路由（无依赖，手机/静态托管天然可用）。
 * #/            项目列表
 * #/p/:pid          项目详情（issue 看板）
 * #/p/:pid/issue/:iid  issue 详情
 * #/p/:pid/chat        对话视图
 * #/p/:pid/chat/:cid    对话视图（钉住某条对话；cid = conversations.id，也是 tmux chat-<cid>）
 * #/p/:pid/term        终端
 * #/p/:pid/workspace[/…]  工作区（文件 + Git 合一，#388；子状态见 lib/workspaceRoute）
 * #/p/:pid/files[/:path]  旧文件页深链 → 工作区「全部文件」同一目标（对话里已发出的链接不失效）
 * #/p/:pid/git            旧 Git 页 → 工作区「当前改动」
 * #/p/:pid/skills      技能（全局/项目 + 市场）
 * #/p/:pid/settings    项目配置
 * #/p/:pid/workflows   工作流模板维护
 * #/p/:pid/external-issues 外部 issue 导入
 * #/settings          我的设定
 * #/admin            admin 后台
 */
import { useEffect, useState } from 'preact/hooks';
import { pushRecent } from './recent';
import { parseIssueId, type IssueId } from '../../../shared/issue-id';
import { legacyFilesLoc, parseWorkspaceParts, type WorkspaceLoc } from './workspaceRoute';

export type RoomPanelRoute = 'goal' | 'artifacts' | 'sources' | 'budget' | 'team';
export type Route =
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'admin'; section?: 'llm' | 'feishu' }
  | { name: 'board'; pid: number }
  | { name: 'issue'; pid: number; iid: IssueId }
  | { name: 'designs'; pid: number }
  | { name: 'design'; pid: number; did: number }
  | { name: 'rooms'; pid: number }
  | { name: 'room'; pid: number; rid: string; artifactId?: string; artifactVersion?: number; memberId?: string; panel?: RoomPanelRoute }
  | { name: 'chat'; pid: number; cid?: string }
  | { name: 'term'; pid: number }
  | { name: 'workspace'; pid: number; loc: WorkspaceLoc }
  | { name: 'skills'; pid: number }
  | { name: 'external-issues'; pid: number }
  | { name: 'workflows'; pid: number }
  | { name: 'project-settings'; pid: number };

/** 对话 id 的形状（uuid / 导入历史 id）；只用于挡住畸形深链，不代表该对话存在 */
const CONV_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** 半截转义（如手改地址栏留下的裸 `%`）会让 decodeURIComponent 抛错，按「没带 cid」处理 */
function decodeSegment(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

export function parseHash(hash: string): Route {
  const [pathname, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = pathname.split('/').filter((s) => s.length > 0);
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'admin') {
    return parts[1] === 'llm' || parts[1] === 'feishu'
      ? { name: 'admin', section: parts[1] }
      : { name: 'admin' };
  }
  if (parts[0] === 'p' && parts[1]) {
    const pid = Number(parts[1]);
    if (Number.isInteger(pid) && pid > 0) {
      if (parts[2] === 'issue' && parts[3]) {
        const iid = parseIssueId(decodeURIComponent(parts[3]));
        if (iid !== null) return { name: 'issue', pid, iid };
      }
      if (parts[2] === 'designs') {
        if (parts[3]) {
          const did = Number(parts[3]);
          if (Number.isInteger(did) && did > 0) return { name: 'design', pid, did };
        }
        return { name: 'designs', pid };
      }
      if (parts[2] === 'rooms') {
        const rid = decodeSegment(parts[3]);
        if (!CONV_ID_RE.test(rid)) return { name: 'rooms', pid };
        const params = new URLSearchParams(query);
        const artifactId = params.get('artifact');
        const memberId = params.get('member');
        const panel = params.get('panel');
        const version = Number(params.get('version'));
        return {
          name: 'room', pid, rid,
          ...(artifactId && CONV_ID_RE.test(artifactId) ? { artifactId, ...(Number.isSafeInteger(version) && version > 0 ? { artifactVersion: version } : {}) } : {}),
          ...(!artifactId && memberId && CONV_ID_RE.test(memberId) ? { memberId } : {}),
          ...(!artifactId && !memberId && panel && ['goal', 'artifacts', 'sources', 'budget', 'team'].includes(panel) ? { panel: panel as RoomPanelRoute } : {}),
        };
      }
      if (parts[2] === 'chat') {
        // cid 只做形状校验：真正的存在性由 ChatView 按对话列表核对，认不出就回退到默认选中项
        const cid = decodeSegment(parts[3]);
        return CONV_ID_RE.test(cid) ? { name: 'chat', pid, cid } : { name: 'chat', pid };
      }
      if (parts[2] === 'term') return { name: 'term', pid };
      if (parts[2] === 'workspace') return { name: 'workspace', pid, loc: parseWorkspaceParts(parts.slice(3)) };
      // 旧深链：path 是整体转义过的一段（斜杠是 %2F），所以不会被上面的 split('/') 拆开
      if (parts[2] === 'files') return { name: 'workspace', pid, loc: legacyFilesLoc(parts[3]) };
      if (parts[2] === 'git') return { name: 'workspace', pid, loc: { view: 'changes' } };
      if (parts[2] === 'external-issues') return { name: 'external-issues', pid };
      if (parts[2] === 'workflows') return { name: 'workflows', pid };
      if (parts[2] === 'settings') return { name: 'project-settings', pid };
      if (parts[2] === 'skills') return { name: 'skills', pid };
      return { name: 'board', pid };
    }
  }
  return { name: 'projects' };
}

/**
 * 跳转（path 不带 #，如 nav(`/p/3/issue/7`)）。
 * opts.replace=true → 用 location.replace 换掉当前历史项（清失效深链时不留返回陷阱）；
 * 仅 hash 变化仍会触发 hashchange，useRoute 照常更新。
 */
export function nav(path: string, opts?: { replace?: boolean }): void {
  if (opts?.replace) location.replace(location.pathname + location.search + '#' + path);
  else location.hash = '#' + path;
}

/**
 * 离开保护（#388）：页面持有未保存内容时登记守卫。hash 变化先经守卫结算——返回 true 表示拦下：
 * 地址栏换回原 hash、路由不变，由守卫自己弹「保存 / 放弃 / 继续编辑」，确认后调用 proceed() 放行。
 * 覆盖全局导航（项目导航、面包屑、任意 `<a href="#…">`、浏览器前进后退），不只是页面内部动作。
 */
export type LeaveGuard = (to: Route, proceed: () => void) => boolean;

interface HashLocation {
  hash: string;
  pathname: string;
  search: string;
  replace(url: string): void;
}

let leaveGuard: LeaveGuard | null = null;
let acceptedHash: string | null = null;
let bypassHash: string | null = null;

/** 登记离开守卫；返回注销函数（只注销自己，防卸载顺序把新守卫清掉） */
export function setLeaveGuard(guard: LeaveGuard): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

/** 结算当前 hash：放行返回 true；被守卫拦下则把地址栏换回上一个已接受的 hash 并返回 false */
export function admitHash(loc: HashLocation = location): boolean {
  const h = loc.hash;
  if (acceptedHash === null || h === acceptedHash || h === bypassHash || !leaveGuard) {
    acceptedHash = h;
    bypassHash = null;
    return true;
  }
  const prev = acceptedHash;
  const proceed = (): void => {
    bypassHash = h;
    loc.hash = h;
  };
  if (!leaveGuard(parseHash(h), proceed)) {
    acceptedHash = h;
    return true;
  }
  loc.replace(loc.pathname + loc.search + prev);
  return false;
}

/** 测试用：清空模块级结算状态 */
export function resetLeaveGuardForTest(): void {
  leaveGuard = null;
  acceptedHash = null;
  bypassHash = null;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const on = (): void => {
      if (!admitHash()) return;
      const r = parseHash(location.hash);
      if ('pid' in r) pushRecent(r.pid); // 进某项目即记一次「最近访问」（直链/刷新也算）
      setRoute(r);
    };
    on(); // 挂载即结算当前路由：若已落在某项目页，补记一次访问
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
