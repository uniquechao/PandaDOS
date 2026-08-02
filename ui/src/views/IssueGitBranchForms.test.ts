import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const board = readFileSync(new URL('./Board.tsx', import.meta.url), 'utf8');
const detail = readFileSync(new URL('./IssueDetail.tsx', import.meta.url), 'utf8');
const fields = readFileSync(new URL('../components/IssueGitBranchFields.tsx', import.meta.url), 'utf8');
const style = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('issue Git 分支配置表单接线', () => {
  test('新建 issue 加载分支清单、默认当前目标，并把规范化目标/源写入创建请求', () => {
    expect(board).toContain('<IssueGitBranchFields');
    expect(board).toContain('value={gitBranch}');
    expect(board).toContain('onChange={setGitBranch}');
    expect(board).toContain('...issueGitBranchPayload(gitBranch)');
    expect(fields).toContain('/git/branches`');
    expect(fields).toContain('initializeIssueGitBranchValue(');
  });

  test('pending 编辑以持久化值初始化，并把目标/源写入 PATCH', () => {
    expect(detail).toContain("targetBranch: issue.targetBranch ?? ''");
    expect(detail).toContain("sourceRef: issue.sourceRef ?? ''");
    expect(detail).toContain('<IssueGitBranchFields');
    expect(detail).toContain('...issueGitBranchPayload(gitBranch)');
  });

  test('分支默认值尚未加载时禁止创建/保存，加载成功或失败后恢复表单操作', () => {
    expect(board).toContain('const [gitBranchLoading, setGitBranchLoading] = useState(true)');
    expect(detail).toContain('const [gitBranchLoading, setGitBranchLoading] = useState(true)');
    expect(board).toContain('onLoadingChange={setGitBranchLoading}');
    expect(detail).toContain('onLoadingChange={setGitBranchLoading}');
    expect(board).toContain('busy || gitBranchLoading || uploading');
    expect(detail).toContain('busy || gitBranchLoading || uploading');
    expect(fields).toContain('onLoadingChangeRef.current?.(true)');
    expect(fields).toContain('onLoadingChangeRef.current?.(false)');
  });

  test('目标不等于当前分支时显示源选择，本地/远程分组且允许不指定', () => {
    expect(fields).toContain('targetNeedsSourceRef(');
    expect(fields).toContain("<optgroup label={t('ui.localBranches')}>");
    expect(fields).toContain("<optgroup label={t('ui.remoteBranches')}>");
    expect(fields).toContain('branches.local.map');
    expect(fields).toContain('branches.remote.map');
    expect(fields).toContain("<option value=\"\">{t('ui.noSourceBranch')}</option>");
    expect(fields).toContain("t('ui.currentBranch'");
    expect(fields).toContain("t('ui.noTrackingBranches')");
  });

  test('详情页始终回显目标分支和源分支，历史空配置有明确兜底', () => {
    expect(detail).toContain('<IssueGitBranchSummary issue={issue} />');
    expect(fields).toContain("t('ui.targetBranch')");
    expect(fields).toContain("issue.targetBranch || t('ui.currentBranchInherited')");
    expect(fields).toContain('formatIssueSourceRef(issue.sourceRef)');
    expect(style).toContain('.issue-git-summary');
  });
});
