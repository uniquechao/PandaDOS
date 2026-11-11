import { stageSourceChanges } from './runtime-git-paths';
import { buildFallbackIdentity, ensureGitIdentity } from '../core/git-identity';
import type { Project } from '../core/types';
import type { ExecutorDriver, GitResult } from '../executor/driver';
import type { IssueId } from '../../shared/issue-id';
import type { EngineExecutionWorkspace, EngineIssue, IssueStore } from './engine';
import type { IssueEffectJournal } from './effect-journal';

/** A non-fast-forward rejection permits one fetch/rebase retry while the project Git lock is held. */
const PUSH_REJECTED_RE = /\[rejected\]|fetch first|non-fast-forward|updates were rejected/i;

type DeliveryStore = Pick<IssueStore, 'logEvent' | 'lastEnterEventId'>;
type DeliveryJournal = Pick<IssueEffectJournal, 'statusOf' | 'targetOf' | 'runOnce'>;

export interface GitDeliveryPorts {
  store: DeliveryStore;
  journal: DeliveryJournal;
  driverForProject: (project: Project) => ExecutorDriver;
  ownerUsername: (project: Project) => string | null;
}

export interface GitDeliveryFailure {
  where: 'auto_commit' | 'auto_push';
  detail: string;
}

/**
 * Auto commit/push with durable effect reconciliation. Caller owns the project Git lock and
 * branch verification; this service never changes issue state or emits notifications.
 */
export class GitDeliveryService {
  constructor(private readonly ports: GitDeliveryPorts) {}

  private async healGitIdentityLocked(
    project: Project,
    issueId: IssueId,
    cwd: string,
  ): Promise<boolean> {
    const fallback = buildFallbackIdentity({
      runUser: project.runUser,
      ownerUsername: this.ports.ownerUsername(project),
    });
    const ensured = await ensureGitIdentity(this.ports.driverForProject(project), cwd, fallback);
    if (!ensured.ok) {
      this.ports.store.logEvent(issueId, 'error', {
        where: 'git-identity',
        error: (ensured.error ?? 'Git 身份自愈失败').slice(0, 300),
      });
      return false;
    }
    if (!ensured.changed) return false; // 身份本来就在，重试同一条 commit 只会再失败一次
    this.ports.store.logEvent(issueId, 'git_identity', {
      applied: true,
      recovered: true, // 与开跑前的预检区分：这条是提交失败后现补的
      scope: ensured.scope,
      name: ensured.name,
      email: ensured.email,
    });
    return true;
  }

  /**
   * push 被远端拒（远端有我没有的提交）→ `fetch origin <branch>` + `rebase FETCH_HEAD`
   * 后重试一次（#272 / B-02）。返回重试后的 push 结果；没条件重试则返回 null（保留原始失败）。
   *
   * 两个必须守住的点：
   * - **rebase 冲突一定要 `--abort`**：否则仓库停在 rebase 中途，下一条 issue 一开跑
   *   就撞上「工作区有未保存改动」，一个推送失败会连坐整条队列。
   * - **detached HEAD 不重试**：没有对应的远端分支可 fetch/rebase，硬试只会把现场搅乱。
   */
  private async rebaseAndRetryPushLocked(
    project: Project,
    issueId: IssueId,
    cwd: string,
    pushArgs: string[],
  ): Promise<GitResult | null> {
    const driver = this.ports.driverForProject(project);
    const head = await driver.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = head.code === 0 ? head.out.trim() : '';
    if (!branch) return null;
    const fetched = await this.gitTransport(project, cwd, ['fetch', 'origin', branch]);
    if (fetched.code !== 0) return fetched;
    const rebased = await driver.git(cwd, ['rebase', 'FETCH_HEAD']);
    if (rebased.code !== 0) {
      await driver.git(cwd, ['rebase', '--abort']); // 收干净，别把仓库留在半途
      this.ports.store.logEvent(issueId, 'auto_push_retry', {
        reason: 'rejected',
        branch,
        result: 'rebase_failed',
        error: (rebased.err || rebased.out).slice(0, 300),
      });
      return null;
    }
    this.ports.store.logEvent(issueId, 'auto_push_retry', { reason: 'rejected', branch, result: 'rebased' });
    return this.gitTransport(project, cwd, pushArgs);
  }

