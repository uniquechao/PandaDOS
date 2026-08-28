import { describe, expect, test } from 'bun:test';
import {
  createTermWheelScrollController,
  type TermWheelEvent,
} from './termWheelScroll';

function wheel(deltaY: number, deltaMode = 0): TermWheelEvent & { prevented: boolean } {
  return {
    deltaY,
    deltaMode,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

describe('终端鼠标与触控板滚动控制器', () => {
  test('普通缓冲区完整交还 xterm 自身处理', () => {
    const lines: number[] = [];
    const controller = createTermWheelScrollController({
      getCellHeight: () => 10,
      getPageRows: () => 24,
      scrollLines: (amount) => lines.push(amount),
    });
    const event = wheel(-30);

    expect(controller.onWheel(event, 'normal')).toBe(true);
    expect(event.prevented).toBe(false);
    expect(lines).toEqual([]);
  });

  test('备用缓冲区阻止 xterm 方向键降级，并把滚轮方向换算成历史滚动行数', () => {
    const lines: number[] = [];
    const controller = createTermWheelScrollController({
      getCellHeight: () => 10,
      getPageRows: () => 24,
      scrollLines: (amount) => lines.push(amount),
    });
    const up = wheel(-25);
    const down = wheel(30);

    expect(controller.onWheel(up, 'alternate')).toBe(false);
    expect(controller.onWheel(down, 'alternate')).toBe(false);
    expect(up.prevented).toBe(true);
    expect(down.prevented).toBe(true);
    expect(lines).toEqual([-2, 2]);
  });

  test('触控板不足一行的像素余量会累计，line/page 模式直接按行语义换算', () => {
    const lines: number[] = [];
    const controller = createTermWheelScrollController({
      getCellHeight: () => 10,
      getPageRows: () => 20,
      scrollLines: (amount) => lines.push(amount),
    });

    controller.onWheel(wheel(-4), 'alternate');
    controller.onWheel(wheel(-7), 'alternate');
    controller.onWheel(wheel(3, 1), 'alternate');
    controller.onWheel(wheel(-1, 2), 'alternate');

    expect(lines).toEqual([-1, 3, -20]);
  });
});
