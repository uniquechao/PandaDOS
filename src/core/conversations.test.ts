import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { migrate } from './migrate';
import { migrateIssueEngine } from '../issues/engine';
import { UserStore } from './users';
import { ConversationManager, chatTmux, dedTmux, moduleTmux, type ConvDriver } from './conversations';

/** 录制型假 Driver：tmux 操作进内存，文件操作走真 fs（LocalDriver 语义子集） */
class RecDriver implements ConvDriver {
  sessions = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
  killed: string[] = [];
  /** capturePane 返回值（测试按需设置：模拟 codex 在跑 / 退回 shell / 更新弹窗） */
  paneText = '';
  /** 每会话的 #{pane_current_command}（不设 = 老实现/解析失败，判活退化成只看屏） */
  commands = new Map<string, string>();
  async listSessions() {
    return [...this.sessions].map((name) => {
      const command = this.commands.get(name);
      return { name, ...(command ? { command } : {}) };
    });
  }
  async capturePane(_session: string) {
    return this.paneText;
  }
  async createSession(name: string, _cwd: string) {
    this.sessions.add(name);
  }
  async killSession(name: string) {
    if (!this.sessions.delete(name)) throw new Error('no session');
    this.killed.push(name);
  }
  async sendKeys(session: string, text: string) {
    this.sent.push({ session, text });
  }
  async statPath(p: string) {
    try {
      const st = await fsp.stat(p);
      return { size: st.size, isDirectory: st.isDirectory() };
    } catch {
      return null;
    }
  }
  async readFileRange(p: string, offset: number, limit: number) {
    const buf = await fsp.readFile(p);
    return { data: new Uint8Array(buf.subarray(offset, offset + limit)), size: buf.length };
  }
  async writeFile(p: string, data: Uint8Array | string) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, data);
  }
}

let dir: string;
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-conv-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  const users = new UserStore(db);
  const { user } = users.create('admin', 'admin');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '${dir}/ws', '${dir}/claude')`,
  );
  const cwd = path.join(dir, 'proj-a');
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, ?)`,
  ).run('a', cwd, user.id, Date.now());
  const driver = new RecDriver();
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
  return { db, driver, convs, jsonl, cwd, projectId: 1 };
}

describe('dedTmux：project 维度命名（弃 hashCwd）', () => {
  test('cc-<projectId>', () => {
    expect(dedTmux(7)).toBe('cc-7');
  });
});

