/**
 * core/readme-summary 单测 —— README 驱动的项目简介：
 * 手动触发（无每日巡检），只看 README，force 强制调 驱动大模型 生成 ≤200 字简介。
 * Driver/LLM 均结构替身：不碰真实执行机与 驱动大模型。
 */
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { LlmClient, LlmMessage, LlmResult } from '../agents/llm';
import { openDb } from './db';
import { migrate } from './migrate';
import {
  findReadmePath,
  generateProjectReadmeSummary,
  md5hex,
  SUMMARY_MAX_CHARS,
  type ReadmeDriver,
} from './readme-summary';

// ---------- 替身 ----------

/** 以「绝对路径 → 文本」造一个只读文件系统 Driver 替身 */
function fakeDriver(files: Record<string, string>): ReadmeDriver {
  const enc = new TextEncoder();
  return {
    async listDir(path) {
      const base = path.replace(/\/+$/, '') + '/';
      const seen = new Map<string, 'file' | 'dir'>();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(base)) continue;
        const rest = f.slice(base.length);
        const seg = rest.split('/')[0]!;
        seen.set(seg, rest.includes('/') ? 'dir' : 'file');
      }
      if (seen.size === 0) throw new Error(`ENOENT: ${path}`);
      return [...seen].map(([name, type]) => ({ name, type }));
    },
    async statPath(p) {
      if (files[p] === undefined) return null;
      return { size: enc.encode(files[p]).length, mtimeMs: 0, isDirectory: false, isFile: true, mode: 0o644 };
    },
    async readFileRange(p, offset, limit) {
      const d = enc.encode(files[p] ?? '');
      return { data: d.slice(offset, offset + limit), size: d.length };
    },
  };
}

/** 可编程 LLM 替身：记下每次收到的消息，按脚本回答/报错 */
function fakeLlm(reply: string | Error = '曼拓：AI 编码项目管家。'): LlmClient & { calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = [];
  return {
    calls,
    async chat(messages: LlmMessage[]): Promise<LlmResult> {
      calls.push(messages);
      if (reply instanceof Error) throw reply;
      return { content: reply, toolCalls: [], raw: { role: 'assistant', content: reply } };
    },
  };
}

function setupDb(): Database {
  const db = openDb(':memory:');
  migrate(db);
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', '', '/ws', '/claude')`,
  );
  db.run(
    `INSERT INTO users (username, token_hash, role, created_ts) VALUES ('u1', 'h', 'user', 1)`,
  );
  return db;
}

