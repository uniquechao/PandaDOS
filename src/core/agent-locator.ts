/**
 * core/agent-locator —— 按对话代理（claude/codex）定位会话 jsonl，locate 接口与
 * JsonlLocator 结构一致（引擎/PM/WS 全部走结构化 {locate}，可无缝替换）。
 *
 * claude：conv.id 即 session id，透传 JsonlLocator（扫 ~/.claude/projects）。
 * codex：session id 无法预指定（CLI 无 --session-id）——fresh 启动后由本定位器从
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<本地时间>-<uuid>.jsonl 发现真实会话：
 *   1. 文件名只用于识别 rollout / 提取 session id，**不做时间判定**——文件名时间是
 *      执行机本地时区，控制面无法可靠还原（Bun 无 TZ 环境变量时按 UTC 解析本地时间，
 *      偏移可达 8h+，曾把 7 小时前的旧会话误判成「launch 之后最早」而错绑，issue #48）；
 *   2. 候选 = 首行 session_meta 的 UTC timestamp ≥ agent_launch_ts - 2min 的 rollout
 *      （按启动时间锚定；resume 旧会话续写原文件、meta 时间早于锚点，天然排除；
 *      timestamp 解析不出则保守跳过——Driver.statPath 无 mtime，且死会话被续写时
 *      mtime 会「复活」，不能当创建时间用）；
 *   3. 读首行 session_meta 核对 cwd == 项目 cwd（同机多项目不串线）；
 *   4. 排除已被其他对话绑走的 session id，优先取锚点后最早者；锚点前容差候选需等待
 *      短确认期且仍无后置候选时，才按最接近锚点者兜底（兼容执行机时钟偏差）；
 *   5. 回填 conversations.agent_session_id / agent_jsonl_path（重启不丢，失效重扫）。
 */
import type { Database } from 'bun:sqlite';
import type { JsonlLocator, JsonlReader } from './jsonl';

/** rollout 文件名：rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl（时间为执行机本地时区） */
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

/**
 * 文件名 → session id；非 rollout 返回 null。文件名里的时间**不解析**：那是执行机
 * 本地时区，控制面进程时区未必一致（Bun 无 TZ 时是 UTC），解析出来的 epoch 不可信
 * ——时间判定一律走首行 session_meta 的 UTC timestamp（readMeta）。
 */
export function rolloutSessionId(name: string): string | null {
  return name.match(ROLLOUT_RE)?.[1] ?? null;
}

/** 发现窗口：meta 时间允许早于 launch_ts 的富余（执行机/控制面时钟与创建耗时偏差） */
const LAUNCH_SLACK_MS = 2 * 60 * 1000;
/** fresh 启动后等待当前 rollout 落盘的确认期；期间不让锚点前旧会话抢先固化绑定。 */
const DISCOVERY_SETTLE_MS = 10 * 1000;
/** findBySessionId 全树回扫的日目录上限（新→旧；超过视为会话过老，交人工） */
const MAX_SCAN_DAY_DIRS = 90;
/**
 * reclaim 的「活跃」判据：候选会话文件末尾最后一条时间戳距今不超过此值。
 * 重认领总是发生在「刚注入过 prompt 但绑定文件零增长」之后——pane 里真正活着的
 * 会话刚收到该注入并有回应（在写），死会话/被弃会话的尾巴则停在过去。
 */
const RECLAIM_ACTIVE_MS = 10 * 60 * 1000;
/** reclaim 候选窗口下限：最多回看这么多天（防 conv 过老时日目录扫描窗口漂出上限） */
const RECLAIM_LOOKBACK_MS = 12 * 24 * 3600 * 1000;

interface ConvAgentRow {
  agent: string;
  agent_session_id: string | null;
  agent_jsonl_path: string | null;
  agent_launch_ts: number | null;
  project_id: number;
  created_ts: number;
  execution_cwd: string;
}

