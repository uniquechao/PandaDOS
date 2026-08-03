import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDriver } from './local';
import { discoverExecutorAgentHistory } from './agent-history';

let dir: string;
let claudeDir: string;
let codexDir: string;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-agent-history-'));
  claudeDir = path.join(dir, '.claude', 'projects');
  codexDir = path.join(dir, '.codex', 'sessions');
  await Promise.all([
    fsp.mkdir(path.join(claudeDir, '-work-app'), { recursive: true }),
    fsp.mkdir(path.join(claudeDir, '-work-other'), { recursive: true }),
    fsp.mkdir(path.join(codexDir, '2026', '08', '02'), { recursive: true }),
  ]);
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function executor(supportsClaude = true, supportsCodex = true) {
  return { claudeDir, codexDir, supportsClaude, supportsCodex };
}

async function writeClaude(folder: string, sid: string, cwd: string, prompt: string, ts: string) {
  const file = path.join(claudeDir, folder, `${sid}.jsonl`);
  await fsp.writeFile(file, [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: ts }),
    JSON.stringify({
      type: 'user',
      cwd,
      sessionId: sid,
      timestamp: ts,
      message: { role: 'user', content: prompt },
    }),
  ].join('\n') + '\n');
  return file;
}

async function writeCodex(sid: string, cwd: string, prompt: string, ts: string) {
  const day = path.join(codexDir, '2026', '08', '02');
  const file = path.join(day, `rollout-2026-08-02T10-00-00-${sid}.jsonl`);
  await fsp.writeFile(file, [
    JSON.stringify({
      timestamp: ts,
      type: 'session_meta',
      payload: { id: sid, timestamp: ts, cwd },
    }),
    JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>忽略</environment_context>' }] },
    }),
    JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    }),
  ].join('\n') + '\n');
  return file;
}

async function writeCodexIndex(entries: Array<{ id: string; thread_name: string; updated_at: string }>) {
  await fsp.writeFile(
    path.join(dir, '.codex', 'session_index.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}

describe('discoverExecutorAgentHistory', () => {
  test('解析 Claude/Codex 元数据，并按 agent + cwd 聚合项目候选', async () => {
    const claudePath = await writeClaude('-work-app', 'claude-a', '/work/app/', '修复登录问题', '2026-08-02T01:00:00.000Z');
    const codexPath = await writeCodex('codex-a', '/work/app', '检查终端输出', '2026-08-02T02:00:00.000Z');
    await writeCodexIndex([
      { id: 'codex-a', thread_name: '旧的 Codex 标题', updated_at: '2026-08-02T02:30:00.000Z' },
      { id: 'codex-a', thread_name: '原生 Codex 标题', updated_at: '2026-08-02T03:00:00.000Z' },
    ]);
    await writeClaude('-work-other', 'claude-b', '/work/other', '整理文档', '2026-08-01T01:00:00.000Z');

    const result = await discoverExecutorAgentHistory(new LocalDriver(), executor());

    expect(result.sessions).toHaveLength(3);
    expect(result.sessions.find((s) => s.sessionId === 'claude-a')).toMatchObject({
      agent: 'claude',
      cwd: '/work/app',
      jsonlPath: claudePath,
      createdTs: Date.parse('2026-08-02T01:00:00.000Z'),
      title: '修复登录问题',
    });
    expect(result.sessions.find((s) => s.sessionId === 'codex-a')).toMatchObject({
      agent: 'codex',
      cwd: '/work/app',
      jsonlPath: codexPath,
      createdTs: Date.parse('2026-08-02T02:00:00.000Z'),
      title: '原生 Codex 标题',
    });
    expect(result.projects).toHaveLength(3); // 同 cwd 的 Claude/Codex 是两类导入候选
    expect(result.projects.find((p) => p.agent === 'claude' && p.cwd === '/work/app')).toMatchObject({
      name: 'app',
      sessions: [expect.objectContaining({ sessionId: 'claude-a' })],
    });
  });

  test('跳过损坏或缺少绝对 cwd 的文件，且不扫描未启用的 Agent', async () => {
    await fsp.writeFile(path.join(claudeDir, '-work-app', 'broken.jsonl'), '{broken\n');
    await fsp.writeFile(
      path.join(claudeDir, '-work-app', 'relative.jsonl'),
      JSON.stringify({ type: 'user', cwd: 'relative/path', sessionId: 'relative', timestamp: '2026-08-02T00:00:00Z' }) + '\n',
    );
    const codexOnly = await discoverExecutorAgentHistory(new LocalDriver(), executor(false, true));
    expect(codexOnly.sessions.every((session) => session.agent === 'codex')).toBe(true);
    expect(codexOnly.sessions.some((session) => session.sessionId === 'broken')).toBe(false);
    expect(codexOnly.sessions.some((session) => session.sessionId === 'relative')).toBe(false);
  });

  test('目录不存在时返回空结果', async () => {
    const result = await discoverExecutorAgentHistory(new LocalDriver(), {
      claudeDir: path.join(dir, 'missing-claude'),
      codexDir: path.join(dir, 'missing-codex'),
      supportsClaude: true,
      supportsCodex: true,
    });
    expect(result).toEqual({ projects: [], sessions: [] });
  });

  test('Codex 标题索引缺失或损坏时回退到首条真实用户消息', async () => {
    await fsp.writeFile(path.join(dir, '.codex', 'session_index.jsonl'), '{broken\n');
    const result = await discoverExecutorAgentHistory(new LocalDriver(), executor(false, true));
    expect(result.sessions.find((session) => session.sessionId === 'codex-a')?.title).toBe('检查终端输出');
  });
});
