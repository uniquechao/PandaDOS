import type { Database } from 'bun:sqlite';
import { chatTmux } from '../core/conversations';
import { readRange } from '../core/jsonl';
import type { AgentKind, Project } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { getProject } from '../issues/engine';
import { KeyedMutex, tmuxLockKey } from '../issues/mutex';

export const CHAT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const CHAT_IDLE_SWEEP_MS = 5 * 60 * 1000;
type Driver = Pick<ExecutorDriver, 'listSessions'|'inspectIdleSession'|'sleepSessionIfIdle'|'statPath'|'readFileRange'|'listDir'|'capturePane'|'capturePaneFresh'>;
export function chatIdleTimeoutFromMinutes(raw?: string): number {
  const minutes=Number(raw);
  return Number.isFinite(minutes)&&minutes>=60&&minutes<=120 ? minutes*60_000 : CHAT_IDLE_TIMEOUT_MS;
}
interface Target {
  id: string; project_id: number; agent: AgentKind; created_ts: number;
  last_active_ts: number|null; agent_session_id: string|null;
}
interface Deps {
  db: Database;
  mutex: KeyedMutex;
  execution(project: Project): { driver: Driver; locate(id: string): Promise<string|null> };
  idleMs?: number;
  intervalMs?: number;
  now?(): number;
  onSleep?(id: string): void;
  onError?(): void;
}

/** Incomplete/unknown turns never qualify, even when an Agent has been silent for hours. */
export function idleTurnFinished(agent: AgentKind, text: string): boolean {
  if (!text.endsWith('\n')) return false;
  let done=false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry=JSON.parse(line); } catch { return false; }
    if(!entry || typeof entry!=='object' || Array.isArray(entry))return false;
    if (agent==='codex' && entry.type==='event_msg') {
      const type=entry.payload?.type;
      if (type==='task_started') done=false;
      if (type==='task_complete' || type==='task_aborted') done=true;
      if (type==='user_message') done=false;
    } else if (agent==='codex' && entry.type==='response_item'
      && (entry.payload?.role==='user' || ['function_call','custom_tool_call'].includes(entry.payload?.type))) {
      done=false;
    } else if (agent==='claude' && (entry.type==='assistant' || entry.type==='user')) {
      done=entry.type==='assistant' && entry.message?.stop_reason==='end_turn';
    }
  }
  return done;
}

