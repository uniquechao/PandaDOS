/** Private process supervisor. Its stdin gate closes the spawn/registration crash window. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { privateWrite, readRecord, signalLocalGroup } from './local-cli-state';

const recordPath = process.argv[2];
const jobPath = process.argv[3];
let gate = '';
for await (const part of process.stdin) { gate += part.toString(); if (gate.length > 16) process.exit(1); }
if (gate !== 'GO\n') process.exit(0);
if (existsSync(join(dirname(recordPath), 'cancelled'))) process.exit(0);
const record = readRecord(recordPath);
if (!record || record.pid !== process.pid || record.state !== 'prepared') process.exit(1);
const job = JSON.parse(readFileSync(jobPath, 'utf8')) as { executable: string; args: string[]; env: Record<string, string>; cwd: string; input: string; outputPath: string; deadlineTs: number };
if (Date.now() >= job.deadlineTs) process.exit(1);
record.state = 'running';
privateWrite(recordPath, JSON.stringify(record));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  signalLocalGroup(record, 'SIGTERM');
  setTimeout(() => signalLocalGroup(record, 'SIGKILL'), 350).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const timer = setTimeout(stop, Math.max(0, job.deadlineTs - Date.now()));
const output: Buffer[] = [];
let bytes = 0;
const child = spawn(job.executable, job.args, { cwd: job.cwd, env: job.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.on('error', () => {});
child.stdin.end(job.input);
child.stdout.on('data', (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes > 1_048_576) { record.failure = 'response_too_large'; stop(); }
  else output.push(chunk);
});
// Raw CLI diagnostics may contain prompts and credentials; discard them in the private worker.
child.stderr.resume();
child.on('error', () => { record.failure = 'runtime_failed'; });
child.on('close', code => {
  clearTimeout(timer);
  record.state = 'exited'; record.exitCode = code;
  if (!record.failure && code === 0 && !stopping) privateWrite(job.outputPath, Buffer.concat(output).toString('utf8'));
  privateWrite(recordPath, JSON.stringify(record));
  process.exit(code === 0 && !stopping && !record.failure ? 0 : 1);
});
