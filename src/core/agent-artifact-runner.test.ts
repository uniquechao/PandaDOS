import { describe, expect, test } from 'bun:test';
import {
  runAgentArtifacts,
  type AgentArtifactDriver,
} from './agent-artifact-runner';

class FakeDriver implements AgentArtifactDriver {
  executable: string | null = '/opt/bin/claude';
  sessions = new Set<string>();
  files = new Map<string, string>();
  created: Array<{ name: string; cwd: string }> = [];
  killed: string[] = [];
  sent: Array<{ session: string; text: string }> = [];
  keys: Array<{ session: string; key: string }> = [];
  removed: string[] = [];
  captureCount = 0;
  failCreate = false;
  paneAt: (n: number) => string = () => '';
  onCapture?: (n: number, files: Map<string, string>) => void;

  async findExecutable() { return this.executable; }
  async listSessions() { return [...this.sessions].map((name) => ({ name, createdTs: 0, attached: false })); }
  async createSession(name: string, cwd: string) {
    if (this.failCreate) throw new Error('create failed');
    this.sessions.add(name);
    this.created.push({ name, cwd });
  }
  async killSession(name: string) {
    if (!this.sessions.delete(name)) throw new Error('missing');
    this.killed.push(name);
  }
  async sendKeys(session: string, text: string) { this.sent.push({ session, text }); }
  async sendKey(session: string, key: string) { this.keys.push({ session, key }); }
  async capturePane() {
    const n = this.captureCount++;
    this.onCapture?.(n, this.files);
    return this.paneAt(n);
  }
  async writeFile(path: string, data: Uint8Array | string) {
    this.files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
  }
  async statPath(path: string) {
    const data = this.files.get(path);
    return data === undefined
      ? null
      : { size: new TextEncoder().encode(data).length, mtimeMs: 0, isDirectory: false, isFile: true, mode: 0o644 };
  }
  async readFileRange(path: string, offset: number, limit: number) {
    const data = new TextEncoder().encode(this.files.get(path) ?? '');
    return { data: data.subarray(offset, offset + limit), size: data.length };
  }
  async removeTree(path: string) {
    this.removed.push(path);
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
  }
}

function clock(onSleep?: (now: number) => void) {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      onSleep?.(now);
    },
  };
}

const paths = {
  scratch: '/repo/.panda/tmp/demo/run-1',
  input: '/repo/.panda/tmp/demo/run-1/task.md',
  output: '/repo/.panda/tmp/demo/run-1/output.json',
  done: '/repo/.panda/tmp/demo/run-1/done',
};

const input = {
  agent: 'claude' as const,
  cwd: '/repo',
  session: 'artifact-1',
  scratch: paths.scratch,
  prompt: 'Read the task file, write output.json, then create done.',
  inputFiles: [{ path: paths.input, data: 'long context' }],
  donePath: paths.done,
  artifacts: [{
    key: 'output',
    path: paths.output,
    maxBytes: 1024,
    parse: (text: string) => JSON.parse(text) as { answer: number },
  }],
};

const FAST = { pollIntervalMs: 10, readyDelayMs: 10, timeoutMs: 50 };

