/** Conservative, executor-local evidence used only for automatic chat hibernation. */
export interface IdleSessionState {
  name: string;
  sessionId: string;
  paneId: string;
  panePid: number;
  activityTs: number;
  createdTs: number;
  attached: boolean;
  windows: number;
  panes: number;
  inMode: boolean;
  command: string;
  processesIdle: boolean;
}

export const IDLE_SESSION_FORMAT = '#{session_id}:#{pane_id}:#{pane_pid}:#{session_activity}:#{session_created}:#{session_attached}:#{session_windows}:#{window_panes}:#{pane_in_mode}:#{pane_current_command}';

export function idleSessionProbeArgs(name: string): string[] {
  if (!/^chat-[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid chat session');
  return ['display-message', '-p', '-t', `=${name}:`, IDLE_SESSION_FORMAT];
}

export function parseIdleSession(name: string, output: string): IdleSessionState | null {
  const m = /^(\$\d+):(%\d+):(\d+):(\d+):(\d+):(\d+):(\d+):(\d+):([01]):([\w-]+)$/.exec(output.trim());
  if (!m) return null;
  return { name, sessionId:m[1]!, paneId:m[2]!, panePid:Number(m[3]), activityTs:Number(m[4]),
    createdTs:Number(m[5]), attached:Number(m[6])>0, windows:Number(m[7]), panes:Number(m[8]),
    inMode:m[9]==='1', command:m[10]!, processesIdle:false };
}

/** ps is portable across Linux/macOS. Unknown helpers and detached tool children veto cleanup. */
export function idleProcessTree(state: IdleSessionState, output: string): boolean {
  const rows = output.trim().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line));
  if (rows.some(row => !row)) return false;
  const processes = rows.map(row => ({pid:Number(row![1]), parent:Number(row![2]), command:row![3]!.split('/').at(-1)!}));
  if (!processes.some(p => p.pid===state.panePid)) return false;
  const ids=new Set([state.panePid]);
  let size=0;
  while (size!==ids.size) { size=ids.size; for (const p of processes) if(ids.has(p.parent)) ids.add(p.pid); }
  const allowed=new Set(['bash','sh','zsh',state.command,...(state.command==='codex'?['codex-code-mode']:[])]);
  return processes.filter(p=>ids.has(p.pid)).every(p=>allowed.has(p.command));
}

export function idleSessionStopArgs(s: IdleSessionState): string[] {
  if (!/^chat-[A-Za-z0-9_-]+$/.test(s.name) || !/^\$\d+$/.test(s.sessionId) || !/^%\d+$/.test(s.paneId)
    || ![s.panePid,s.activityTs,s.createdTs].every(n=>Number.isSafeInteger(n)&&n>0)
    || !['codex','claude'].includes(s.command) || !s.processesIdle || s.attached || s.windows!==1 || s.panes!==1 || s.inMode) {
    throw new Error('Unsafe idle session snapshot');
  }
  const fields: Array<[string,string|number]> = [['session_name',s.name],['pane_id',s.paneId],['pane_pid',s.panePid],
    ['session_activity',s.activityTs],['session_created',s.createdTs],['session_attached',0],
    ['session_windows',1],['window_panes',1],['pane_in_mode',0],['pane_current_command',s.command]];
  const condition=fields.map(([key,value])=>`#{==:#{${key}},${value}}`).reduce((a,b)=>`#{&&:${a},${b}}`);
  return ['if-shell','-F','-t',s.sessionId,condition,
    `kill-session -t '${s.sessionId}' ; display-message -p panda-idle-slept`,''];
}
