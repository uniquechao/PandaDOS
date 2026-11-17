import { posix } from 'node:path';
import type { ValidationCommand } from '../core/types';
import { DependencyPreparationError } from './dependency-preparation';

export interface ValidationPreparation {
  command: ValidationCommand;
  cwd: string;
  argv: string[];
  env: Record<string,string>;
  kind: 'node'|'uv';
}

function invalid(): never {
  throw new DependencyPreparationError('validation_preparation: use a frozen install without package mutations, in a workspace subdirectory');
}

/** Recognize argv, never shell text or labels. Preserve explicit installer options. */
export function splitValidationCommands(commands: readonly ValidationCommand[]) {
  const checks: ValidationCommand[] = [], preparation: ValidationPreparation[] = [];
  for(const command of commands) {
    const argv=[...command.argv],env:Record<string,string>={};
    let index=0;
    if(posix.basename(argv[0]??'')==='env') {
      index++;
      while(/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index]??'')) {
        const value=argv[index++]!,equal=value.indexOf('=');env[value.slice(0,equal)]=value.slice(equal+1);
      }
      if(argv[index]==='--')index++;
    }
    const executable=argv[index],manager=posix.basename(executable??'');
    if(!['npm','pnpm','yarn','bun','uv'].includes(manager)) {checks.push(command);continue;}
    let cwd=command.cwd??'.';
    const args:string[]=[],paths:string[]=[];
    for(let n=index+1;n<argv.length;n++) {
      const arg=argv[n]!;
      if(['--prefix','--cwd','--dir','-C','--project'].includes(arg)) {
        paths.push(argv[++n]??'');
      } else if(/^(--prefix|--cwd|--dir|--project)=/.test(arg)) {
        paths.push(arg.slice(arg.indexOf('=')+1));
      }
      else args.push(arg);
    }
    const action=args[0];
    const frozen=manager==='npm'&&action==='ci' || manager==='uv'&&action==='sync'&&args.includes('--locked') ||
      ['pnpm','yarn','bun'].includes(manager)&&action==='install'&&(args.includes('--frozen-lockfile')||args.includes('--immutable'));
    if(!frozen) {
      if(['install','ci','add','remove','uninstall','update','upgrade','sync'].includes(action??''))invalid();
      checks.push(command);continue;
    }
    // Installer positional package names would mutate the requested dependency set.
    if(args.slice(1).some(arg=>!arg.startsWith('-')))invalid();
    if(args.some(arg=>/^--(omit=dev|production(?:=true)?|prod(?:=true)?)$/.test(arg)))invalid();
    for(const path of paths) {if(!path||posix.isAbsolute(path))invalid();cwd=posix.join(cwd,path);}
    if(cwd!=='.' && (!/^[\w-][\w.-]*(\/[\w-][\w.-]*)*$/.test(cwd)||cwd.split('/').some(part=>part==='.'||part==='..')))invalid();
    const prepared={command,cwd,argv:[executable!,...args],env,kind:manager==='uv'?'uv' as const:'node' as const};
    const duplicate=preparation.find(entry=>entry.cwd===cwd);
    if(duplicate) {
      const identity=(entry:ValidationPreparation)=>JSON.stringify([entry.argv,Object.entries(entry.env).sort()]);
      if(identity(duplicate)!==identity(prepared))invalid();
    } else preparation.push(prepared);
  }
  return {checks,preparation};
}
