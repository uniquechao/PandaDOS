/**
 * core/sessions —— 登录会话存取（002_auth_sessions；飞书扫码登录用）。
 *
 * 与 users.token 的分工：users.token_hash 是长期 API token（重置才变），
 * 会话 token 是登录动作签发的一次性凭据（30 天过期，与 cookie Max-Age 对齐）。
 * 纪律与 users 一致：明文只在 create 返回值出现一次，DB 只存 sha256；
 * 查找全表扫 + 常数时间比较、不提前退出（规模个位数用户，可承受）。
 */
import type { Database } from 'bun:sqlite';
import { genToken, hashEq, hashToken } from './users';

/** 会话时长 30 天 = web/auth.ts COOKIE_MAX_AGE（秒）×1000，两边同改 */
export const SESSION_TTL_MS = 2592000_000;

export interface CreatedSession {
  /** 明文会话 token，仅此一次；调用方种 cookie 后即弃 */
  token: string;
  expiresTs: number;
}

interface SessionRow {
  user_id: number;
  token_hash: string;
  expires_ts: number;
}

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 签发会话；顺手清掉全部过期行（无独立定时器，写路径捎带） */
  create(userId: number, via = 'feishu'): CreatedSession {
    this.prune();
    const plain = genToken();
    const ts = this.now();
    const expiresTs = ts + SESSION_TTL_MS;
    this.db
      .query(
        `INSERT INTO auth_sessions (user_id, token_hash, via, created_ts, expires_ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(userId, hashToken(plain), via, ts, expiresTs);
    return { token: plain, expiresTs };
  }

  /** 按会话 token 哈希找用户 id；过期/不存在 → undefined。全表扫不提前退出。 */
  userIdByTokenHash(hash: string): number | undefined {
    if (!hash) return undefined;
    const ts = this.now();
    let found: number | undefined;
    for (const r of this.db
      .query<SessionRow, []>('SELECT user_id, token_hash, expires_ts FROM auth_sessions')
      .all()) {
      if (hashEq(r.token_hash, hash) && r.expires_ts > ts) found = r.user_id;
    }
    return found;
  }

  /** 吊销某用户全部会话（token 重置/删号等场景由调用方决定）；返回删除行数 */
  revokeForUser(userId: number): number {
    return this.db.query('DELETE FROM auth_sessions WHERE user_id = ?').run(userId).changes;
  }

  /** 清过期会话；返回删除行数 */
  prune(): number {
    return this.db
      .query('DELETE FROM auth_sessions WHERE expires_ts <= ?')
      .run(this.now()).changes;
  }
}
