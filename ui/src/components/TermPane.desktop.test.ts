import { describe, expect, test } from 'bun:test';

const termPaneUrl = new URL('./TermPane.tsx', import.meta.url);

describe('TermPane PC 端回归', () => {
  test('按原生目标构造终端 WS 地址，且 bash 不携带会话选择器', async () => {
    const { buildTermWsPath } = await import('./TermPane');

    expect(buildTermWsPath(42, { kind: 'bash' }, 80, 24)).toBe('/ws/term/42?cols=80&rows=24');
    expect(buildTermWsPath(42, { kind: 'issue', issueId: 7 }, 80, 24)).toBe(
      '/ws/term/42?issue=7&cols=80&rows=24',
    );
    expect(buildTermWsPath(42, { kind: 'conversation', convId: 'chat-7' }, 80, 24)).toBe(
      '/ws/term/42?conv=chat-7&cols=80&rows=24',
    );
  });

  test('公开的终端目标与面板 props 都要求调用方选择目标', async () => {
    const source = await Bun.file(termPaneUrl).text();

    expect(source).toContain("export type NativeTarget = { kind: 'bash' } | { kind: 'issue'; issueId: number } | { kind: 'conversation'; convId: string };");
    expect(source).toContain('export function TermPane({ pid, target, onStatus, closedMessage }');
  });

  test('断线遮罩允许宿主提供不可接管状态的说明文案', async () => {
    const source = await Bun.file(termPaneUrl).text();

    expect(source).toContain('closedMessage?: string;');
    expect(source).toContain("{status === 'closed' ? (closedMessage ?? tr('ui.terminalDisconnected')) : tr('ui.terminalEnded')}");
  });

  test('xterm、fit addon 与样式在面板 effect 内按需加载，并规避卸载竞态', async () => {
    const source = await Bun.file(termPaneUrl).text();

    expect(source).not.toContain("import { Terminal } from '@xterm/xterm';");
    expect(source).not.toContain("import { FitAddon } from '@xterm/addon-fit';");
    expect(source).toContain("import('@xterm/xterm')");
    expect(source).toContain("import('@xterm/addon-fit')");
    expect(source).toContain("import('@xterm/xterm/css/xterm.css')");
    expect(source).toContain('let disposed = false;');
    expect(source).toContain('if (disposed) return;');
    expect(source).toContain('if (disposed || exited) return;');
    expect(source).toContain('conn.send(JSON.stringify({ type:');
  });

  test('通过 xterm 自定义 wheel 钩子区分普通与备用缓冲区', async () => {
    const source = await Bun.file(termPaneUrl).text();

    expect(source).toContain('createTermWheelScrollController');
    expect(source).toContain('term.attachCustomWheelEventHandler');
    expect(source).toContain('term.buffer.active.type');
    expect(source).not.toMatch(/addEventListener\(['"]wheel/);
  });

  test('滚动控制帧保留方向语义并限制单帧行数', async () => {
    const { buildTermScrollFrame } = await import('./TermPane');

    expect(buildTermScrollFrame(-12)).toEqual({ type: 'scroll', direction: 'up', lines: 12 });
    expect(buildTermScrollFrame(8)).toEqual({ type: 'scroll', direction: 'down', lines: 8 });
    expect(buildTermScrollFrame(999)).toEqual({ type: 'scroll', direction: 'down', lines: 100 });
    expect(buildTermScrollFrame(0)).toBeNull();
  });

  test('终端右侧提供共用的上下翻页按钮', async () => {
    const [source, css] = await Promise.all([
      Bun.file(termPaneUrl).text(),
      Bun.file(new URL('../style.css', import.meta.url)).text(),
    ]);

    expect(source).toContain('class="term-scroll-controls"');
    expect(source).toContain("aria-label={tr('ui.terminalPageUp')}");
    expect(source).toContain("aria-label={tr('ui.terminalPageDown')}");
    expect(source).toContain('sendPageScroll(-1)');
    expect(source).toContain('sendPageScroll(1)');
    expect(css).toContain('.term-scroll-controls');
    expect(css).toContain('.term-scroll-btn:focus-visible');
  });

  test('终端键盘输入仍编码后写入当前 WebSocket', async () => {
    const source = await Bun.file(termPaneUrl).text();

    expect(source).toContain('const enc = new TextEncoder();');
    expect(source).toMatch(/term\.onData\(\(d: string\) => \{[\s\S]*?conn\.send\(enc\.encode\(d\)\)/);
    expect(source).toContain('dataSub.dispose();');
  });

  test('底部快捷键保留完整键位并写入当前 WebSocket', async () => {
    const source = await Bun.file(termPaneUrl).text();
    const expectedKeys = [
      "['Esc', '\\x1b']",
      "['Tab', '\\t']",
      "['^C', '\\x03']",
      "['^D', '\\x04']",
      "['↑', '\\x1b[A']",
      "['↓', '\\x1b[B']",
      "['←', '\\x1b[D']",
      "['→', '\\x1b[C']",
      "['⏎', '\\r']",
    ];

    for (const key of expectedKeys) expect(source).toContain(key);
    expect(source).toContain('TERM_KEYS.map(([label, bytes]) =>');
    expect(source).toContain('onClick={() => writeKey(bytes)}');
    expect(source).toContain('wsRef.current?.send(new TextEncoder().encode(bytes));');
  });

  test('终端尺寸初始化及 ResizeObserver 调整通路保持完整', async () => {
    const source = await Bun.file(termPaneUrl).text();

    expect(source).toContain('fit.fit();');
    expect(source).toContain("JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })");
    expect(source).toContain('new ResizeObserver(() => sendResize())');
    expect(source).toContain('ro.observe(box);');
    expect(source).toContain('ro.disconnect();');
  });
});
