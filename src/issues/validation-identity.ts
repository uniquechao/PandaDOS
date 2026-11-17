import { createHash } from 'node:crypto';
import type { ExecutorDriver } from '../executor/driver';
import type { ValidationCommand } from '../core/types';
import type { ValidationExecutor } from './validation';
import { DEPENDENCY_IDENTITY_PYTHON } from './dependency-identity';

// Runs on the executor, not the control host. Prints only a digest, never paths, file contents or env.
// Unknown runtimes/configured commands deliberately opt out of reuse.
const FINGERPRINT = String.raw`
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto');
const h = crypto.createHash('sha256');
h.update(JSON.stringify([process.cwd(), process.platform, process.arch, process.versions,
  Object.entries(process.env).sort((a,b)=>a[0].localeCompare(b[0]))]));
const names = [...new Set(cp.execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],
  {maxBuffer:16*1024*1024}).toString().split('\0').filter(Boolean))].sort();
let bytes=0;
for(const name of names) {
  h.update(JSON.stringify(name));
  let st; try {st=fs.lstatSync(name);} catch(e) {if(e.code==='ENOENT'){h.update('deleted');continue;}throw e;}
  h.update(String(st.mode));
  if(st.isSymbolicLink()) { h.update(fs.readlinkSync(name)); throw Error('symlink inputs are not cacheable'); }
  if(!st.isFile()) throw Error('non-file git input');
  bytes+=st.size; if(bytes>256*1024*1024) throw Error('fingerprint input limit');
  h.update(fs.readFileSync(name));
}
// Dependency installation identity, including changes below the node_modules root.
function dependencies(dir, relative='') {
 if(!fs.existsSync(dir)) return;
 if(!relative) {const st=fs.lstatSync(dir);h.update(JSON.stringify([dir,st.mode,st.isSymbolicLink()?fs.readlinkSync(dir):null]));}
 for(const name of fs.readdirSync(dir).sort()) {
  const rel=relative+name;
  if(['.vite','.vite-temp'].includes(rel.split('/')[0])) continue;
  if(/^\.tmp\/[^/]+\.tsbuildinfo$/.test(rel)) continue;
  const p=dir+'/'+name, st=fs.lstatSync(p);
  if(!(rel==='.tmp' && st.isDirectory()))h.update(JSON.stringify(st.isDirectory()?[p,st.mode]:[p,st.mode,st.size,st.mtimeMs,st.ctimeMs]));
  if(st.isDirectory()) dependencies(p,rel+'/');
  else if(st.isSymbolicLink()) h.update(fs.readlinkSync(p));
 }
}
dependencies('node_modules');
for(const name of ['.env','.env.local','.npmrc','.bunfig.toml','bunfig.toml']) {
 if(fs.existsSync(name)) h.update(fs.readFileSync(name));
}
console.log('PANDA_VALIDATION_ID:'+h.digest('hex'));
`;

export async function validationIdentity(exec: ValidationExecutor, cwd: string): Promise<string | null> {
  try {
    const r = await exec.runCommand(cwd, ['bun', '-e', FINGERPRINT], 30_000);
    if (r.code !== 0 || r.timedOut) return null;
    return /^PANDA_VALIDATION_ID:([a-f0-9]{64})\s*$/.exec(r.out.trim())?.[1] ?? null;
  } catch { return null; }
}

export function validationCheckKey(identity: string, argv: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([identity, argv])).digest('hex');
}

