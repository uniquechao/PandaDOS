import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isUploadRel, MAX_UPLOAD_FILE_BYTES } from '../core/uploads';
import type { ValidationCommand } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { DependencyPreparationError, prepareDependencies } from './dependency-preparation';
import { splitValidationCommands } from './validation-preparation';

const MANIFEST = '.panda/execution.json';
const MAX_MANIFEST = 64 * 1024;
const ATTACHMENTS = '.panda/tmp/attachments';
type Driver = Pick<ExecutorDriver, 'statPath' | 'readFileNoFollowWithin' | 'writeFileNoFollowWithin' | 'runCommand'>;
interface Subproject {
  path: string;
  runtime: { name: 'node' | 'python' | 'bun'; major: number };
  prepare: 'node' | 'uv' | 'none';
  validation: ValidationCommand[];
}

function bad(reason: string): never {
  throw new DependencyPreparationError('workspace_inputs: ' + reason);
}

function uploadPath(value: string): string | null {
  const path = value.replace(/^\.\//, '');
  return isUploadRel(path) && /^\.panda\/uploads\/[\w.-]+\/[\w.-]+$/.test(path) ? path : null;
}

export function projectedAttachmentPath(value: string): string | null {
  const path = uploadPath(value);
  // Preserve the upload suffix so conversation previews resolve the original project attachment.
  return path ? posix.join(ATTACHMENTS, path) : null;
}

export async function projectWorkspaceAttachments(driver: Driver, projectCwd: string, cwd: string, imagesJson: string | null) {
  if (!imagesJson || projectCwd === cwd) return [];
  let images: unknown;
  try { images = JSON.parse(imagesJson); } catch { return bad('invalid attachment list'); }
  if (!Array.isArray(images) || images.length > 20) return bad('invalid attachment list');
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const value of new Set(images)) {
    if (typeof value !== 'string') return bad('invalid attachment path');
    const source = uploadPath(value);
    const target = projectedAttachmentPath(value);
    // Historical absolute references retain the original execution-host path.
    if (!source || !target) continue;
    if (!driver.readFileNoFollowWithin || !driver.writeFileNoFollowWithin) return bad('executor cannot securely project attachments');
    let file;
    try { file = await driver.readFileNoFollowWithin(projectCwd, source, MAX_UPLOAD_FILE_BYTES + 1); }
    catch { return bad('missing or unreadable attachment ' + source); }
    if (file.size > MAX_UPLOAD_FILE_BYTES || file.data.length !== file.size) return bad('incomplete attachment ' + source);
    if (await driver.writeFileNoFollowWithin(cwd, target, file.data, 0o400) === 'conflict') return bad('projected attachment changed ' + source);
    entries.push({ path: target, sha256: createHash('sha256').update(file.data).digest('hex') });
  }
  return entries;
}

function parseManifest(text: string): Subproject[] {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return bad('invalid ' + MANIFEST); }
  if (!Array.isArray(parsed?.subprojects) || !parsed.subprojects.length || parsed.subprojects.length > 12)
    return bad('subprojects must contain 1 to 12 entries');
  const seen = new Set<string>();
  return parsed.subprojects.map((item: any): Subproject => {
    const path = item?.path;
    if (typeof path !== 'string' || (path !== '.' && !/^[\w-][\w.-]*(\/[\w-][\w.-]*)*$/.test(path)) || seen.has(path))
      return bad('invalid or duplicate subproject path');
    seen.add(path);
    const runtime = item.runtime;
    if (!['node', 'python', 'bun'].includes(runtime?.name) || !Number.isSafeInteger(runtime?.major) || runtime.major < 1)
      return bad(path + ': runtime name and major version required');
    const prepare = item.prepare ?? 'none';
    if (!['node', 'uv', 'none'].includes(prepare)) return bad(path + ': invalid preparation mode');
    const validation = item.validation ?? [];
    if (!Array.isArray(validation) || validation.length > 12) return bad(path + ': invalid validation commands');
    const commands = validation.map((entry: any): ValidationCommand => {
      if (typeof entry?.label !== 'string' || !entry.label.trim() || !Array.isArray(entry.argv) ||
        !entry.argv.length || entry.argv.length > 32 || entry.argv.some((arg: unknown) => typeof arg !== 'string' || !arg || arg.length > 2000))
        return bad(path + ': invalid validation command');
      return { label: entry.label.slice(0, 60), argv: entry.argv, cwd: path };
    });
    return { path, runtime: { name: runtime.name, major: runtime.major }, prepare, validation: commands };
  });
}