describe('runAgentArtifacts', () => {
  test('resolves the selected executable and quotes its path before launching Claude Code or Codex', async () => {
    for (const [agent, executable, expected] of [
      ['claude', '/Applications/Claude Code/bin/claude', "'/Applications/Claude Code/bin/claude' --permission-mode acceptEdits"],
      ['codex', '/srv/tools/codex', '/srv/tools/codex --dangerously-bypass-approvals-and-sandbox'],
    ] as const) {
      const driver = new FakeDriver();
      driver.executable = executable;
      driver.onCapture = (n, files) => {
        if (n >= 2) {
          files.set(paths.output, '{"answer":42}');
          files.set(paths.done, 'ok');
        }
      };
      const result = await runAgentArtifacts(
        { driver, ...clock() },
        { ...input, agent },
        FAST,
      );
      expect(result.ok).toBe(true);
      expect(driver.sent[0]?.text).toBe(expected);
    }
  });

  test('dismisses blocking menus and completes only from the done file sentinel', async () => {
    const driver = new FakeDriver();
    driver.paneAt = (n) => n === 0
      ? ['Do you trust this folder?', '❯ 1. No', '  2. Yes, continue'].join('\n')
      : 'The terminal says done, but that is not a completion signal.';
    driver.onCapture = (n, files) => {
      if (n >= 3) {
        files.set(paths.output, '{"answer":42}');
        files.set(paths.done, 'ok');
      }
    };
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);
    expect(result).toEqual({ ok: true, artifacts: { output: { answer: 42 } } });
    expect(driver.keys).toEqual([
      { session: 'artifact-1', key: 'Down' },
      { session: 'artifact-1', key: 'Enter' },
    ]);
  });

  test('rejects a completed run whose required artifact is malformed', async () => {
    const driver = new FakeDriver();
    driver.onCapture = (n, files) => {
      if (n >= 2) {
        files.set(paths.output, '{bad json');
        files.set(paths.done, 'ok');
      }
    };
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);
    expect(result).toMatchObject({ ok: false, reason: 'malformed-artifact', artifact: 'output' });
  });

  test('rejects an artifact whose on-disk size exceeds its declared bound', async () => {
    const driver = new FakeDriver();
    driver.onCapture = (n, files) => {
      if (n >= 2) {
        files.set(paths.output, '{"answer":42}' + ' '.repeat(1024));
        files.set(paths.done, 'ok');
      }
    };
    const result = await runAgentArtifacts({ driver, ...clock() }, {
      ...input,
      artifacts: input.artifacts.map((artifact) => ({ ...artifact, rejectOversize: true })),
    }, FAST);
    expect(result).toMatchObject({ ok: false, reason: 'malformed-artifact', artifact: 'output' });
  });

  test('preserves legacy bounded-read semantics unless strict size rejection is requested', async () => {
    const driver = new FakeDriver();
    driver.onCapture = (n, files) => {
      if (n >= 2) {
        files.set(paths.output, '{"answer":42}' + ' '.repeat(1024));
        files.set(paths.done, 'ok');
      }
    };
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);
    expect(result).toEqual({ ok: true, artifacts: { output: { answer: 42 } } });
  });

  test('can leave permission menus untouched for sandboxed callers', async () => {
    const driver = new FakeDriver();
    driver.paneAt = () => ['Allow access outside the working directory?', '❯ 1. No', '  2. Yes'].join('\n');
    const result = await runAgentArtifacts(
      { driver, ...clock() },
      input,
      { ...FAST, autoApproveMenus: false },
    );
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(driver.keys).toEqual([]);
  });

  test('times out without a file sentinel even when terminal prose claims completion', async () => {
    const driver = new FakeDriver();
    driver.paneAt = () => 'DONE successfully';
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  test('cancels promptly through AbortSignal', async () => {
    const driver = new FakeDriver();
    const controller = new AbortController();
    const result = await runAgentArtifacts(
      { driver, ...clock((now) => { if (now >= 20) controller.abort(); }) },
      input,
      { ...FAST, signal: controller.signal },
    );
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });

  test('guarantees session and scratch cleanup after success, parse failure, and launch failure', async () => {
    for (const mode of ['success', 'parse', 'launch'] as const) {
      const driver = new FakeDriver();
      driver.failCreate = mode === 'launch';
      driver.onCapture = (n, files) => {
        if (n >= 2) {
          files.set(paths.output, mode === 'parse' ? '{' : '{"answer":42}');
          files.set(paths.done, 'ok');
        }
      };
      await runAgentArtifacts({ driver, ...clock() }, input, FAST);
      expect(driver.removed).toContain(paths.scratch);
      expect(driver.sessions.has(input.session)).toBe(false);
    }
  });

  test('refuses to create a session when the selected executable is unavailable', async () => {
    const driver = new FakeDriver();
    driver.executable = null;
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);
    expect(result).toEqual({ ok: false, reason: 'executable-not-found' });
    expect(driver.created).toEqual([]);
  });
});
