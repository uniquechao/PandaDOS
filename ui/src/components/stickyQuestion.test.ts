import { describe, expect, test } from 'bun:test';
import { questionAtTop, questionAttachments } from './questionPosition';

describe('阅读轮次吸顶边界', () => {
  const first = { top: -100, bottom: -20 };
  test('原提问完全离开顶部后才显示，部分可见时隐藏', () => {
    expect(questionAtTop([{ top: -100, bottom: 1 }], 0)).toBeNull();
    expect(questionAtTop([{ top: -100, bottom: 0 }], 0)).not.toBeNull();
    expect(questionAtTop([], 0)).toBeNull();
  });
  test('下一提问进入阅读区顶部时让位，完全越顶后切换；反向同样适用', () => {
    expect(questionAtTop([first, { top: 10, bottom: 60 }], 0)).toBe(first);
    expect(questionAtTop([first, { top: 95, bottom: 150 }], 0)).toBe(first);
    expect(questionAtTop([first, { top: 0, bottom: 150 }], 0)).toBeNull();
    const second = { top: -50, bottom: -1 };
    expect(questionAtTop([first, second], 0)).toBe(second);
    expect(questionAtTop([first, { top: -10, bottom: 60 }], 0)).toBeNull();
    expect(questionAtTop([first, { top: 100, bottom: 160 }], 0)).toBe(first);
  });
  test('新消息到达但位于阅读区下方时保持历史轮次', () => {
    expect(questionAtTop([first, { top: 1000, bottom: 1080 }], 0)).toBe(first);
  });
  test('支持窗口偏移及前插历史后的相同几何位置', () => {
    const current = { top: 100, bottom: 200 };
    expect(questionAtTop([{ top: -1000, bottom: -900 }, current], 250)).toBe(current);
  });
  test('纯附件提问保留图片和文件名称', () => {
    expect(questionAttachments({ images: ['.panda/uploads/a/image.png'], files: ['docs/需求.pdf'] }))
      .toEqual(['image.png', '需求.pdf']);
    expect(questionAttachments({})).toEqual([]);
  });
});
