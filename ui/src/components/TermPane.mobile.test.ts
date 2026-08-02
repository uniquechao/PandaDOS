import { describe, expect, test } from 'bun:test';
import {
  bindTermTouchScroll,
  createTermTouchScrollController,
  type TermTouchEvent,
  type TermTouchPoint,
} from './termTouchScroll';

const MOBILE_ENTRIES = [
  {
    name: '项目独立终端页',
    sourceUrl: new URL('../views/Term.tsx', import.meta.url),
    sourceChecks: [
      "from '../components/TermPane'",
      "<TermPane pid={pid} target={{ kind: 'bash' }} onStatus={setStatus} />",
    ],
  },
  {
    name: 'issue「执行→原生」',
    sourceUrl: new URL('../views/IssueDetail.tsx', import.meta.url),
    sourceChecks: [
      '<NativeModeSwitch mode={mode} onChange={setMode} />',
      '<ExecNative pid={pid} issue={issue} seg={seg} />',
      "import('../components/TermPane')",
      "target={{ kind: 'issue', issueId: issue.id }}",
      "closedMessage={tr('issue.nativeSessionUnavailable')}",
    ],
  },
] as const;

class MobileTouchTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, value: TermTouchEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(value as unknown as Event);
    }
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

function touch(y: number, x = 0): TermTouchPoint {
  return { clientX: x, clientY: y };
}

function event(touches: readonly TermTouchPoint[]): TermTouchEvent {
  return { touches, preventDefault() {} };
}

function swipe(target: MobileTouchTarget, fromY: number, toY: number): void {
  target.dispatch('touchstart', event([touch(fromY)]));
  target.dispatch('touchmove', event([touch(toY)]));
  target.dispatch('touchend', event([]));
}

function mountTerminalSession(initialLine = 200, maxLine = 200): {
  target: MobileTouchTarget;
  position(): number;
  cleanup(): void;
} {
  const target = new MobileTouchTarget();
  let line = initialLine;
  const controller = createTermTouchScrollController({
    getCellHeight: () => 10,
    scrollLines: (amount) => {
      line = Math.max(0, Math.min(maxLine, line + amount));
    },
  });
  const cleanup = bindTermTouchScroll(target as unknown as HTMLElement, controller);
  return { target, position: () => line, cleanup };
}

describe('两个移动端终端入口', () => {
  for (const entry of MOBILE_ENTRIES) {
    test(`${entry.name} 复用共享 TermPane`, async () => {
      const source = await Bun.file(entry.sourceUrl).text();
      for (const expected of entry.sourceChecks) expect(source).toContain(expected);
    });

    test(`${entry.name} 长输出可上翻并下翻回到底部`, () => {
      const session = mountTerminalSession();

      swipe(session.target, 100, 200);
      expect(session.position()).toBe(190);

      swipe(session.target, 200, 100);
      expect(session.position()).toBe(200);
      session.cleanup();
    });

    test(`${entry.name} 断线重连会清理旧监听并为新会话重新绑定`, () => {
      const oldSession = mountTerminalSession();
      expect(oldSession.target.listenerCount()).toBe(4);
      oldSession.cleanup();
      expect(oldSession.target.listenerCount()).toBe(0);

      swipe(oldSession.target, 100, 200);
      expect(oldSession.position()).toBe(200);

      const newSession = mountTerminalSession();
      swipe(newSession.target, 100, 200);
      expect(newSession.position()).toBe(190);
      newSession.cleanup();
      expect(newSession.target.listenerCount()).toBe(0);
    });
  }
});

describe('TermPane 重连与卸载生命周期', () => {
  test('断线展示手动重连入口，并通过 gen 重建整套终端会话', async () => {
    const source = await Bun.file(new URL('./TermPane.tsx', import.meta.url)).text();

    expect(source).toContain("status === 'closed' || status === 'exit'");
    expect(source).toContain('setGen((g) => g + 1)');
    expect(source).toMatch(/useEffect\([\s\S]*?\}, \[pid, targetKey, gen\]\);/);
  });

  test('组件卸载先解绑触摸监听，再销毁 xterm', async () => {
    const source = await Bun.file(new URL('./TermPane.tsx', import.meta.url)).text();
    const unbindAt = source.indexOf('unbindTouchScroll();');
    const disposeAt = source.indexOf('term.dispose();');

    expect(unbindAt).toBeGreaterThan(-1);
    expect(disposeAt).toBeGreaterThan(unbindAt);
  });
});