// Candidate receipts cover configured commands too. Keep individual hashes on the
// executor and send only a digest and a bounded list of changed names back.
const CANDIDATE_SNAPSHOT = String.raw`
import hashlib, json, os, platform, shutil, stat, subprocess, sys

mode, receipt, executable_json = sys.argv[1:]
root = os.getcwd()
${DEPENDENCY_IDENTITY_PYTHON}
def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=True, sort_keys=True).encode()).hexdigest()
def metadata(path):
    value = os.lstat(path)
    return [value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns,
            os.readlink(path) if stat.S_ISLNK(value.st_mode) else None]
def file_digest(path):
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return digest('missing')
    link = None
    if stat.S_ISLNK(mode):
        link = os.readlink(path)
        path = os.path.realpath(path)
        if os.path.commonpath([root, path]) != root or not os.path.isfile(path):
            raise ValueError('unsupported source symlink')
    elif not stat.S_ISREG(mode):
        raise ValueError('unsupported source input')
    h = hashlib.sha256()
    h.update(json.dumps([mode, link]).encode())
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()
def fail(error):
    raise error
def dependencies(path):
    return dependency_fingerprint(path)

inventory = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
paths = {os.fsdecode(path) for path in inventory.split(b'\0') if path}
files = {path: file_digest(path) for path in sorted(paths)}
skip = {'.git', '.panda', '.private', '.build', '.next', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache'}
for base, dirs, names in os.walk(root, onerror=fail):
    for name in dirs:
        if name in {'node_modules', '.venv', 'venv'}:
            path = os.path.join(base, name)
            files[os.path.relpath(path, root)] = dependencies(path)
    dirs[:] = sorted(name for name in dirs if name not in skip)
    for name in names:
        if name.startswith('.env') or name in {'.npmrc', '.yarnrc.yml', 'bunfig.toml', '.bunfig.toml', 'pip.conf', '.python-version', '.nvmrc'}:
            path = os.path.join(base, name)
            files[os.path.relpath(path, root)] = file_digest(path)

attachments = '.panda/tmp/attachments'
if os.path.lexists(attachments):
    if os.path.realpath(attachments) != os.path.join(root, attachments):
        raise ValueError('unsupported attachment path')
    for base, dirs, names in os.walk(attachments, onerror=fail):
        if any(os.path.islink(os.path.join(base, name)) for name in dirs):
            raise ValueError('unsupported attachment directory')
        for name in names:
            path = os.path.join(base, name)
            files[path] = file_digest(path)

executables = []
commands = {tuple(entry) for entry in json.loads(executable_json)}
commands.update(('.', command) for command in {'bun','node','python3','npm','pnpm','uv'})
for cwd, command in sorted(commands):
    if '/' in command:
        path = os.path.join(root, cwd, command)
        if not os.access(path, os.X_OK):
            path = None
    else:
        path = shutil.which(command)
    resolved = os.path.realpath(path) if path else None
    executables.append([cwd, command, resolved, metadata(resolved) if resolved else None])
environment = digest([root, platform.system(), platform.machine(), sys.version, executables,
                      sorted((key, value) for key, value in os.environ.items() if key not in {'_', 'SHLVL'})])
current = {'files': files, 'environment': environment}
changed = []
environment_changed = False
if mode != 'current':
    filename = 'validation-inputs-' + receipt + '.json'
    panda = os.open('.panda', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        temporary = os.open('tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=panda)
        try:
            if mode == 'start':
                with os.fdopen(os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=temporary), 'w') as output:
                    json.dump(current, output)
            else:
                with os.fdopen(os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=temporary)) as source:
                    previous = json.load(source)
                os.unlink(filename, dir_fd=temporary)
                before = previous['files']
                changed = [path for path in sorted(before.keys() | files.keys()) if before.get(path) != files.get(path)]
                environment_changed = previous['environment'] != environment
        finally:
            os.close(temporary)
    finally:
        os.close(panda)
print('PANDA_CANDIDATE_INPUTS:' + json.dumps({'digest': digest(current),
      'changedPaths': [name[:300] for name in changed[:32]], 'changedCount': len(changed),
      'environmentChanged': environment_changed}, ensure_ascii=True))
`;

export interface CandidateInputSnapshot {
  digest: string;
  changedPaths: string[];
  changedCount: number;
  environmentChanged: boolean;
}

export async function candidateInputSnapshot(driver: Pick<ExecutorDriver,'runCommand'>, cwd: string,
  commands: readonly ValidationCommand[], env: Record<string,string>, mode: 'start'|'finish'|'current', receipt = ''): Promise<CandidateInputSnapshot | null> {
  if (mode !== 'current' && !/^[a-f0-9-]{36}$/.test(receipt)) return null;
  try {
    const executables = commands.map(command=>[command.cwd??'.',command.argv[0]]);
    const result = await driver.runCommand(cwd, ['python3','-I','-c',CANDIDATE_SNAPSHOT,mode,receipt,JSON.stringify(executables)], 60_000, env);
    if (result.code !== 0 || result.timedOut) return null;
    const match = /^PANDA_CANDIDATE_INPUTS:(.*)$/m.exec(result.out);
    if (!match) return null;
    const value = JSON.parse(match[1]!) as CandidateInputSnapshot;
    return /^[a-f0-9]{64}$/.test(value.digest) && Array.isArray(value.changedPaths) ? value : null;
  } catch { return null; }
}
