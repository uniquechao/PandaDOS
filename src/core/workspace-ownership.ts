import type { Database } from 'bun:sqlite';

/** UI focus is not execution authority. Legacy databases remain supported. */
export function managedConversationOwned(db: Database, projectId: number, conversationId: string): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_attempts'").get()) return false;
  return Boolean(db.query(`SELECT 1 FROM workspace_attempts a
    JOIN module_workspaces w ON w.id=a.workspace_id AND w.current_attempt=a.id
    JOIN issues i ON i.id=a.issue_id AND i.conv_id=a.conversation_id
    WHERE w.project_id=? AND a.conversation_id=? AND a.released_ts IS NULL
      AND a.stop_confirmed=0 AND i.status NOT IN ('done','cancelled')`).get(projectId, conversationId)) || workflowConversationOwned(db,projectId,conversationId);
}

function workflowConversationOwned(db:Database,projectId:number,id:string):boolean {
 return Boolean(db.query(`SELECT 1 FROM issue_workflow_node_runs n JOIN issue_workflows f ON f.id=n.issue_workflow_id
 JOIN issues i ON i.id=f.issue_id LEFT JOIN issue_workflow_worktrees t ON t.node_run_id=n.id
 LEFT JOIN workspace_runtime_resources r ON r.node_run_id=CASE WHEN t.resolution_conversation_id=? THEN -n.id ELSE n.id END
 JOIN workspace_attempts a ON a.issue_id=i.id AND a.released_ts IS NULL
 JOIN module_workspaces w ON w.current_attempt=a.id
 WHERE i.project_id=? AND (n.conversation_id=? OR t.resolution_conversation_id=?)
 AND (r.attempt_id IS NULL OR r.attempt_id=a.id) AND a.stop_confirmed=0 AND a.result_sha IS NULL
 AND i.status NOT IN ('done','cancelled')
 AND (n.conversation_id=? AND n.status IN ('queued','running','routing','blocked') OR t.resolution_conversation_id=? AND t.status IN ('resolving','paused'))`).get(id,projectId,id,id,id,id));
}

export function managedExecutionConversationKnown(db:Database,id:string):boolean {
 if(!db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_attempts'").get())return false;
 return managedConversationKnown(db,id) || Boolean(db.query(`SELECT 1 FROM issue_workflow_node_runs n
 JOIN issue_workflows f ON f.id=n.issue_workflow_id JOIN issues i ON i.id=f.issue_id
 LEFT JOIN issue_workflow_worktrees t ON t.node_run_id=n.id
 WHERE i.workspace_mode='module' AND (n.conversation_id=? OR t.resolution_conversation_id=?)`).get(id,id));
}

export function managedConversationEnvironment(db: Database, conversationId: string): Record<string,string> | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_attempts'").get()) return null;
  const row = db.query<{cwd:string;id:string;port:number},[string]>(`SELECT COALESCE(a.execution_cwd,w.cwd) cwd,a.id,r.port
    FROM workspace_attempts a JOIN module_workspaces w ON w.id=a.workspace_id AND w.current_attempt=a.id
    JOIN workspace_runtime_resources r ON r.attempt_id=a.id
    WHERE a.conversation_id=? AND a.released_ts IS NULL AND r.node_run_id=0`).get(conversationId);
  if(row)return workspaceEnvironment(row.cwd,row.id,row.port);
  const node=db.query<{id:number;attempt:string;executor:number;cwd:string;stop_confirmed:number;result_sha:string|null;status:string;released_ts:number|null},[string,string,string,string,string]>(`SELECT
    CASE WHEN t.resolution_conversation_id=? THEN -n.id ELSE n.id END id,
    a.id attempt,w.executor_id executor,a.stop_confirmed,a.result_sha,a.released_ts,i.status,
    CASE WHEN t.resolution_conversation_id=? THEN COALESCE(a.execution_cwd,w.cwd) ELSE COALESCE(t.path,a.execution_cwd,w.cwd) END cwd
    FROM issue_workflow_node_runs n JOIN issue_workflows f ON f.id=n.issue_workflow_id
    JOIN issues i ON i.id=f.issue_id
    LEFT JOIN issue_workflow_worktrees t ON t.node_run_id=n.id
    LEFT JOIN workspace_runtime_resources binding ON binding.node_run_id=CASE WHEN t.resolution_conversation_id=? THEN -n.id ELSE n.id END
    JOIN workspace_attempts a ON (binding.attempt_id=a.id OR binding.attempt_id IS NULL AND a.issue_id=f.issue_id AND a.released_ts IS NULL)
    JOIN module_workspaces w ON w.id=a.workspace_id WHERE n.conversation_id=? OR t.resolution_conversation_id=?`).get(conversationId,conversationId,conversationId,conversationId,conversationId);
  if(!node) {if(managedExecutionConversationKnown(db,conversationId))throw new Error('工作流父轮次已释放，禁止启动节点');return null;}
  if(node.released_ts!==null || node.stop_confirmed || node.result_sha || ['done','cancelled'].includes(node.status))throw new Error('工作流父轮次已停止，禁止启动节点');
  let resource=db.query<{port:number},[string,number]>('SELECT port FROM workspace_runtime_resources WHERE attempt_id=? AND node_run_id=?').get(node.attempt,node.id);
  if(!resource) db.transaction(()=>{
    for(let port=18000;port<60000;port++) {
      if(db.query('INSERT OR IGNORE INTO workspace_runtime_resources(attempt_id,node_run_id,executor_id,port) VALUES(?,?,?,?)').run(node.attempt,node.id,node.executor,port).changes)break;
    }
  })();
  resource=db.query<{port:number},[string,number]>('SELECT port FROM workspace_runtime_resources WHERE attempt_id=? AND node_run_id=?').get(node.attempt,node.id);
  if(!resource)throw new Error('工作流节点运行资源分配失败');
  return workspaceEnvironment(node.cwd, node.attempt, resource.port, `node-${node.id}`);
}

