import { describe, expect, test } from 'bun:test';
import {
  CODEX_READY_DELAY_MS,
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
  /** 诊断用：列 scratch 目录（#280）——按 files 里的路径前缀推出直接子项 */
  async listDir(path: string) {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const [head] = rest.split('/');
      if (head) names.add(rest.includes('/') ? `${head}/` : head);
    }
    return [...names].map((name) => name.endsWith('/')
      ? { name: name.slice(0, -1), type: 'dir' as const }
      : { name, type: 'file' as const });
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
      // #281：一次性会话统一 low（codex 的 effort 是启动参数，只能在这里定）
      ['codex', '/srv/tools/codex', '/srv/tools/codex --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="low"'],
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
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(driver.keys).toEqual([]);
  });

  test('times out without a file sentinel even when terminal prose claims completion', async () => {
    const driver = new FakeDriver();
    driver.paneAt = () => 'DONE successfully';
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    // 屏上说完事了不算数，产物也确实没写出来 → 不是 partial
    expect(result.ok === false && result.partial).toBeUndefined();
  });

  test('cancels promptly through AbortSignal', async () => {
    const driver = new FakeDriver();
    const controller = new AbortController();
    const result = await runAgentArtifacts(
      { driver, ...clock((now) => { if (now >= 20) controller.abort(); }) },
      input,
      { ...FAST, signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
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

  // #280 / B-06：超时即 kill + removeTree 让生产上 92% 的失败退化成一句无信息的 reason=timeout
  test('超时带回现场证据：pane 尾部 + scratch 文件清单 + 耗时', async () => {
    const driver = new FakeDriver();
    driver.paneAt = () => ['正在读取代码库…', '❯ 还在跑'].join('\n');
    driver.onCapture = (n, files) => {
      if (n >= 2) files.set(`${paths.scratch}/notes.md`, '半成品');
    };
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);

    expect(result.ok).toBe(false);
    const diag = result.ok === false ? result.diagnostics : undefined;
    expect(diag?.paneTail).toContain('正在读取代码库');
    expect(diag?.files.map((f) => f.name).sort()).toEqual(['notes.md', 'task.md']);
    expect(diag?.files.find((f) => f.name === 'task.md')?.size).toBeGreaterThan(0);
    expect(diag?.elapsedMs).toBeGreaterThan(0);
    expect(diag?.hadArtifacts).toBe(0);
  });

  test('产物抢救：done 没出现但产物写出来了 → partial + 产物照常带回', async () => {
    const driver = new FakeDriver();
    driver.onCapture = (n, files) => {
      if (n >= 2) files.set(paths.output, '{"answer":42}'); // 就是不写 done
    };
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);

    expect(result).toMatchObject({ ok: false, reason: 'timeout', partial: true });
    expect(result.ok === false && result.artifacts).toEqual({ output: { answer: 42 } });
    expect(result.ok === false && result.diagnostics?.hadArtifacts).toBe(1);
  });

  test('失败时可按选项保留 scratch 留现场；成功路径照常清理', async () => {
    const kept = new FakeDriver();
    await runAgentArtifacts({ driver: kept, ...clock() }, input, { ...FAST, preserveScratchOnFailure: true });
    // 起会话前那次自清残留仍在（步骤 0），失败后的那次被跳过 → 总共只删一次
    expect(kept.removed.filter((p2) => p2 === paths.scratch)).toHaveLength(1);
    expect(kept.sessions.has(input.session)).toBe(false); // 会话仍然要收

    const wiped = new FakeDriver();
    await runAgentArtifacts({ driver: wiped, ...clock() }, input, FAST); // 不开保留 → 删两次
    expect(wiped.removed.filter((p2) => p2 === paths.scratch)).toHaveLength(2);

    const cleaned = new FakeDriver();
    cleaned.onCapture = (n, files) => {
      if (n >= 2) {
        files.set(paths.output, '{"answer":42}');
        files.set(paths.done, 'ok');
      }
    };
    const ok = await runAgentArtifacts({ driver: cleaned, ...clock() }, input, { ...FAST, preserveScratchOnFailure: true });
    expect(ok).toEqual({ ok: true, artifacts: { output: { answer: 42 } } });
    expect(cleaned.removed).toContain(paths.scratch);
  });

  test('成功路径不受影响：不采样、不带诊断字段', async () => {
    const driver = new FakeDriver();
    driver.onCapture = (n, files) => {
      if (n >= 2) {
        files.set(paths.output, '{"answer":7}');
        files.set(paths.done, 'ok');
      }
    };
    const result = await runAgentArtifacts({ driver, ...clock() }, input, FAST);
    expect(result).toEqual({ ok: true, artifacts: { output: { answer: 7 } } });
  });

  test('required 产物缺失也带诊断；其它产物已写出时同样标 partial', async () => {
    const driver = new FakeDriver();
    driver.onCapture = (n, files) => {
      if (n >= 2) files.set(paths.done, 'ok'); // 只写 done，不写 output
    };
    const result = await runAgentArtifacts(
      { driver, ...clock() },
      { ...input, artifacts: [{ key: 'output', path: paths.output, maxBytes: 1024, required: true }] },
      FAST,
    );
    expect(result).toMatchObject({ ok: false, reason: 'malformed-artifact', artifact: 'output' });
    expect(result.ok === false && result.diagnostics?.files.map((f) => f.name)).toContain('done');
    expect(result.ok === false && result.partial).toBeUndefined(); // 一个都没写出来，不算部分成功
  });

  // #280 / B-06：生产上失败几乎全落在 codex（codex 4 成功 / 47 失败，claude 55 / 3），
  // 失败形态是「跑满超时也没写出 done」——最可疑的一档是提示词打进了还没接管终端的 shell。
  test('codex：pane 在注入后毫无变化 → 补交一次提示词（最多一次）', async () => {
    const driver = new FakeDriver();
    driver.paneAt = () => 'codex 启动中…'; // 屏幕从头到尾不变
    const result = await runAgentArtifacts(
      { driver, ...clock() },
      { ...input, agent: 'codex' },
      FAST,
    );

    expect(result.ok).toBe(false); // 本例照常超时，这里只验补交行为
    const prompts = driver.sent.filter((x) => x.text === input.prompt);
    expect(prompts).toHaveLength(2); // 原发 + 补交，且只补一次
  });

  test('codex：pane 变了说明收到了 → 不补交', async () => {
    const driver = new FakeDriver();
    // 收到提示词之后屏幕就变了（按「提示词发出去没有」切，不按抓屏次数切）
    driver.paneAt = () => (driver.sent.some((x) => x.text === input.prompt)
      ? '> 收到任务，正在读取 task.md'
      : 'codex 启动中…');
    await runAgentArtifacts({ driver, ...clock() }, { ...input, agent: 'codex' }, FAST);
    expect(driver.sent.filter((x) => x.text === input.prompt)).toHaveLength(1);
  });

  test('claude 路径行为不变：既不补交，也不用 codex 的加长就绪窗口', async () => {
    const driver = new FakeDriver();
    driver.paneAt = () => '同一屏，从不变化';
    await runAgentArtifacts({ driver, ...clock() }, input, FAST);
    expect(driver.sent.filter((x) => x.text === input.prompt)).toHaveLength(1);
  });

  test('抓屏不可用时不补交：宁可这轮白跑，也不重复灌进一个其实在干活的会话', async () => {
    const driver = new FakeDriver();
    driver.capturePane = async () => { throw new Error('capture failed'); };
    await runAgentArtifacts({ driver, ...clock() }, { ...input, agent: 'codex' }, FAST);
    expect(driver.sent.filter((x) => x.text === input.prompt)).toHaveLength(1);
  });

  test('codex 默认就绪窗口更长；显式传 readyDelayMs 仍以调用方为准', async () => {
    expect(CODEX_READY_DELAY_MS).toBeGreaterThan(12_000);

    const slow = new FakeDriver();
    const timeline: number[] = [];
    await runAgentArtifacts(
      { driver: slow, ...clock((now) => timeline.push(now)) },
      { ...input, agent: 'codex' },
      { pollIntervalMs: 1000, timeoutMs: 1000 }, // 不传 readyDelayMs → 用 codex 档
    );
    // 就绪窗口按 codex 档走：注入提示词之前至少睡够 CODEX_READY_DELAY_MS
    const promptAt = slow.sent.findIndex((x) => x.text === input.prompt);
    expect(promptAt).toBeGreaterThan(0);
    expect(timeline.some((t) => t >= CODEX_READY_DELAY_MS)).toBe(true);
  });

  // #281 / I-04：这些会话每条 issue 都会跑，是最值得先砍的一块
  test('一次性会话默认 low；调用方显式传 codexArgs 仍以调用方为准；claude 不受影响', async () => {
    const low = new FakeDriver();
    low.executable = '/bin/codex';
    await runAgentArtifacts({ driver: low, ...clock() }, { ...input, agent: 'codex' }, FAST);
    expect(low.sent[0]!.text).toContain('-c model_reasoning_effort="low"');

    const override = new FakeDriver();
    override.executable = '/bin/codex';
    await runAgentArtifacts(
      { driver: override, ...clock() },
      { ...input, agent: 'codex' },
      { ...FAST, codexArgs: '--dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="high"' },
    );
    expect(override.sent[0]!.text).toContain('model_reasoning_effort="high"');
    expect(override.sent[0]!.text).not.toContain('model_reasoning_effort="low"');

    const claude = new FakeDriver();
    await runAgentArtifacts({ driver: claude, ...clock() }, input, FAST);
    expect(claude.sent[0]!.text).toBe('/opt/bin/claude --permission-mode acceptEdits');
    expect(claude.sent[0]!.text).not.toContain('model_reasoning_effort');
  });
});