export class AgentJsonlLocator {
  constructor(
    private readonly db: Database,
    private readonly reader: JsonlReader,
    private readonly claude: JsonlLocator,
    /** 执行机上的 codex sessions 根目录（如 ~/.codex/sessions） */
    private readonly codexSessionsDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  invalidate(convId: string): void {
    this.claude.invalidate(convId);
    this.db
      .query('UPDATE conversations SET agent_jsonl_path = NULL WHERE id = ?')
      .run(convId);
  }

  async locate(convId: string): Promise<string | null> {
    const executionCwd = this.executionCwdSql();
    const row = this.db
      .query<ConvAgentRow, [string]>(
        `SELECT conversations.agent, agent_session_id, agent_jsonl_path, agent_launch_ts,
                conversations.project_id, conversations.created_ts,
                ${executionCwd} AS execution_cwd
         FROM conversations JOIN projects ON projects.id = conversations.project_id
         WHERE conversations.id = ?`,
      )
      .get(convId);
    if (!row || row.agent !== 'codex') {
      // claude：常规 = conv.id 即 session id，透传扫描；但 reclaim 认领过手动重启的
      // 新会话时会把新 jsonl 写进 agent_jsonl_path——该覆盖优先（失效则清列回退常规）。
      if (row?.agent_jsonl_path) {
        if (await this.reader.statPath(row.agent_jsonl_path).catch(() => null)) {
          return row.agent_jsonl_path;
        }
        this.db.query('UPDATE conversations SET agent_jsonl_path = NULL WHERE id = ?').run(convId);
      }
      return this.claude.locate(convId);
    }

    // 1) 路径缓存仍有效 → 直接用
    if (row.agent_jsonl_path) {
      if (await this.reader.statPath(row.agent_jsonl_path).catch(() => null)) {
        return row.agent_jsonl_path;
      }
      this.db.query('UPDATE conversations SET agent_jsonl_path = NULL WHERE id = ?').run(convId);
    }

    // 2) 已知 session id → 按文件名后缀回扫（重启丢缓存的恢复路径）
    if (row.agent_session_id) {
      const p = await this.findBySessionId(row.agent_session_id);
      if (p) this.db.query('UPDATE conversations SET agent_jsonl_path = ? WHERE id = ?').run(p, convId);
      return p;
    }

    // 3) 未知 session id → 按 launch_ts + cwd 发现（无锚点不猜，防错绑）
    if (!row.agent_launch_ts) return null;
    const bound = new Set(
      this.db
        .query<{ agent_session_id: string }, [string]>(
          `SELECT agent_session_id FROM conversations
           WHERE agent_session_id IS NOT NULL AND id != ?`,
        )
        .all(convId)
        .map((r) => r.agent_session_id),
    );
    const found = await this.discover(row.agent_launch_ts, row.execution_cwd, bound);
    if (!found) return null;
    this.db
      .query('UPDATE conversations SET agent_session_id = ?, agent_jsonl_path = ? WHERE id = ?')
      .run(found.sessionId, found.path, convId);
    return found.path;
  }

  /**
   * 会话重新认领（引擎会话失效检测的执行端，issue #48）：绑定的会话已死（撞限退出 /
   * 人工在 pane 里重启换了进程），按 cwd 重新发现**当前活跃**的会话并重绑。
   * 与 fresh 发现「取最早」相反，这里取 meta 时间**最新**者——pane 里活着的必是最近
   * 一次启动的进程；同时要求候选文件尾部时间戳距今 ≤ RECLAIM_ACTIVE_MS（重认领前
   * 引擎刚注入过 prompt，活会话必有新写入；死/弃会话尾巴停在过去，天然排除）。
   * 候选下限 = conv 创建时刻（会话必然晚于对话建立），排除其它对话绑走的 id 与
   * 本对话当前已死的绑定。命中：codex 回填 sid+path 并重盖 launch_ts=新会话创建时间；
   * claude 把新 jsonl 写进 agent_jsonl_path 覆盖（locate 优先走它）。
   * 无候选返回 null 且不动原绑定（调用方冷却重试/告警）。
   */
  async reclaim(convId: string): Promise<string | null> {
    const executionCwd = this.executionCwdSql();
    const row = this.db
      .query<ConvAgentRow, [string]>(
        `SELECT conversations.agent, agent_session_id, agent_jsonl_path, agent_launch_ts,
                conversations.project_id, conversations.created_ts,
                ${executionCwd} AS execution_cwd
         FROM conversations JOIN projects ON projects.id = conversations.project_id
         WHERE conversations.id = ?`,
      )
      .get(convId);
    if (!row) return null;
    const sinceTs = Math.max(row.created_ts - LAUNCH_SLACK_MS, this.now() - RECLAIM_LOOKBACK_MS);
    return row.agent === 'codex'
      ? this.reclaimCodex(convId, row, row.execution_cwd, sinceTs)
      : this.reclaimClaude(convId, row, sinceTs);
  }

  // ---- 内部 ----

  private root(): string {
    return this.codexSessionsDir.replace(/\/+$/, '');
  }

  private executionCwdSql(): string {
    const available = this.db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM pragma_table_info('conversations') WHERE name = 'workspace_cwd'`,
    ).get()!.n === 1;
    return available
      ? "COALESCE(NULLIF(conversations.workspace_cwd, ''), projects.cwd)"
      : 'projects.cwd';
  }

  /** 文件尾 4KB 的最后一条 "timestamp" → epoch ms（活跃度判据）；读不出返回 null */
  private async readLastTs(path: string): Promise<number | null> {
    try {
      const st = await this.reader.statPath(path);
      if (!st || st.size === 0) return null;
      const off = Math.max(0, st.size - 4096);
      const { data } = await this.reader.readFileRange(path, off, st.size - off);
      const text = new TextDecoder('utf-8').decode(data);
      const m = text.match(/"timestamp":"([^"]+)"/g);
      if (!m || m.length === 0) return null;
      const iso = m[m.length - 1]!.slice('"timestamp":"'.length, -1);
      const t = Date.parse(iso);
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  /** codex 重认领：日目录窗口内找 meta.ts ≥ sinceTs、cwd 匹配、未被绑走且尾部活跃的最新会话 */
  private async reclaimCodex(
    convId: string,
    row: ConvAgentRow,
    projectCwd: string,
    sinceTs: number,
  ): Promise<string | null> {
    const wantCwd = projectCwd.replace(/\/+$/, '');
    const bound = new Set(
      this.db
        .query<{ agent_session_id: string }, [string]>(
          `SELECT agent_session_id FROM conversations
           WHERE agent_session_id IS NOT NULL AND id != ?`,
        )
        .all(convId)
        .map((r) => r.agent_session_id),
    );
    if (row.agent_session_id) bound.add(row.agent_session_id); // 自己的死绑定也排除
    const activeSince = this.now() - RECLAIM_ACTIVE_MS;
    let best: { sessionId: string; path: string; ts: number } | null = null;
    for (const dir of this.dayDirsSince(sinceTs)) {
      for (const f of await this.listDirSafe(dir)) {
        if (f.type === 'dir') continue;
        const nameSid = rolloutSessionId(f.name);
        if (!nameSid || bound.has(nameSid)) continue;
        const path = `${dir}/${f.name}`;
        const meta = await this.readMeta(path);
        if (!meta || meta.ts === null || meta.ts < sinceTs) continue;
        if (meta.cwd.replace(/\/+$/, '') !== wantCwd) continue;
        if (bound.has(meta.sessionId)) continue;
        if (best && meta.ts <= best.ts) continue; // 取最新
        const lastTs = await this.readLastTs(path);
        if (lastTs === null || lastTs < activeSince) continue; // 尾巴不活跃 = 死/弃会话
        best = { sessionId: meta.sessionId, path, ts: meta.ts };
      }
    }
    if (!best) return null;
    this.db
      .query(
        `UPDATE conversations SET agent_session_id = ?, agent_jsonl_path = ?, agent_launch_ts = ?
         WHERE id = ?`,
      )
      .run(best.sessionId, best.path, best.ts, convId);
    return best.path;
  }

  /**
   * claude 重认领（best-effort）：手动重启的 claude 是新 session id，新 jsonl 落在
   * 同一项目目录（同 cwd）。以原 conv jsonl 所在目录为锚，找「首条时间戳 ≥ sinceTs、
   * 尾部活跃、未被其它对话占用」的最新 session 文件，绑进 agent_jsonl_path 覆盖。
   */
  private async reclaimClaude(convId: string, row: ConvAgentRow, sinceTs: number): Promise<string | null> {
    const orig = await this.claude.locate(convId);
    if (!orig) return null;
    const dir = orig.slice(0, orig.lastIndexOf('/'));
    const taken = new Set<string>();
    for (const r of this.db
      .query<{ id: string; agent_jsonl_path: string | null }, [string]>(
        `SELECT id, agent_jsonl_path FROM conversations WHERE id != ?`,
      )
      .all(convId)) {
      taken.add(`${r.id}.jsonl`); // claude 常规命名 = <convId>.jsonl
      if (r.agent_jsonl_path) taken.add(r.agent_jsonl_path.slice(r.agent_jsonl_path.lastIndexOf('/') + 1));
    }
    const activeSince = this.now() - RECLAIM_ACTIVE_MS;
    let best: { path: string; ts: number } | null = null;
    for (const f of await this.listDirSafe(dir)) {
      if (f.type === 'dir' || !f.name.endsWith('.jsonl')) continue;
      if (f.name === `${convId}.jsonl` || taken.has(f.name)) continue;
      const path = `${dir}/${f.name}`;
      const firstTs = await this.readFirstTs(path);
      if (firstTs === null || firstTs < sinceTs) continue;
      if (best && firstTs <= best.ts) continue; // 取最新
      const lastTs = await this.readLastTs(path);
      if (lastTs === null || lastTs < activeSince) continue;
      best = { path, ts: firstTs };
    }
    if (!best) return null;
    this.db.query('UPDATE conversations SET agent_jsonl_path = ? WHERE id = ?').run(best.path, convId);
    return best.path;
  }

  /** 文件头 64KB 的第一条 "timestamp" → epoch ms（claude jsonl 无 session_meta，以此当会话开始时间） */
  private async readFirstTs(path: string): Promise<number | null> {
    try {
      const { data } = await this.reader.readFileRange(path, 0, 64 * 1024);
      const iso = new TextDecoder('utf-8').decode(data).match(/"timestamp":"([^"]+)"/)?.[1];
      if (!iso) return null;
      const t = Date.parse(iso);
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  private async listDirSafe(path: string): Promise<Array<{ name: string; type: string }>> {
    try {
      return await this.reader.listDir(path);
    } catch {
      return [];
    }
  }

  /** 全树新→旧回扫，找文件名以 -<sessionId>.jsonl 结尾的 rollout */
  private async findBySessionId(sessionId: string): Promise<string | null> {
    const suffix = `-${sessionId}.jsonl`;
    const root = this.root();
    const numDesc = (a: { name: string }, b: { name: string }) => Number(b.name) - Number(a.name);
    let scanned = 0;
    for (const y of (await this.listDirSafe(root)).filter((d) => d.type === 'dir').sort(numDesc)) {
      for (const m of (await this.listDirSafe(`${root}/${y.name}`)).filter((d) => d.type === 'dir').sort(numDesc)) {
        for (const d of (await this.listDirSafe(`${root}/${y.name}/${m.name}`)).filter((x) => x.type === 'dir').sort(numDesc)) {
          if (scanned++ >= MAX_SCAN_DAY_DIRS) return null;
          const dir = `${root}/${y.name}/${m.name}/${d.name}`;
          for (const f of await this.listDirSafe(dir)) {
            if (f.type !== 'dir' && f.name.endsWith(suffix)) return `${dir}/${f.name}`;
          }
        }
      }
    }
    return null;
  }

  /**
   * launch_ts 起至今的日目录（发现场景跨度极小，硬上限 14 天防误配置扫穿）。
   * 目录名按执行机本地日期，进程本地日期与之可差 ±1 天（时区偏移 ±14h 以内），
   * 故起止各外扩一天；多扫的目录不存在时 listDirSafe 返回空，无副作用。
   */
  private dayDirsSince(launchTs: number): string[] {
    const root = this.root();
    const dirs: string[] = [];
    const day = new Date(launchTs - LAUNCH_SLACK_MS - 86_400_000);
    day.setHours(0, 0, 0, 0);
    const end = this.now() + 86_400_000;
    for (let i = 0; i < 14 && day.getTime() <= end; i++) {
      const y = day.getFullYear();
      const m = String(day.getMonth() + 1).padStart(2, '0');
      const d = String(day.getDate()).padStart(2, '0');
      dirs.push(`${root}/${y}/${m}/${d}`);
      day.setDate(day.getDate() + 1);
    }
    return dirs;
  }

  /**
   * 读 rollout 首行 session_meta → {sessionId, cwd, ts}；首行超长时正则兜底。
   * ts = 会话创建时间（epoch ms），取 payload.timestamp（会话创建）优先、顶层
   * timestamp（该行落盘）次之——两者都是带 Z 的 UTC ISO，跨时区解析无歧义；
   * 都解析不出则 ts=null（discover 保守跳过该候选）。
   */
  private async readMeta(path: string): Promise<{ sessionId: string; cwd: string; ts: number | null } | null> {
    let text: string;
    try {
      const { data } = await this.reader.readFileRange(path, 0, 64 * 1024);
      text = new TextDecoder('utf-8').decode(data);
    } catch {
      return null;
    }
    const parseTs = (...isos: Array<string | undefined>): number | null => {
      for (const iso of isos) {
        if (!iso) continue;
        const t = Date.parse(iso);
        if (Number.isFinite(t)) return t;
      }
      return null;
    };
    const nl = text.indexOf('\n');
    if (nl > 0) {
      try {
        const e = JSON.parse(text.slice(0, nl)) as {
          type?: string;
          timestamp?: string;
          payload?: { session_id?: string; id?: string; cwd?: string; timestamp?: string };
        };
        if (e.type === 'session_meta' && e.payload?.cwd) {
          const sid = e.payload.session_id ?? e.payload.id;
          if (sid) return { sessionId: sid, cwd: e.payload.cwd, ts: parseTs(e.payload.timestamp, e.timestamp) };
        }
        return null;
      } catch {
        /* 落入正则兜底 */
      }
    }
    const sid = text.match(/"session_id":"([0-9a-f-]+)"/)?.[1];
    const cwd = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
    if (!sid || !cwd) return null;
    // 兜底正则取首个 timestamp（session_meta 行内顶层在前，语义同上）
    return { sessionId: sid, cwd: cwd.replace(/\\(.)/g, '$1'), ts: parseTs(text.match(/"timestamp":"([^"]+)"/)?.[1]) };
  }

  private async discover(
    launchTs: number,
    projectCwd: string,
    boundIds: Set<string>,
  ): Promise<{ sessionId: string; path: string } | null> {
    const wantCwd = projectCwd.replace(/\/+$/, '');
    let bestAfter: { sessionId: string; path: string; ts: number } | null = null;
    let bestBefore: { sessionId: string; path: string; ts: number } | null = null;
    for (const dir of this.dayDirsSince(launchTs)) {
      for (const f of await this.listDirSafe(dir)) {
        if (f.type === 'dir') continue;
        const nameSid = rolloutSessionId(f.name);
        if (!nameSid || boundIds.has(nameSid)) continue;
        // 时间判定只信 meta 的 UTC timestamp（文件名时间时区不可靠，见文件头）
        const path = `${dir}/${f.name}`;
        const meta = await this.readMeta(path);
        if (!meta || meta.ts === null || meta.ts < launchTs - LAUNCH_SLACK_MS) continue;
        if (meta.cwd.replace(/\/+$/, '') !== wantCwd) continue;
        if (boundIds.has(meta.sessionId)) continue;
        const candidate = { sessionId: meta.sessionId, path, ts: meta.ts };
        if (meta.ts >= launchTs) {
          if (!bestAfter || meta.ts < bestAfter.ts) bestAfter = candidate;
        } else if (!bestBefore || meta.ts > bestBefore.ts) {
          bestBefore = candidate;
        }
      }
    }
    const best = bestAfter ?? (this.now() - launchTs >= DISCOVERY_SETTLE_MS ? bestBefore : null);
    return best ? { sessionId: best.sessionId, path: best.path } : null;
  }
}