export function idleInputEmpty(agent: AgentKind, text: string): boolean {
  if (/esc to (?:interrupt|cancel)|thinking…|working \(|running \(/i.test(text)) return false;
  const marker=agent==='codex'?'›':'❯';
  const lines=text.split('\n').map(line=>line.trim().replace(/^[│┃]\s*/,''));
  let index=-1;
  for(let i=0;i<lines.length;i++) if(lines[i]!.startsWith(marker)) index=i;
  if(index<0 || !['','Ask Codex to do anything','Implement {feature}'].includes(lines[index]!.slice(1).trim())) return false;
  // Multiline drafts and approval menus must survive. Only known, non-input footer lines are allowed.
  return lines.slice(index+1).every(line=>!line || /^[─━│┃╭╮╰╯┌┐└┘\s]+$/.test(line)
    || /^\? for shortcuts\b/.test(line) || /^\d+% context left\b/.test(line)
    || /^⏵⏵ bypass permissions on(?:\s|$)/.test(line));
}

/** Only runtime containers are removed. Conversation rows and native session histories stay intact. */
export class ChatIdleReaper {
  private timer: ReturnType<typeof setInterval>|null=null;
  private flight: Promise<number>|null=null;
  private stopped=false;
  private pins=new Map<string,number>();
  private released=new Map<string,number>();
  private readonly exclusions: string;
  constructor(private readonly deps: Deps) {
    const has=(table:string)=>!!deps.db.query('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table);
    this.exclusions=[
      has('issues') ? "NOT EXISTS (SELECT 1 FROM issues i WHERE i.conv_id=c.id AND i.status NOT IN ('done','cancelled'))" : '1',
      has('workspace_attempts') ? 'NOT EXISTS (SELECT 1 FROM workspace_attempts w WHERE w.conversation_id=c.id AND w.released_ts IS NULL)' : '1',
      has('design_saga_conversation_owners') ? 'NOT EXISTS (SELECT 1 FROM design_saga_conversation_owners o WHERE o.conversation_id=c.id)' : '1',
      has('design_tasks') ? 'NOT EXISTS (SELECT 1 FROM design_tasks d WHERE d.conversation_id=c.id)' : '1',
    ].join(' AND ');
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  /** Connected chat and native-terminal websockets pin their session, including PTY startup. */
  retain(session: string): ()=>void {
    this.pins.set(session,(this.pins.get(session)??0)+1);
    let closed=false;
    return ()=> {
      if(closed)return;
      closed=true;
      const count=(this.pins.get(session)??1)-1;
      if(count) this.pins.set(session,count); else this.pins.delete(session);
      this.released.set(session,this.now());
      if(!count && !this.stopped && session.startsWith('chat-')) {
        try {
          this.deps.db.query("UPDATE conversations SET last_active_ts=MAX(COALESCE(last_active_ts,created_ts),?) WHERE id=? AND kind='chat' AND archived=0")
            .run(this.now(),session.slice(5));
        } catch { this.deps.onError?.(); }
      }
    };
  }
  start(): void {
    if(this.timer || (this.deps.idleMs??CHAT_IDLE_TIMEOUT_MS)<=0)return;
    this.stopped=false;
    this.timer=setInterval(()=>void this.tick(),this.deps.intervalMs??CHAT_IDLE_SWEEP_MS);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped=true;
    if(this.timer)clearInterval(this.timer);
    this.timer=null;
    await this.flight;
  }
  tick(): Promise<number> {
    if(this.stopped || (this.deps.idleMs??CHAT_IDLE_TIMEOUT_MS)<=0)return Promise.resolve(0);
    if(this.flight)return this.flight;
    this.flight=this.sweep().catch(()=>{this.deps.onError?.();return 0;}).finally(()=>{this.flight=null;});
    return this.flight;
  }
  private targets(cutoff:number, id?:string): Target[] {
    const sql=`SELECT c.id,c.project_id,c.agent,c.created_ts,c.last_active_ts,c.agent_session_id
      FROM conversations c JOIN projects p ON p.id=c.project_id
      WHERE c.kind='chat' AND c.archived=0 AND c.shared_read_only=0 AND p.status='active'
        AND NULLIF(TRIM(c.workspace_cwd),'') IS NULL AND COALESCE(c.last_active_ts,c.created_ts)<=?
        AND ${this.exclusions}`;
    return id===undefined
      ? this.deps.db.query<Target,[number]>(sql+' ORDER BY COALESCE(c.last_active_ts,c.created_ts),c.id').all(cutoff)
      : this.deps.db.query<Target,[number,string]>(sql+' AND c.id=?').all(cutoff,id);
  }
  private async sweep(): Promise<number> {
    const cutoff=this.now()-(this.deps.idleMs??CHAT_IDLE_TIMEOUT_MS);
    for(const [session,ts] of this.released) if(ts<=cutoff)this.released.delete(session);
    const sessions=new Map<Driver,Promise<Set<string>>>();
    let closed=0;
    for(const target of this.targets(cutoff)) {
      if(this.stopped)break;
      const name=chatTmux(target.id);
      if(this.pins.has(name) || (this.released.get(name)??0)>cutoff || (target.agent==='codex'&&!target.agent_session_id))continue;
      try {
        const project=getProject(this.deps.db,target.project_id);
        if(!project)continue;
        const execution=this.deps.execution(project), driver=execution.driver;
        if(!driver.inspectIdleSession || !driver.sleepSessionIfIdle)continue;
        if(!sessions.has(driver))sessions.set(driver,driver.listSessions().then(rows=>new Set(rows.map(r=>r.name))));
        if(!(await sessions.get(driver)!).has(name))continue;
        if(this.deps.mutex.isLocked(tmuxLockKey(name)))continue;
        const slept=await this.deps.mutex.runExclusive(tmuxLockKey(name),async()=> {
          if(this.stopped || this.pins.has(name) || !this.targets(cutoff,target.id).some(t=>JSON.stringify(t)===JSON.stringify(target)))return false;
          const snapshot=await driver.inspectIdleSession!(name);
          if(this.stopped || !snapshot || snapshot.name!==name || snapshot.attached || snapshot.windows!==1 || snapshot.panes!==1 || snapshot.inMode
            || snapshot.command!==target.agent || !snapshot.processesIdle || Math.max(snapshot.activityTs,snapshot.createdTs)*1000>cutoff)return false;
          const path=await execution.locate(target.id);
          if(!path)return false;
          // Claude activation always resumes c.id. A reclaimed manual session with a different
          // native ID cannot be safely hibernated through that activation contract.
          if(target.agent==='claude' && !path.endsWith(`/${target.id}.jsonl`))return false;
          const stat=await driver.statPath(path);
          if(!stat?.isFile || !Number.isFinite(stat.mtimeMs) || stat.mtimeMs>cutoff)return false;
          const offset=Math.max(0,stat.size-1024*1024);
          let text=new TextDecoder().decode(await readRange(driver,path,offset,stat.size-offset));
          if(offset>0) { const newline=text.indexOf('\n'); if(newline<0)return false; text=text.slice(newline+1); }
          if(!idleTurnFinished(target.agent,text) || !idleInputEmpty(target.agent,
            await (driver.capturePaneFresh?.(name) ?? driver.capturePane(name))))return false;
          const latest=await driver.inspectIdleSession!(name);
          const history=await driver.statPath(path);
          if(!latest || JSON.stringify(latest)!==JSON.stringify(snapshot) || !history || history.size!==stat.size || history.mtimeMs!==stat.mtimeMs)return false;
          if(this.stopped || this.pins.has(name) || (this.released.get(name)??0)>cutoff
            || !this.targets(cutoff,target.id).some(t=>JSON.stringify(t)===JSON.stringify(target)))return false;
          return driver.sleepSessionIfIdle!(snapshot);
        });
        if(slept) { closed++; this.deps.onSleep?.(target.id); }
      } catch { this.deps.onError?.(); } // An offline executor must not prevent other executors from being inspected.
    }
    return closed;
  }
}
