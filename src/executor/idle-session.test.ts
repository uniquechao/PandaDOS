import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { idleSessionProbeArgs, parseIdleSession, idleProcessTree, idleSessionStopArgs } from './idle-session';

const snapshot=()=>({...parseIdleSession('chat-test','$2:%3:123:1000:900:0:1:1:0:codex\n')!,processesIdle:true});
describe('idle session executor contract',()=>{
  test('snapshot parser and exact targets reject missing/ambiguous data',()=>{
    expect(snapshot()).toMatchObject({sessionId:'$2',paneId:'%3',panePid:123,activityTs:1000,attached:false});
    expect(parseIdleSession('chat-test','bad')).toBeNull();
    expect(()=>idleSessionProbeArgs('cc-1-console')).toThrow();
    expect(idleSessionProbeArgs('chat-test')).toContain('=chat-test:');
    expect(()=>idleSessionStopArgs({...snapshot(),sessionId:'$2; kill-server'})).toThrow();
    for(const delta of [{attached:true},{windows:2},{panes:2},{inMode:true},{processesIdle:false},{command:'bash'}]) {
      expect(()=>idleSessionStopArgs({...snapshot(),...delta})).toThrow();
    }
  });
  test('active tool descendants or an unreadable process tree veto hibernation',()=>{
    const ps='123 1 bash\n124 123 codex\n125 124 codex-code-mode\n';
    expect(idleProcessTree(snapshot(),ps)).toBe(true);
    expect(idleProcessTree(snapshot(),ps+'126 125 python3\n')).toBe(false);
    expect(idleProcessTree(snapshot(),'1 0 systemd\n')).toBe(false);
    expect(idleProcessTree(snapshot(),ps+'truncated')).toBe(false);
  });
});

const hasTmux=!!Bun.which('tmux');
test.skipIf(!hasTmux)('isolated real tmux: stale snapshots preserve replacement and multi-window containers',async()=>{
  mkdirSync('.private',{recursive:true});
  const dir=mkdtempSync(join(process.cwd(),'.private/idle-tmux-test-'));
  const socket='panda-idle-'+randomUUID();
  const command=(...args:string[])=>spawnSync('tmux',['-L',socket,...args],{encoding:'utf8'});
  const must=(...args:string[])=>{const r=command(...args);if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
  const probe=async()=>{
    for(let i=0;i<40;i++){
      const s=parseIdleSession('chat-test',must(...idleSessionProbeArgs('chat-test')));
      if(s?.command==='codex')return {...s,processesIdle:true};
      await Bun.sleep(25);
    }
    throw new Error('test process not ready');
  };
  try {
    copyFileSync('/bin/sleep',join(dir,'codex'));
    must('new-session','-d','-s','keep','sleep 60');
    const create=()=>must('new-session','-d','-s','chat-test',join(dir,'codex')+' 60');
    create();const old=await probe();
    must('new-window','-d','-t',old.sessionId,'sleep 60');
    expect(must(...idleSessionStopArgs(old))).toBe('');
    expect(must('list-sessions','-F','#{session_name}')).toContain('chat-test');
    must('kill-session','-t',old.sessionId);create();const current=await probe();
    expect(current.panePid).not.toBe(old.panePid);
    expect(command(...idleSessionStopArgs(old)).stdout).not.toContain('panda-idle-slept');
    expect(must(...idleSessionStopArgs(current))).toContain('panda-idle-slept');
    expect(must('list-sessions','-F','#{session_name}').trim()).toBe('keep');
  } finally { command('kill-server');rmSync(dir,{recursive:true,force:true}); }
});
