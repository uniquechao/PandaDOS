/** File projections and import adapters for project settings, modules, and issues. */
import type { Database } from 'bun:sqlite';
import { BUSY_STATES } from './queue';
import { MAX_ISSUE_BODY_CHARS } from './limits';
import { issueOriginalRequestEnd } from './module-docs';
import { legacySyncUid, PANDA_PROJECT_DATA, PANDA_PROJECT_DATA_VERSION } from '../core/project-data';
import type { PandaSyncAdapter, VersionedPandaRecord } from '../core/project-sync';

type Meta = Record<string, string>;

function managedMeta(text: string, name: 'module-meta' | 'issue-meta', path: string): Meta {
  const match = new RegExp(`<!-- panda:${name}:start -->\\s*---\\s*([\\s\\S]*?)\\s*---\\s*<!-- panda:${name}:end -->`).exec(text);
  if (!match) throw new Error(`缺少 ${name}：${path}`);
  const out: Meta = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const item = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (item) out[item[1]!] = item[2]!;
  }
  return out;
}

function textValue(value: string | undefined): string | null {
  if (value === undefined || value === 'null') return null;
  if (value.startsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return null; }
  }
  return value;
}

function intValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function markdownText(data: Uint8Array, path: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new Error(`Markdown 编码无效：${path}`); }
}

function titleFrom(text: string, issue: boolean, path: string): string {
  const match = issue ? /^#\s+#\S+\s+(.+)$/m.exec(text) : /^#\s+(.+)$/m.exec(text);
  const title = match?.[1]?.trim();
  if (!title) throw new Error(`Markdown 标题无效：${path}`);
  return title;
}

function originalRequest(text: string): string | null {
  const section = /^## 原始需求[^\r\n]*(?:\r?\n|$)/m.exec(text);
  if (!section || section.index === undefined) return null;
  const contentStart = section.index + section[0].length;
  const body = text.slice(contentStart, issueOriginalRequestEnd(text, contentStart)).trim();
  return body && body !== '（无补充正文）' ? body : null;
}

function validAgent(value: string | undefined): 'claude' | 'codex' {
  return value === 'codex' ? 'codex' : 'claude';
}

function moduleRecord(data: Uint8Array, path: string): VersionedPandaRecord {
  const text = markdownText(data, path);
  const meta = managedMeta(text, 'module-meta', path);
  const createdTs = intValue(meta.created_ts, 0);
  const uid = textValue(meta.sync_uid) ?? legacySyncUid(createdTs, `module:${path}`);
  return {
    schema: PANDA_PROJECT_DATA.schema,
    version: PANDA_PROJECT_DATA_VERSION,
    kind: 'module',
    uid,
    updatedTs: intValue(meta.last_used_ts, createdTs),
    title: titleFrom(text, false, path),
    slug: textValue(meta.slug),
    displayName: textValue(meta.display_name),
    agent: validAgent(meta.agent),
    source: meta.source === 'auto' || meta.source === 'legacy' ? meta.source : 'manual',
    status: meta.status === 'archived' ? 'archived' : 'active',
    createdTs,
  };
}

function issueRecord(data: Uint8Array, path: string): VersionedPandaRecord {
  const text = markdownText(data, path);
  const meta = managedMeta(text, 'issue-meta', path);
  const createdTs = intValue(meta.created_ts, 0);
  const uid = textValue(meta.sync_uid) ?? legacySyncUid(createdTs, `issue:${path}`);
  return {
    schema: PANDA_PROJECT_DATA.schema,
    version: PANDA_PROJECT_DATA_VERSION,
    kind: 'issue',
    uid,
    updatedTs: intValue(meta.updated_ts, createdTs),
    title: titleFrom(text, true, path),
    body: originalRequest(text),
    moduleUid: textValue(meta.module_uid),
    moduleSlug: textValue(meta.module),
    agent: validAgent(meta.agent),
    category: meta.category === 'debug' || meta.category === 'design' ? meta.category : 'task',
    implMode: meta.impl_mode === 'team' ? 'team' : 'seq',
    status: meta.status ?? 'pending',
    createdTs,
  };
}

const ISSUE_STATES = new Set([
  'pending', 'clarifying', 'planning', 'plan_review', 'implementing', 'testing',
  'merge_review', 'merging', 'done', 'blocked', 'cancelled',
]);

