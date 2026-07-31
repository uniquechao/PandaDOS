/**
 * core/conversations —— 对话管理（v1 conversations.ts activate/resume 平移改造）。
 *
 * 相对 v1 的结构性修复：
 * - 专用 tmux 名 `cc-<projectId>`（弃 hashCwd：无碰撞、多执行机同 cwd 不同名，评审 LOW/2.4-4）；
 * - 对话入 conversations 表；「项目当前激活对话」入 project_active_conv 表
 *   （v1 current Map 仅内存 = 评审 H4，重启即丢 → 第一次 activate 误杀干活进程）；
 * - jsonl 存在性判断走 JsonlLocator（列目录按 id 匹配），决定 --resume vs --session-id，
 *   弃 cwd.replace(/\//g,'-') 硬算（评审 H5）；
 * - 一切执行机操作走 Driver（tmux/文件），控制面不摸本地 fs；
 * - activate 的 kill+new+send 三连不再靠同步隐式串行——调用方（引擎/路由）须用
 *   issues/mutex 的 projectLockKey 包住（本模块不内置锁，避免与调用方锁重入死锁）。
 *
 * 依赖方向：core 最内层，不 import executor——ConvDriver 是与 ExecutorDriver
 * 结构兼容的最小接口，调用方直接传 SshDriver/LocalDriver。
 */
import type { Database } from 'bun:sqlite';
import {
  ensureArtifactSkill,
  ensureCompatSkills,
  ensureMandoIssueSkill,
  ensureModuleGuideBlocks,
  ensureProjectBridge,
} from './agent-compat';
import { judgeAgentLiveness } from './agent-liveness';
import { isCodexUpdatePrompt } from './screen';
import type { AgentKind, AutoApproveLevel, Conversation, ProjectKind } from './types';

// ---------- Driver 最小接口（与 ExecutorDriver 结构兼容） ----------

export interface ConvDriver {
  /** 只探测受支持的 Agent 命令；启动必须使用返回的实际路径，找不到则拒绝创建 tmux。 */
  findExecutable(agent: AgentKind): Promise<string | null>;
  /** command = tmux `#{pane_current_command}`（判「代理还在不在跑」的主证据，缺省则退化成只看屏） */
  listSessions(): Promise<Array<{ name: string; command?: string }>>;
  createSession(name: string, cwd: string): Promise<void>;
  killSession(name: string): Promise<void>;
  sendKeys(session: string, text: string): Promise<void>;
  capturePane(session: string): Promise<string>;
  statPath(path: string): Promise<{ size: number; isDirectory: boolean } | null>;
  readFileRange(path: string, offset: number, limit: number): Promise<{ data: Uint8Array; size: number }>;
  writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void>;
}

/** jsonl 定位最小接口（core/jsonl.ts JsonlLocator 结构兼容） */
export interface ConvLocator {
  locate(convId: string): Promise<string | null>;
}

// ---------- 纯函数 ----------

/** 项目专用 claude 进程的 tmux 会话名（v1 dedTmux 改 project 维度）——issue 模式单活跃会话 */
export function dedTmux(projectId: number): string {
  return `cc-${projectId}`;
}

/** 正式模块的按需运行 tmux；逻辑会话仍由 conversations/project_modules 持久化。 */
export function moduleTmux(projectId: number, slug: string): string {
  return `cc-${projectId}-m-${slug}`;
}

/**
 * chat（对话模式）每对话独立 tmux 会话名（009）：以 convId（UUID）为键，与 issue 的
 * `cc-<pid>` 隔离——故同项目多条 chat 对话可各自常驻、来回切换互不 kill。
 */
export function chatTmux(convId: string): string {
  return `chat-${convId}`;
}

// ---------- 行映射 ----------

interface ConvRow {
  id: string;
  project_id: number;
  label: string | null;
  created_ts: number;
  archived: number;
  agent: string;
  agent_session_id: string | null;
  /** 009 迁移；旧库兜底 'issue' */
  kind?: string | null;
  /** 009 迁移；旧库兜底 null */
  last_active_ts?: number | null;
  /** 014 迁移；旧库兜底 'cautious' */
  auto_approve?: string | null;
}

