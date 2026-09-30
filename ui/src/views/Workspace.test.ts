/**
 * 工作区（issue #388）组合约束：bun test 无 DOM，按仓库惯例校验源码关键不变式 + 纯函数行为。
 * 覆盖：单一入口与深链同步、桌面分栏（左右/上下拖拽、侧栏/分区可收起）、手机三入口钻入与底部操作条、
 * 文件操作（新建/上传/重命名/移动/删除/下载 + 未保存保护）、路径复制、Git（暂存分组、按块、撤销、冲突、
 * 提交、fetch/pull/push、分支安全检查）、多 worktree（只导航不改 cwd）、跨项目迟到响应。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { clampRatio, groupWorktree, leafGroup, splitDiffHunks } from './Workspace';

const source = readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const projects = readFileSync(new URL('./Projects.tsx', import.meta.url), 'utf8');
const board = readFileSync(new URL('./Board.tsx', import.meta.url), 'utf8');

describe('入口与路由', () => {
  test('项目卡片与项目详情只有一个工作区入口', () => {
    for (const s of [projects, board]) {
      expect(s).toContain('/workspace`');
      expect(s).not.toContain('/files`');
      expect(s).not.toContain('/git`');
    }
  });
  test('按 pid 挂载：切项目 / 工作位置整页重建，旧请求不落进新页面', () => {
    expect(main).toContain('<WorkspaceView key={route.pid} pid={route.pid} loc={route.loc} />');
    expect(source).toContain('alive.current');
    expect(source).toContain('completeGitLoad(prev, pid, request, result)');
    expect(source).toContain('keyedResult(result, diffKey)');
  });
  test('选择与深链双向同步（replace 不刷历史），数据未到时不冲掉深链', () => {
    expect(source).toContain('nav(workspacePath(pid, next), { replace: true })');
    expect(source).toContain('if (pendingSel.current) return;');
    expect(source).toContain('applyLoc(loc)');
  });
});

describe('桌面布局', () => {
  test('左右可拖拽、侧栏可收起为细轨', () => {
    expect(source).toContain('<ListSplitter');
    expect(source).toContain('class="ws-rail"');
    expect(source).toContain('setNavOpen');
  });
  test('上下（树 | 历史）可拖拽并记忆，树与历史分区都可收起', () => {
    expect(source).toContain('<HSplitter');
    expect(source).toContain('aria-orientation="horizontal"');
    expect(source).toContain('VSPLIT_KEY');
    expect(source).toContain('setTreeOpen((v) => !v)');
    expect(source).toContain('setHistoryOpen((v) => !v)');
    expect(clampRatio(0)).toBe(0.2);
    expect(clampRatio(2)).toBe(0.85);
  });
  test('左侧全部文件 / 当前改动 + 提交历史（可筛选），右侧文件 / diff / 提交详情', () => {
    expect(source).toContain("tr('ws.allFiles')");
    expect(source).toContain("tr('ws.currentChanges')");
    expect(source).toContain('<CommitHistory');
    expect(source).toContain("tr('ws.filterCommits')");
    expect(source).toContain('<FileViewer');
    expect(source).toContain('<HunkDiff');
    expect(source).toContain('<CommitPanel');
  });
});

describe('手机布局', () => {
  test('三入口 + 目录逐层钻入 + 内容全屏，返回先回列表', () => {
    expect(source).toContain("(['files', 'changes', 'history'] as const)");
    expect(source).toContain('<MobileDirList');
    expect(source).toContain('class="git-mobile-content"');
    expect(source).toContain("if (!wide && workspace.content) {");
  });
  test('行菜单与更多菜单在手机为底部面板，内容页底部固定复制路径与更多', () => {
    expect(source).toContain('sheet={!wide}');
    expect(source).toContain('bottomBar=');
    expect(source).toContain('class="ws-bottom-bar"');
  });
});

describe('文件操作', () => {
  test('新建 / 上传 / 重命名 / 移动 / 删除 / 下载（目录打包）', () => {
    expect(source).toContain("/fs/${kind === 'file' ? 'file' : 'mkdir'}");
    expect(source).toContain('/fs/upload?path=${encodeURIComponent(curDir)}');
    expect(source).toContain('/fs/move');
    expect(source).toContain("'DELETE'");
    expect(source).toContain("'download-dir' : 'download'");
    expect(source).toContain("q.set('expectVersion', count!.version)");
  });
  test('移动后跟随更新打开路径与深链；删除打开中的未保存文件先处理保存', () => {
    expect(source).toContain('const next = clean + openedPath.slice(from.length);');
    expect(source).toContain('viewer.current?.dirty()) setPending({ run: () => setDelDlg(t) })');
  });
  test('未保存保护：保存 / 放弃 / 继续编辑，切换与返回都经 guard', () => {
    expect(source).toContain('<UnsavedDialog');
    expect(source).toContain("tr('ws.keepEditing')");
    expect(source).toContain('guard(() => nav(`/p/${pid}`))');
  });
  test('全局导航离开同样受保护：登记 router 离开守卫，本工作区内部深链放行', () => {
    expect(source).toContain('useEffect(() => setLeaveGuard((to, proceed) => {');
    expect(source).toContain("if (to.name === 'workspace' && to.pid === pid) return false;");
    expect(source).toContain('setPending({ run: proceed });');
  });
  test('搜索框回车先做相对路径直达（当前目录/项目根），未命中回退内容搜索；桌面手机共用同一工具栏', () => {
    expect(source).toContain("import { resolveWorkspacePath } from '../lib/workspacePathLookup';");
    expect(source).toContain('const hit = await resolveWorkspacePath(q, curDir, async (p) => {');
    expect(source).toContain("if (!hit) {\n            guard(() => { rawDispatch({ type: 'show-all' }); setSearch({ mode: 'content', q }); });");
    expect(source).toContain("if (!wide) setMobileTab('files');");
  });
  test('pull 预览：有运行中 issue 时说明原因且不给拉取按钮', () => {
    expect(source).toContain("tr('ws.blockIssueRunning', { count: pv.running })");
    expect(source).toContain('pv.dirty === 0 && !pv.running && !pv.operation');
  });
  test('复制路径四种结果在行菜单与内容头都可用', () => {
    expect(source).toContain('copyMenuItems(copyTarget(t.path, t.dir), executor, setCopyFail)');
    expect(source).toContain('<CopyPathButton');
    expect(source).toContain('<CopyFallback');
  });
});

describe('Git 操作', () => {
  test('改动按冲突 / 已暂存 / 未暂存 / 未跟踪分组，同一文件可分别查看', () => {
    const groups = groupWorktree([
      { status: 'MM', path: 'a.ts' },
      { status: 'UU', path: 'c.ts' },
      { status: '??', path: 'n.md' },
      { status: 'R ', path: 'new.ts', oldPath: 'old.ts' },
    ]);
    expect(groups.map((g) => g.group)).toEqual(['conflict', 'staged', 'unstaged', 'untracked']);
    expect(groups[1]!.leaves.map((l) => l.path)).toEqual(['a.ts', 'new.ts']);
    expect(groups[2]!.leaves.map((l) => l.path)).toEqual(['a.ts']);
    expect(leafGroup(groups[1]!.leaves[0]!)).toBe('staged');
    expect(groups[1]!.leaves[1]!.oldPath).toBe('old.ts');
  });
  test('按块暂存 / 取消 / 撤销带块头；撤销需确认；未跟踪走删除', () => {
    const { head, hunks } = splitDiffHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-c\n+d\n');
    expect(head).toHaveLength(3);
    expect(hunks.map((h) => h.header)).toEqual(['@@ -1 +1 @@', '@@ -5 +5 @@']);
    expect(source).toContain("/git/hunk`, 'POST', { path, side: group, index, header, action }");
    expect(source).toContain('setDiscardDlg({ hunk: { index, header, path } })');
    expect(source).toContain('onDeleteUntracked');
  });
  test('冲突：打开编辑、标记已解决、继续/中止；未解决时提交解释禁用原因', () => {
    expect(source).toContain('/git/resolve');
    expect(source).toContain("{ action: 'continue' }");
    expect(source).toContain("{ action: 'abort' }");
    expect(source).toContain("tr('ws.commitBlockedConflicts', { count: conflicts })");
    expect(source).toContain("tr('ws.willCommit', { count: stagedN })");
  });
  test('fetch / pull（预览后选择方式）/ push（无 upstream 先说明目标）', () => {
    expect(source).toContain('/git/fetch');
    expect(source).toContain('/git/pull-preview');
    expect(source).toContain("tr('ws.pushWillCreate', { target: pushDlg })");
    expect(source).toContain('info.lastFetchTs');
    expect(source).toContain('setSyncError(errText(e))');
  });
  test('分支：搜索本地/远程、新建、切换前安全检查并给出可执行入口', () => {
    expect(source).toContain('/git/checkout-check?');
    expect(source).toContain("tr('ws.goToChanges')");
    expect(source).toContain("tr('ws.openHolder')");
    expect(source).toContain("tr('ws.checkoutRemoteConfirm'");
  });
  test('多 worktree：打开只导航、外部可关联、系统创建才能移除、设计托管只展示', () => {
    expect(source).toContain('nav(`/p/${projectId}/workspace`)');
    expect(source).toContain('/git/worktrees/associate');
    expect(source).toContain("w.kind === 'panda' && !w.current");
    expect(source).toContain("tr('ws.designManaged')");
    expect(source).toContain('dryRun: true');
    expect(source).not.toMatch(/PATCH[^\n]*cwd/);
  });
});