export function createIssueProjectDataAdapters(db: Database): PandaSyncAdapter[] {
  const project: PandaSyncAdapter = {
    kind: 'project',
    priority: 0,
    matches: (path) => path === PANDA_PROJECT_DATA.project,
    apply(projectId, item) {
      const value = item.value as Record<string, unknown>;
      const name = typeof value.name === 'string' ? value.name.trim().slice(0, 100) : '';
      if (!name) throw new Error('项目名称为空');
      const status = value.status === 'archived' ? 'archived' : 'active';
      db.query(`UPDATE projects SET sync_uid = ?, name = ?, goal = ?, pm_persona = ?,
        work_branch = ?, manual_review = ?, kind = ?, status = ? WHERE id = ?`)
        .run(
          item.uid,
          name,
          typeof value.goal === 'string' ? value.goal.slice(0, 2000) : null,
          typeof value.pmPersona === 'string' ? value.pmPersona.slice(0, 8000) : null,
          typeof value.workBranch === 'string' ? value.workBranch.slice(0, 200) : null,
          value.manualReview === true ? 1 : 0,
          'issue',
          status,
          projectId,
        );
    },
    archive(projectId) { db.query(`UPDATE projects SET status = 'archived' WHERE id = ?`).run(projectId); },
  };

  const module: PandaSyncAdapter = {
    kind: 'module',
    priority: 10,
    matches: (path) => /^\.panda\/modules\/[a-z0-9-]+\/MODULE\.md$/.test(path),
    decode: moduleRecord,
    apply(projectId, item) {
      const value = item.value as Record<string, unknown>;
      const slug = typeof value.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(value.slug)
        ? value.slug : null;
      if (!slug) throw new Error('模块 slug 无效');
      const displayName = typeof value.displayName === 'string' && value.displayName.trim()
        ? value.displayName.trim().slice(0, 80) : String(value.title).slice(0, 80);
      const agent = value.agent === 'codex' ? 'codex' : 'claude';
      const source = value.source === 'auto' || value.source === 'legacy' ? value.source : 'manual';
      const status = value.status === 'archived' ? 'archived' : 'active';
      const createdTs = Number(value.createdTs) || 0;
      const existing = db.query<{ id: number }, [number, string, string, string]>(
        'SELECT id FROM project_modules WHERE project_id = ? AND (sync_uid = ? OR slug = ?) ORDER BY sync_uid = ? DESC LIMIT 1',
      ).get(projectId, item.uid, slug, item.uid);
      if (existing) {
        db.query(`UPDATE project_modules SET sync_uid = ?, slug = ?, display_name = ?, agent = ?,
          source = ?, status = ?, sync_status = 'ready', sync_error = NULL WHERE id = ?`)
          .run(item.uid, slug, displayName, agent, source, status, existing.id);
      } else {
        db.query(`INSERT INTO project_modules
          (project_id, sync_uid, slug, display_name, agent, source, status, created_ts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(projectId, item.uid, slug, displayName, agent, source, status, createdTs);
      }
    },
    archive(projectId, item) {
      db.query(`UPDATE project_modules SET status = 'archived'
        WHERE project_id = ? AND sync_uid = ?`).run(projectId, item.uid);
    },
  };

  const issue: PandaSyncAdapter = {
    kind: 'issue',
    priority: 20,
    matches: (path) => /^\.panda\/modules\/[a-z0-9-]+\/issues\/[^/]+\.md$/.test(path),
    decode: issueRecord,
    apply(projectId, item) {
      const value = item.value as Record<string, unknown>;
      const moduleRow = typeof value.moduleUid === 'string'
        ? db.query<{ id: number; slug: string }, [number, string]>(
          'SELECT id, slug FROM project_modules WHERE project_id = ? AND sync_uid = ?',
        ).get(projectId, value.moduleUid)
        : db.query<{ id: number; slug: string }, [number, string]>(
          'SELECT id, slug FROM project_modules WHERE project_id = ? AND slug = ?',
        ).get(projectId, String(value.moduleSlug ?? ''));
      if (!moduleRow) throw new Error('Issue 引用的模块不存在');
      const existing = db.query<{ id: number; status: string }, [number, string]>(
        'SELECT id, status FROM issues WHERE project_id = ? AND sync_uid = ?',
      ).get(projectId, item.uid);
      const fileStatus = typeof value.status === 'string' && ISSUE_STATES.has(value.status)
        ? value.status : 'pending';
      // 文件状态只参与首次导入；一旦入库，状态机就是唯一事实源。协作文件可能落后于
      // outbox，也可能被人工编辑，任何反向覆盖都会把运行态/受阻态/终态重新排队。
      // 首次导入中的运行态仍降为 pending，避免恢复并不存在的本机执行现场。
      const status = !existing && BUSY_STATES.includes(fileStatus as never) ? 'pending' : fileStatus;
      const title = String(value.title).trim().slice(0, 200);
      const body = typeof value.body === 'string' ? value.body.slice(0, MAX_ISSUE_BODY_CHARS) : null;
      const category = value.category === 'debug' || value.category === 'design' ? value.category : 'task';
      const implMode = value.implMode === 'team' ? 'team' : 'seq';
      const agent = value.agent === 'codex' ? 'codex' : 'claude';
      const createdTs = Number(value.createdTs) || 0;
      if (existing) {
        db.query(`UPDATE issues SET title = ?, body = ?, category = ?, module = ?, module_id = ?,
          impl_mode = ?, agent = ?, doc_path = ? WHERE id = ?`)
          .run(title, body, category, moduleRow.slug, moduleRow.id, implMode, agent,
            item.path, existing.id);
      } else {
        db.query(`INSERT INTO issues
          (project_id, sync_uid, title, body, category, status, module, module_id, impl_mode, agent,
           doc_path, created_ts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(projectId, item.uid, title, body, category, status, moduleRow.slug, moduleRow.id,
            implMode, agent, item.path, createdTs);
      }
    },
    archive(projectId, item) {
      const existing = db.query<{ status: string }, [number, string]>(
        'SELECT status FROM issues WHERE project_id = ? AND sync_uid = ?',
      ).get(projectId, item.uid);
      if (existing && !BUSY_STATES.includes(existing.status as never)) {
        db.query(`UPDATE issues SET status = 'cancelled'
          WHERE project_id = ? AND sync_uid = ?`).run(projectId, item.uid);
      }
    },
  };
  return [project, module, issue];
}

export function projectDataProjection(db: Database, projectId: number): VersionedPandaRecord {
  const row = db.query<Record<string, unknown>, [number]>('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!row || typeof row.sync_uid !== 'string') throw new Error('项目不存在或缺少 sync_uid');
  return {
    schema: PANDA_PROJECT_DATA.schema,
    version: PANDA_PROJECT_DATA_VERSION,
    kind: 'project',
    uid: row.sync_uid,
    updatedTs: Number(row.understanding_ts ?? row.created_ts),
    name: row.name,
    goal: row.goal,
    pmPersona: row.pm_persona,
    workBranch: row.work_branch,
    manualReview: Number(row.manual_review) !== 0,
    status: row.status,
  };
}

export function moduleMetaProjection(db: Database, moduleId: number): string {
  const row = db.query<Record<string, unknown>, [number]>('SELECT * FROM project_modules WHERE id = ?').get(moduleId);
  if (!row || typeof row.sync_uid !== 'string') throw new Error('模块不存在或缺少 sync_uid');
  return [
    '---', `sync_uid: ${row.sync_uid}`, `module_id: ${row.id}`, `project_id: ${row.project_id}`,
    `slug: ${row.slug}`, `display_name: ${JSON.stringify(row.display_name)}`, `agent: ${row.agent}`,
    `source: ${row.source}`, `status: ${row.status}`, `created_ts: ${row.created_ts}`,
    `last_used_ts: ${row.last_used_ts ?? 'null'}`, '---',
  ].join('\n');
}

export function issueMetaProjection(db: Database, issueId: number): string {
  const row = db.query<Record<string, unknown>, [number]>('SELECT * FROM issues WHERE id = ?').get(issueId);
  if (!row || typeof row.sync_uid !== 'string') throw new Error('Issue 不存在或缺少 sync_uid');
  const module = row.module_id === null ? null : db.query<{ sync_uid: string }, [number]>(
    'SELECT sync_uid FROM project_modules WHERE id = ?',
  ).get(Number(row.module_id));
  return [
    '---', `sync_uid: ${row.sync_uid}`, `issue_id: ${row.id}`,
    `module_uid: ${module?.sync_uid ?? 'null'}`, `module: ${row.module}`, `agent: ${row.agent}`,
    `category: ${row.category}`, `impl_mode: ${row.impl_mode}`, `status: ${row.status}`,
    `created_ts: ${row.created_ts}`, '---',
  ].join('\n');
}