function mapConv(r: ConvRow): Conversation {
  return {
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    createdTs: r.created_ts,
    archived: r.archived !== 0,
    agent: r.agent === 'codex' ? 'codex' : 'claude',
    kind: r.kind === 'chat' ? 'chat' : 'issue',
    lastActiveTs: r.last_active_ts ?? null,
    // 认不出的值（旧库无此列/脏数据）一律落到最保守档，宁可多问人也不误批
    autoApprove: r.auto_approve === 'medium' || r.auto_approve === 'auto' ? r.auto_approve : 'cautious',
  };
}

// ---------- 管理器 ----------

export interface ConversationManagerOpts {
  /**
   * 执行机上的 ~/.claude.json（trustDir 预置信任用，v1 conversations.ts:101-113 平移）。
   * 不给则跳过预置——兜底是 PM 对 trust 弹窗自动同意（评审 M14 认可的双层兜底）。
   */
  trustFile?: string;
  /** 执行机上的 ~/.codex/config.toml（codex trust_level 预置；缺省跳过，兜底=启动参数直接 bypass） */
  codexConfigFile?: string;
  /**
   * codex 启动附加参数。默认 bypass 审批+沙箱：mando 无人守屏全自动驱动，codex 的
   * 审批弹窗不走 CC 菜单协议（screen.ts 检不到），滞留即卡死——与 claude 侧
   * 「PM 自动过菜单」对齐的等效选择。
   */
  codexArgs?: string;
  /** 执行机 ~/.claude（装 agents-md-compat 默认技能；缺省跳过该侧） */
  claudeHome?: string;
  /** 执行机 ~/.codex（装 claude-config-compat 默认技能；缺省跳过该侧） */
  codexHome?: string;
}

/** codex 默认启动参数（见 ConversationManagerOpts.codexArgs 注释） */
export const DEFAULT_CODEX_ARGS = '--dangerously-bypass-approvals-and-sandbox';

/**
 * 启动时禁用 codex「standalone installer 自更新检查」的 config 覆盖（`-c` = 等价顶层 key）。
 *
 * 关键坑：生效的是 *顶层* `check_for_update_on_startup`，不是 `[tui].check_for_update_on_startup`。
 * 后者只关 TUI 的被动更新横幅；standalone 安装（install.sh 落地的）另有一套「startup update check」，
 * 实测 codex ≥0.145 即便 `[tui]` 关了仍会在启动时自更新、打印「Please restart Codex」并退回 shell——
 * 于是每条 chat 会话被打回 bash，用户消息全被当成 shell 命令跑掉（command not found），表现为「发了没反应」。
 * `codex doctor` 里对应「startup update check」一项；用 `codex -c check_for_update_on_startup=false` 可置 false。
 *
 * 走 `-c` 启动覆盖而非改 config.toml：顶层键必须排在任何 `[表]` 之前，向既有 config 追加不安全（易落进末尾的表里）；
 * `-c` 每次启动都保证生效、零文件结构风险。全局选项须在子命令之前（`codex -c ... resume <sid>`，实测可解析）。
 */
export const CODEX_NO_UPDATE_FLAG = '-c check_for_update_on_startup=false';

export class AgentExecutableNotFoundError extends Error {
  constructor(readonly agent: AgentKind) {
    super(`执行机 PATH 中找不到 ${agent === 'claude' ? 'Claude' : 'Codex'} 可执行文件`);
    this.name = 'AgentExecutableNotFoundError';
  }
}

