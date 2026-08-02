/**
 * core/users —— 用户/设定的 SQLite 存取 + token 哈希纪律（spec §4/§7；v1 users.ts 平移入库）。
 *
 * 安全要点（评审 5.5#4）：
 * - token 明文只在生成/重置瞬间返回一次，DB 只存 sha256 hex（v1 明文存储债在 v2 还掉）
 * - 一切比对走 timingSafeEqual（常数时间）；byTokenHash 全表扫且不提前退出
 * - workspace 目录名用不可复用的 user id（u<id>）：改名不孤儿、删号后同名新用户
 *   不继承前任数据（评审 5.5#5 推荐方案，取代 v1 的 username 目录）
 *
 * 依赖方向：core 是最内层，不 import executor——写 workspace 用结构化最小接口
 * WorkspaceWriter（与 ExecutorDriver.writeFile 结构兼容，调用方直接传 Driver 即可）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { User, UserRole, UserSettings } from './types';
import type { SupportedLocale } from '../../shared/i18n/locales';

// ---------- 常量（v1 护栏平移，评审 5.7：迁移别瞎改） ----------

/** 用户名约束（v1 web.ts:224 平移）；workspace 已改 id 目录，但用户名仍出现在 UI/日志，保持保守 */
export const USERNAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** persona 截断上限（prompt 预算护栏，v1 users.ts:75） */
export const PERSONA_MAX_CHARS = 8000;
/** memory 截断上限（v1 users.ts:66） */
export const MEMORY_MAX_CHARS = 50000;
/** token 随机字节数 → 48 hex（v1 users.ts:21） */
export const TOKEN_BYTES = 24;
/** last_seen_ts 写库节流间隔（012）：认证链每请求都 touch，距上次写入不足此间隔跳过 */
export const SEEN_TOUCH_INTERVAL_MS = 5 * 60_000;

// ---------- token 纯函数 ----------

/** 生成 48 hex 明文 token（只在生成瞬间存在，入库前必须 hashToken） */
export function genToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** sha256(token) → 64 hex（DB 唯一存储形态） */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 定长哈希串的常数时间比较；空值/长度不同直接 false */
export function hashEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

// ---------- 行映射 ----------

interface UserRow {
  id: number;
  username: string;
  token_hash: string;
  role: string;
  feishu_openid: string | null;
  created_ts: number;
  last_login_ts: number | null;
  last_seen_ts: number | null;
}

interface SettingsRow {
  user_id: number;
  persona: string | null;
  memory: string | null;
  autopilot_default: number;
  notify_pref: string | null;
  locale: string | null;
  timezone: string | null;
  detected_timezone: string | null;
}

function mapUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    tokenHash: r.token_hash,
    role: r.role as UserRole,
    feishuOpenid: r.feishu_openid,
    createdTs: r.created_ts,
    lastLoginTs: r.last_login_ts,
    lastSeenTs: r.last_seen_ts,
  };
}

function mapSettings(r: SettingsRow): UserSettings {
  return {
    userId: r.user_id,
    persona: r.persona,
    memory: r.memory,
    autopilotDefault: r.autopilot_default !== 0,
    notifyPref: r.notify_pref,
    locale: r.locale as SupportedLocale | null,
    timezone: r.timezone,
    detectedTimezone: r.detected_timezone,
  };
}

// ---------- 设定 patch ----------

export interface SettingsPatch {
  persona?: string | null;
  memory?: string | null;
  autopilotDefault?: boolean;
  notifyPref?: string | null;
  locale?: SupportedLocale;
  timezone?: string | null;
  detectedTimezone?: string | null;
}

// ---------- UserStore ----------

/** 建用户/重置 token 的返回：明文 token 只在这里出现一次 */
export interface CreatedUser {
  user: User;
  /** 明文 token，仅此一次；调用方展示后即弃 */
  token: string;
}

export class UserStore {
  constructor(private readonly db: Database) {}

  // ---- 查询 ----

