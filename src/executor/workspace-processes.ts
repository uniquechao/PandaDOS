/** Fixed executor-side program: stop only processes carrying this attempt's marker.
 * Detached descendants inherit the marker; inability to inspect our own processes fails closed.
 * Worktrees are not a security sandbox against processes deliberately dropping the marker.
 */
export const STOP_WORKSPACE_PROCESSES = String.raw`
import os,sys,time,signal
marker=b'PANDA_WORKSPACE_ATTEMPT='+sys.argv[1].encode()
cutoff=float(sys.argv[2])/1000-2
with open('/proc/stat') as f: boot=int(next(line.split()[1] for line in f if line.startswith('btime ')))
hz=os.sysconf('SC_CLK_TCK')
if len(sys.argv[1])!=36: raise RuntimeError('invalid attempt')
def process_stat(root):
 with open(root+'/stat') as f: return f.read().rsplit(')',1)[1].split()
def exited_after_denial(root):
 # environ can become unreadable before the exiting task reaches zombie state.
 # Wait briefly for proof of exit, never treat the permission error itself as proof.
 for _ in range(100):
  try:
   if process_stat(root)[0]=='Z': return True
  except (FileNotFoundError,ProcessLookupError): return True
  time.sleep(.01)
 return False
def matching():
 result=[]
 for name in os.listdir('/proc'):
  if not name.isdigit() or int(name)==os.getpid(): continue
  root='/proc/'+name
  try:
   if os.stat(root).st_uid!=os.getuid(): continue
   stat=process_stat(root)
   if stat[0]=='Z' or boot+int(stat[19])/hz<cutoff: continue
   with open(root+'/environ','rb') as f: env=f.read().split(b'\0')
   if marker not in env: continue
   if stat[0]!='Z': result.append((int(name),stat[19]))
  except (FileNotFoundError,ProcessLookupError): pass
  except PermissionError:
   # A process may exit after stat was read: Linux can deny environ before /proc disappears.
   # Only a fresh zombie/disappearance check proves it cannot write; live unknowns still fail closed.
   if exited_after_denial(root): continue
   raise
 return result
for sig in (signal.SIGTERM,signal.SIGKILL):
 for pid,start in matching():
  try:
   with open('/proc/'+str(pid)+'/stat') as f: current=f.read().rsplit(')',1)[1].split()[19]
   if current==start: os.kill(pid,sig)
  except (FileNotFoundError,ProcessLookupError): pass
 for _ in range(20):
  if not matching(): break
  time.sleep(.05)
if matching(): raise RuntimeError('workspace processes still running')
print('stopped')
`;

export function workspaceEnvArgs(env:Record<string,string> = {}):string[] {
 return Object.entries(env).map(([key,value])=>{
   if(!/^[A-Z_][A-Z0-9_]*$/.test(key)||value.includes('\0')) throw new Error('invalid workspace environment');
   return `${key}=${value}`;
 });
}
