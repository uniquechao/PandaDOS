import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { ExecutorDriver } from './driver';

export interface ReclamationRequest {
 action:string; jobId:string; kind:string; projectId:number; executorId:number;
 workspaceRoot:string; projectCwd:string; cwd:string; branch:string|null;
 expectedHead?:string|null; resultSha?:string|null; targetRef:string;
 attemptIds:string[]; startedTs?:number; generation:number; minFreeBytes:number; archiveMaxBytes:number;
 probePaths?:string[]; cachePaths?:string[];
 archives?:Array<{jobId:string;path:string;sha256:string;bytes:number}>;
}
export interface ReclamationResult {
 state:'ready'|'reclaimed'|'retained'|'uncertain'; reason?:string; details?:string;
 archive?:{path:string;sha256:string;bytes:number}; archivePurged?:boolean;
 availableBytes?:number; totalBytes?:number; cacheBytes?:number; archiveBytes?:number;
 sourceHead?:string; resources?:Array<{rel:string;kind:string}>;
 purged?:string[];
}
export class ReclamationUncertain extends Error {}

/** The same fixed executor program runs through LocalDriver and SshDriver. No shell input. */
export async function runWorkspaceReclamation(
 driver:Pick<ExecutorDriver,'runCommand'|'writeFileNoFollowWithin'|'removeFileNoFollowWithin'>,cwd:string,request:ReclamationRequest,
):Promise<ReclamationResult> {
 const payload=JSON.stringify(request),bytes=Buffer.byteLength(payload);
 if(bytes>8*1024*1024)throw new ReclamationUncertain('reclamation_request_too_large');
 let relative:string|null=null,digest:string|null=null;
 const argv=['python3','-c',WORKSPACE_RECLAMATION_SCRIPT];
 if(bytes>32_000) {
  if(!driver.writeFileNoFollowWithin||!driver.removeFileNoFollowWithin)throw new ReclamationUncertain('reclamation_request_storage_unavailable');
  relative=`.panda-archives/requests/${randomUUID()}.json`;digest=createHash('sha256').update(payload).digest('hex');
  if(await driver.writeFileNoFollowWithin(request.workspaceRoot,relative,payload,0o600)==='conflict')throw new ReclamationUncertain('reclamation_request_conflict');
  argv.push('@'+posix.join(request.workspaceRoot,relative),digest);
 }else argv.push(payload);
 let r;
 try {r=await driver.runCommand(cwd,argv,request.action==='reclaim'?600_000:15_000);}
 finally {if(relative&&digest)await driver.removeFileNoFollowWithin!(request.workspaceRoot,relative,digest).catch(()=>{});}
 if(r.timedOut||r.code!==0)throw new ReclamationUncertain((r.err||r.out||'reclamation_result_unknown').slice(-1800));
 try {
  const value=JSON.parse(r.out.trim()) as ReclamationResult;
  if(!['ready','reclaimed','retained','uncertain'].includes(value.state))throw new Error('invalid_state');
  return value;
 } catch {throw new ReclamationUncertain('reclamation_receipt_invalid');}
}