describe('ConversationManager', () => {
  test('create/list/get 入库', () => {
    const { convs } = setup();
    const c = convs.create(1, '第一条');
    expect(convs.get(c.id)?.label).toBe('第一条');
    expect(convs.listByProject(1).map((x) => x.id)).toContain(c.id);
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('首次 activate：--session-id + 建会话 + cwd 物化 + current 入库', async () => {
    const { convs, driver, cwd } = setup();
    const c = convs.create(1, 'x');
    const got = await convs.activate(c.id);
    expect(got?.id).toBe(c.id);
    expect(driver.sessions.has('cc-1')).toBe(true);
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]).toEqual({ session: 'cc-1', text: `claude --session-id ${c.id}` });
    expect(convs.currentConv(1)).toBe(c.id);
    // cwd 不存在 → 模块指南先物化 cwd；无需再写 .butler-keep
    expect(await fsp.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('mando-issue');
  });

  test('重复 activate 同对话且 tmux 活着 → 幂等短路（不 kill 不重发）', async () => {
    const { convs, driver } = setup();
    const c = convs.create(1, 'x');
    await convs.activate(c.id);
    await convs.activate(c.id);
    expect(driver.sent).toHaveLength(1);
    expect(driver.killed).toHaveLength(0);
  });

  // issue #97：本 issue 的关键堵点——旧实现在「当前对话 + tmux 会话存在」时直接 return，
  // 于是壳还在、代理已退回 bash 的会话永远重启不了，引擎照旧往 shell 里注入。
  test('当前对话但前台已是 bash → activate 不再短路，kill 旧起新并 --resume 续上下文', async () => {
    const { convs, driver, jsonl } = setup();
    const c = convs.create(1, 'x');
    await convs.activate(c.id);
    const p = path.join(dir, `${c.id}.jsonl`);
    await fsp.writeFile(p, '');
    jsonl.set(c.id, p);

    driver.commands.set('cc-1', 'bash'); // 代理退出，窗格只剩 shell
    driver.paneText = `[root@VM p]# claude --session-id ${c.id}\n[root@VM p]#`;
    await convs.activate(c.id);

    expect(driver.killed).toEqual(['cc-1']);
    expect(driver.sent).toHaveLength(2);
    expect(driver.sent[1]).toEqual({ session: 'cc-1', text: `claude --resume ${c.id}` });
    expect(convs.currentConv(1)).toBe(c.id); // 仍是当前对话
  });

  // 抓屏没给出任何线索时，前台命令是唯一证据——丢掉它就等于漏判（照旧往 shell 注入）
  test('屏面说不清但前台是 bash → 仍判死并重启；拿不到前台命令则保守不动', async () => {
    const { convs, driver } = setup();
    const c = convs.create(1, 'x');
    await convs.activate(c.id);
    driver.paneText = ''; // 抓屏空白：光看屏无从判定

    await convs.activate(c.id); // 无 command → unknown → 不动
    expect(driver.sent).toHaveLength(1);
    expect(driver.killed).toHaveLength(0);

    driver.commands.set('cc-1', 'bash'); // 有 command → 判死
    await convs.activate(c.id);
    expect(driver.killed).toEqual(['cc-1']);
    expect(driver.sent).toHaveLength(2);
  });

  test('当前对话且前台是 claude → 幂等短路（屏上出现 shell 提示符也不误杀在跑的代理）', async () => {
    const { convs, driver } = setup();
    const c = convs.create(1, 'x');
    await convs.activate(c.id);
    driver.commands.set('cc-1', 'claude');
    driver.paneText = '⏺ Bash(ls)\n  ⎿ [root@VM p]#'; // 代理正在跑命令，屏面像 shell
    await convs.activate(c.id);
    expect(driver.sent).toHaveLength(1);
    expect(driver.killed).toHaveLength(0);
  });

  test('前台命令说不清（vim/未知）→ unknown，保守不动', async () => {
    const { convs, driver } = setup();
    const c = convs.create(1, 'x');
    await convs.activate(c.id);
    driver.commands.set('cc-1', 'vim');
    driver.paneText = '[root@VM p]#';
    await convs.activate(c.id);
    expect(driver.sent).toHaveLength(1);
    expect(driver.killed).toHaveLength(0);
  });

  test('relaunch：无条件 kill 旧起新（哪怕判定健康），并把它设为当前对话', async () => {
    const { convs, driver, jsonl } = setup();
    const c = convs.create(1, 'x');
    await convs.activate(c.id);
    const p = path.join(dir, `${c.id}.jsonl`);
    await fsp.writeFile(p, '');
    jsonl.set(c.id, p);
    driver.commands.set('cc-1', 'claude'); // 健康：activate 会短路，relaunch 不管
    driver.paneText = '╭──╮\n❯ ';

    const got = await convs.relaunch(c.id);
    expect(got?.id).toBe(c.id);
    expect(driver.killed).toEqual(['cc-1']);
    expect(driver.sent[1]).toEqual({ session: 'cc-1', text: `claude --resume ${c.id}` });
    expect(convs.currentConv(1)).toBe(c.id);
  });

  test('relaunch：chat 打到自己的 chat-<id> 会话；对话不存在 → null', async () => {
    const { convs, driver } = setup();
    const c = convs.create(1, 'ch', 'claude', 'chat');
    await convs.activate(c.id);
    await convs.relaunch(c.id);
    expect(driver.killed).toEqual([chatTmux(c.id)]);
    expect(driver.sent).toHaveLength(2);
    expect(driver.sent[1]!.session).toBe(chatTmux(c.id));
    expect(convs.currentConv(1)).toBeUndefined(); // chat 不碰单活跃表
    expect(await convs.relaunch('no-such')).toBeNull();
  });

  test('切对话 = kill 旧起新；jsonl 已存在 → --resume', async () => {
    const { convs, driver, jsonl } = setup();
    const c1 = convs.create(1, 'one');
    const c2 = convs.create(1, 'two');
    await convs.activate(c1.id);
    // c2 的 jsonl 已落地 → resume
    const p = path.join(dir, `${c2.id}.jsonl`);
    await fsp.writeFile(p, '');
    jsonl.set(c2.id, p);
    await convs.activate(c2.id);
    expect(driver.killed).toEqual(['cc-1']);
    expect(driver.sent[1]).toEqual({ session: 'cc-1', text: `claude --resume ${c2.id}` });
    expect(convs.currentConv(1)).toBe(c2.id);
  });

  test('对话不存在 → null；activate 后 current 持久化在 DB（重启不丢）', async () => {
    const { convs, db, driver } = setup();
    expect(await convs.activate('no-such')).toBeNull();
    const c = convs.create(1, 'x');
    await convs.activate(c.id);
    // 用同一 db 新建管理器（模拟重启）：current 仍在
    const convs2 = new ConversationManager(db, driver, { locate: async () => null });
    expect(convs2.currentConv(1)).toBe(c.id);
  });

  test('正式模块使用独立 tmux，切模块休眠旧进程，sleep 后仍可 resume', async () => {
    const { convs, db, driver, jsonl } = setup();
    const a = convs.create(1, 'module:export-tools');
    const b = convs.create(1, 'module:billing-core', 'claude');
    db.query(
      `INSERT INTO project_modules
         (project_id, slug, display_name, agent, source, conversation_id, created_ts)
       VALUES (1, 'export-tools', 'Export', 'claude', 'manual', ?, 1),
              (1, 'billing-core', 'Billing', 'claude', 'manual', ?, 1)`,
    ).run(a.id, b.id);
    expect(moduleTmux(1, 'export-tools')).toBe('cc-1-m-export-tools');
    expect(convs.sessionName(a)).toBe('cc-1-m-export-tools');

    await convs.activate(a.id);
    expect(driver.sessions.has('cc-1-m-export-tools')).toBe(true);
    await convs.activate(b.id);
    expect(driver.killed).toContain('cc-1-m-export-tools');
    expect(driver.sessions.has('cc-1-m-billing-core')).toBe(true);

    const p = path.join(dir, `${b.id}.jsonl`);
    await fsp.writeFile(p, '');
    jsonl.set(b.id, p);
    await convs.sleepIssue(b.id);
    expect(driver.sessions.has('cc-1-m-billing-core')).toBe(false);
    expect(convs.currentConv(1)).toBeUndefined();
    await convs.activate(b.id);
    expect(driver.sent.at(-1)?.text).toBe(`claude --resume ${b.id}`);
  });
});

describe('ConversationManager chat 独立对话（009）', () => {
  test('chatTmux/sessionName：chat 用 chat-<convId>，issue 用 cc-<pid>', () => {
    const { convs } = setup();
    const chat = convs.create(1, 'c', 'claude', 'chat');
    const issue = convs.create(1, 'i', 'claude', 'issue');
    expect(chatTmux(chat.id)).toBe(`chat-${chat.id}`);
    expect(convs.sessionName(chat)).toBe(`chat-${chat.id}`);
    expect(convs.sessionName(issue)).toBe('cc-1');
  });

  test('activate chat：起 chat-<convId> 独立会话，不碰 project_active_conv', async () => {
    const { convs, driver } = setup();
    const c = convs.create(1, 'x', 'claude', 'chat');
    await convs.activate(c.id);
    expect(driver.sessions.has(`chat-${c.id}`)).toBe(true);
    expect(driver.sessions.has('cc-1')).toBe(false);
    expect(driver.sent[0]).toEqual({ session: `chat-${c.id}`, text: `claude --session-id ${c.id}` });
    // chat 不写单活跃表
    expect(convs.currentConv(1)).toBeUndefined();
    // 记了 last_active_ts
    expect(convs.get(c.id)!.lastActiveTs).not.toBeNull();
  });

  test('多条 chat 各自常驻、互不 kill', async () => {
    const { convs, driver } = setup();
    const a = convs.create(1, 'a', 'claude', 'chat');
    const b = convs.create(1, 'b', 'codex', 'chat');
    await convs.activate(a.id);
    await convs.activate(b.id);
    expect(driver.sessions.has(`chat-${a.id}`)).toBe(true);
    expect(driver.sessions.has(`chat-${b.id}`)).toBe(true);
    expect(driver.killed).toHaveLength(0); // 谁也没被切掉
    // 重复 activate 活着的对话 → 幂等短路（不打断在跑的）
    await convs.activate(a.id);
    expect(driver.sent.filter((s) => s.session === `chat-${a.id}`)).toHaveLength(1);
  });

  test('listChats：仅 chat、排除归档、按最近活跃倒序', async () => {
    const { convs } = setup();
    convs.create(1, 'issue-conv', 'claude', 'issue'); // 不应出现
    const a = convs.create(1, 'a', 'claude', 'chat');
    const b = convs.create(1, 'b', 'claude', 'chat');
    await convs.activate(a.id); // a 最近活跃 → 排最前
    let ids = convs.listChats(1).map((c) => c.id);
    expect(ids).toEqual([a.id, b.id]);
    await convs.archive(b.id);
    ids = convs.listChats(1).map((c) => c.id);
    expect(ids).toEqual([a.id]); // 归档的 b 不列
    expect(convs.listChats(1, true).map((c) => c.id)).toContain(b.id); // includeArchived 才列
  });

  test('rename 改标题；archive kill 独立会话；closeChat 只 kill 不归档', async () => {
    const { convs, driver } = setup();
    const c = convs.create(1, 'old', 'claude', 'chat');
    convs.rename(c.id, 'new');
    expect(convs.get(c.id)!.label).toBe('new');

    await convs.activate(c.id);
    expect(driver.sessions.has(`chat-${c.id}`)).toBe(true);
    // closeChat：kill 会话但保留 archived=0
    await convs.closeChat(c.id);
    expect(driver.sessions.has(`chat-${c.id}`)).toBe(false);
    expect(convs.get(c.id)!.archived).toBe(false);

    // archive：（重新起会话后）归档并 kill
    await convs.activate(c.id);
    await convs.archive(c.id);
    expect(convs.get(c.id)!.archived).toBe(true);
    expect(driver.sessions.has(`chat-${c.id}`)).toBe(false);
  });
});

describe('ConversationManager codex 代理', () => {
  test('fresh 启动：bypass 参数 + launch_ts 锚点入库', async () => {
    const { db, driver, convs } = setup();
    const c = convs.create(1, 'cx', 'codex');
    expect(c.agent).toBe('codex');
    const before = Date.now();
    await convs.activate(c.id);
    expect(driver.sent[0]!.text).toBe(
      'codex -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox',
    );
    const row = db
      .query<{ agent_launch_ts: number | null }, [string]>(
        'SELECT agent_launch_ts FROM conversations WHERE id = ?',
      )
      .get(c.id);
    expect(row!.agent_launch_ts).toBeGreaterThanOrEqual(before);
  });

  test('已发现 session id → codex resume <sid>；claude 对话不受影响', async () => {
    const { db, driver, convs } = setup();
    const c = convs.create(1, 'cx', 'codex');
    db.query('UPDATE conversations SET agent_session_id = ? WHERE id = ?').run('sid-123', c.id);
    await convs.activate(c.id);
    expect(driver.sent[0]!.text).toBe(
      'codex -c check_for_update_on_startup=false resume sid-123 --dangerously-bypass-approvals-and-sandbox',
    );

    const cc = convs.create(1, 'cl'); // 默认 claude
    await convs.activate(cc.id);
    expect(driver.sent[1]!.text).toBe(`claude --session-id ${cc.id}`);
  });

  test('resume 也重盖 launch_ts 并清 path 缓存（防旧绑定粘连，issue #48）', async () => {
    const { db, driver, convs } = setup();
    const c = convs.create(1, 'cx', 'codex');
    db.query(
      'UPDATE conversations SET agent_session_id = ?, agent_jsonl_path = ?, agent_launch_ts = ? WHERE id = ?',
    ).run('sid-9', '/stale/rollout.jsonl', 1000, c.id);
    const before = Date.now();
    await convs.activate(c.id);
    expect(driver.sent[0]!.text).toBe(
      'codex -c check_for_update_on_startup=false resume sid-9 --dangerously-bypass-approvals-and-sandbox',
    );
    const row = db
      .query<{ agent_jsonl_path: string | null; agent_launch_ts: number }, [string]>(
        'SELECT agent_jsonl_path, agent_launch_ts FROM conversations WHERE id = ?',
      )
      .get(c.id);
    expect(row!.agent_jsonl_path).toBeNull(); // 缓存作废 → 按 sid 回扫重定位
    expect(row!.agent_launch_ts).toBeGreaterThanOrEqual(before); // 锚点重盖
  });

  test('codex chat：会话活着但已退回 shell → 重启 codex（真存活检测，非 tmux 短路）', async () => {
    const { driver, convs } = setup();
    const c = convs.create(1, 'cx', 'codex', 'chat');
    await convs.activate(c.id); // fresh：会话不在 → launchInto 起 codex
    const session = chatTmux(c.id);
    expect(driver.sessions.has(session)).toBe(true);
    expect(driver.sent.length).toBe(1);
    // 模拟 codex 自更新后退回 bash（tmux 会话仍活着）
    driver.paneText = '🎉 Update ran successfully! Please restart Codex.\n[root@VM yuhang_project]#';
    await convs.activate(c.id);
    expect(driver.killed).toContain(session); // 重启 = kill 旧
    expect(driver.sent.length).toBe(2);
    expect(driver.sent[1]!.text).toContain('codex '); // 再起 codex
  });

  test('codex chat：会话活着且 codex 在跑 → 幂等短路，不打断在跑对话', async () => {
    const { driver, convs } = setup();
    const c = convs.create(1, 'cx', 'codex', 'chat');
    await convs.activate(c.id);
    driver.paneText = '› \n  gpt-5.6-sol medium · ~/user_space/users/u12/yuhang_project';
    await convs.activate(c.id);
    expect(driver.sent.length).toBe(1); // 未重启
    expect(driver.killed).toEqual([]);
  });

  test('codex chat：卡「Update available」交互弹窗 → 输入 2 跳过，不重启', async () => {
    const { driver, convs } = setup();
    const c = convs.create(1, 'cx', 'codex', 'chat');
    await convs.activate(c.id);
    driver.paneText = 'Update available! 0.144.6 -> 0.145.0\n› 1. Update now\n  2. Skip\nPress enter to continue';
    await convs.activate(c.id);
    expect(driver.killed).toEqual([]); // 不重启
    const last = driver.sent[driver.sent.length - 1]!;
    expect(last.text).toBe('2'); // Skip
    expect(last.session).toBe(chatTmux(c.id));
  });

  // issue #97 起 claude 也做真存活检测（旧契约「claude 分支不看屏」已作废）：
  // claude 崩溃/登录过期同样把窗格留给 bash，短路只会让用户消息继续打进 shell。
  test('claude chat：退回 shell 也要重启（真存活检测不再是 codex 专利）', async () => {
    const { driver, convs, jsonl } = setup();
    const c = convs.create(1, 'cl', 'claude', 'chat');
    await convs.activate(c.id);
    const session = chatTmux(c.id);
    // 会话已落地 jsonl（跑过一轮），重启时应 --resume 续上下文
    const p = path.join(dir, `${c.id}.jsonl`);
    await fsp.writeFile(p, '');
    jsonl.set(c.id, p);
    driver.paneText = `[root@VM p]# claude --session-id ${c.id}\n[root@VM p]#`; // claude 退出后的实测形态
    await convs.activate(c.id);
    expect(driver.killed).toContain(session);
    expect(driver.sent.length).toBe(2);
    expect(driver.sent[1]!.text).toBe(`claude --resume ${c.id}`); // 接着原对话，不新开
  });

  test('claude chat：屏面还是 claude UI → 幂等短路，绝不打断在跑的对话', async () => {
    const { driver, convs } = setup();
    const c = convs.create(1, 'cl', 'claude', 'chat');
    await convs.activate(c.id);
    driver.paneText = '╭──────────╮\n❯ \n  ⏸ manual mode on · ? for shortcuts';
    await convs.activate(c.id);
    expect(driver.sent.length).toBe(1);
    expect(driver.killed).toEqual([]);
  });

  test('claude activate 清 reclaim 覆盖（重启回原生会话后不再 tail 手动会话文件）', async () => {
    const { db, driver, convs } = setup();
    const c = convs.create(1, 'cl');
    db.query('UPDATE conversations SET agent_jsonl_path = ? WHERE id = ?').run('/manual/session.jsonl', c.id);
    await convs.activate(c.id);
    expect(driver.sent[0]!.text).toBe(`claude --session-id ${c.id}`);
    const row = db
      .query<{ agent_jsonl_path: string | null }, [string]>(
        'SELECT agent_jsonl_path FROM conversations WHERE id = ?',
      )
      .get(c.id);
    expect(row!.agent_jsonl_path).toBeNull();
  });

  test('codexConfigFile 信任预置 + 家目录兼容技能落盘（幂等不覆盖）', async () => {
    const { db, driver, cwd } = setup();
    const claudeHome = path.join(dir, 'home-claude', '.claude');
    const codexHome = path.join(dir, 'home-claude', '.codex');
    const cfg = path.join(codexHome, 'config.toml');
    const convs2 = new ConversationManager(db, driver, { locate: async () => null }, {
      codexConfigFile: cfg,
      claudeHome,
      codexHome,
    });
    const c = convs2.create(1, 'cx', 'codex');
    await convs2.activate(c.id);

    const toml = await fsp.readFile(cfg, 'utf8');
    expect(toml).toContain(`[projects."${cwd}"]`);
    expect(toml).toContain('trust_level = "trusted"');

    const skill1 = await fsp.readFile(path.join(codexHome, 'skills/claude-config-compat/SKILL.md'), 'utf8');
    expect(skill1).toContain('CLAUDE.md');
    const skill2 = await fsp.readFile(path.join(claudeHome, 'skills/agents-md-compat/SKILL.md'), 'utf8');
    expect(skill2).toContain('AGENTS.md');
    const mandoClaude = await fsp.readFile(path.join(claudeHome, 'skills/mando-issue/SKILL.md'), 'utf8');
    const mandoCodex = await fsp.readFile(path.join(codexHome, 'skills/mando-issue/SKILL.md'), 'utf8');
    expect(mandoClaude).toBe(mandoCodex);
    expect(mandoClaude).toContain('.butler/modules/INDEX.md');
    expect(await fsp.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('mando-issue');
    expect(await fsp.readFile(path.join(cwd, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');

    // 再激活：trust 段不重复追加、技能不覆盖
    await fsp.writeFile(path.join(codexHome, 'skills/claude-config-compat/SKILL.md'), '人工改过');
    const c2 = convs2.create(1, 'cx2', 'codex');
    await convs2.activate(c2.id);
    const toml2 = await fsp.readFile(cfg, 'utf8');
    expect(toml2.split(`[projects."${cwd}"]`).length).toBe(2); // 只出现一次
    expect(await fsp.readFile(path.join(codexHome, 'skills/claude-config-compat/SKILL.md'), 'utf8')).toBe('人工改过');
  });
});