  list(): User[] {
    return this.db
      .query<UserRow, []>('SELECT * FROM users ORDER BY id')
      .all()
      .map(mapUser);
  }

  byId(id: number): User | undefined {
    const r = this.db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(id);
    return r ? mapUser(r) : undefined;
  }

  byUsername(username: string): User | undefined {
    const r = this.db
      .query<UserRow, [string]>('SELECT * FROM users WHERE username = ?')
      .get(username);
    return r ? mapUser(r) : undefined;
  }

  /**
   * 按 token 哈希找用户：全表扫 + 常数时间比较、不提前退出（规模个位数用户，扫表可承受）。
   * 注意入参是 sha256 hex（调用方先 hashToken），DB 永远不见明文。
   */
  byTokenHash(hash: string): User | undefined {
    if (!hash) return undefined;
    let found: UserRow | undefined;
    for (const r of this.db.query<UserRow, []>('SELECT * FROM users').all()) {
      if (hashEq(r.token_hash, hash)) found = r;
    }
    return found ? mapUser(found) : undefined;
  }

  countAdmins(): number {
    const r = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get();
    return r?.n ?? 0;
  }

  // ---- 写入 ----

  /** 建用户；token 可指定（迁移导入用），缺省随机。明文 token 仅经返回值暴露一次。 */
  create(username: string, role: UserRole = 'user', token?: string): CreatedUser {
    if (!USERNAME_RE.test(username)) throw new Error(`invalid username: ${username}`);
    const plain = token || genToken();
    const row = this.db
      .query<UserRow, [string, string, string, number]>(
        `INSERT INTO users (username, token_hash, role, created_ts)
         VALUES (?, ?, ?, ?) RETURNING *`,
      )
      .get(username, hashToken(plain), role, Date.now());
    if (!row) throw new Error('insert user failed');
    return { user: mapUser(row), token: plain };
  }

  /** 重置 token，返回新明文（仅此一次）；无此用户返回 null */
  resetToken(id: number): string | null {
    if (!this.byId(id)) return null;
    const plain = genToken();
    this.db
      .query('UPDATE users SET token_hash = ? WHERE id = ?')
      .run(hashToken(plain), id);
    return plain;
  }

  /** 改名（workspace 目录锚在 id 上，改名零文件系统副作用）；无此用户返回 false */
  rename(id: number, username: string): boolean {
    if (!USERNAME_RE.test(username)) throw new Error(`invalid username: ${username}`);
    if (!this.byId(id)) return false;
    this.db.query('UPDATE users SET username = ? WHERE id = ?').run(username, id);
    return true;
  }

