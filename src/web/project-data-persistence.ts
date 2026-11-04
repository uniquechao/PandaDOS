/** Service-layer projection handlers; outer layer may compose core, issue and design domains. */
import type { Database } from 'bun:sqlite';
import { conversationDataProjection, readSharedConversationMessages } from '../core/conversation-project-data';
import { ProjectDataPersistenceOutbox, type ProjectDataOutboxHandler, type ProjectDataOutboxJob } from '../core/project-data-outbox';
import { PandaProjectSync, sha256Hex } from '../core/project-sync';
import type { Project } from '../core/types';
import { designDataProjection } from '../designs/project-data-sync';
import type { ExecutorDriver } from '../executor/driver';
import { issueMetaProjection, moduleMetaProjection, projectDataProjection } from '../issues/project-data-sync';
import { moduleIssueRelPath, syncIssueDocumentContent } from '../issues/module-docs';
import { gitLockKey, type KeyedMutex } from '../issues/mutex';
import { workflowDataProjection } from '../issues/workflow-project-data';
import { getProject } from '../issues/engine';
import { lastRenumberFromDocPath } from '../issues/issue-renumber';
import type { IssueId } from '../../shared/issue-id';

function replaceManaged(content: string, name: string, body: string): string {
  const start = `<!-- panda:${name}:start -->`;
  const end = `<!-- panda:${name}:end -->`;
  const block = `${start}\n${body}\n${end}`;
  const from = content.indexOf(start);
  const to = from < 0 ? -1 : content.indexOf(end, from + start.length);
  if (from < 0 || to < 0) return `${content.trimEnd()}\n\n${block}\n`;
  return `${content.slice(0, from)}${block}${content.slice(to + end.length)}`;
}

export function createProjectDataPersistence(
  db: Database,
  driverForProject: (project: Project) => ExecutorDriver,
  mutex: KeyedMutex,
): ProjectDataPersistenceOutbox {
  const handler: ProjectDataOutboxHandler = {
    async persist(job) {
      const workspace = () => job.entityKind === 'issue' && db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_attempts'").get()
        ? db.query<{workspace_id:number;cwd:string;result_sha:string|null},[string]>(`SELECT a.workspace_id,COALESCE(a.execution_cwd,w.cwd) cwd,a.result_sha FROM workspace_attempts a JOIN module_workspaces w ON w.id=a.workspace_id WHERE a.issue_id=? ORDER BY a.created_ts DESC,a.rowid DESC LIMIT 1`).get(job.entityId) : null;
      const reservation=workspace();
      await mutex.runExclusive(reservation ? `workspace-git:${reservation.workspace_id}` : gitLockKey(job.projectId), async () => {
        const managed=workspace();
        if(managed?.workspace_id!==reservation?.workspace_id)throw new Error('工作区投影归属变化，等待重新投影');
        const project = getProject(db, job.projectId);
        if (!project) return;
        const driver = driverForProject(project);
        if (!driver.readFileNoFollowWithin || !driver.replaceFileNoFollowWithin) {
          throw new Error('执行机不支持协作文件原子持久化');
        }
        if (job.entityKind === 'attachment') return; // upload bytes are already the authoritative file.
        if (managed?.result_sha) {
          // Fixed result trees are immutable. Final runtime state is a DB-owned, ignored overlay.
          await driver.writeFile(`${managed.cwd}/.panda/tmp/state/${job.entityId}.json`, JSON.stringify(issueDataState(db,job.entityId)));
          return;
        }
        if (job.entityKind === 'module' || job.entityKind === 'issue') {
          await persistMarkdown(db, driver, managed?.cwd ?? project.cwd, job, managed ? project.cwd : undefined);
          return;
        }
        const target = jsonProjection(db, job);
        if (!target) return;
        let expected: string | null = null;
        const prior = await driver.readFileNoFollowWithin(project.cwd, target.path, 25 * 1024 * 1024).catch(() => null);
        if (prior) expected = sha256Hex(prior.data);
        const sync = new PandaProjectSync(driver, null, []);
        const written = await sync.writeJson(project.cwd, target.path, target.value, expected);
        if (written.status === 'conflict') throw new Error(`协作文件并发冲突：${target.path}`);
      });
    },
  };
  return new ProjectDataPersistenceOutbox(db, new Map(
    ['project', 'module', 'issue', 'workflow', 'design', 'conversation', 'attachment']
      .map((kind) => [kind, handler] as const),
  ));
}