export const WORKSPACE_RECLAMATION_SCRIPT=String.raw`
import os,sys,json,hashlib,subprocess,stat,fcntl,tarfile,shutil,time,re
from pathlib import Path
class Retain(Exception):
 def __init__(self,reason,detail=''): self.reason=reason; self.detail=detail
if sys.argv[1].startswith('@'):
 payload_path=Path(sys.argv[1][1:])
 if payload_path.resolve()!=payload_path:raise RuntimeError('request_path_replaced')
 fd=os.open(payload_path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f:
  if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):raise RuntimeError('request_type_invalid')
  data=f.read(8*1024*1024+1)
 if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!=sys.argv[2]:raise RuntimeError('request_changed')
 q=json.loads(data)
 expected=Path(q['workspaceRoot'])/'.panda-archives/requests'
 if payload_path.parent!=expected or not re.fullmatch(r'[0-9a-f-]{36}\.json',payload_path.name):raise RuntimeError('request_scope_invalid')
 os.chmod(expected,0o700);os.chmod(expected.parent,0o700)
else:q=json.loads(sys.argv[1])
root=Path(q['cwd']); project=Path(q['projectCwd']); workspace=Path(q['workspaceRoot']); held_locks=[]
def reject(reason,detail=''): raise Retain(reason,detail)
def real(path,missing=False):
 path=Path(path)
 if not path.is_absolute() or '..' in path.parts or path.resolve()!=path: reject('path_replaced',str(path))
 if not missing and not path.is_dir(): reject('path_missing',str(path))
 return path
def mkdir_private(path):
 path=Path(path); real(path,True)
 if path.exists():
  if not path.is_dir() or path.is_symlink():reject('path_replaced',str(path))
  return
 mkdir_private(path.parent);os.mkdir(path,0o700)
def open_lock(path,reason):
 real(path.parent)
 fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 if not stat.S_ISREG(os.fstat(fd).st_mode):os.close(fd);reject('lock_replaced')
 f=os.fdopen(fd,'a+')
 try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:f.close();reject(reason)
 held_locks.append(f)
 return f
def fsync_dir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def read_json(path):
 try:
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  with os.fdopen(fd,'r') as f:return json.load(f)
 except FileNotFoundError:return None
def save_json(path,value):
 real(path.parent)
 temp=path.parent/(path.name+'.'+str(os.getpid())+'.partial')
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
 if path.is_symlink():reject('receipt_replaced')
 os.replace(temp,path);fsync_dir(path.parent)
def git(cwd,args,allowed=(0,)):
 p=subprocess.run(['git','-C',str(cwd),*args],capture_output=True,env=dict(os.environ,GIT_OPTIONAL_LOCKS='0',LC_ALL='C'),timeout=30,pass_fds=tuple(f.fileno() for f in held_locks if not f.closed))
 if p.returncode not in allowed:reject('git_check_failed',(p.stderr or p.stdout).decode(errors='replace')[-900:])
 return p.returncode,p.stdout
def out(cwd,args,allowed=(0,)):return git(cwd,args,allowed)[1].decode(errors='replace').strip()
def digest(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW); h=hashlib.sha256()
 with os.fdopen(fd,'rb') as f:
  if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):reject('unexpected_file_type',str(path))
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def signature(path,fast=False):
 s=path.lstat()
 if stat.S_ISLNK(s.st_mode):return {'kind':'link','target':os.readlink(path),'inode':s.st_ino,'device':s.st_dev,'mtime':s.st_mtime_ns,'ctime':s.st_ctime_ns}
 if not stat.S_ISREG(s.st_mode):reject('unexpected_file_type',str(path))
 return {'kind':'file','size':s.st_size,**({} if fast else {'sha256':digest(path)}),'inode':s.st_ino,'device':s.st_dev,'mtime':s.st_mtime_ns,'ctime':s.st_ctime_ns}
def tree_bytes(path):
 if not path.exists() or path.is_symlink():return 0
 seen=set();total=0
 for base,dirs,files in os.walk(path,followlinks=False):
  for name in dirs+files:
   try:
    s=(Path(base)/name).lstat();key=(s.st_dev,s.st_ino)
    if key not in seen:seen.add(key);total+=s.st_blocks*512
   except FileNotFoundError:pass
 return total
def free_space():
 probes=[workspace,project,root.parent,archive_root]
 probes+=list(map(Path,q.get('probePaths',[])));values=[]
 for p in probes:
  real(p,True)
  while not p.exists():p=p.parent
  s=os.statvfs(p);values.append((s.f_bavail*s.f_frsize,s.f_blocks*s.f_frsize))
 return min(values)
def archive_bytes():
 if not archive_base.is_dir():return 0
 total=0
 for base,dirs,files in os.walk(archive_base,followlinks=False):
  dirs[:]=[n for n in dirs if not (Path(base)/n).is_symlink()]
  for n in files:
   p=Path(base)/n
   if n.endswith(('.tar.gz','.partial')) and not p.is_symlink():total+=p.stat().st_size
 return total
def entries():
 data=git(project,['worktree','list','--porcelain','-z'])[1].split(b'\0');result={};current=None
 for item in data:
  if item.startswith(b'worktree '):current=item[9:].decode();result[current]=[]
  elif current and item:result[current].append(item.decode())
 return result
def repo_lock():return open_lock(Path(common)/'panda-workspace.lock','repository_busy')
def source_state():
 head=out(root,['rev-parse','HEAD'])
 status=git(root,['status','--porcelain=v1','-z','--untracked-files=all'])[1]
 bits=b'\0'.join(git(root,a)[1] for a in [['diff','--binary'],['diff','--cached','--binary'],['ls-files','--stage','-z']])
 return {'head':head,'status':status.decode(errors='replace'),'index':hashlib.sha256(bits).hexdigest()}
system_manager_pid=None
system_key_pids=None
def protected_system_process(proc):
 global system_manager_pid,system_key_pids
 try:
  uid=str(os.getuid());prefix='/user.slice/user-'+uid+'.slice/'
  group=next(line.strip()[3:] for line in (proc/'cgroup').read_text().splitlines() if line.startswith('0::'))
  own=next(line.strip()[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
  service=prefix+'user@'+uid+'.service'
  if not (own==service or own.startswith(service+'/')):return False
  boot=int(next(line.split()[1] for line in Path('/proc/stat').read_text().splitlines() if line.startswith('btime ')))
  fields=(proc/'stat').read_text().rsplit(')',1)[1].split()
  older=boot+int(fields[19])/os.sysconf('SC_CLK_TCK')<q.get('startedTs',0)/1000-2
  cgroup=Path('/sys/fs/cgroup'+group)
  if re.fullmatch(re.escape(prefix)+r'session-(?:[0-9]+|c[0-9]+)\.scope',group):
   return (proc/'environ').stat().st_uid==0 and cgroup.stat().st_uid==0 and not os.access(cgroup/'cgroup.procs',os.W_OK)
  # A delegated user cgroup is not a privilege boundary. Identify the manager through
  # the root system manager, and key daemons through their immutable vendor unit.
  if system_manager_pid is None:
   p=subprocess.run(['/usr/bin/systemctl','show','user@'+uid+'.service','--property=MainPID','--value'],capture_output=True,text=True,timeout=3)
   system_manager_pid=int(p.stdout.strip()) if p.returncode==0 and p.stdout.strip().isdigit() else -1
  if group==service+'/init.scope':
   if int(proc.name)==system_manager_pid:return True
   if not older:return False
   return int(fields[1])==system_manager_pid and (proc/'comm').read_text().strip()=='(sd-pam)' and (proc/'environ').stat().st_uid==0
  if system_key_pids is None:
   system_key_pids=set()
   p=subprocess.run(['/usr/bin/systemctl','--user','show','gpg-agent.service','--property=MainPID','--property=FragmentPath','--property=DropInPaths','--property=ExecStart'],capture_output=True,text=True,timeout=3)
   values=dict(line.split('=',1) for line in p.stdout.splitlines() if '=' in line)
   unit=Path(values.get('FragmentPath','/nonexistent'));binary=Path('/usr/bin/gpg-agent')
   if (p.returncode==0 and not values.get('DropInPaths') and values.get('MainPID','').isdigit()
    and str(unit).startswith(('/usr/lib/systemd/user/','/lib/systemd/user/')) and unit.stat().st_uid==0 and not os.access(unit,os.W_OK)
    and binary.stat().st_uid==0 and not os.access(binary,os.W_OK)
    and 'argv[]=/usr/bin/gpg-agent --supervised ;' in values.get('ExecStart','')):
    system_key_pids.add(int(values['MainPID']))
  return int(proc.name) in system_key_pids
 except (OSError,StopIteration,ValueError,subprocess.TimeoutExpired):return False

def live_references():
 prefixes=[str(root),str(archive_root/'trash'/q['jobId'])];markers={('PANDA_WORKSPACE_ATTEMPT='+a).encode() for a in q['attemptIds']}
 def inside(p):return any(p==prefix or p.startswith(prefix+'/') for prefix in prefixes)
 for name in os.listdir('/proc'):
  if not name.isdigit() or int(name)==os.getpid():continue
  proc=Path('/proc')/name
  try:
   if proc.stat().st_uid!=os.getuid():continue
   state=(proc/'stat').read_text().rsplit(')',1)[1].split()[0]
   if state=='Z':continue
   try:cwd=os.readlink(proc/'cwd')
   except FileNotFoundError:continue
   if inside(cwd):reject('live_writer','pid='+name)
   env=(proc/'environ').read_bytes().split(b'\0')
   if markers.intersection(env) or any(b'=' in e and inside(e.split(b'=',1)[1].decode(errors='replace')) for e in env):reject('live_writer','pid='+name)
   for fd in (proc/'fd').iterdir():
    try:
     target=os.readlink(fd)
     if inside(target.removesuffix(' (deleted)')):reject('live_writer','pid='+name)
    except FileNotFoundError:pass
  except (FileNotFoundError,ProcessLookupError):pass
  except PermissionError:
   if protected_system_process(proc):continue
   try:
    if (proc/'stat').read_text().rsplit(')',1)[1].split()[0]=='Z':continue
   except (FileNotFoundError,ProcessLookupError):continue
   reject('writer_inspection_denied','pid='+name)
def identity(check_source=True):
 real(workspace);real(project);real(root)
 records=entries();record=records.get(str(root))
 if record is None:reject('worktree_registration_missing')
 if any(line.startswith('locked') for line in record):reject('worktree_locked')
 if out(root,['rev-parse','--path-format=absolute','--git-common-dir'])!=common:reject('repository_changed')
 if q['branch']:
  if 'branch refs/heads/'+q['branch'] not in record:reject('branch_changed')
 elif 'detached' not in record:reject('candidate_branch_changed')
 if check_source:
  current=source_state()
  if current['status']:reject('source_dirty',current['status'][:900])
  if q.get('expectedHead') and current['head']!=q['expectedHead']:reject('head_changed')
  if git(root,['rev-parse','--verify','MERGE_HEAD'],(0,1,128))[0]==0:reject('merge_in_progress')
  if q['kind']=='candidate':
   for sha in (current['head'],q.get('resultSha')):
    if not sha or git(project,['merge-base','--is-ancestor',sha,q['targetRef']],(0,1))[0]!=0:reject('candidate_not_integrated')
  return current

def resources():
 selected=[]
 def add(rel,kind):
  p=root/rel
  if not p.exists() and not p.is_symlink():return
  real(p)
  if git(root,['check-ignore','--no-index','-q','--',rel],(0,1))[0]!=0:reject('resource_not_ignored',rel)
  tracked=git(root,['ls-files','-z','--',rel])[1]
  if tracked and kind!='installed':reject('tracked_runtime',rel)
  selected.append({'rel':rel,'kind':kind})
 add('.build','build')
 for attempt in q['attemptIds']:
  runtime=root/'.panda/tmp/runtime'/attempt
  if not runtime.exists():continue
  real(runtime)
  for base,dirs,files in os.walk(runtime,followlinks=False):
   keep=[]
   for name in sorted(dirs):
    p=Path(base)/name;rel=p.relative_to(root).as_posix()
    if name in ('cache','build'):add(rel,name)
    elif re.fullmatch(r'node--?[0-9]+|merge-agent',name) and not p.is_symlink():keep.append(name)
   dirs[:]=keep
 for base,dirs,files in os.walk(root,followlinks=False):
  keep=[]
  for name in sorted(dirs):
   p=Path(base)/name
   if name in ('.git','.panda','.private','.worktrees','.release-work','.build'):continue
   if name=='node_modules':add(p.relative_to(root).as_posix(),'installed')
   elif not p.is_symlink():keep.append(name)
  dirs[:]=keep
 return selected

def selected_files(items,fast=False,moved=False):
 result={}
 if moved:
  bases=[(Path(m['trash']),m['rel']) for m in receipt.get('moves',[]) if q['kind']=='candidate' or any(r['kind']=='build' and (m['rel']==r['rel'] or m['rel'].startswith(r['rel']+'/')) for r in items)]
  tracked=set()
 else:
  bases=[(root,'')] if q['kind']=='candidate' else [(root/r['rel'],r['rel']) for r in items if r['kind']=='build']
  tracked=set(git(root,['ls-files','-z'])[1].decode().split('\0'))
 def excluded(rel):
  parts=Path(rel).parts
  return any(n in ('node_modules','npm-cache','_cacache','pip-cache') for n in parts) or (parts[:3]==('.panda','tmp','runtime') and 'cache' in parts[4:])
 def add(p,rel):
  if rel=='.git' or rel in tracked or excluded(rel):return
  if p.name=='.git' and (q['kind']=='candidate' or p.is_file()):reject('nested_repository',rel)
  if stat.S_ISSOCK(p.lstat().st_mode):return
  result[rel]=signature(p,fast)
 for base,prefix in bases:
  if base.is_file() or base.is_symlink():add(base,prefix);continue
  for directory,dirs,files in os.walk(base,followlinks=False):
   physical=Path(directory);tail=physical.relative_to(base).as_posix();logical=prefix if tail=='.' else (prefix+'/'+tail if prefix else tail)
   keep=[]
   for name in sorted(dirs):
    p=physical/name;rel=logical+'/'+name if logical else name
    if excluded(rel) or rel=='.git':continue
    if name=='.git' and q['kind']=='candidate':reject('nested_repository',rel)
    if p.is_symlink():add(p,rel)
    else:keep.append(name)
   dirs[:]=keep
   for name in sorted(files):add(physical/name,logical+'/'+name if logical else name)
 return result

def verify_trash():
 current=selected_files(receipt['resources'],moved=True)
 for rel,value in current.items():
  old=receipt['files'].get(rel)
  if old is None or {k:v for k,v in value.items() if k!='ctime'}!={k:v for k,v in old.items() if k!='ctime'}:reject('trash_diagnostics_changed',rel)


def archive_valid(meta):
 p=Path(meta['path'])
 if p!=archive_root/(q['jobId']+'.tar.gz') or p.is_symlink() or not p.is_file() or p.stat().st_size!=meta['bytes'] or digest(p)!=meta['sha256']:reject('archive_changed')
 with tarfile.open(p,'r:gz') as tar:
  members=tar.getmembers()
  if {m.name for m in members}!=set(receipt['files']) or len(members)!=len(receipt['files']):reject('archive_verification_failed')
  for item in members:
   expected=receipt['files'][item.name]
   if expected['kind']=='link':
    if not item.issym() or item.linkname!=expected['target']:reject('archive_verification_failed')
   else:
    stream=tar.extractfile(item);h=hashlib.sha256()
    if stream is None:reject('archive_verification_failed')
    for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
    if h.hexdigest()!=expected['sha256']:reject('archive_verification_failed')
def checkpoint(stage):
 receipt['state']=stage;receipt['updatedAt']=int(time.time()*1000);save_json(receipt_path,receipt)
def create_archive():
 target=archive_root/(q['jobId']+'.tar.gz');partial=archive_root/(q['jobId']+'.partial')
 with open_lock(archive_base/'quota.lock','archive_busy'):
  if target.exists():
   if target.is_symlink() or not target.is_file():reject('archive_changed')
   receipt['archive']={'path':str(target),'sha256':digest(target),'bytes':target.stat().st_size}
   archive_valid(receipt['archive']);checkpoint('archived');return
  if partial.is_symlink():reject('path_replaced')
  if partial.exists():partial.unlink()
  available,_=free_space();budget=min(q['archiveMaxBytes']-archive_bytes(),available-65536)
  limit_reason='archive_quota' if q['archiveMaxBytes']-archive_bytes()<=available-65536 else 'archive_disk_low'
  if budget<512:reject(limit_reason)
  class Limited:
   def __init__(self,file):self.file=file
   def write(self,data):
    if self.file.tell()+len(data)>budget:reject(limit_reason)
    return self.file.write(data)
   def flush(self):self.file.flush()
   def tell(self):return self.file.tell()
  try:
   fd=os.open(partial,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   with os.fdopen(fd,'wb') as stream:
    with tarfile.open(fileobj=Limited(stream),mode='w:gz',compresslevel=1,dereference=False) as tar:
     for rel in receipt['files']:tar.add(root/rel,arcname=rel,recursive=False)
    stream.flush();os.fsync(stream.fileno())
   os.rename(partial,target);fsync_dir(archive_root)
   receipt['archive']={'path':str(target),'sha256':digest(target),'bytes':target.stat().st_size}
   archive_valid(receipt['archive']);checkpoint('archived')
  except BaseException:
   if partial.exists():partial.unlink()
   raise

def unchanged(allow_missing=False,fast=False):
 current=selected_files(receipt['resources'],fast)
 def comparable(value):return {k:v for k,v in value.items() if k!='sha256'} if fast else value
 if any(rel not in receipt['files'] or comparable(value)!=comparable(receipt['files'][rel]) for rel,value in current.items()):reject('diagnostics_changed')
 for rel in set(receipt['files'])-set(current):
  covered=any(rel==m['rel'] or rel.startswith(m['rel']+'/') for m in receipt.get('moves',[]))
  if not allow_missing or not covered:reject('diagnostics_changed',rel)
 if identity()!=receipt['before']:reject('source_changed')
 live_references()

def resource_allowed(item):
 rel=item['rel'];parts=Path(rel).parts;kind=item['kind']
 if Path(rel).is_absolute() or '..' in parts:reject('resource_identity_invalid')
 if kind=='installed':
  if not parts or parts[-1]!='node_modules' or any(p in ('.git','.panda','.private','.worktrees','.release-work') for p in parts):reject('resource_identity_invalid')
 elif rel=='.build' and kind=='build':pass
 elif len(parts) in (5,6) and parts[:3]==('.panda','tmp','runtime') and parts[3] in q['attemptIds'] and parts[-1]==kind and kind in ('cache','build'):
  if len(parts)==6 and not re.fullmatch(r'node--?[0-9]+|merge-agent',parts[4]):reject('resource_identity_invalid')
 else:reject('resource_identity_invalid')
 p=root/rel
 if p.exists() or p.is_symlink():
  real(p)
  if git(root,['check-ignore','--no-index','-q','--',rel],(0,1))[0]!=0:reject('resource_not_ignored',rel)
  if kind!='installed' and git(root,['ls-files','-z','--',rel])[1]:reject('tracked_runtime',rel)
 return p

def nested_git(path):
 if not path.is_dir() or path.is_symlink():return False
 for base,dirs,files in os.walk(path,followlinks=False):
  if '.git' in dirs or '.git' in files:return True
  dirs[:]=[n for n in dirs if not (Path(base)/n).is_symlink()]
 return False

def plan_moves():
 result=[];preserved=[]
 if q['kind']=='candidate':items=[{'rel':'.','kind':'candidate'}]
 else:items=receipt['resources']
 for item in items:
  if q['kind']=='environment':resource_allowed(item)
  if item['kind']=='candidate':paths=git(root,['ls-files','--others','--ignored','--exclude-standard','--directory','-z','--','.'])[1].decode().split('\0')
  elif item['kind']!='installed':paths=[item['rel']] if (root/item['rel']).exists() else []
  else:
   tracked=set(filter(None,git(root,['ls-files','-z','--',item['rel']])[1].decode().split('\0')))
   paths=[];pending=[root/item['rel']]
   while pending:
    p=pending.pop();rel=p.relative_to(root).as_posix()
    if rel in tracked:continue
    if not any(name.startswith(rel+'/') for name in tracked):paths.append(rel)
    elif p.is_dir() and not p.is_symlink():pending.extend(p.iterdir())
  for name in paths:
   if not name:continue
   rel=name.rstrip('/');src=root/rel
   if src.is_dir() and not src.is_symlink():real(src)
   else:real(src.parent)
   if item['kind']=='installed' and nested_git(src):preserved.append(rel);continue
   if git(root,['ls-files','-z','--',rel])[1]:reject('tracked_runtime',rel)
   if src.lstat().st_dev!=archive_root.stat().st_dev:reject('trash_filesystem_mismatch',rel)
   result.append({'rel':rel,'inode':src.lstat().st_ino,'device':src.lstat().st_dev})
 unique=[]
 for m in sorted(result,key=lambda v:len(Path(v['rel']).parts)):
  if not any(m['rel']==old['rel'] or m['rel'].startswith(old['rel']+'/') for old in unique):unique.append(m)
 receipt['preservedResources']=preserved
 for n,m in enumerate(unique):m['trash']=str(archive_root/'trash'/q['jobId']/str(n))
 return unique

def move_resources():
 trash=archive_root/'trash'/q['jobId'];mkdir_private(trash)
 for item in receipt['resources']:resource_allowed(item)
 for m in receipt['moves']:
  src=root/m['rel'];dst=Path(m['trash'])
  if Path(m['rel']).is_absolute() or '..' in Path(m['rel']).parts or dst.parent!=trash or not dst.name.isdigit():reject('resource_identity_invalid')
  src_present=src.exists() or src.is_symlink();dst_present=dst.exists() or dst.is_symlink()
  if dst_present:
   if src_present:reject('resource_recreated',m['rel'])
   if dst.lstat().st_ino!=m['inode'] or dst.lstat().st_dev!=m['device']:reject('trash_identity_changed')
  elif src_present:
   real(src.parent)
   st=src.lstat()
   if st.st_ino!=m['inode'] or st.st_dev!=m['device']:reject('resource_recreated',m['rel'])
   os.rename(src,dst);fsync_dir(src.parent);fsync_dir(trash)


def reclaim():
 global receipt,receipt_path,common
 if not re.fullmatch(r'[0-9a-f-]{36}',q['jobId']) or any(not re.fullmatch(r'[0-9a-f-]{36}',a) for a in q['attemptIds']):reject('identity_invalid')
 expected=workspace/'.panda-worktrees'/('project-'+str(q['projectId']))
 if q['kind']=='candidate':
  if root.parent!=expected/'integration' or not re.fullmatch(r'[0-9a-f-]{36}',root.name):reject('path_outside_workspace')
 elif q['kind']=='environment':
  if root.parent!=expected or not re.fullmatch(r'module-[0-9]+',root.name):reject('path_outside_workspace')
 else:reject('kind_invalid')
 common=out(project,['rev-parse','--path-format=absolute','--git-common-dir']);real(Path(common))
 immutable={k:q.get(k) for k in ('jobId','kind','projectId','executorId','workspaceRoot','projectCwd','cwd','branch','expectedHead','resultSha','targetRef','attemptIds','generation')}
 binding=hashlib.sha256(json.dumps(immutable,sort_keys=True).encode()).hexdigest()
 if q['action']=='inspect':
  with repo_lock():before=identity();live_references();items=resources() if q['kind']=='environment' else []
  return {'state':'ready','sourceHead':before['head'],'resources':items}
 mkdir_private(archive_root);mkdir_private(archive_base/'receipts')
 with open_lock(archive_base/'receipts'/(q['jobId']+'.lock'),'reclamation_busy'):
  receipt_path=archive_base/'receipts'/(q['jobId']+'.json');receipt=read_json(receipt_path)
  if receipt and receipt.get('binding')!=binding:reject('receipt_identity_changed')
  if receipt and receipt['state']=='reclaimed':
   if q['kind']=='candidate' and (root.exists() or str(root) in entries()):reject('reclaimed_path_reused')
   if not receipt.get('archivePurged'):archive_valid(receipt['archive'])
   return {k:v for k,v in receipt.items() if k in ('state','archive','archivePurged','resources','sourceHead')}
  if not root.exists():
   if receipt and receipt['state']=='deleting' and q['kind']=='candidate':
    with repo_lock():
     archive_valid(receipt['archive'])
     if str(root) in entries():reject('removal_incomplete')
     if git(project,['merge-base','--is-ancestor',receipt['before']['head'],q['targetRef']],(0,1))[0]!=0:reject('candidate_not_integrated')
    live_references();verify_trash();trash=archive_root/'trash'/q['jobId']
    if trash.exists():real(trash);shutil.rmtree(trash)
    checkpoint('reclaimed')
    return {'state':'reclaimed','archive':receipt['archive']}
   reject('path_missing')
  with repo_lock():before=identity()
  install_lock=None
  try:
   if q['kind']=='environment':
    deps=root/'.panda/tmp/dependencies';mkdir_private(deps)
    install_lock=open_lock(deps/'install.lock','dependency_busy')
   live_references()
   if receipt is None:
    items=resources() if q['kind']=='environment' else []
    receipt={'binding':binding,'state':'checking','before':before,'sourceHead':before['head'],'resources':items,'files':selected_files(items)}
    checkpoint('archiving')
   elif before!=receipt['before']:reject('source_changed')
   if 'archive' not in receipt:create_archive()
   else:archive_valid(receipt['archive'])
   # Full enumeration, hashing and archive validation happen without the shared Git lock.
   unchanged(receipt['state']=='deleting')
   if 'moves' not in receipt:
    receipt['moves']=plan_moves();checkpoint('deleting')
   with repo_lock():
    unchanged(True,True);move_resources()
   # Same-filesystem renames detach large ignored installations/caches in milliseconds.
   # The per-job and installation locks remain held while the private trash is removed.
   live_references();verify_trash();trash=archive_root/'trash'/q['jobId']
   assert shutil.rmtree.avoids_symlink_attacks
   if trash.exists():real(trash);shutil.rmtree(trash)
   with repo_lock():
    unchanged(True,True)
    if q['kind']=='candidate':
     git(project,['worktree','remove',str(root)])
     if root.exists() or str(root) in entries():reject('removal_incomplete')
    else:
     cold=root/'.panda/tmp/dependencies/receipt.json'
     if git(root,['ls-files','-z','--','.panda/tmp/dependencies/receipt.json'])[1]:reject('tracked_runtime')
     old=read_json(cold) or {};old.update(phase='cold',reclamation=q['jobId']);save_json(cold,old)
     if source_state()!=before:reject('source_changed')
    checkpoint('reclaimed')
   return {'state':'reclaimed','archive':receipt['archive'],'resources':receipt['resources'],'sourceHead':before['head']}
  finally:
   if install_lock:install_lock.close()

def prune():
 purged=[]
 mkdir_private(archive_base)
 with open_lock(archive_base/'quota.lock','archive_busy'):
  for item in q.get('archives',[]):
   job=item['jobId'];path=Path(item['path'])
   if not re.fullmatch(r'[0-9a-f-]{36}',job) or path!=archive_root/(job+'.tar.gz'):reject('archive_identity_invalid')
   journal=archive_base/'receipts'/(job+'.json');data=read_json(journal)
   if not data or data['state']!='reclaimed' or data.get('archive')!={'path':str(path),'sha256':item['sha256'],'bytes':item['bytes']}:reject('archive_not_reclaimable')
   with open_lock(archive_base/'receipts'/(job+'.lock'),'reclamation_busy'):
    if path.exists():
     if path.is_symlink() or digest(path)!=item['sha256']:reject('archive_changed')
     path.unlink();fsync_dir(path.parent)
    data={k:v for k,v in data.items() if k in ('binding','state','archive','sourceHead')}
    data['archivePurged']=True;save_json(journal,data);purged.append(job)
 return {'state':'ready','purged':purged}

try:
 real(workspace);real(project)
 archive_base=workspace/'.panda-archives';archive_root=archive_base/('project-'+str(q['projectId']))
 real(archive_root,True)
 if q['action']=='capacity':
  available,total=free_space();cache=0
  for p in q.get('cachePaths',[]):
   p=Path(p);real(p,True)
   if not p.is_relative_to(workspace/'.panda-worktrees'):reject('path_outside_workspace')
   if p.exists():
    for base,dirs,files in os.walk(p,followlinks=False):
     keep=[]
     for name in dirs:
      child=Path(base)/name
      if name=='cache':cache+=tree_bytes(child)
      elif re.fullmatch(r'node--?[0-9]+|merge-agent',name) and not child.is_symlink():keep.append(name)
     dirs[:]=keep
  result={'state':'ready','availableBytes':available,'totalBytes':total,'cacheBytes':cache,'archiveBytes':archive_bytes()}
 elif q['action']=='prune':result=prune()
 elif q['action'] in ('inspect','reclaim'):result=reclaim()
 else:reject('action_invalid')
 print(json.dumps(result,ensure_ascii=False))
except Retain as error:
 result={'state':'retained','reason':error.reason,'details':error.detail}
 saved=globals().get('receipt') or {}
 if saved.get('state') in ('archived','deleting','reclaimed') and saved.get('archive'):result.update(archive=saved['archive'],receiptStage=saved['state'])
 print(json.dumps(result,ensure_ascii=False))
except Exception as error:print(json.dumps({'state':'uncertain','reason':'executor_failure','details':str(error)[-1500:]},ensure_ascii=False))
`;
