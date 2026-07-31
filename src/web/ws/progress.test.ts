/**
 * V2 进度管道测试：
 * - ProgressBridge：每项目一个 reporter（惰性建+start）、消息逐条喂入、
 *   {push,status,needsReply,headline} → NotifyEvent 适配帧形状、stopAll 生命周期；
 * - 引擎钩子：onConvMessages（tail 新消息，事件源唯一）与 onMenu（弹窗检测）在
 *   watch 循环里被回调；钩子抛错不打断 tick（落 error 事件）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProgressAnalysis, ProgressEventLike } from '../../agents/progress';
import { ConversationManager } from '../../core/conversations';
import { openDb } from '../../core/db';
import type { ChatMessage } from '../../core/jsonl';
import { migrate } from '../../core/migrate';
import type { Project } from '../../core/types';
import { UserStore } from '../../core/users';
import { LocalDriver } from '../../executor/local';
import {
  IssueEngine,
  migrateIssueEngine,
  type EngineIssue,
  type EngineMenuCtx,
} from '../../issues/engine';
import { KeyedMutex } from '../../issues/mutex';
import { ProgressBridge, progressToEvent } from './progress';

// ---------- ProgressBridge（reporter/notify 全 mock） ----------

class FakeReporter {
  events: ProgressEventLike[] = [];
  started = 0;
  stopped = 0;
  onPush: ((a: ProgressAnalysis) => void | Promise<void>) | null = null;
  add(ev: ProgressEventLike) {
    this.events.push(ev);
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
  }
}

const project = (id: number): Project => ({
  id,
  name: `p${id}`,
  executorId: 1,
  cwd: '/tmp',
  ownerUserId: 1,
  pmPersona: null,
  goal: null,
  status: 'active',
  createdTs: 0,
  runUser: '',
  readmeSummary: null,
  workBranch: null,
  understanding: null,
  understandingAgent: null,
  understandingTs: null,
  summaryStatus: 'idle',
  summaryError: null,
  manualReview: false,
  kind: 'issue',
});

const issue = (id: number, projectId: number): EngineIssue => ({
  id,
  projectId,
  title: 't',
  body: null,
  category: 'task',
  status: 'implementing',
  moduleId: null,
  convId: 'c',
  planJson: null,
  subtasksJson: null,
  subIndex: 0,
  targetBranch: null,
  sourceRef: null,
  branch: null,
  note: null,
  imagesJson: null,
  createdBy: null,
  createdTs: 0,
  doneTs: null,
  module: 'm',
  implMode: 'seq',
  agent: 'claude',
  pinnedTs: null,
  clarifyFeedback: null,
  resultSummary: null,
  autoApprove: 'medium',
});

describe('ProgressBridge', () => {
  function setup() {
    const reporters = new Map<number, FakeReporter>();
    const throttles: Array<number | undefined> = [];
    const dispatched: Array<Record<string, unknown>> = [];
    const bridge = new ProgressBridge({
      pmFor: (p) => ({
        createProgressReporter(onPush, opts) {
          const r = new FakeReporter();
          r.onPush = onPush;
          reporters.set(p.id, r);
          throttles.push(opts?.throttleSeconds);
          return r;
        },
      }),
      notify: {
        async dispatch(e) {
          dispatched.push(e);
        },
      },
      throttleSeconds: 7,
    });
    return { bridge, reporters, dispatched, throttles };
  }

  test('惰性建 reporter（每项目一个，start 即挂）+ 消息逐条喂入', () => {
    const t = setup();
    const msgs: ChatMessage[] = [
      { seq: 0, role: 'assistant', text: '在改代码' },
      { seq: 1, role: 'tool_result', result: 'ok', isError: false },
    ];
    t.bridge.onConvMessages(issue(1, 10), project(10), msgs);
    t.bridge.onConvMessages(issue(2, 10), project(10), [msgs[0]!]);
    t.bridge.onConvMessages(issue(3, 20), project(20), [msgs[1]!]);

    expect(t.bridge.size).toBe(2); // 项目 10/20 各一个
    expect(t.reporters.get(10)!.events.length).toBe(3);
    expect(t.reporters.get(10)!.started).toBe(1);
    expect(t.reporters.get(20)!.events.length).toBe(1);
    expect(t.throttles).toEqual([7, 7]); // throttleSeconds 透传
  });

  test('onPush 适配：{push,status,needsReply,headline} → NotifyEvent（issueId 跟随最近消息）', async () => {
    const t = setup();
    t.bridge.onConvMessages(issue(42, 10), project(10), [{ seq: 0, role: 'assistant', text: 'x' }]);
    const r = t.reporters.get(10)!;
    await r.onPush!({ push: true, status: 'error', needsReply: true, headline: '测试炸了' });
    expect(t.dispatched).toEqual([
      { kind: 'status_change', projectId: 10, issueId: 42, summary: '❗ 测试炸了（它在等你回话）' },
    ]);
    await r.onPush!({ push: true, status: 'milestone', needsReply: false, headline: '阶段完成' });
    expect(t.dispatched[1]!.summary).toBe('📌 阶段完成');
  });

  test('progressToEvent 帧形状（确定性翻译）', () => {
    expect(progressToEvent(1, 2, { push: true, status: 'done', needsReply: false, headline: 'ok' }))
      .toEqual({ kind: 'status_change', projectId: 1, issueId: 2, summary: '✅ ok' });
    expect(
      progressToEvent(1, 2, { push: true, status: 'waiting', needsReply: true, headline: '等确认' })
        .summary,
    ).toBe('💬 等确认（它在等你回话）');
  });

  test('stopAll：清全部 reporter，之后消息忽略（停机语义）', () => {
    const t = setup();
    t.bridge.onConvMessages(issue(1, 10), project(10), [{ seq: 0, role: 'assistant', text: 'x' }]);
    const r = t.reporters.get(10)!;
    t.bridge.stopAll();
    expect(r.stopped).toBe(1);
    expect(t.bridge.size).toBe(0);
    t.bridge.onConvMessages(issue(1, 10), project(10), [{ seq: 0, role: 'assistant', text: 'y' }]);
    expect(t.bridge.size).toBe(0); // stopped 后不再建 reporter
  });
});

// ---------- 引擎钩子（onConvMessages / onMenu 在 watch 循环里被回调） ----------

class FakeDriver extends LocalDriver {
  tmuxSessions = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
  pane = '';
  override async listSessions() {
    return [...this.tmuxSessions].map((name) => ({ name, createdTs: 0, attached: false }));
  }
  override async createSession(name: string) {
    this.tmuxSessions.add(name);
  }
  override async killSession(name: string) {
    if (!this.tmuxSessions.delete(name)) throw new Error('no session');
  }
  override async sendKeys(session: string, text: string) {
    this.sent.push({ session, text });
  }
  override async capturePane() {
    return this.pane;
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('引擎 Wave3 钩子', () => {
  async function engineSetup() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-hooks-'));
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    const users = new UserStore(db);
    const { user: admin } = users.create('admin', 'admin');
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', '', '${dir}/ws', '${dir}/claude')`,
    );
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('demo', 1, ?, ?, ?)`,
    ).run(path.join(dir, 'repo'), admin.id, Date.now());

    const driver = new FakeDriver();
    const jsonl = new Map<string, string>();
    const locator = {
      async locate(id: string) {
        const p = jsonl.get(id);
        if (!p) return null;
        try {
          await fsp.stat(p);
          return p;
        } catch {
          return null;
        }
      },
    };
    const convs = new ConversationManager(db, driver, locator);
    const menuCalls: EngineMenuCtx[] = [];
    const menuGone: string[] = [];
    const msgCalls: Array<{ issueId: number; msgs: ChatMessage[] }> = [];
    let menuThrow = false;

    const engine = new IssueEngine({
      db,
      driver,
      convs,
      locator,
      pmFor: () => ({
        async judgeDone() {
          return 'not_done' as const;
        },
        async generateClarifyingQuestions() {
          return null;
        },
      }),
      notify: { async dispatch() {} },
      mutex: new KeyedMutex(),
      config: { kickoffMinBootMs: 0, resultSummaryTimeoutMs: 0 },
      onMenu: (ctx) => {
        if (menuThrow) throw new Error('钩子炸了');
        menuCalls.push(ctx);
      },
      onMenuGone: (session) => menuGone.push(session),
      onConvMessages: (i, _p, msgs) => msgCalls.push({ issueId: i.id, msgs }),
    });
    return {
      dir, db, driver, jsonl, engine, menuCalls, menuGone, msgCalls,
      setMenuThrow: (v: boolean) => (menuThrow = v),
    };
  }

  test('onConvMessages：tail 新消息回调（事件源=引擎 tail）；onMenu：弹窗检测回调；抛错不打断 tick', async () => {
    const t = await engineSetup();
    const issue = await t.engine.createIssue(1, { title: '任务', category: 'task' });
    expect(t.engine.store.get(issue.id)!.status).toBe('planning');
    const convId = t.engine.store.get(issue.id)!.convId!;
    const p = path.join(t.dir, `${convId}.jsonl`);
    await fsp.writeFile(
      p,
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '开工' }] } })}\n`,
    );
    t.jsonl.set(convId, p);

    await t.engine.tick();
    expect(t.msgCalls.length).toBe(1);
    expect(t.msgCalls[0]!.issueId).toBe(issue.id);
    expect(t.msgCalls[0]!.msgs.map((m) => m.text)).toEqual(['开工']);
    expect(t.menuCalls.length).toBe(0); // 无弹窗不回调

    // 弹窗出现 → onMenu 带 sel/pane 回调（每 tick 一次，去重在管道侧）
    t.driver.pane = ' 要不要继续？\n ❯ 1. Yes\n   2. No';
    await t.engine.tick();
    expect(t.menuCalls.length).toBe(1);
    expect(t.menuCalls[0]!.sel.options).toEqual(['Yes', 'No']);
    expect(t.menuCalls[0]!.session).toBe(`cc-1`);

    // 菜单消失（有→无 一次性转沿）→ onMenuGone
    t.driver.pane = '';
    await t.engine.tick();
    await t.engine.tick(); // 只在转沿回调一次
    expect(t.menuGone).toEqual([`cc-1`]);

    // 钩子抛错：tick 不炸，error 事件落盘
    t.driver.pane = ' 要不要继续？\n ❯ 1. Yes\n   2. No';
    t.setMenuThrow(true);
    await t.engine.tick();
    const errs = t.engine.store
      .listEvents(issue.id)
      .filter((e) => e.kind === 'error' && (e.dataJson ?? '').includes('onMenu'));
    expect(errs.length).toBe(1);
  });
});