  setRole(id: number, role: UserRole): void {
    this.db.query('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  setFeishuOpenid(id: number, openid: string | null): void {
    this.db.query('UPDATE users SET feishu_openid = ? WHERE id = ?').run(openid, id);
  }

  touchLogin(id: number): void {
    this.db.query('UPDATE users SET last_login_ts = ? WHERE id = ?').run(Date.now(), id);
  }

  /**
   * 记「最后使用时间」（012 last_seen_ts）：认证链每次成功认证都会调，写库节流——
   * 距上次写入不足 minIntervalMs（默认 5min）时 WHERE 不命中直接跳过。返回是否真写了。
   */
  touchSeen(id: number, minIntervalMs: number = SEEN_TOUCH_INTERVAL_MS): boolean {
    const now = Date.now();
    return (
      this.db
        .query(
          `UPDATE users SET last_seen_ts = ?
            WHERE id = ? AND (last_seen_ts IS NULL OR ? - last_seen_ts >= ?)`,
        )
        .run(now, id, now, minIntervalMs).changes > 0
    );
  }

  /**
   * 删用户。user_settings/subscriptions 级联删；projects/issues/sessions 等仍引用时
   * SQLite 外键约束抛错——调用方（admin 路由）转 400 提示先转移归属，默认安全。
   */
  remove(id: number): boolean {
    if (!this.byId(id)) return false;
    this.db.query('DELETE FROM users WHERE id = ?').run(id);
    return true;
  }

  // ---- 每用户设定（persona/memory/autopilot 默认，spec §7 入库单一真相源） ----

  getSettings(userId: number): UserSettings {
    const r = this.db
      .query<SettingsRow, [number]>('SELECT * FROM user_settings WHERE user_id = ?')
      .get(userId);
    if (r) return mapSettings(r);
    return {
      userId,
      persona: null,
      memory: null,
      autopilotDefault: false,
      notifyPref: null,
      locale: null,
      timezone: null,
      detectedTimezone: null,
    };
  }

  /** 局部更新（未提供的字段保持原值）；persona/memory 按护栏截断。用户不存在时 FK 抛错。 */
  putSettings(userId: number, patch: SettingsPatch): UserSettings {
    const cur = this.getSettings(userId);
    const next: UserSettings = {
      userId,
      persona:
        patch.persona === undefined
          ? cur.persona
          : patch.persona === null
            ? null
            : patch.persona.slice(0, PERSONA_MAX_CHARS),
      memory:
        patch.memory === undefined
          ? cur.memory
          : patch.memory === null
            ? null
            : patch.memory.slice(0, MEMORY_MAX_CHARS),
      autopilotDefault:
        patch.autopilotDefault === undefined ? cur.autopilotDefault : Boolean(patch.autopilotDefault),
      notifyPref: patch.notifyPref === undefined ? cur.notifyPref : patch.notifyPref,
      locale: patch.locale === undefined ? cur.locale : patch.locale,
      timezone: patch.timezone === undefined ? cur.timezone : patch.timezone,
      detectedTimezone:
        patch.detectedTimezone === undefined ? cur.detectedTimezone : patch.detectedTimezone,
    };
    this.db
      .query(
        `INSERT INTO user_settings
           (user_id, persona, memory, autopilot_default, notify_pref, locale, timezone, detected_timezone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           persona = excluded.persona,
           memory = excluded.memory,
           autopilot_default = excluded.autopilot_default,
           notify_pref = excluded.notify_pref,
           locale = excluded.locale,
           timezone = excluded.timezone,
           detected_timezone = excluded.detected_timezone`,
      )
      .run(
        userId,
        next.persona,
        next.memory,
        next.autopilotDefault ? 1 : 0,
        next.notifyPref,
        next.locale,
        next.timezone,
        next.detectedTimezone,
      );
    return next;
  }
}

/**
 * 首启引导：无 admin 时建一个（用户名 admin，随机 token）。
 * 返回含明文 token（凭据纪律：调用方一次性输出到 stdout/0600 文件，严禁写日志）；
 * 已有 admin 返回 null。
 */
export function ensureAdminUser(store: UserStore): CreatedUser | null {
  if (store.countAdmins() > 0) return null;
  return store.create('admin', 'admin');
}

// ---------- workspace 供给（经 Driver 落到执行机） ----------

/**
 * 写 workspace 的最小接口——与 ExecutorDriver.writeFile 结构兼容
 * （core 不 import executor，依赖方向铁律；调用方直接传 SshDriver/LocalDriver）。
 */
export interface WorkspaceWriter {
  writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void>;
}

/** 用户 workspace 目录：<workspace_root>/u<id>（id 不可复用 → 改名/删号安全） */
export function userWorkspaceDir(workspaceRoot: string, user: Pick<User, 'id'>): string {
  return `${workspaceRoot.replace(/\/+$/, '')}/u${user.id}`;
}

/**
 * 在执行机上建用户 workspace：写一个 .mando/keep 占位文件，
 * Driver.writeFile 会自动创建父目录（driver.ts 契约）。返回 workspace 绝对路径。
 */
export async function provisionUserWorkspace(
  driver: WorkspaceWriter,
  workspaceRoot: string,
  user: Pick<User, 'id' | 'username'>,
): Promise<string> {
  const dir = userWorkspaceDir(workspaceRoot, user);
  await driver.writeFile(
    `${dir}/.mando/keep`,
    `workspace of ${user.username} (user ${user.id})\n`,
    0o600,
  );
  return dir;
}
