import type { Database } from 'bun:sqlite';
import type { LocalPlan } from '../../shared/local-plan-format.mjs';
import type { LocalPlanEffect, LocalPlanExecution } from '../../shared/local-plans';
import type { IssueId } from '../../shared/issue-id';

interface PublicationRow {
  plan_id: string; digest: string; title: string; source_path: string;
  snapshot_json: string; created_ts: number;
}

/** Durable publication identities and effect receipts only; filesystem and scheduling live outside core. */
export class LocalPlanStore {
  constructor(private readonly db: Database) {}

  get(projectId: number, planId: string): LocalPlanExecution | null {
    const row = this.db.query<PublicationRow, [number, string]>(
      'SELECT * FROM local_issue_plan_publications WHERE project_id=? AND plan_id=?',
    ).get(projectId, planId);
    if (!row) return null;
    const issues = this.db.query<{ node_key: string; id: IssueId; title: string; status: string }, [number, string]>(
      `SELECT p.node_key,i.id,i.title,i.status FROM local_issue_plan_items p
       JOIN issues i ON i.id=p.issue_id AND i.project_id=p.project_id
       WHERE p.project_id=? AND p.plan_id=? ORDER BY i.created_ts,i.id`,
    ).all(projectId, planId).map(item => ({
      key: item.node_key, issueId: item.id, title: item.title, status: item.status,
      blockers: this.db.query<{ issueId: IssueId; status: string }, [IssueId]>(
        `SELECT i.id AS issueId,i.status FROM issue_dependencies d
         JOIN issues i ON i.id=d.depends_on_issue_id WHERE d.issue_id=? AND i.status<>'done'`,
      ).all(item.id),
    }));
    const pending = this.db.query<{ last_error: string | null }, [number, string]>(
      'SELECT last_error FROM local_issue_plan_effects WHERE project_id=? AND plan_id=? AND completed_ts IS NULL',
    ).all(projectId, planId);
    return {
      planId: row.plan_id, digest: row.digest, title: row.title, path: row.source_path,
      plan: JSON.parse(row.snapshot_json) as LocalPlan, createdTs: row.created_ts,
      effectsPending: pending.length > 0, lastError: pending.find(item => item.last_error)?.last_error ?? null, issues,
    };
  }

  list(projectId: number): LocalPlanExecution[] {
    return this.db.query<{ plan_id: string }, [number]>(
      'SELECT plan_id FROM local_issue_plan_publications WHERE project_id=? ORDER BY created_ts DESC',
    ).all(projectId).map(row => this.get(projectId, row.plan_id)!);
  }

  /** Called inside the issue batch transaction, including all linkage and scheduling intents. */
  record(input: {
    projectId: number; plan: LocalPlan; digest: string; path: string; actorId: number;
    items: ReadonlyArray<{ key: string; issueId: IssueId }>;
    effects: readonly LocalPlanEffect[];
  }): void {
    this.db.query(`INSERT INTO local_issue_plan_publications
      (project_id,plan_id,digest,title,source_path,snapshot_json,created_by,created_ts)
      VALUES(?,?,?,?,?,?,?,?)`).run(input.projectId, input.plan.planId, input.digest,
      input.plan.title, input.path, JSON.stringify(input.plan), input.actorId, Date.now());
    for (const item of input.items) this.db.query(
      'INSERT INTO local_issue_plan_items(project_id,plan_id,node_key,issue_id) VALUES(?,?,?,?)',
    ).run(input.projectId, input.plan.planId, item.key, item.issueId);
    for (const effect of input.effects) this.db.query(`INSERT INTO local_issue_plan_effects
      (project_id,plan_id,effect_key,operation_json) VALUES(?,?,?,?)`,
    ).run(input.projectId, input.plan.planId, effect.key, JSON.stringify(effect));
  }

  operations(projectId: number, planId: string): LocalPlanEffect[] {
    return this.db.query<{ operation_json: string }, [number, string]>(
      'SELECT operation_json FROM local_issue_plan_effects WHERE project_id=? AND plan_id=? ORDER BY rowid',
    ).all(projectId, planId).map(row => JSON.parse(row.operation_json) as LocalPlanEffect);
  }

  isComplete(projectId: number, planId: string, key: string): boolean {
    return this.db.query<{ completed_ts: number | null }, [number, string, string]>(
      'SELECT completed_ts FROM local_issue_plan_effects WHERE project_id=? AND plan_id=? AND effect_key=?',
    ).get(projectId, planId, key)?.completed_ts != null;
  }

  finish(projectId: number, planId: string, key: string, error?: string): void {
    this.db.query(`UPDATE local_issue_plan_effects SET completed_ts=?,last_error=?
      WHERE project_id=? AND plan_id=? AND effect_key=? AND completed_ts IS NULL`,
    ).run(error === undefined ? Date.now() : null, error?.slice(0, 4000) ?? null, projectId, planId, key);
  }

  pending(): Array<{ projectId: number; planId: string }> {
    return this.db.query<{ projectId: number; planId: string }, []>(
      `SELECT DISTINCT e.project_id AS projectId,e.plan_id AS planId FROM local_issue_plan_effects e
       JOIN projects p ON p.id=e.project_id WHERE e.completed_ts IS NULL AND p.status='active'`,
    ).all();
  }

  pendingProjects(): number[] {
    return this.db.query<{ project_id: number }, []>(
      `SELECT DISTINCT p.project_id FROM local_issue_plan_items p
       JOIN issues i ON i.id=p.issue_id JOIN projects project ON project.id=p.project_id
       WHERE i.status='pending' AND project.status='active'`,
    ).all().map(row => row.project_id);
  }
}
