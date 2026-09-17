/** Portable conversation archives and `.panda/uploads` attachment metadata. */
import type { Database } from 'bun:sqlite';
import type { ChatMessage } from './jsonl';
import { legacySyncUid, PANDA_PROJECT_DATA, PANDA_PROJECT_DATA_VERSION } from './project-data';
import { sha256Hex, type PandaSyncAdapter, type VersionedPandaRecord } from './project-sync';
import { ALLOWED_IMAGE_EXT, isUploadRel } from './uploads';

export interface SharedConversationMessage {
  sequence: number;
  role: ChatMessage['role'];
  text: string | null;
  images: string[];
  createdTs: number | null;
}

const ROLES = new Set<SharedConversationMessage['role']>(
  ['assistant', 'thinking', 'tool_use', 'tool_result', 'user'],
);

function safeImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((path): path is string => typeof path === 'string' && isUploadRel(path)))].slice(0, 20);
}

function cleanMessages(value: unknown): SharedConversationMessage[] {
  if (!Array.isArray(value)) throw new Error('共享对话 messages 无效');
  return value.slice(0, 100_000).map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`共享对话消息无效：${index}`);
    const item = raw as Record<string, unknown>;
    if (!ROLES.has(item.role as SharedConversationMessage['role'])) throw new Error(`共享对话角色无效：${index}`);
    return {
      sequence: index,
      role: item.role as SharedConversationMessage['role'],
      text: typeof item.text === 'string' ? item.text.slice(0, 100_000) : null,
      images: safeImages(item.images),
      createdTs: Number.isSafeInteger(item.createdTs) && Number(item.createdTs) >= 0 ? Number(item.createdTs) : null,
    };
  });
}

/** Build a sanitized archive without native session ids, JSONL paths, cwd, tmux names or user identity. */
export function conversationDataProjection(
  db: Database,
  conversationId: string,
  messages: readonly ChatMessage[],
): VersionedPandaRecord {
  const row = db.query<Record<string, unknown>, [string]>(
    'SELECT sync_uid, label, agent, created_ts, archived, last_active_ts FROM conversations WHERE id = ?',
  ).get(conversationId);
  if (!row || typeof row.sync_uid !== 'string') throw new Error('对话不存在或缺少 sync_uid');
  return {
    schema: PANDA_PROJECT_DATA.schema,
    version: PANDA_PROJECT_DATA_VERSION,
    kind: 'conversation',
    uid: row.sync_uid,
    updatedTs: Number(row.last_active_ts) || Number(row.created_ts),
    label: typeof row.label === 'string' ? row.label : null,
    agent: row.agent === 'codex' ? 'codex' : 'claude',
    createdTs: Number(row.created_ts),
    archived: Number(row.archived) !== 0,
    messages: messages.map((message) => ({
      role: message.role,
      text: typeof message.text === 'string' ? message.text : null,
      images: safeImages(message.images),
      createdTs: Number.isSafeInteger(message.ts) && Number(message.ts) >= 0 ? message.ts : null,
    })),
  };
}

export function readSharedConversationMessages(db: Database, conversationId: string): SharedConversationMessage[] {
  const rows = db.query<{ sequence: number; role: string; text: string | null; images_json: string | null; created_ts: number | null }, [string]>(
    `SELECT sequence, role, text, images_json, created_ts FROM conversation_shared_messages
     WHERE conversation_id = ? ORDER BY sequence`,
  ).all(conversationId);
  return rows.map((row) => ({
    sequence: row.sequence,
    role: row.role as SharedConversationMessage['role'],
    text: row.text,
    images: safeImages(row.images_json ? JSON.parse(row.images_json) : []),
    createdTs: row.created_ts,
  }));
}

function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
}

export function createConversationProjectDataAdapters(db: Database): PandaSyncAdapter[] {
  const attachment: PandaSyncAdapter = {
    kind: 'attachment',
    priority: 40,
    matches(path) {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      return isUploadRel(path) && ALLOWED_IMAGE_EXT.has(ext);
    },
    decode(data, path) {
      return {
        schema: PANDA_PROJECT_DATA.schema,
        version: PANDA_PROJECT_DATA_VERSION,
        kind: 'attachment',
        uid: legacySyncUid(0, `attachment:${path}`),
        updatedTs: 0,
        path,
        sha256: sha256Hex(data),
        mimeType: mimeFor(path),
        size: data.byteLength,
      };
    },
    apply(projectId, item) {
      const value = item.value as Record<string, unknown>;
      db.query(`INSERT INTO project_attachments
        (project_id, sync_uid, path, sha256, mime_type, size, created_ts, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(project_id, path) DO UPDATE SET sync_uid = excluded.sync_uid,
          sha256 = excluded.sha256, mime_type = excluded.mime_type, size = excluded.size, status = 'active'`)
        .run(projectId, item.uid, item.path, String(value.sha256), String(value.mimeType), Number(value.size), Date.now());
    },
    archive(projectId, item) {
      db.query(`UPDATE project_attachments SET status = 'archived'
        WHERE project_id = ? AND sync_uid = ?`).run(projectId, item.uid);
    },
  };

  const conversation: PandaSyncAdapter = {
    kind: 'conversation',
    priority: 50,
    matches: (path) => /^\.panda\/conversations\/[0-9a-f-]+\.json$/.test(path),
    apply(projectId, item) {
      const value = item.value as Record<string, unknown>;
      const messages = cleanMessages(value.messages);
      const id = `shared-${item.uid}`;
      const available = new Set(db.query<{ path: string }, [number]>(
        `SELECT path FROM project_attachments WHERE project_id = ? AND status = 'active'`,
      ).all(projectId).map((row) => row.path));
      for (const message of messages) message.images = message.images.filter((path) => available.has(path));
      db.transaction(() => {
        const collision = db.query<{ project_id: number }, [string]>(
          'SELECT project_id FROM conversations WHERE sync_uid = ?',
        ).get(item.uid);
        if (collision && collision.project_id !== projectId) throw new Error('共享对话身份与其他项目冲突');
        db.query(`INSERT INTO conversations
          (id, project_id, sync_uid, label, created_ts, archived, agent, kind, shared_read_only)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'chat', 1)
          ON CONFLICT(sync_uid) WHERE sync_uid IS NOT NULL DO UPDATE SET label = excluded.label, archived = excluded.archived,
            agent = excluded.agent, shared_read_only = 1`)
          .run(id, projectId, item.uid,
            typeof value.label === 'string' ? value.label.slice(0, 80) : '共享历史',
            Number(value.createdTs) || Number(value.updatedTs), value.archived === true ? 1 : 0,
            value.agent === 'codex' ? 'codex' : 'claude');
        const local = db.query<{ id: string }, [number, string]>(
          'SELECT id FROM conversations WHERE project_id = ? AND sync_uid = ?',
        ).get(projectId, item.uid);
        if (!local) throw new Error('共享对话身份与其他项目冲突');
        db.query('DELETE FROM conversation_shared_messages WHERE conversation_id = ?').run(local.id);
        for (const message of messages) db.query(`INSERT INTO conversation_shared_messages
          (conversation_id, sequence, role, text, images_json, created_ts) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(local.id, message.sequence, message.role, message.text,
            message.images.length ? JSON.stringify(message.images) : null, message.createdTs);
      })();
    },
    archive(projectId, item) {
      db.query(`UPDATE conversations SET archived = 1
        WHERE project_id = ? AND sync_uid = ? AND shared_read_only = 1`).run(projectId, item.uid);
    },
  };
  return [attachment, conversation];
}
