import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { testTmuxDirectory } from '../../scripts/test-tmux';
import { tmuxNewSessionArgs } from './driver';
import { runCommand } from './local';

test.skipIf(!Bun.which('tmux'))('workspace environment belongs to new-session before resize-window (real tmux)', async () => {
  const dir = testTmuxDirectory();
  const socket = resolve(dir, 'tmux.sock');
  const tmux = (args: string[]) => runCommand('tmux', ['-S', socket, '-f', '/dev/null', ...args]);
  try {
    const value = 'workspace value with spaces';
    const result = await tmux(tmuxNewSessionArgs('probe', resolve(dir), { PANDA_ENV_PROBE: value }));
    expect(result).toMatchObject({ code: 0, err: '' });
    const pane = await tmux(['display-message', '-p', '-t', 'probe', '#{pane_pid}']);
    const { readFile } = await import('node:fs/promises');
    const environment = await readFile(`/proc/${pane.out.trim()}/environ`);
    expect(environment.toString().split('\0')).toContain(`PANDA_ENV_PROBE=${value}`);
    expect((await tmux(['show-window-options', '-v', '-t', 'probe', 'window-size'])).out.trim()).toBe('manual');
  } finally {
    await tmux(['kill-server']).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