function addProject(db: Database, cwd: string, opts: { status?: string; name?: string } = {}): number {
  const r = db
    .query<{ id: number }, [string, string, string]>(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, status, created_ts)
       VALUES (?, 1, ?, 1, ?, 1) RETURNING id`,
    )
    .get(opts.name ?? 'demo', cwd, opts.status ?? 'active');
  return r!.id;
}

interface ProjRow {
  readme_md5: string | null;
  readme_summary: string | null;
  readme_checked_ts: number;
}

function projRow(db: Database, id: number): ProjRow {
  return db
    .query<ProjRow, [number]>(
      'SELECT readme_md5, readme_summary, readme_checked_ts FROM projects WHERE id = ?',
    )
    .get(id)!;
}

/** 造一个供 helper 用的最小 project 对象（id/name/cwd 足够） */
function proj(id: number, name: string, cwd: string) {
  return { id, name, cwd };
}

const NOW = 1_800_000_000_000; // 固定“现在”，避免真实时钟

// ---------- md5hex ----------

describe('md5hex', () => {
  test('输出 32 位 hex，且内容敏感', () => {
    expect(md5hex('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
    expect(md5hex('hello!')).not.toBe(md5hex('hello'));
  });
});

// ---------- findReadmePath ----------

describe('findReadmePath', () => {
  test('大小写不敏感命中 README.md', async () => {
    const d = fakeDriver({ '/p/readme.MD': '# x', '/p/a.txt': 'y' });
    expect(await findReadmePath(d, '/p')).toBe('/p/readme.MD');
  });

  test('多候选时优先 .md，其次无扩展 README', async () => {
    const d = fakeDriver({ '/p/README': 'a', '/p/README.md': 'b', '/p/README.txt': 'c' });
    expect(await findReadmePath(d, '/p')).toBe('/p/README.md');
    const d2 = fakeDriver({ '/p/README': 'a', '/p/README.txt': 'c' });
    expect(await findReadmePath(d2, '/p')).toBe('/p/README');
  });

  test('无 README / 目录不存在 → null（不抛错）', async () => {
    expect(await findReadmePath(fakeDriver({ '/p/main.ts': 'x' }), '/p')).toBeNull();
    expect(await findReadmePath(fakeDriver({}), '/p')).toBeNull();
  });

  test('readme 是目录时忽略', async () => {
    const d = fakeDriver({ '/p/readme/doc.md': 'x' });
    expect(await findReadmePath(d, '/p')).toBeNull();
  });
});

// ---------- generateProjectReadmeSummary（手动触发；README-only；force） ----------

describe('generateProjectReadmeSummary', () => {
  test('有 README → 调 LLM 生成简介并落库（md5/summary/checked_ts）', async () => {
    const db = setupDb();
    const id = addProject(db, '/p', { name: '曼拓' });
    const llm = fakeLlm('曼拓：AI 编码项目管家，定位团队协作。');
    const driver = fakeDriver({ '/p/README.md': '# Mando\n多用户 AI 编码平台' });

    const r = await generateProjectReadmeSummary(
      { db, llm, driver, now: () => NOW },
      proj(id, '曼拓', '/p'),
    );

    expect(r).toEqual({ ok: true, summary: '曼拓：AI 编码项目管家，定位团队协作。' });
    expect(llm.calls.length).toBe(1);
    // 提示词里要带上项目名与 README 内容（LLM 才能写清名字/内容/定位）
    const sent = JSON.stringify(llm.calls[0]);
    expect(sent).toContain('曼拓');
    expect(sent).toContain('多用户 AI 编码平台');
    expect(sent).toContain('200');

    const row = projRow(db, id);
    expect(row.readme_summary).toBe('曼拓：AI 编码项目管家，定位团队协作。');
    expect(row.readme_md5).toBe(md5hex('# Mando\n多用户 AI 编码平台'));
    expect(row.readme_checked_ts).toBe(NOW);
  });

  test('LLM 超长回答被截到 SUMMARY_MAX_CHARS 字', async () => {
    const db = setupDb();
    const id = addProject(db, '/p');
    const llm = fakeLlm('长'.repeat(500));
    const driver = fakeDriver({ '/p/README.md': 'x' });
    const r = await generateProjectReadmeSummary({ db, llm, driver, now: () => NOW }, proj(id, 'demo', '/p'));
    expect(r.ok).toBe(true);
    expect([...projRow(db, id).readme_summary!].length).toBe(SUMMARY_MAX_CHARS);
  });

  test('无 README → 返回 no-readme、不调 LLM、旧简介/字段不动', async () => {
    const db = setupDb();
    const id = addProject(db, '/p');
    db.query(`UPDATE projects SET readme_summary = '旧简介' WHERE id = ?`).run(id);
    const llm = fakeLlm();
    const r = await generateProjectReadmeSummary(
      { db, llm, driver: fakeDriver({}), now: () => NOW },
      proj(id, 'demo', '/p'),
    );
    expect(r).toEqual({ ok: false, reason: 'no-readme' });
    expect(llm.calls.length).toBe(0);
    const row = projRow(db, id);
    expect(row.readme_summary).toBe('旧简介');
    expect(row.readme_checked_ts).toBe(0);
  });

  test('force：md5 未变也重新生成（无缓存闸门，每次都调 LLM）', async () => {
    const db = setupDb();
    const id = addProject(db, '/p');
    const llm = fakeLlm('简介');
    const driver = fakeDriver({ '/p/README.md': 'x' });
    await generateProjectReadmeSummary({ db, llm, driver, now: () => NOW }, proj(id, 'demo', '/p'));
    const r2 = await generateProjectReadmeSummary(
      { db, llm, driver, now: () => NOW + 1000 },
      proj(id, 'demo', '/p'),
    );
    expect(r2.ok).toBe(true);
    expect(llm.calls.length).toBe(2); // README 没变，force 仍第二次调用
    expect(projRow(db, id).readme_checked_ts).toBe(NOW + 1000);
  });

  test('LLM 失败 → 抛错（route 层兜错），旧数据不动', async () => {
    const db = setupDb();
    const id = addProject(db, '/p');
    const llm = fakeLlm(new Error('llm 500'));
    await expect(
      generateProjectReadmeSummary(
        { db, llm, driver: fakeDriver({ '/p/README.md': 'x' }), now: () => NOW },
        proj(id, 'demo', '/p'),
      ),
    ).rejects.toThrow('llm 500');
    const row = projRow(db, id);
    expect(row.readme_summary).toBeNull();
    expect(row.readme_md5).toBeNull();
    expect(row.readme_checked_ts).toBe(0);
  });
});

// ---------- mapProject 暴露 readmeSummary ----------

describe('Project.readmeSummary 暴露', () => {
  test('getProject 返回 readmeSummary（无则 null）', async () => {
    const db = setupDb();
    const id = addProject(db, '/p');
    const { getProject } = await import('../issues/engine');
    expect(getProject(db, id)!.readmeSummary).toBeNull();
    db.query(`UPDATE projects SET readme_summary = '简介' WHERE id = ?`).run(id);
    expect(getProject(db, id)!.readmeSummary).toBe('简介');
  });
});