async function readManifest(driver: Driver, cwd: string): Promise<Subproject[] | null> {
  if (!await driver.statPath(posix.join(cwd, MANIFEST))) return null;
  if (!driver.readFileNoFollowWithin) return bad('executor cannot securely read ' + MANIFEST);
  const result = await driver.readFileNoFollowWithin(cwd, MANIFEST, MAX_MANIFEST + 1);
  if (result.size > MAX_MANIFEST || result.data.length !== result.size) return bad('incomplete ' + MANIFEST);
  return parseManifest(new TextDecoder().decode(result.data));
}

export async function configuredWorkspaceValidation(driver: Driver, cwd: string): Promise<ValidationCommand[] | null> {
  const manifest = await readManifest(driver, cwd);
  return manifest?.flatMap(entry => entry.validation) ?? null;
}

export async function workspaceInputWritePaths(driver: Driver, cwd: string, configured?:readonly ValidationCommand[]|null): Promise<string[]> {
  const manifest = await readManifest(driver, cwd);
  const paths=manifest?.flatMap(entry => {
    const subproject = posix.join(cwd, entry.path);
    return entry.prepare === 'node' ? [subproject, posix.join(subproject, 'node_modules')] :
      entry.prepare === 'uv' ? [subproject, posix.join(subproject, '.venv')] : [subproject];
  }) ?? [];
  for(const entry of splitValidationCommands(configured??manifest?.flatMap(entry=>entry.validation)??[]).preparation) {
    const subproject=posix.join(cwd,entry.cwd);paths.push(subproject,posix.join(subproject,entry.kind==='uv'?'.venv':'node_modules'));
  }
  return [...new Set(paths)];
}

const INSPECT_SUBPROJECT = `
import os, stat, sys
root, rel = os.getcwd(), sys.argv[1]
target = root
if rel != '.':
    for item in rel.split('/'):
        target = os.path.join(target, item)
        if not stat.S_ISDIR(os.lstat(target).st_mode):
            raise RuntimeError('subproject path is not a real directory')
`;

export async function prepareWorkspaceInputs(driver: Driver, cwd: string, env?: Record<string, string>, configured?:readonly ValidationCommand[]|null): Promise<void> {
  const manifest = await readManifest(driver, cwd);
  const preparation=splitValidationCommands(configured??manifest?.flatMap(entry=>entry.validation)??[]).preparation;
  if (!manifest && !preparation.some(entry=>entry.cwd==='.')) await prepareDependencies(driver, cwd, env);
  for (const entry of manifest??[]) {
    const explicit=preparation.find(item=>item.cwd===entry.path);
    const entryEnv={...env,...explicit?.env};
    const checked = await driver.runCommand(cwd, ['python3', '-c', INSPECT_SUBPROJECT, entry.path], 10_000, entryEnv);
    const workdir = posix.join(cwd, entry.path);
    if (checked.code !== 0 || checked.timedOut) return bad(entry.path + ': subproject directory unavailable');
    const bin = entry.runtime.name === 'python' ? 'python3' : entry.runtime.name;
    const version = await driver.runCommand(workdir, [bin, '--version'], 10_000, entryEnv);
    const major = /(?:^|\s)v?(\d+)\.\d+/.exec(version.out + ' ' + version.err)?.[1];
    if (version.code !== 0 || version.timedOut || Number(major) !== entry.runtime.major)
      return bad(entry.path + ': requires ' + bin + ' ' + entry.runtime.major + ', found ' + ((version.out || version.err).trim().slice(0, 100) || 'unavailable'));
    if (entry.prepare !== 'none' && !explicit) {
      await prepareDependencies(driver, workdir, {
        ...env, PANDA_DEPENDENCY_INSTALL_ROOT: cwd, PANDA_DEPENDENCY_PREPARE_KIND: entry.prepare,
      });
    }
  }
  for(const entry of preparation) {
    const preparedEnv={...env,...entry.env};
    const checked=await driver.runCommand(cwd,['python3','-c',INSPECT_SUBPROJECT,entry.cwd],10_000,preparedEnv);
    if(checked.code!==0||checked.timedOut)return bad(entry.cwd+': subproject directory unavailable');
    await prepareDependencies(driver,posix.join(cwd,entry.cwd),{
      ...preparedEnv,PANDA_DEPENDENCY_INSTALL_ROOT:cwd,PANDA_DEPENDENCY_PREPARE_KIND:entry.kind,
      PANDA_DEPENDENCY_COMMAND_JSON:JSON.stringify(entry.argv),
    });
  }
}
