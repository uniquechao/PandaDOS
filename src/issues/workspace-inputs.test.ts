import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDriver } from '../executor/local';
import { configuredWorkspaceValidation, prepareWorkspaceInputs, projectWorkspaceAttachments } from './workspace-inputs';
import { runValidation } from './validation';

test('projects issue attachment bytes to each workspace and detects missing or replaced inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'panda-attachments-'));
  try {
    const source = join(root, 'project');
    const cwd = join(root, 'workspace');
    const dir = '.panda/uploads/abcd';
    mkdirSync(join(source, dir), { recursive: true });
    mkdirSync(cwd);
    const file = dir + '/example.png';
    writeFileSync(join(source, file), 'attachment');
    const driver = new LocalDriver();
    const attachments = JSON.stringify([file]);
    const first = await projectWorkspaceAttachments(driver, source, cwd, attachments);
    expect(first[0]?.path).toBe('.panda/tmp/attachments/.panda/uploads/abcd/example.png');
    expect(readFileSync(join(cwd, first[0]!.path), 'utf8')).toBe('attachment');
    expect(await projectWorkspaceAttachments(driver, source, cwd, attachments)).toEqual(first);
    writeFileSync(join(source, file), 'changed');
    await expect(projectWorkspaceAttachments(driver, source, cwd, attachments)).rejects.toThrow('projected attachment changed');
    await expect(projectWorkspaceAttachments(driver, source, cwd, JSON.stringify([dir + '/missing.png']))).rejects.toThrow('missing or unreadable attachment');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nested runtime and validation use the declared subproject, and symlinked subprojects are rejected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'panda-nested-'));
  try {
    const driver = new LocalDriver();
    const version = await driver.runCommand(cwd, ['python3', '--version'], 5000);
    const major = Number(/Python (\d+)\./.exec(version.out + version.err)?.[1]);
    mkdirSync(join(cwd, '.panda'));
    mkdirSync(join(cwd, 'apps/web'), { recursive: true });
    symlinkSync(join(cwd, 'apps/web'), join(cwd, 'linked'));
    const argv = ['python3', '-c', 'from pathlib import Path; assert Path.cwd().name == "web"'];
    const manifest = (path: string, version = major) => JSON.stringify({
      subprojects: [{ path, runtime: { name: 'python', major: version }, validation: [{ label: 'nested gate', argv }] }],
    });
    const file = join(cwd, '.panda/execution.json');
    writeFileSync(file, manifest('apps/web'));
    await prepareWorkspaceInputs(driver, cwd);
    const commands = await configuredWorkspaceValidation(driver, cwd);
    expect(commands).toEqual([{ label: 'nested gate', argv, cwd: 'apps/web' }]);
    expect((await runValidation(driver, cwd, commands!, { kind: 'full', files: [], reason: 'fixture' })).ok).toBe(true);
    writeFileSync(file, manifest('apps/web', major + 1));
    await expect(prepareWorkspaceInputs(driver, cwd)).rejects.toThrow('requires python3');
    writeFileSync(file, manifest('linked'));
    await expect(prepareWorkspaceInputs(driver, cwd)).rejects.toThrow('subproject directory unavailable');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for(const subproject of ['.','apps/web'])test(`legacy npm ci in ${subproject} is prepared once through the installation receipt before checks`,async()=>{
 mkdirSync('.private',{recursive:true});
 const cwd=mkdtempSync(process.cwd()+'/.private/validation-prepare-');
 try {
  const packageRoot=join(cwd,subproject);
  mkdirSync(packageRoot,{recursive:true});mkdirSync(cwd+'/bin');
  writeFileSync(packageRoot+'/package.json',JSON.stringify({dependencies:{fixture:'1.0.0'}}));
  writeFileSync(packageRoot+'/package-lock.json','{}');
  writeFileSync(cwd+'/bin/npm','#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\necho install >> calls\nmkdir -p node_modules\n',{mode:0o755});
  const commands=[{label:'dependencies',argv:['/usr/bin/env','PATH='+cwd+'/bin:'+process.env.PATH,'npm','--prefix',subproject,'ci','--prefer-offline','--no-audit','--no-fund']}];
  const driver=new LocalDriver();
  await prepareWorkspaceInputs(driver,cwd,undefined,commands);
  expect(existsSync(packageRoot+'/node_modules')).toBe(true);
  await prepareWorkspaceInputs(driver,cwd,undefined,commands);
  expect(readFileSync(packageRoot+'/calls','utf8').trim().split('\n')).toHaveLength(1);
 } finally {rmSync(cwd,{recursive:true,force:true});}
});
