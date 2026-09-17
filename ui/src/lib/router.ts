/**
 * ui/lib/router —— hash 路由（无依赖，手机/静态托管天然可用）。
 * #/            项目列表
 * #/p/:pid          项目详情（issue 看板）
 * #/p/:pid/issue/:iid  issue 详情
 * #/p/:pid/chat        对话视图
 * #/p/:pid/chat/:cid    对话视图（钉住某条对话；cid = conversations.id，也是 tmux chat-<cid>）
 * #/p/:pid/term        终端
 * #/p/:pid/files       文件浏览
 * #/p/:pid/git         git 提交图
 * #/p/:pid/skills      技能（全局/项目 + 市场）
 * #/p/:pid/settings    项目配置
 * #/p/:pid/workflows   工作流模板维护
 * #/p/:pid/external-issues 外部 issue 导入
 * #/settings          我的设定
 * #/admin            admin 后台
 */
import { useEffect, useState } from 'preact/hooks';
import { pushRecent } from './recent';

export type Route =
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'admin'; section?: 'llm' | 'feishu' }
  | { name: 'board'; pid: number }
  | { name: 'issue'; pid: number; iid: number }
  | { name: 'designs'; pid: number }
  | { name: 'design'; pid: number; did: number }
  | { name: 'chat'; pid: number; cid?: string }
  | { name: 'term'; pid: number }
  | { name: 'files'; pid: number }
  | { name: 'git'; pid: number }
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
  const parts = hash.replace(/^#/, '').split('/').filter((s) => s.length > 0);
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
        const iid = Number(parts[3]);
        if (Number.isInteger(iid) && iid > 0) return { name: 'issue', pid, iid };
      }
      if (parts[2] === 'designs') {
        if (parts[3]) {
          const did = Number(parts[3]);
          if (Number.isInteger(did) && did > 0) return { name: 'design', pid, did };
        }
        return { name: 'designs', pid };
      }
      if (parts[2] === 'chat') {
        // cid 只做形状校验：真正的存在性由 ChatView 按对话列表核对，认不出就回退到默认选中项
        const cid = decodeSegment(parts[3]);
        return CONV_ID_RE.test(cid) ? { name: 'chat', pid, cid } : { name: 'chat', pid };
      }
      if (parts[2] === 'term') return { name: 'term', pid };
      if (parts[2] === 'files') return { name: 'files', pid };
      if (parts[2] === 'git') return { name: 'git', pid };
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

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const on = (): void => {
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
