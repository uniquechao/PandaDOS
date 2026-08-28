import { describe, expect, test } from 'bun:test';
import {
  bindTermTouchScroll,
  createTermTouchScrollController,
  type TermTouchEvent,
  type TermTouchPoint,
} from './termTouchScroll';

/**
 * 移动端终端滚动的可执行契约。
 *
 * 控制器行为用普通测试约束；TermPane 的事件接入属于后续子任务，继续用
 * test.failing 记录当前缺失通路，避免在本子任务提前改动组件。
 */

function createHarness(cellHeight = 10): {
  controller: ReturnType<typeof createTermTouchScrollController>;
  lines: number[];
} {
  const lines: number[] = [];
  const controller = createTermTouchScrollController({
    getCellHeight: () => cellHeight,
    scrollLines: (amount) => lines.push(amount),
  });
  return { controller, lines };
}

function touch(y: number, x = 0): TermTouchPoint {
  return { clientX: x, clientY: y };
}

function event(touches: readonly TermTouchPoint[]): TermTouchEvent & { prevented: boolean } {
  return {
    touches,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

describe('移动端终端触摸滚动控制器', () => {
  test('单指纵向滑动按终端行高触发滚动', () => {
    const { controller, lines } = createHarness(12);
    controller.onTouchStart(event([touch(100)]));
    const move = event([touch(76)]);

    controller.onTouchMove(move);

    expect(lines).toEqual([2]);
    expect(move.prevented).toBe(true);
  });

  test('手指上滑换算为正行数，下滑换算为负行数', () => {
    const { controller, lines } = createHarness();
    controller.onTouchStart(event([touch(100)]));
    controller.onTouchMove(event([touch(80)]));
    controller.onTouchMove(event([touch(110)]));

    expect(lines).toEqual([2, -3]);
  });

  test('不足一行的像素余量跨多次 move 累计', () => {
    const { controller, lines } = createHarness();
    controller.onTouchStart(event([touch(100)]));

    controller.onTouchMove(event([touch(94)]));
    expect(lines).toEqual([]);
    controller.onTouchMove(event([touch(88)]));
    expect(lines).toEqual([1]);
    controller.onTouchMove(event([touch(80)]));
    expect(lines).toEqual([1, 1]);
  });

  test('多指开始和多指移动均不触发终端滚动', () => {
    const { controller, lines } = createHarness();
    controller.onTouchStart(event([touch(100), touch(120)]));
    controller.onTouchMove(event([touch(70), touch(90)]));

    expect(lines).toEqual([]);

    controller.onTouchStart(event([touch(100)]));
    controller.onTouchMove(event([touch(80), touch(90)]));

    expect(lines).toEqual([]);

    controller.onTouchEnd();
    controller.onTouchStart(event([touch(100)]));
    controller.onTouchMove(event([touch(80)]));

    expect(lines).toEqual([2]);
  });

  test('手势结束会清空坐标和像素余量，下一次手势重新计算', () => {
    const { controller, lines } = createHarness();
    controller.onTouchStart(event([touch(100)]));
    controller.onTouchMove(event([touch(94)]));
    controller.onTouchEnd();
    controller.onTouchMove(event([touch(80)]));

    controller.onTouchStart(event([touch(50)]));
    controller.onTouchMove(event([touch(40)]));

    expect(lines).toEqual([1]);
  });

  test('未超过判向阈值的轻微移动不滚动也不阻止默认输入行为', () => {
    const { controller, lines } = createHarness();
    controller.onTouchStart(event([touch(100, 20)]));
    const move = event([touch(97, 21)]);

    controller.onTouchMove(move);

    expect(lines).toEqual([]);
    expect(move.prevented).toBe(false);
  });

  test('横向占优后整段手势不滚动也不阻止页面默认行为', () => {
    const { controller, lines } = createHarness();
    controller.onTouchStart(event([touch(100, 0)]));
    const horizontal = event([touch(96, 20)]);
    const laterVertical = event([touch(60, 25)]);

    controller.onTouchMove(horizontal);
    controller.onTouchMove(laterVertical);

    expect(lines).toEqual([]);
    expect(horizontal.prevented).toBe(false);
    expect(laterVertical.prevented).toBe(false);
  });
});

class FakeTouchTarget {
  readonly added: Array<{ type: string; passive: boolean | undefined }> = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    const passive = typeof options === 'object' ? options.passive : undefined;
    this.added.push({ type, passive });
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
}

describe('终端触摸事件绑定', () => {
  test('注册非被动监听、转发手势并在清理后彻底解绑', () => {
    const target = new FakeTouchTarget();
    const { controller, lines } = createHarness();
    const cleanup = bindTermTouchScroll(target as unknown as HTMLElement, controller);

    expect(target.added).toEqual([
      { type: 'touchstart', passive: false },
      { type: 'touchmove', passive: false },
      { type: 'touchend', passive: false },
      { type: 'touchcancel', passive: false },
    ]);

    target.dispatch('touchstart', event([touch(100)]));
    target.dispatch('touchmove', event([touch(80)]));
    expect(lines).toEqual([2]);

    cleanup();
    target.dispatch('touchstart', event([touch(100)]));
    target.dispatch('touchmove', event([touch(80)]));
    expect(lines).toEqual([2]);
  });
});

describe('TermPane 触摸滚动接入', () => {
  test('TermPane 建立触摸事件到普通 xterm 或备用 tmux 历史的共享通路', async () => {
    const source = await Bun.file(new URL('./TermPane.tsx', import.meta.url)).text();

    expect(source).toContain('createTermTouchScrollController');
    expect(source).toContain('bindTermTouchScroll');
    expect(source).toContain("term.buffer.active.type === 'alternate'");
    expect(source).toContain('term.scrollLines(lines)');
    expect(source).toContain('sendTermScroll(lines)');
    expect(source).toContain('.xterm-screen');
  });
});