function jsonProjection(db: Database, job: ProjectDataOutboxJob): { path: string; value: unknown } | null {
  const id = Number(job.entityId);
  if (job.entityKind === 'project') return { path: '.panda/project.json', value: projectDataProjection(db, job.projectId) };
  if (job.entityKind === 'workflow') {
    const value = workflowDataProjection(db, id);
    return { path: `.panda/workflows/${value.uid}.json`, value };
  }
  if (job.entityKind === 'design') return { path: `.panda/designs/design-${id}/sync.json`, value: designDataProjection(db, id) };
  if (job.entityKind === 'conversation') {
    const row = db.query<{ shared_read_only: number; sync_uid: string }, [string]>(
      'SELECT shared_read_only, sync_uid FROM conversations WHERE id = ?',
    ).get(job.entityId);
    if (!row?.shared_read_only) return null;
    const messages = readSharedConversationMessages(db, job.entityId).map((message) => ({
      seq: message.sequence, role: message.role, text: message.text ?? undefined,
      images: message.images, ts: message.createdTs ?? undefined,
    }));
    return { path: `.panda/conversations/${row.sync_uid}.json`, value: conversationDataProjection(db, job.entityId, messages) };
  }
  return null;
}

async function persistMarkdown(
  db: Database, driver: ExecutorDriver, cwd: string, job: ProjectDataOutboxJob, sourceCwd?: string,
): Promise<void> {
  let path: string;
  let name: string;
  let body: string;
  let fallback: string;
  let issueContent: { id: IssueId; title: string; body: string | null } | null = null;
  if (job.entityKind === 'module') {
    const row = db.query<{ slug: string; display_name: string }, [number]>('SELECT slug, display_name FROM project_modules WHERE id = ?').get(Number(job.entityId));
    if (!row) return;
    path = `.panda/modules/${row.slug}/MODULE.md`;
    name = 'module-meta'; body = moduleMetaProjection(db, Number(job.entityId)); fallback = `# ${row.display_name}\n`;
  } else {
    const row = db.query<{ id: IssueId; doc_path: string | null; module_id: number | null; title: string; body: string | null; slug: string | null }, [IssueId]>(
      `SELECT issue.id, issue.doc_path, issue.module_id, issue.title, issue.body, module.slug
       FROM issues issue LEFT JOIN project_modules module ON module.id = issue.module_id WHERE issue.id = ?`,
    ).get(job.entityId);
    if (!row) return;
    issueContent = { id: row.id, title: row.title, body: row.body };
    path = row.doc_path || moduleIssueRelPath(row.slug ?? 'unclassified', row.id, row.title);
    name = 'issue-meta'; body = issueMetaProjection(db, row.id);
    fallback = `# #${job.entityId} ${row.title}\n\n## 原始需求\n\n${row.body ?? ''}\n`;
  }
  const read = await driver.readFileNoFollowWithin!(cwd, path, 25 * 1024 * 1024).catch(() => null);
  // #307：换号后旧过程页还在 → 新路径没文件时沿用旧正文，写好新文件后删掉旧文件（重试也会补删）
  let movedFrom: { path: string; sha: string } | null = null;
  const source = !read && sourceCwd ? await driver.readFileNoFollowWithin!(sourceCwd,path,25*1024*1024).catch(()=>null) : null;
  let current = read ? new TextDecoder().decode(read.data) : source ? new TextDecoder().decode(source.data) : fallback;
  if (issueContent) {
    const renumbered = lastRenumberFromDocPath(db, issueContent.id);
    if (renumbered && renumbered.fromDocPath !== path) {
      const old = await driver.readFileNoFollowWithin!(cwd, renumbered.fromDocPath, 25 * 1024 * 1024).catch(() => null);
      if (old) {
        movedFrom = { path: renumbered.fromDocPath, sha: sha256Hex(old.data) };
        if (!read) current = new TextDecoder().decode(old.data)
          .replace(new RegExp(`^# #${renumbered.from}(?=\\s|$)`, 'm'), `# #${issueContent.id}`);
      }
    }
  }
  const synchronized = issueContent
    ? syncIssueDocumentContent(current, issueContent)
    : current;
  const next = new TextEncoder().encode(replaceManaged(synchronized, name, body));
  const status = await driver.replaceFileNoFollowWithin!(cwd, path, next, read ? sha256Hex(read.data) : null);
  if (status === 'conflict') throw new Error(`协作文件并发冲突：${path}`);
  if (movedFrom && driver.removeFileNoFollowWithin) {
    const removed = await driver.removeFileNoFollowWithin(cwd, movedFrom.path, movedFrom.sha);
    if (removed === 'conflict') throw new Error(`协作文件并发冲突：${movedFrom.path}`);
  }
}

function issueDataState(db:Database,id:string):unknown {
 return db.query('SELECT id,status,result_summary FROM issues WHERE id=?').get(id);
}
