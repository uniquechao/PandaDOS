import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RoomAttempt } from './contracts';

export interface LocalCliRecord {
  version: 1; attemptId: string; projectId: number; roomId: string; memberId: string;
  missionId: string; workerId: string; fence: number; controlEpoch: number;
  provider: 'claude' | 'codex'; bootId: string; pid: number | null; startTime: string | null;
  state: 'prepared' | 'running' | 'exited'; exitCode: number | null;
  stopped?: boolean;
  failure?: 'response_too_large' | 'runtime_failed';
}
export const localHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function privateDirectory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
export function privateWrite(path: string, value: string): void {
  privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function readRecord(path: string): LocalCliRecord | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.version !== 1 || !['prepared', 'running', 'exited'].includes(value.state)) throw new Error('invalid_local_record');
  return value as LocalCliRecord;
}
export function sameAttempt(record: LocalCliRecord, attempt: RoomAttempt): boolean {
  return record.attemptId === attempt.id && record.projectId === attempt.projectId && record.roomId === attempt.roomId
    && record.memberId === attempt.memberId && record.missionId === attempt.missionId && record.workerId === attempt.workerId
    && record.fence === attempt.fence && record.controlEpoch === attempt.controlEpoch;
}
type ProcessInfo = { state: string; group: number; session: number; start: string };

export function bootId(): string {
  if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (process.platform === 'darwin') {
    // /private/var/run is recreated for each macOS boot. Its birth time gives
    // us a stable boot-scoped identity without shelling out to sysctl (which
    // is unavailable in sandboxed test and desktop environments).
    return `darwin:${statSync('/private/var/run').birthtimeMs}`;
  }
  throw new Error('unsupported_local_cli_platform');
}

function parseDarwinProcessLine(text: string): { pid: number; info: ProcessInfo } | undefined {
  const match = text.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return undefined;
  return { pid: Number(match[1]), info: { state: match[2], group: Number(match[3]), session: Number(match[4]), start: match[5].trim() } };
}

function darwinProcessTable(pid?: number): Map<number, ProcessInfo> {
  const args = pid === undefined
    ? ['-axo', 'pid=,state=,pgid=,sess=,lstart=']
    : ['-o', 'pid=,state=,pgid=,sess=,lstart=', '-p', String(pid)];
  const output = execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 4_194_304 });
  const table = new Map<number, ProcessInfo>();
  for (const line of output.split('\n')) {
    const parsed = parseDarwinProcessLine(line);
    if (parsed) table.set(parsed.pid, parsed.info);
  }
  return table;
}

function processInfo(pid: number): ProcessInfo | undefined {
  if (process.platform === 'darwin') {
    try { return darwinProcessTable(pid).get(pid); }
    catch (error) {
      // BSD ps exits 1 when the requested pid no longer exists.
      if ((error as { status?: number }).status === 1) return undefined;
      throw error;
    }
  }
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function processStart(pid: number): string | undefined { return processInfo(pid)?.start; }
/** A process ID by itself is never sufficient proof after a server restart. */
export function inspectLocalGroup(record: LocalCliRecord): 'running' | 'gone' | 'unknown' {
  try {
    if (record.stopped === true) return 'gone';
    if (record.bootId !== bootId()) return 'gone';
    // The supervisor cannot receive GO until its exact identity is durably stored.
    if (record.pid === null && record.state === 'prepared') return 'gone';
    if (!record.pid || !record.startTime) return 'unknown';
    const leader = processInfo(record.pid);
    if (leader && leader.start !== record.startTime) return 'unknown';
    if (process.platform === 'darwin') {
      for (const info of darwinProcessTable().values()) {
        // Node/Bun detached children are process-group leaders on macOS, but
        // unlike Linux their session id remains inherited (often 0 in ps).
        if (!info.state.startsWith('Z') && !info.state.startsWith('X') && info.group === record.pid) return 'running';
      }
      return 'gone';
    }
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const info = processInfo(Number(entry));
      if (info && info.state !== 'Z' && info.state !== 'X' && info.group === record.pid && info.session === record.pid) return 'running';
    }
    return 'gone';
  } catch { return 'unknown'; }
}
export function signalLocalGroup(record: LocalCliRecord, signal: NodeJS.Signals): void {
  if (inspectLocalGroup(record) !== 'running' || !record.pid) return;
  try { process.kill(-record.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
export function releaseLocalLock(roomDirectory: string, record: LocalCliRecord): void {
  const lock = join(roomDirectory, 'execution.lock');
  const owner = readRecord(join(lock, 'process.json'));
  if (owner && owner.attemptId === record.attemptId && owner.fence === record.fence && owner.workerId === record.workerId
    && owner.roomId === record.roomId && owner.projectId === record.projectId) unlinkSync(lock);
}