  // 网络命令超时与普通非零退出码走同一条“未推送”路径。
  // 不包住 commit/rebase 等本地写操作：这些失败可能影响开发现场，仍须单独处理。
  private async gitTransport(project: Project, cwd: string, args: string[]): Promise<GitResult> {
    try {
      return await this.ports.driverForProject(project).git(cwd, args);
    } catch (error) {
      return { code: 1, out: '', err: String(error) };
    }
  }

  /**
   * 自动收尾（manual_review 关，tests_passed 后）：git add -A → 有暂存改动才 commit
   * 「<标题> (#id)」→ push origin 当前分支（HEAD）。commit 失败会保留现场并阻止完成；
   * push 失败只记事件+通知，不阻止本地已经提交完成的 issue 收尾。
   * 没有新 commit 也照样 push（CC 实施中自己 commit 过、只欠 push 是常态）。
   *
   * #272 加固的三处：
   * - commit 失败先补身份重试一次（见 healGitIdentityLocked），仍失败才降级；
   * - **push 前预检 origin**：没有远端的项目（本地私有仓库）记 `push_skipped` 就收工，
   *   那不是故障，不该每次收尾都刷一条 error 和一次通知；
   * - 被拒（fetch first / non-fast-forward）fetch+rebase 重试一次；最终仍失败要留下
   *   `auto_push_failed` 这个**持久可见标记**——push 失败不挡完成，但绝不能静默 done。
   */
  async deliverLocked(
    project: Project,
    issue: EngineIssue,
    workspace: EngineExecutionWorkspace,
  ): Promise<GitDeliveryFailure | null> {
    const cwd = workspace.cwd;
    const driver = this.ports.driverForProject(project);
    const branchLabel = issue.branch ?? 'HEAD';
    const fail = (where: 'auto_commit' | 'auto_push', detail: string) => {
      this.ports.store.logEvent(issue.id, 'error', { where, error: detail.slice(0, 300) });
      return { where, detail };
    };
    const add = await stageSourceChanges(driver,cwd);
    if (add.code !== 0) {
      return fail('auto_commit', add.err || add.out);
    }
    // diff --cached --quiet：0 = 无暂存改动（跳过 commit），非 0 = 有改动要提
    const staged = await driver.git(cwd, ['diff', '--cached', '--quiet']);
    const deliveryEntry = this.ports.store.lastEnterEventId(issue.id, 'merge_review');
    const commitKey = `git-commit:${deliveryEntry}`;
    if (staged.code !== 0 || this.ports.journal.statusOf(issue.id, commitKey) !== null) {
      const msg = `${issue.title.slice(0, 120)} (#${issue.id})`;
      const marker = `PandaDOS-Effect: ${issue.id}/${deliveryEntry}`;
      const recordedTarget = this.ports.journal.targetOf(issue.id, commitKey);
      const tree = recordedTarget ? null : await driver.git(cwd, ['write-tree']);
      if (tree && tree.code !== 0) return fail('auto_commit', tree.err || tree.out || 'git write-tree failed');
      const target = recordedTarget ?? `git:${cwd}#tree=${tree!.out.trim()}`;
      const expectedTree = target.startsWith(`git:${cwd}#tree=`)
        ? target.slice(`git:${cwd}#tree=`.length) : '';
      if (!/^[0-9a-f]{40,64}$/.test(expectedTree)) {
        return fail('auto_commit', '持久提交意图缺少可核对的 Git tree');
      }
      try {
        await this.ports.journal.runOnce({
          issueId: issue.id, operationKey: commitKey, projectId: issue.projectId,
          executorId: project.executorId, target, input: `${msg}\n${marker}`,
        }, async () => {
          let commit = await driver.git(cwd, ['commit', '-m', msg, '-m', marker]);
          if (commit.code !== 0 && await this.healGitIdentityLocked(project, issue.id, cwd)) {
            commit = await driver.git(cwd, ['commit', '-m', msg, '-m', marker]);
          }
          if (commit.code !== 0) throw new Error(commit.err || commit.out || 'git commit failed');
        }, async () => {
          // Search the current branch's reachable history: HEAD may have advanced after commit.
          // An exact trailer alone is not enough; its tree must match the staged snapshot.
          const history = await driver.git(cwd, ['log', 'HEAD', '--format=%H', `--grep=${marker}`]);
          if (history.code !== 0) return 'unknown';
          for (const sha of history.out.trim().split('\n').filter(Boolean)) {
            const [message, committedTree] = await Promise.all([
              driver.git(cwd, ['show', '-s', '--format=%B', sha]),
              driver.git(cwd, ['rev-parse', `${sha}^{tree}`]),
            ]);
            if (message.code === 0 && committedTree.code === 0
              && message.out.split('\n').some((line) => line.trim() === marker)
              && committedTree.out.trim() === expectedTree) return 'confirmed';
          }
          return 'unknown';
        });
      } catch (error) {
        return fail('auto_commit', `提交结果未确认：${String(error)}`);
      }
      this.ports.store.logEvent(issue.id, 'auto_commit', { message: msg });
    }
    const remote = await driver.git(cwd, ['remote', 'get-url', 'origin']);
    if (remote.code !== 0) {
      this.ports.store.logEvent(issue.id, 'push_skipped', { reason: 'no-remote', branch: branchLabel });
      return null; // 没有远端可推 ≠ 推失败
    }
    let pushArgs = ['push', 'origin', 'HEAD'];
    if (workspace.kind === 'design-worktree') {
      const upstream = await driver.git(cwd, [
        'rev-parse', '--symbolic-full-name', '@{upstream}',
      ]);
      if (upstream.code !== 0 || !upstream.out.trim().startsWith('refs/remotes/')) {
        pushArgs = ['push', '--set-upstream', 'origin', 'HEAD'];
      }
    }
    try {
      await this.ports.journal.runOnce({
        issueId: issue.id, operationKey: `git-push:${deliveryEntry}`,
        projectId: issue.projectId, executorId: project.executorId,
        target: `git:${cwd}:origin`, input: 'push origin HEAD',
      }, async () => {
        let push = await this.gitTransport(project, cwd, pushArgs);
        if (push.code !== 0 && PUSH_REJECTED_RE.test(push.err || push.out)) {
          const retried = await this.rebaseAndRetryPushLocked(project, issue.id, cwd, pushArgs);
          if (retried) push = retried;
        }
        if (push.code !== 0) throw new Error(push.err || push.out || 'git push failed');
      }, async () => {
        const [head, branch] = await Promise.all([
          driver.git(cwd, ['rev-parse', 'HEAD']),
          driver.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        ]);
        if (head.code !== 0 || branch.code !== 0) return 'unknown';
        const remote = await this.gitTransport(project, cwd,
          ['ls-remote', '--heads', 'origin', branch.out.trim()]);
        return remote.code === 0 && remote.out.trim().split(/\s+/)[0] === head.out.trim()
          ? 'confirmed' : 'unknown';
      });
    } catch (error) {
      const detail = `推送结果未确认：${String(error)}`;
      // 持久可见标记：本地已提交，issue 照常完成，但详情页要一直挂着「未推送」
      this.ports.store.logEvent(issue.id, 'auto_push_failed', {
        branch: branchLabel,
        detail: detail.slice(0, 300),
      });
      return fail('auto_push', detail);
    }
    this.ports.store.logEvent(issue.id, 'auto_push', { branch: branchLabel });
    return null;
  }
}
