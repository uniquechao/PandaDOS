import type { Database } from 'bun:sqlite';
import type { AgentKind, Conversation } from './types';
import type { AgentModelCatalog, AgentModelSelection, AgentModelState, AgentModelApplyRequest, AgentModelApplyResult } from '../../shared/agent-models';
import { validModelToken } from '../../shared/agent-models';
import { paneHasAgentInput, isAgentCommand } from './agent-liveness';
import { detectSelection } from './screen';

export interface ModelControlDriver {
  discoverAgentModels?(agent: AgentKind, cwd: string, env?: Record<string,string>): Promise<AgentModelCatalog>;
  applyAgentModel?(request: AgentModelApplyRequest): Promise<AgentModelApplyResult>;
  listSessions(): Promise<Array<{ name: string; command?: string }>>;
  capturePane(session: string): Promise<string>;
  capturePaneFresh?(session: string): Promise<string>;
}
export interface ModelTarget {
  kind: 'issue' | 'conversation'; id: string; projectId: number; agent: AgentKind; conversation: Conversation | null;
}
export interface ModelContext { driver: ModelControlDriver; cwd: string; session: string | null; env?: Record<string,string>; owned(): boolean }
interface SettingsRow {
  target_kind: ModelTarget['kind']; target_id: string; project_id: number; agent: AgentKind;
  model: string; effort: string | null; revision: number; state: Exclude<AgentModelState['state'],'unset'>;
  actual_model: string | null; actual_effort: string | null; error: string | null;
}

/** 原生控制入口不会提交或覆盖 composer；运行提示和菜单仍必须阻止切换。 */
export function modelControlReady(agent: AgentKind, pane: string): boolean {
  return paneHasAgentInput(agent,pane) && !detectSelection(pane)
    && !/esc to (?:interrupt|cancel)|ctrl.?c to interrupt/iu.test(pane.split('\n').slice(-12).join('\n'));
}
export function selectedModelForConversation(db: Database, c: Conversation): AgentModelSelection | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='agent_model_settings'").get()) return null;
  const row = db.query<{ model: string; effort: string | null },[string,string,string]>(`
    SELECT s.model,s.effort FROM agent_model_settings s
    WHERE s.agent=? AND ((s.target_kind='conversation' AND s.target_id=?) OR
      (s.target_kind='issue' AND s.target_id IN (SELECT id FROM issues WHERE conv_id=? AND status NOT IN ('done','cancelled'))))
    ORDER BY CASE s.target_kind WHEN 'issue' THEN 0 ELSE 1 END LIMIT 1`).get(c.agent,c.id,c.id);
  return row ?? null;
}
export function markModelLaunchPending(db: Database, c: Conversation): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='agent_model_settings'").get()) return;
  db.query(`UPDATE agent_model_settings SET state='pending',actual_model=NULL,actual_effort=NULL,error=NULL
    WHERE agent=? AND ((target_kind='conversation' AND target_id=?) OR (target_kind='issue' AND target_id IN
    (SELECT id FROM issues WHERE conv_id=? AND status NOT IN ('done','cancelled'))))`).run(c.agent,c.id,c.id);
}

