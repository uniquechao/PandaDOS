import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateIssueEngine } from '../issues/engine';
import { LocalDriver } from '../executor/local';
import { ConversationManager } from './conversations';
import { openDb } from './db';
import { migrate } from './migrate';
import { PandaProjectSync, PandaSyncIndex } from './project-sync';
import {
  conversationDataProjection,
  createConversationProjectDataAdapters,
  readSharedConversationMessages,
} from './conversation-project-data';

const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

function seed(db: ReturnType<typeof openDb>, cwd: string): void {
  migrate(db); migrateIssueEngine(db);
  db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
  db.run(`INSERT INTO executors
    (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'e', 'local', '', '', '/ws', '')`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (7, 'p', 1, ?, 1, 1)`, [cwd]);
}

describe('共享对话与附件同步', () => {
  test('导入净化历史和附件关联，删除文件后归档', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-conversation-sync-'));
    cleanups.push(cwd);
    const db = openDb(':memory:'); seed(db, cwd);
    const uid = '018bcfe5-6800-7102-8304-05060708090a';
    const upload = '.panda/uploads/abc/image.png';
    await fs.mkdir(path.join(cwd, '.panda/uploads/abc'), { recursive: true });
    await fs.mkdir(path.join(cwd, '.panda/conversations'), { recursive: true });
    await fs.writeFile(path.join(cwd, upload), new Uint8Array([1, 2, 3]));
    await fs.writeFile(path.join(cwd, `.panda/conversations/${uid}.json`), JSON.stringify({
      schema: 'pandados.project-data', version: 1, kind: 'conversation', uid,
      updatedTs: 20, createdTs: 10, label: '团队历史', agent: 'codex', archived: false,
      messages: [
        { role: 'user', text: '查看图片', images: [upload, '/home/u/private.png'], createdTs: 11 },
        { role: 'assistant', text: '已查看', createdTs: 12 },
      ],
    }));
    const sync = new PandaProjectSync(
      new LocalDriver(), new PandaSyncIndex(db), createConversationProjectDataAdapters(db),
    );
    expect(await sync.pull(7, cwd)).toMatchObject({ imported: 2, errors: 0 });
    const conversation = db.query<Record<string, unknown>, []>(
      `SELECT * FROM conversations WHERE sync_uid = '${uid}'`,
    ).get()!;
    expect(conversation.shared_read_only).toBe(1);
    expect(conversation.agent_session_id).toBeNull();
    expect(conversation.agent_jsonl_path).toBeNull();
    expect(readSharedConversationMessages(db, String(conversation.id))).toEqual([
      { sequence: 0, role: 'user', text: '查看图片', images: [upload], createdTs: 11 },
      { sequence: 1, role: 'assistant', text: '已查看', images: [], createdTs: 12 },
    ]);
    expect(db.query<{ status: string; sha256: string }, []>('SELECT status, sha256 FROM project_attachments').get())
      .toMatchObject({ status: 'active', sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' });

    const manager = new ConversationManager(db, new LocalDriver(), { locate: async () => null });
    await expect(manager.activate(String(conversation.id))).rejects.toThrow('只读历史');
    await fs.rm(path.join(cwd, upload));
    await fs.rm(path.join(cwd, `.panda/conversations/${uid}.json`));
    expect(await sync.pull(7, cwd)).toMatchObject({ archived: 2, errors: 0 });
    expect(db.query<{ status: string }, []>('SELECT status FROM project_attachments').get()!.status).toBe('archived');
    expect(db.query<{ archived: number }, []>(`SELECT archived FROM conversations WHERE sync_uid = '${uid}'`).get()!.archived).toBe(1);
    db.close();
  });

  test('投影不携带本机会话、绝对路径和用户身份', () => {
    const db = openDb(':memory:'); seed(db, '/project');
    db.run(`INSERT INTO conversations
      (id, project_id, label, created_ts, agent, kind, agent_session_id, agent_jsonl_path)
      VALUES ('native-id', 7, '原始', 10, 'claude', 'chat', 'agent-session', '/home/u/a.jsonl')`);
    const result = conversationDataProjection(db, 'native-id', [{
      seq: 1, role: 'user', text: '你好', images: ['.panda/uploads/a/a.png', '/home/u/private.png'], ts: 11,
    }]);
    const json = JSON.stringify(result);
    expect(result.messages).toEqual([{ role: 'user', text: '你好', images: ['.panda/uploads/a/a.png'], createdTs: 11 }]);
    expect(json).not.toContain('native-id');
    expect(json).not.toContain('agent-session');
    expect(json).not.toContain('/home/');
    expect(json).not.toContain('userId');
    db.close();
  });
});

describe('协作文件免读短路（size + mtime）', () => {
  /** 记下每个路径被真正读了几次——这条优化的全部意义就是「第二轮别再读」 */
  function countingDriver(): { driver: LocalDriver; reads: string[] } {
    const driver = new LocalDriver();
    const reads: string[] = [];
    const original = driver.readFileNoFollowWithin.bind(driver);
    driver.readFileNoFollowWithin = async (cwd: string, rel: string, max: number) => {
      reads.push(rel);
      return original(cwd, rel, max);
    };
    return { driver, reads };
  }

  async function setup(): Promise<{ cwd: string; db: ReturnType<typeof openDb>; upload: string }> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-attach-skip-'));
    cleanups.push(cwd);
    const db = openDb(':memory:');
    seed(db, cwd);
    const upload = '.panda/uploads/abc/image.png';
    await fs.mkdir(path.join(cwd, '.panda/uploads/abc'), { recursive: true });
    await fs.writeFile(path.join(cwd, upload), new Uint8Array([1, 2, 3, 4]));
    return { cwd, db, upload };
  }

  test('第二轮不再读文件重算哈希，仍记为 unchanged', async () => {
    const { cwd, db, upload } = await setup();
    const { driver, reads } = countingDriver();
    const sync = new PandaProjectSync(driver, new PandaSyncIndex(db), createConversationProjectDataAdapters(db));

    expect(await sync.pull(7, cwd)).toMatchObject({ imported: 1, errors: 0 });
    expect(reads).toEqual([upload]); // 首轮必须读，要落 sha256

    reads.length = 0;
    expect(await sync.pull(7, cwd)).toMatchObject({ imported: 0, unchanged: 1, errors: 0 });
    expect(reads).toEqual([]); // 关键：一个字节都不该再读
  });

  test('文件被改写（mtime 前进）→ 退回全量读，不会漏掉改动', async () => {
    const { cwd, db, upload } = await setup();
    const { driver, reads } = countingDriver();
    const sync = new PandaProjectSync(driver, new PandaSyncIndex(db), createConversationProjectDataAdapters(db));
    await sync.pull(7, cwd);

    // 大小不变、只有内容与 mtime 变了：短路必须靠 mtime 这一条拦住，不能只信 size
    await fs.writeFile(path.join(cwd, upload), new Uint8Array([9, 9, 9, 9]));
    await fs.utimes(path.join(cwd, upload), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    reads.length = 0;
    expect(await sync.pull(7, cwd)).toMatchObject({ imported: 1, errors: 0 });
    expect(reads).toEqual([upload]);
    const row = db.query<{ sha256: string }, []>('SELECT sha256 FROM project_attachments').get()!;
    expect(row.sha256).toBe(new Bun.CryptoHasher('sha256').update(new Uint8Array([9, 9, 9, 9])).digest('hex'));
  });

  test('执行机不提供 statPath → 老实全量读（能力缺失只能变慢，不能变错）', async () => {
    const { cwd, db, upload } = await setup();
    const { driver, reads } = countingDriver();
    (driver as { statPath?: unknown }).statPath = undefined;
    const sync = new PandaProjectSync(driver, new PandaSyncIndex(db), createConversationProjectDataAdapters(db));
    await sync.pull(7, cwd);
    reads.length = 0;
    expect(await sync.pull(7, cwd)).toMatchObject({ unchanged: 1, errors: 0 });
    expect(reads).toEqual([upload]);
  });
});
