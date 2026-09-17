import { createHash } from 'node:crypto';
import type { ValidationExecutor } from './validation';

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
function dependencies(dir) {
 if(!fs.existsSync(dir)) return;
 for(const name of fs.readdirSync(dir).sort()) {
  const p=dir+'/'+name, st=fs.lstatSync(p);
  h.update(JSON.stringify([p,st.mode,st.size,st.mtimeMs,st.ctimeMs]));
  if(st.isDirectory()) dependencies(p);
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
