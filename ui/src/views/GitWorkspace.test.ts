import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Git.tsx', import.meta.url), 'utf8');

describe('GitView VSCode 式工作区组合', () => {
  test('gitworkspace reducer 是页面唯一选择状态，项目切换 reset、刷新保留上下文', () => {
    expect(source).toContain('useReducer(gitWorkspaceReducer');
    expect(source).toContain("dispatch({ type: 'reset' })");
    expect(source).toContain("dispatch({ type: 'refresh' })");
    expect(source).toContain('workspace.refreshToken');
    expect(source).not.toContain('const [sel, setSel]');
  });

  test('左上树统一全部、未提交和选中 commit 三种来源', () => {
    expect(source).toContain('buildGitWorkspaceTree(');
    expect(source).toContain('<FileTree');
    expect(source).toContain('<ChangeTree');
    expect(source).toContain("dispatch({ type: 'show-all' })");
    expect(source).toContain("dispatch({ type: 'show-worktree' })");
    expect(source).toContain("kind: 'commit', sha: tree.sha");
    expect(source).toContain('class="git-tree-pane"');
    expect(source).toContain("tr('git.all')");
    expect(source).toContain("tr('git.changesOnly')");
  });

  test('左下 commit 图可折叠；行点击切树，独立详情按钮打开完整 commit', () => {
    expect(source).toContain('git-history-pane');
    expect(source).toContain('setHistoryOpen((open) => !open)');
    expect(source).toContain("dispatch({ type: 'select-commit', sha: c.sha })");
    expect(source).toContain('if (ev.target !== ev.currentTarget) return;');
    expect(source).toContain('ev.stopPropagation()');
    expect(source).toContain("dispatch({ type: 'open-commit-detail', sha: c.sha })");
    expect(source).toContain("tr('git.viewDetails')");
  });

  test('宽屏两栏可拖拽：左树+历史，右侧按内容展示文件、diff 或 commit message', () => {
    expect(source).toContain('class="git-workspace"');
    expect(source).toContain('class="git-nav"');
    expect(source).toContain('<ListSplitter');
    expect(source).toContain('class="git-context"');
    expect(source).toContain('<FileViewer');
    expect(source).toContain('<DiffBody');
    expect(source).toContain('<CommitPanel');
  });

  test('当前 diff 请求失败时显示真实错误，不伪装成无内容差异', () => {
    expect(source).toContain('error={err}');
    expect(source).toContain('error={fd.err}');
    expect(source).toContain('err: string;');
    expect(source).toContain('{error ? (');
    expect(source).toContain('<span class="err">{error}</span>');
  });

  test('项目与 GitInfo 请求接入可执行的生命周期协调器', () => {
    expect(source).toContain('const gitLoadSeq = useRef(0);');
    expect(source).toContain('const request = ++gitLoadSeq.current;');
    expect(source).toContain('beginGitLoad(prev, pid, request, !clear)');
    expect(source).toContain('completeGitLoad(prev, pid, request, result)');
    expect(source).toContain('failGitLoad(prev, pid, request, e.message)');
    expect(source).toContain('projectResult?.pid === pid ? projectResult.value : null');
  });

  test('diff 结果接入可执行的请求 key 协调器', () => {
    expect(source).toContain('const diffKey = requestKey(pid, state.refreshToken, url);');
    expect(source).toContain('const visible = keyedResult(result, diffKey);');
    expect(source).toContain("setResult({ key: diffKey, value: result, error: '' })");
  });

  test('刷新保留选择并重拉当前文件、commit 详情和改动 diff', () => {
    expect(source).toContain('key={`${file.path}:${state.refreshToken}`}');
    expect(source).toContain('reloadToken={state.refreshToken}');
    expect(source).toContain('[pid, file, state.refreshToken, diffKey, url]');
  });

  test('手机打开内容后全屏钻入，返回只关闭右侧内容、不改变树来源', () => {
    expect(source).toContain('!wide && workspace.content');
    expect(source).toContain('class="git-mobile-content"');
    expect(source).toContain("commitPanelLayout(mobile, fd.file !== null) === 'mobile-diff'");
    expect(source).toContain('<WorkspaceContext');
    expect(source).toContain('mobile');
    expect(source).toContain("dispatch({ type: 'close-content' })");
    expect(source).toContain("tr('git.backWorkspace')");
  });

  test('手机 commit 内文件 diff 独占宽度，刷新会重拉已打开的详情内 diff', () => {
    expect(source).toContain('mobile={mobile}');
    expect(source).toContain('reloadToken = 0');
    expect(source).toContain('commitDiffUrl(pid, sha, f), reloadToken);');
    expect(source).toContain('load(false)');
  });

  test('只看改动来源接入逐个/全部暂存与撤销暂存，重命名沿用模型给出的完整路径组', () => {
    expect(source).toContain('<GitOperationsPanel');
    expect(source).toContain("tr('git.stageAll')");
    expect(source).toContain("tr('git.unstageAll')");
    expect(source).toContain('operations.write(');
    expect(source.match(/\{ paths: operation\.paths \}/g)).toHaveLength(2);
    expect(source).toContain("'stage',");
    expect(source).toContain("'unstage',");
    expect(source).toContain("write('stage', { all: true },");
    expect(source).toContain("write('unstage', { all: true },");
    expect(source).toContain("renderActions={tree.kind === 'worktree'");
    expect(source).toContain('ev.stopPropagation()');
  });

  test('commit message 可手填或 AI 生成，提交与 push 有统一忙碌态、防重复和结果提示', () => {
    expect(source).toContain('aiCommitMessage(pid)');
    expect(source).toContain('setCommitMessage(text.trim())');
    expect(source).toContain('value={commitMessage}');
    expect(source).toContain("write('commit'");
    expect(source).toContain("write('push'");
    expect(source).toContain('coordinator.run(');
    expect(source).toContain('requireGitOperationSuccess(');
    expect(source).toContain('disabled={busy !== null');
    expect(source).toContain('toast.success');
    expect(source).toContain('toast.error');
  });

  test('有当前分支时允许请求 push，让无提交或无远程等失败显示后端的具体提示', () => {
    expect(source).toContain('disabled={busy !== null || !info.branch}');
    expect(source).not.toContain("!info.branch || (info.commits?.length ?? 0) === 0");
  });

  test('操作状态位于 GitView，手机钻入卸载导航时保留输入与防重门闩，跨项目忽略迟到结果', () => {
    const gitViewAt = source.indexOf('export function GitView');
    expect(source.lastIndexOf('useGitOperations(')).toBeGreaterThan(gitViewAt);
    expect(source).toContain('operations={operations}');
    expect(source).toContain('coordinator.isCurrent(token)');
    expect(source).toContain('createGitOperationCoordinator(');
    expect(source).toContain('commitState.pid === pid');
    expect(source).toContain('coordinator.active(pid)');
  });

  test('所有成功的 Git 写操作复用页面刷新，更新树、历史及分支/上游状态', () => {
    expect(source).toContain('onRefresh();');
    expect(source).toContain('const operations = useGitOperations(');
    expect(source).toContain('    refresh,');
    expect(source).toContain("dispatch({ type: 'refresh' })");
    expect(source).toContain('load(false)');
  });
});