/** Agent 路径来自受限 findExecutable，但仍须安全嵌入 tmux 里的交互 shell 命令。 */
function quoteShellWord(word: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export class ConversationManager {
  constructor(
    private readonly db: Database,
    private readonly driver: ConvDriver,
    private readonly locator: ConvLocator,
    private readonly opts: ConversationManagerOpts = {},
  ) {}

  // ---- 查询 ----

  get(id: string): Conversation | undefined {
    const r = this.db.query<ConvRow, [string]>('SELECT * FROM conversations WHERE id = ?').get(id);
    return r ? mapConv(r) : undefined;
  }

  listByProject(projectId: number): Conversation[] {
    return this.db
      .query<ConvRow, [number]>(
        'SELECT * FROM conversations WHERE project_id = ? ORDER BY created_ts DESC',
      )
      .all(projectId)
      .map(mapConv);
  }

  /**
   * 列某项目的 chat（对话模式）对话，按最近活跃（无则创建时间）倒序——对话模式左侧对话列表用。
   * 默认排除已归档；includeArchived=true 时全列。
   */
  listChats(projectId: number, includeArchived = false): Conversation[] {
    const sql = includeArchived
      ? `SELECT * FROM conversations WHERE project_id = ? AND kind = 'chat'
         ORDER BY COALESCE(last_active_ts, created_ts) DESC`
      : `SELECT * FROM conversations WHERE project_id = ? AND kind = 'chat' AND archived = 0
         ORDER BY COALESCE(last_active_ts, created_ts) DESC`;
    return this.db.query<ConvRow, [number]>(sql).all(projectId).map(mapConv);
  }

  /** 项目当前激活的对话 id（入库，重启不丢） */
  currentConv(projectId: number): string | undefined {
    const r = this.db
      .query<{ conv_id: string }, [number]>(
        'SELECT conv_id FROM project_active_conv WHERE project_id = ?',
      )
      .get(projectId);
    return r?.conv_id;
  }

  /** issue 模式项目级会话名（cc-<pid>）；chat 对话请用 sessionName(conv) 取每对话独立会话 */
  tmuxName(projectId: number, convId?: string | null): string {
    if (convId) {
      const row = this.db
        .query<{ slug: string }, [number, string]>(
          'SELECT slug FROM project_modules WHERE project_id = ? AND conversation_id = ?',
        )
        .get(projectId, convId);
      if (row) return moduleTmux(projectId, row.slug);
    }
    return dedTmux(projectId);
  }

  /** 一条对话对应的 tmux 会话名：issue = 项目级 cc-<pid>；chat = 每对话独立 chat-<convId> */
  sessionName(c: Conversation): string {
    return c.kind === 'chat' ? chatTmux(c.id) : this.tmuxName(c.projectId, c.id);
  }

  // ---- 写入 ----

  /**
   * 分配一条对话并登记（不启动进程；activate 时才起进程）。agent 对话生命周期内不变。
   * kind：'issue'（默认，供 issue 引擎绑定，共用 cc-<pid>）或 'chat'（对话模式，独立会话）。
   */
  create(
    projectId: number,
    label: string,
    agent: AgentKind = 'claude',
    kind: ProjectKind = 'issue',
  ): Conversation {
    const id = crypto.randomUUID();
    const row = this.db
      .query<ConvRow, [string, number, string, number, string, string]>(
        `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        id,
        projectId,
        (label || '会话').slice(0, 80),
        Date.now(),
        agent === 'codex' ? 'codex' : 'claude',
        kind === 'chat' ? 'chat' : 'issue',
      );
    if (!row) throw new Error('insert conversation failed');
    return mapConv(row);
  }

  /** 改对话标题（chat 对话重命名用；≤80 字符） */
  rename(id: string, label: string): void {
    this.db.query('UPDATE conversations SET label = ? WHERE id = ?').run((label || '会话').slice(0, 80), id);
  }

  /**
   * 改对话的自动批准档位（014，issue #108）。改完立刻生效：后台巡检每轮现读这一列
   * （谨慎档直接不进扫描面），不需要重启会话或重连 WS。
   */
  setAutoApprove(id: string, level: AutoApproveLevel): void {
    this.db.query('UPDATE conversations SET auto_approve = ? WHERE id = ?').run(level, id);
  }

  /** 归档对话；chat 对话顺手 kill 其独立 tmux 会话（关闭清理，best-effort） */
  async archive(id: string): Promise<void> {
    const c = this.get(id);
    this.db.query('UPDATE conversations SET archived = 1 WHERE id = ?').run(id);
    if (c?.kind === 'chat') await this.killChatSession(c);
  }

  /**
   * 关闭清理：kill 一条 chat 对话的独立 tmux 会话（不改 archived——下次 activate 会
   * `--resume` 复活并接续上下文）。用于「关闭对话页 / 停机回收」等场景。
   */
  async closeChat(id: string): Promise<void> {
    const c = this.get(id);
    if (c) await this.killChatSession(c);
  }

  /** issue 模块按需休眠：仅回收 tmux 进程，保留 conversation/session id 供下次 resume。 */
  async sleepIssue(id: string): Promise<void> {
    const c = this.get(id);
    if (!c || c.kind !== 'issue') return;
    await this.driver.killSession(this.tmuxName(c.projectId, c.id)).catch(() => {});
    this.db
      .query('DELETE FROM project_active_conv WHERE project_id = ? AND conv_id = ?')
      .run(c.projectId, c.id);
  }

  /** kill 一条 chat 对话的独立 tmux 会话（best-effort，失败静默） */
  private async killChatSession(c: Conversation): Promise<void> {
    if (c.kind !== 'chat') return;
    try {
      await this.driver.killSession(chatTmux(c.id));
    } catch {
      /* 会话不存在或已关，正常 */
    }
  }

  /** 记一条对话最近活跃时刻（009 last_active_ts；chat 列表按它排序） */
  private touch(id: string): void {
    this.db.query('UPDATE conversations SET last_active_ts = ? WHERE id = ?').run(Date.now(), id);
  }

  // ---- 激活（切对话 = kill 旧起新） ----

  /**
   * tmux 会话是否存在 + 它的前台命令（#{pane_current_command}）。
   * listSessions 抛错按「不存在」处理——沿用旧 tmuxAlive 语义（执行机不可达时宁可重起）。
   */
  private async sessionInfo(name: string): Promise<{ alive: boolean; command?: string }> {
    try {
      const s = (await this.driver.listSessions()).find((x) => x.name === name);
      if (!s) return { alive: false };
      return { alive: true, ...(s.command ? { command: s.command } : {}) };
    } catch {
      return { alive: false };
    }
  }

  /**
   * 对话「真存活」保障（幂等，issue #97 从 codex-chat 专用泛化到 claude+codex、chat+issue）：
   * **tmux 会话活着 ≠ 代理在跑**。
   *
   * 代理退出（codex 自更新、崩溃、登录过期、被 Ctrl-C）后 tmux 会话仍在，窗格里只剩 bash——
   * 单看会话存在就短路，之后所有注入都被 send-keys 打进 shell（command not found），表现为
   * 「发消息没反应」「issue 一直不动」。故：
   * - 会话不在 → launchInto 起代理；
   * - 会话在但屏面是 codex「Update available」弹窗 → 输入 2 选 Skip（不重启，codex 会继续）；
   * - 会话在但判定已退回 shell → launchInto 重启（claude --resume / codex resume，上下文接得上）；
   * - 判定 live 或 unknown → 幂等短路，绝不打断在跑的对话。
   * 判据见 core/agent-liveness：前台命令为主、屏面为辅，判不准一律 unknown（保守不动）。
   * capturePane 失败传 undefined（≠ 空屏），退化成只按前台命令判。
   */
  private async ensureAgentLive(session: string, c: Conversation, cwd: string): Promise<void> {
    const info = await this.sessionInfo(session);
    if (!info.alive) {
      await this.launchInto(session, c, cwd);
      return;
    }
    const pane = await this.driver.capturePane(session).catch(() => undefined);
    if (pane !== undefined && isCodexUpdatePrompt(pane)) {
      await this.driver.sendKeys(session, '2').catch(() => {}); // Skip，跳过「1. Update now」
      return;
    }
    const state = judgeAgentLiveness({
      agent: c.agent,
      ...(info.command !== undefined ? { paneCommand: info.command } : {}),
      ...(pane !== undefined ? { pane } : {}),
    });
    if (state === 'shell') await this.launchInto(session, c, cwd);
  }

  /** 预置 cwd 信任（best-effort；失败静默，靠 trust 弹窗自动同意兜底） */
  private async trustDir(cwd: string): Promise<void> {
    const f = this.opts.trustFile;
    if (!f) return;
    try {
      const st = await this.driver.statPath(f);
      if (!st) return;
      const { data } = await this.driver.readFileRange(f, 0, Math.max(st.size, 1));
      const j = JSON.parse(new TextDecoder().decode(data)) as {
        projects?: Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>>;
      };
      j.projects = j.projects || {};
      if (j.projects[cwd]?.hasTrustDialogAccepted === true) return;
      j.projects[cwd] = { ...(j.projects[cwd] || {}), hasTrustDialogAccepted: true };
      await this.driver.writeFile(f, JSON.stringify(j, null, 2));
    } catch {
      /* best-effort：失效兜底 = trust 弹窗自动同意 */
    }
  }

  /**
   * codex 侧配置预置（best-effort）：追加 [projects."<cwd>"] trust_level = "trusted"
   * （信任目录，兜底 = 启动参数 bypass 审批）。已有该段则不重复追加。
   *
   * 注：自更新检查的关闭不在这里做——生效的是 *顶层* check_for_update_on_startup，
   * 而顶层键须排在任何 [表] 之前，向既有 config 追加不安全；改由启动命令的
   * CODEX_NO_UPDATE_FLAG（`-c check_for_update_on_startup=false`）保证每次生效（见 buildCommand）。
   * 历史上这里曾写 [tui] check_for_update_on_startup=false，实测对 standalone 自更新无效，已移除。
   */
  private async codexTrustDir(cwd: string): Promise<void> {
    const f = this.opts.codexConfigFile;
    if (!f) return;
    try {
      const section = `[projects."${cwd}"]`;
      const st = await this.driver.statPath(f);
      let text = '';
      if (st) {
        const { data } = await this.driver.readFileRange(f, 0, Math.max(st.size, 1));
        text = new TextDecoder().decode(data);
      }
      if (text.includes(section)) return;
      const sep = text.length && !text.endsWith('\n') ? '\n' : '';
      await this.driver.writeFile(f, `${text}${sep}${section}\ntrust_level = "trusted"\n`);
    } catch {
      /* best-effort：兜底 = 启动参数 bypass 审批 */
    }
  }

  /** 按对话 agent 组装启动命令；codex fresh/resume 一律重盖 launch_ts 锚点并清 path 缓存（会话发现/重定位用） */
  private async buildCommand(c: Conversation): Promise<string> {
    const executable = await this.driver.findExecutable(c.agent);
    if (!executable) throw new AgentExecutableNotFoundError(c.agent);
    const command = quoteShellWord(executable);
    if (c.agent !== 'codex') {
      // 清掉 reclaim 期间可能绑上的手动会话覆盖（agent_jsonl_path）：重启后 pane 里
      // 跑的是 --resume/--session-id 的原生会话，覆盖不清会让引擎继续 tail 死文件
      this.db.query('UPDATE conversations SET agent_jsonl_path = NULL WHERE id = ?').run(c.id);
      const exists = (await this.locator.locate(c.id)) !== null;
      return exists ? `${command} --resume ${c.id}` : `${command} --session-id ${c.id}`;
    }
    const args = this.opts.codexArgs ?? DEFAULT_CODEX_ARGS;
    const row = this.db
      .query<{ agent_session_id: string | null }, [string]>(
        'SELECT agent_session_id FROM conversations WHERE id = ?',
      )
      .get(c.id);
    const sid = row?.agent_session_id;
    // fresh 与 resume 都重盖 launch_ts 并清 path 缓存（issue #48：旧绑定粘连是卡死元凶）：
    // resume 后按 sid 回扫重定位（resume 若换了文件，缓存路径已是死的）；fresh 后按新
    // 锚点重新发现。锚点必须在进程启动前落库（发现窗口从它起算）。
    this.db
      .query('UPDATE conversations SET agent_launch_ts = ?, agent_jsonl_path = NULL WHERE id = ?')
      .run(Date.now(), c.id);
    if (sid) return `${command} ${CODEX_NO_UPDATE_FLAG} resume ${sid} ${args}`.trim();
    // fresh：codex 无 --session-id，启动后靠 agent-locator 按 launch_ts+cwd 发现真实会话
    return `${command} ${CODEX_NO_UPDATE_FLAG} ${args}`.trim();
  }

  /**
   * 启动一条对话到指定 tmux 会话：预置信任/兼容层/cwd → buildCommand → kill 旧起新 → sendKeys。
   * 失败上抛（评审铁律：不许 void 吞错）。
   */
  private async launchInto(session: string, c: Conversation, cwd: string): Promise<void> {
    if (c.agent === 'codex') await this.codexTrustDir(cwd);
    else await this.trustDir(cwd);

    try {
      const homes = { claudeHome: this.opts.claudeHome, codexHome: this.opts.codexHome };
      await ensureCompatSkills(this.driver, homes);
      await ensureArtifactSkill(this.driver, homes); // 产物落 cwd 内置技能（缺失才写）
      await ensureMandoIssueSkill(this.driver, homes);
      await ensureProjectBridge(this.driver, cwd);
      await ensureModuleGuideBlocks(this.driver, cwd);
    } catch {
      /* best-effort：兼容层缺失不阻断激活 */
    }

    // 确保项目 cwd 在执行机上存在（writeFile 会建父目录；已存在则跳过，不污染项目目录）
    const cwdStat = await this.driver.statPath(cwd).catch(() => null);
    if (!cwdStat) {
      await this.driver.writeFile(`${cwd.replace(/\/+$/, '')}/.mando/keep`, '');
    }

    const cmd = await this.buildCommand(c);

    try {
      await this.driver.killSession(session);
    } catch {
      /* 会话不存在，正常 */
    }
    await this.driver.createSession(session, cwd);
    await this.driver.sendKeys(session, cmd);
  }

  /**
   * 激活一条对话（起进程）。返回 null 仅当对话不存在。
   *
   * issue（默认）：项目单活跃会话 `cc-<pid>`——已在它上面则只做「代理真存活」保障（幂等，
   *   见 ensureAgentLive）；切对话 = kill 旧起新 + 落 project_active_conv。
   *   调用方须用 projectLockKey(projectId) 互斥。
   * chat（对话模式）：每对话独立会话 `chat-<convId>`——各自常驻互不 kill；代理在跑即幂等短路
   *   （不打断在跑的对话），只在没在跑（会话不在 / 退回 shell）时启动；不碰 project_active_conv。
   *   调用方须用本对话会话名的 tmuxLockKey 互斥（kill+new+send 三连非原子）。
   *
   * 注意「代理在跑」不等于「tmux 会话存在」（issue #97）：判不准时一律不动，需要无条件
   * 重起请显式调 relaunch。
   *
   * claude：首次（jsonl 未落地）`claude --session-id <id>`，之后 `claude --resume <id>`；
   * codex：已发现 session id 则 `codex resume <sid>`，否则 fresh 启动。
   */
  async activate(id: string): Promise<Conversation | null> {
    const c = this.get(id);
    if (!c) return null;
    const cwd = this.projectCwd(c);

    if (c.kind === 'chat') {
      // 独立聊天会话：代理真在跑即幂等短路（不打断在跑的对话），否则启动/重启
      // （死后 activate 会 --resume 复活；退回 shell 也算「没在跑」，见 ensureAgentLive）。
      await this.ensureAgentLive(chatTmux(c.id), c, cwd);
      this.touch(id);
      return c;
    }

    // issue：项目单活跃会话——切对话 = kill 旧起新
    const ded = this.tmuxName(c.projectId, c.id);
    // 已经是当前对话：不切不 kill，但要保证代理**真的**在跑。旧实现在这里只看 tmux 会话
    // 是否存在就 return，于是「壳还在、代理已退回 bash」永远修不好（issue #97）。
    if (this.currentConv(c.projectId) === id) {
      await this.ensureAgentLive(ded, c, cwd);
      return c;
    }
    const previousId = this.currentConv(c.projectId);
    if (previousId && previousId !== id) {
      const previous = this.tmuxName(c.projectId, previousId);
      if (previous !== ded) await this.driver.killSession(previous).catch(() => {});
    }
    await this.launchInto(ded, c, cwd);
    this.setActiveConv(c.projectId, id);
    return c;
  }

  /**
   * 强制重启一条对话的代理进程（issue #97）：**不做任何存活短路**，直接 kill 旧起新
   * （claude --resume / codex resume，历史上下文接得上）。返回 null 仅当对话不存在。
   *
   * 与 activate 的分工：activate 是「保证它在跑」（健康就不动），relaunch 是「我已经判定它
   * 死了，给我重起」。调用方（引擎判定 pane 里只剩 bash 之后）必须自己做冷却与次数上限——
   * 本方法不带任何节流，连调就是连 kill。
   * 锁序同 activate：调用方须持 projectLockKey → tmuxLockKey。
   */
  async relaunch(id: string): Promise<Conversation | null> {
    const c = this.get(id);
    if (!c) return null;
    await this.launchInto(this.sessionName(c), c, this.projectCwd(c));
    if (c.kind === 'chat') this.touch(id);
    else this.setActiveConv(c.projectId, id); // 重启后这条就是项目的当前对话（幂等）
    return c;
  }

  /** 项目 cwd（对话必须挂在存在的项目上，取不到是数据不一致，直接上抛） */
  private projectCwd(c: Conversation): string {
    const proj = this.db
      .query<{ cwd: string }, [number]>('SELECT cwd FROM projects WHERE id = ?')
      .get(c.projectId);
    if (!proj) throw new Error(`conversation ${c.id} 的项目 ${c.projectId} 不存在`);
    return proj.cwd;
  }

  private setActiveConv(projectId: number, convId: string): void {
    this.db
      .query(
        `INSERT INTO project_active_conv (project_id, conv_id, updated_ts) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET conv_id = excluded.conv_id, updated_ts = excluded.updated_ts`,
      )
      .run(projectId, convId, Date.now());
  }
}