export class AgentModelSettings {
  private closing = false;
  private drain: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();
  constructor(private readonly db: Database,
    private readonly context: (target: ModelTarget) => Promise<ModelContext>,
    private readonly convOf: (id: string) => Conversation | undefined,
    private readonly lock: <T>(key: string, action: () => Promise<T>) => Promise<T>,
  ) {
    // 控制投递中宕机：不能假定成功或自动盲目重发。
    db.query("UPDATE agent_model_settings SET state='failed',error='model_apply_unconfirmed' WHERE state='applying'").run();
  }
  target(kind: ModelTarget['kind'], id: string, projectId: number): ModelTarget {
    if (kind === 'conversation') {
      const c = this.convOf(id);
      if (!c || c.projectId !== projectId || c.kind !== 'chat' || c.archived || c.sharedReadOnly) throw new Error('model_target_unavailable');
      return { kind,id,projectId,agent:c.agent,conversation:c };
    }
    const i = this.db.query<{ agent: AgentKind; conv_id: string | null; project_id: number; status: string },[string]>('SELECT agent,conv_id,project_id,status FROM issues WHERE id=?').get(id);
    if (!i || i.project_id !== projectId) throw new Error('model_target_unavailable');
    return { kind,id,projectId,agent:i.agent,conversation:!['done','cancelled'].includes(i.status) && i.conv_id ? this.convOf(i.conv_id) ?? null : null };
  }
  state(target: ModelTarget): AgentModelState {
    const r = this.row(target);
    return r ? { selection: { model:r.model,effort:r.effort },revision:r.revision,state:r.state,
      actual:r.actual_model ? { model:r.actual_model,effort:r.actual_effort } : null,error:r.error } :
      { selection:null,revision:0,state:'unset',actual:null,error:null };
  }
  private row(t: ModelTarget): SettingsRow | null {
    return this.db.query<SettingsRow,[string,string]>('SELECT * FROM agent_model_settings WHERE target_kind=? AND target_id=?').get(t.kind,t.id);
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('model_service_stopped'));
    const promise = work(); this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => {});
    return promise;
  }
  catalog(t: ModelTarget): Promise<AgentModelCatalog> {
    return this.track(async () => {
      const ctx = await this.context(t);
      if (!ctx.driver.discoverAgentModels) throw new Error('model_discovery_unsupported');
      return ctx.driver.discoverAgentModels(t.agent,ctx.cwd,ctx.env);
    });
  }
  save(t: ModelTarget, selection: AgentModelSelection, revision: number): Promise<AgentModelState> {
    return this.track(async () => {
      if (t.kind === 'issue' && ['done','cancelled'].includes(this.db.query<{status:string},[string]>('SELECT status FROM issues WHERE id=?').get(t.id)?.status ?? '')) throw new Error('model_target_unavailable');
      if (!validModelToken(selection.model) || selection.effort !== null && !validModelToken(selection.effort)) throw new Error('model_selection_invalid');
      const catalog = await this.catalog(t);
      const option = catalog.models.find(m => m.id === selection.model);
      if (!option || selection.effort !== null && !option.efforts.includes(selection.effort)) throw new Error('model_selection_invalid');
      return this.lock(`agent-model:${t.kind}:${t.id}`, async () => {
        const fresh = this.target(t.kind,t.id,t.projectId);
        if (fresh.agent !== catalog.agent) throw new Error('model_target_changed');
        if (this.state(fresh).revision !== revision) throw new Error('model_settings_conflict');
        this.db.query(`INSERT INTO agent_model_settings(target_kind,target_id,project_id,agent,model,effort,revision,state,updated_ts)
          VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT(target_kind,target_id) DO UPDATE SET
          agent=excluded.agent,model=excluded.model,effort=excluded.effort,revision=excluded.revision,state='pending',error=NULL,updated_ts=excluded.updated_ts`)
          .run(t.kind,t.id,t.projectId,t.agent,selection.model,selection.effort,revision+1,Date.now());
        await this.apply(fresh);
        return this.state(fresh);
      });
    });
  }
  private async apply(t: ModelTarget): Promise<void> {
    const row = this.row(t);
    if (!row || row.state !== 'pending') return;
    const c = t.conversation;
    if (!c) return;
    const ctx = await this.context(t);
    if (!ctx.session) return;
    await this.lock(`tmux:${ctx.session}`, async () => {
      const current = this.target(t.kind,t.id,t.projectId);
      if (current.agent !== row.agent || current.conversation?.id !== c.id || !ctx.owned()) throw new Error('model_target_changed');
      if (this.row(t)?.revision !== row.revision) return;
      const live = (await ctx.driver.listSessions()).find(s => s.name === ctx.session);
      if (!live || !isAgentCommand(live.command)) return;
      const capture = () => ctx.driver.capturePaneFresh?.(ctx.session!) ?? ctx.driver.capturePane(ctx.session!);
      const pane = await capture();
      if (!modelControlReady(t.agent,pane)) return;
      this.db.query("UPDATE agent_model_settings SET state='applying' WHERE target_kind=? AND target_id=? AND revision=? AND state='pending'").run(t.kind,t.id,row.revision);
      try {
        if (!ctx.driver.applyAgentModel || !ctx.driver.discoverAgentModels) throw new Error('model_switch_unsupported');
        const catalog = await ctx.driver.discoverAgentModels(t.agent,ctx.cwd,ctx.env);
        const option = catalog.models.find(m => m.id === row.model);
        if (!option || row.effort !== null && !option.efforts.includes(row.effort)) throw new Error('model_selection_invalid');
        if (!ctx.owned()) throw new Error('model_target_changed');
        if (this.row(t)?.revision !== row.revision) return;
        const fresh = this.target(t.kind,t.id,t.projectId);
        if (fresh.conversation?.id !== c.id || fresh.agent !== row.agent) throw new Error('model_target_changed');
        const result = await ctx.driver.applyAgentModel({ agent:t.agent,cwd:ctx.cwd,session:ctx.session!,
          nativeSessionId:this.db.query<{agent_session_id:string|null},[string]>('SELECT agent_session_id FROM conversations WHERE id=?').get(c.id)?.agent_session_id ?? null,
          model:row.model,effort:row.effort,modelName:option.name,resolvedModel:option.resolvedModel,env:ctx.env });
        this.db.query(`UPDATE agent_model_settings SET state=?,actual_model=?,actual_effort=?,error=? WHERE target_kind=? AND target_id=? AND revision=?`)
          .run(result.state,result.state==='applied'?result.model:row.actual_model,result.state==='applied'?result.effort:row.actual_effort,
            result.state==='failed'?result.error:null,t.kind,t.id,row.revision);
      } catch (error) {
        this.db.query("UPDATE agent_model_settings SET state='failed',error=? WHERE target_kind=? AND target_id=? AND revision=?")
          .run(error instanceof Error ? error.message : 'model_apply_failed',t.kind,t.id,row.revision);
      }
    });
  }
  tick(): Promise<void> {
    if (this.drain || this.closing) return this.drain ?? Promise.resolve();
    this.drain = this.track(async () => {
      const rows=this.db.query<SettingsRow,[]>('SELECT * FROM agent_model_settings WHERE state=\'pending\' ORDER BY updated_ts LIMIT 8').all();
      for (const r of rows) {
        try { await this.apply(this.target(r.target_kind,r.target_id,r.project_id)); }
        catch { /* 归属、启动或执行机暂不可用：保留待生效，不盲投。 */ }
        finally { this.db.query("UPDATE agent_model_settings SET updated_ts=? WHERE target_kind=? AND target_id=? AND state='pending'").run(Date.now(),r.target_kind,r.target_id); }
      }
    }).finally(() => { this.drain=null; });
    return this.drain;
  }
  async stop(): Promise<void> { this.closing=true; await Promise.allSettled([...this.inFlight]); }
}
