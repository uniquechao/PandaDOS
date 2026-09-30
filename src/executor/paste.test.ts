import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pasteTextWithTmux, sanitizeInjectText } from './driver';
import { LocalDriver, runCommand } from './local';

test('并发粘贴使用独立缓存，原文作为参数且提交不夹带 Enter', async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); return { code: 0, out: '', err: '' }; };
  const text = "中文 '; $(touch should-not-exist) `id`";
  await Promise.all([pasteTextWithTmux(run, 'left', text), pasteTextWithTmux(run, 'right', text)]);
  const sets = calls.filter(c => c[0] === 'set-buffer');
  expect(new Set(sets.map(c => c[2])).size).toBe(2);
  expect(sets.every(c => c.at(-1) === text)).toBe(true);
  expect(calls.filter(c => c[0] === 'paste-buffer').every(c => c.includes('-p') && c.includes('-d'))).toBe(true);
  expect(calls.flat()).not.toContain('Enter');
});

test('粘贴失败清理缓存，保留原始错误', async () => {
  const calls: string[][] = [];
  await expect(pasteTextWithTmux(async args => {
    calls.push(args);
    return { code: args[0] === 'paste-buffer' ? 1 : 0, out: '', err: 'missing pane' };
  }, 'missing', 'prompt')).rejects.toThrow('missing pane');
  expect(calls.map(c => c[0])).toEqual(['set-buffer', 'paste-buffer', 'delete-buffer']);
  expect(calls[2]![2]).toBe(calls[0]![2]);
});

for (const bracketed of [true, false]) {
  test.skipIf(!Bun.which('tmux') || !Bun.which('python3'))(`真实 tmux 58×38：${bracketed ? '显式粘贴事件' : '非粘贴终端兼容'}，长中文完整提交一次`, async () => {
    await mkdir('.panda/tmp', { recursive: true });
    const dir = await mkdtemp('.panda/tmp/paste-test-');
    const socket = resolve(dir, 'tmux.sock');
    const output = resolve(dir, 'received.json');
    const script = resolve(dir, 'terminal.py');
    await writeFile(script, `import os,sys,tty,json,time
tty.setraw(0)
os.write(1, b'\\x1b[?2004${bracketed ? 'h' : 'l'}READY\\r\\n')
data=b''
while True:
 data+=os.read(0,65536)
 if b'\\x1b[201~' in data and not b'\\r' in data:
  os.write(1, b'\\r\\n'+'› [Pasted text]'.encode()+b'\\r\\n')
 if b'\\r' in data:
  with open(sys.argv[1],'w') as f: json.dump(data.decode(),f)
  os.write(1,b'\\r\\n'+'• Working'.encode()+b'\\r\\n')
  time.sleep(30)
  break
`);
    const tmux = (args: string[]) => runCommand('tmux', ['-S', socket, ...args]);
    try {
      const started = await tmux(['new-session', '-d', '-s', 'probe', '-x', '58', '-y', '38', 'python3', script, output]);
      expect(started.code).toBe(0);
      for (let i = 0; i < 30; i++) {
        if ((await tmux(['capture-pane', '-p', '-t', 'probe'])).out.includes('READY')) break;
        await Bun.sleep(50);
      }
      const driver = new LocalDriver();
      Object.defineProperty(driver, 'tmux', { value: tmux });
      const text = sanitizeInjectText("中文 $() `id` '; " + '完整任务输入'.repeat(400));
      await driver.sendKeys('probe', text);
      expect(JSON.parse(await readFile(output, 'utf8'))).toBe(bracketed ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`);
      const buffers = await tmux(['list-buffers']);
      expect(buffers.out).not.toContain('panda-input-');
    } finally {
      await tmux(['kill-server']);
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
}
