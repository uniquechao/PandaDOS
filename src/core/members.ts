/**
 * core/members —— 项目↔用户 多对多成员关联（011_project_members）。
 *
 * 项目仍有单一属主 projects.owner_user_id（不进本表）；本表只登记「额外协作成员」。
 * 访问口径由 middleware 'project-access' 用（属主 ∨ 本表成员 ∨ admin）：
 * 成员可对 issue 做全部操作，项目级管理（改设置/增删成员/归档删除/转属主）仍限属主与 admin。
 * 本 store 不做权限判断——增删成员的鉴权由路由层（'project-owner'）把关。
 */
import type { Database } from 'bun:sqlite';

export interface ProjectMember {
  projectId: number;
  userId: number;
  username: string;
  createdTs: number;
  /** 用户最近登录/最后使用（012），成员页展示活跃度；NULL = 从未 */
  lastLoginTs: number | null;
  lastSeenTs: number | null;
}

interface MemberRow {
  project_id: number;
  user_id: number;
  username: string;
  created_ts: number;
  last_login_ts: number | null;
  last_seen_ts: number | null;
}

export class ProjectMemberStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 列出项目成员（JOIN users 带用户名与活跃时间），按加入时间升序；不含属主。 */
  list(projectId: number): ProjectMember[] {
    return this.db
      .query<MemberRow, [number]>(
        `SELECT pm.project_id, pm.user_id, u.username, pm.created_ts,
                u.last_login_ts, u.last_seen_ts
           FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = ?
          ORDER BY pm.created_ts, pm.user_id`,
      )
      .all(projectId)
      .map((r) => ({
        projectId: r.project_id,
        userId: r.user_id,
        username: r.username,
        createdTs: r.created_ts,
        lastLoginTs: r.last_login_ts,
        lastSeenTs: r.last_seen_ts,
      }));
  }

  /** 该用户是否是该项目成员（不含属主/admin——那两者由调用方另判）。 */
  isMember(projectId: number, userId: number): boolean {
    const r = this.db
      .query<{ one: number }, [number, number]>(
        'SELECT 1 AS one FROM project_members WHERE project_id = ? AND user_id = ?',
      )
      .get(projectId, userId);
    return r != null;
  }

  /** 该用户作为成员参与的项目 id 列表（供项目列表「owner ∨ 成员」并集用）。 */
  projectIdsForUser(userId: number): number[] {
    return this.db
      .query<{ project_id: number }, [number]>(
        'SELECT project_id FROM project_members WHERE user_id = ? ORDER BY project_id',
      )
      .all(userId)
      .map((r) => r.project_id);
  }

  /**
   * 加成员（幂等）：已是成员保留原 created_ts 不覆盖，返回 false（未新增）；新增返回 true。
   * 不校验 user/project 存在——外键约束会挡住无效引用（调用方宜先查用户存在给 400 更友好）。
   */
  add(projectId: number, userId: number): boolean {
    return (
      this.db
        .query(
          `INSERT INTO project_members (project_id, user_id, created_ts) VALUES (?, ?, ?)
           ON CONFLICT(project_id, user_id) DO NOTHING`,
        )
        .run(projectId, userId, this.now()).changes > 0
    );
  }

  /** 移除成员（幂等）；返回是否确有删除。 */
  remove(projectId: number, userId: number): boolean {
    return (
      this.db
        .query('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
        .run(projectId, userId).changes > 0
    );
  }
}