export function workspaceEnvironment(cwd: string, attempt: string, port: number, child?:string): Record<string,string> {
  const runtime = `${cwd}/.panda/tmp/runtime/${attempt}${child?'/'+child:''}`;
  return { PANDA_WORKSPACE_CWD:cwd, PANDA_WORKSPACE_ATTEMPT:attempt,
    PANDA_DATA_DIR:`${runtime}/data`, PANDA_DB:`${runtime}/data/panda.db`, PANDA_DB_PATH:`${runtime}/data/panda.db`,
    PANDA_PORT:String(port), PORT:String(port), PANDA_BIND:"127.0.0.1",
    PANDA_ADMIN_TOKEN_FILE:`${runtime}/data/admin-token`, TMUX_TMPDIR:`${runtime}/tmux`, TMPDIR:`${runtime}/tmp`,
    XDG_CACHE_HOME:`${runtime}/cache`, BUN_INSTALL_CACHE_DIR:`${runtime}/cache/bun`,
    PANDA_BUILD_DIR:`${runtime}/build` };
}

export function issueWorkspaceCwd(db:Database, projectId:number, issueId:string):string|null {
 if (!db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_attempts'").get()) return null;
 return db.query<{cwd:string},[number,string]>(`SELECT COALESCE(a.execution_cwd,w.cwd) cwd FROM workspace_attempts a JOIN module_workspaces w ON w.id=a.workspace_id
 WHERE w.project_id=? AND a.issue_id=? ORDER BY a.created_ts DESC,a.rowid DESC LIMIT 1`).get(projectId,issueId)?.cwd ?? null;
}
export function managedConversationKnown(db:Database, conversationId:string):boolean {
 if (!db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_attempts'").get()) return false;
 return Boolean(db.query('SELECT 1 FROM workspace_attempts WHERE conversation_id=?').get(conversationId));
}

export interface IssueWorkspaceView {
 cwd:string|null; branch:string|null; targetBranch:string|null; attempt:string|null;
 phase:string; computeHeld:boolean; retained:boolean; baseSha:string|null;
 resultSha:string|null; integratedSha:string|null; integrationCwd:string|null;
 reason:'module-held'|'capacity'|'dependency'|'legacy'|'ready'|'retained'|'integration'; diagnostic:string|null;
}
export function issueWorkspaceView(db:Database,issueId:string):IssueWorkspaceView|null {
 if(!db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_attempts'").get())return null;
 const i=db.query<{project_id:number;module_id:number|null;workspace_mode:string;status:string},[string]>('SELECT project_id,module_id,workspace_mode,status FROM issues WHERE id=?').get(issueId);
 if(!i||i.workspace_mode!=='module')return null;
 const p=db.query<{integration_branch:string|null;work_branch:string|null;module_concurrency:number},[number]>('SELECT integration_branch,work_branch,module_concurrency FROM projects WHERE id=?').get(i.project_id)!;
 const a=db.query<{id:string;cwd:string;branch:string;phase:string;compute_held:number;released_ts:number|null;base_sha:string|null;result_sha:string|null;integrated_sha:string|null;diagnostic:string|null},[string]>(`SELECT a.*,COALESCE(a.execution_cwd,w.cwd) cwd,COALESCE(a.execution_branch,w.branch) branch FROM workspace_attempts a JOIN module_workspaces w ON w.id=a.workspace_id WHERE a.issue_id=? ORDER BY a.created_ts DESC,a.rowid DESC LIMIT 1`).get(issueId);
 const j=a?db.query<{cwd:string;diagnostic:string|null},[string]>('SELECT cwd,diagnostic FROM workspace_integrations WHERE attempt_id=? ORDER BY created_ts DESC,rowid DESC LIMIT 1').get(a.id):null;
 let reason:IssueWorkspaceView['reason']=a?.result_sha&&!a.integrated_sha?'integration':a&&a.released_ts===null&&!a.compute_held?'retained':'ready';
 if(!a && i.status==='pending') {
   if(db.query(`SELECT 1 FROM issue_dependencies d JOIN issues p ON p.id=d.depends_on_issue_id WHERE d.issue_id=? AND p.status<>'done'`).get(issueId))reason='dependency';
   else if(db.query(`SELECT 1 FROM module_workspaces WHERE project_id=? AND module_key=? AND current_attempt IS NOT NULL`).get(i.project_id,i.module_id??0))reason='module-held';
   else if(db.query(`SELECT 1 FROM issues WHERE project_id=? AND workspace_mode='legacy' AND status IN ('planning','implementing','testing','merging','paused','blocked')`).get(i.project_id))reason='legacy';
   else if(db.query<{n:number},[number]>(`SELECT COUNT(*) n FROM workspace_attempts a JOIN module_workspaces w ON w.id=a.workspace_id WHERE w.project_id=? AND a.released_ts IS NULL AND a.compute_held=1`).get(i.project_id)!.n>=p.module_concurrency)reason='capacity';
 }
 return {cwd:a?.cwd??null,branch:a?.branch??null,targetBranch:p.integration_branch??p.work_branch,attempt:a?.id??null,
 phase:a?.phase??'pending',computeHeld:a?.compute_held===1,retained:Boolean(a&&a.released_ts===null&&!a.compute_held),baseSha:a?.base_sha??null,
 resultSha:a?.result_sha??null,integratedSha:a?.integrated_sha??null,integrationCwd:j?.cwd??null,reason,diagnostic:j?.diagnostic??a?.diagnostic??null};
}
