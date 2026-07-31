import { describe, expect, test } from 'bun:test';
import type { RunToolEvent } from '../../lib/runstream';
import { cmdHeadView, commandLine } from './cmdview';

function cmd(ev: Partial<RunToolEvent>): RunToolEvent {
  return { kind: 'command', seq: 0, tool: 'Bash', status: 'ok', ...ev };
}

describe('commandLine', () => {
  test('去掉 toolfmt 的前导 `$ `', () => {
    expect(commandLine(cmd({ input: '$ ls -l' }))).toBe('ls -l');
    expect(commandLine(cmd({ input: '$ git status' }))).toBe('git status');
    expect(commandLine(cmd({ input: '$echo hi' }))).toBe('echo hi');
  });

  test('无 $ 前缀的 input 原样', () => {
    expect(commandLine(cmd({ input: 'npm test' }))).toBe('npm test');
  });

  test('无 input → 退化 title（去 💻）→ tool 名', () => {
    expect(commandLine(cmd({ input: undefined, title: '💻 npm run build' }))).toBe('npm run build');
    expect(commandLine(cmd({ input: undefined, title: undefined, tool: 'shell' }))).toBe('shell');
  });
});

describe('cmdHeadView', () => {
  test('折叠态：命令 + 耗时 + stdout 预览；hasOut 为真', () => {
    const h = cmdHeadView(cmd({ input: '$ ls', result: 'a\nb\nc', durationMs: 500 }), false);
    expect(h.cmd).toBe('ls');
    expect(h.dur).toBe('500ms');
    expect(h.preview).toBe('a b c');
    expect(h.hasOut).toBe(true);
  });

  test('展开态不出预览', () => {
    const h = cmdHeadView(cmd({ input: '$ ls', result: 'x' }), true);
    expect(h.preview).toBe('');
    expect(h.hasOut).toBe(true);
  });

  test('运行中（无结果）：无预览、无耗时、hasOut 假', () => {
    const h = cmdHeadView(cmd({ input: '$ sleep 9', status: 'running', result: undefined }), false);
    expect(h.preview).toBe('');
    expect(h.dur).toBe('');
    expect(h.hasOut).toBe(false);
  });
});
