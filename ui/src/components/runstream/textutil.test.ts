/** runstream 纯文本小工具单测：折叠态预览 + 服务端截断标记探测（issue #288）。 */
import { describe, expect, test } from 'bun:test';
import { firstLine, isClipped } from './textutil';

describe('firstLine', () => {
  test('压成单行、超长加省略号', () => {
    expect(firstLine('第一行\n第二行   第三行', 100)).toBe('第一行 第二行 第三行');
    expect(firstLine('abcdefghij', 4)).toBe('abcd…');
  });
});

describe('isClipped（服务端截断标记）', () => {
  test('认得 brief 的换行式标记与 toolfmt 的行内标记', () => {
    expect(isClipped('头部\n…[省略12345字]…\n尾部')).toBe(true); // core/jsonl brief
    expect(isClipped('$ ls …[省略80字]… -la')).toBe(true); // core/toolfmt clip
  });

  test('没被截的正文不出按钮：无标记 / 缺省 / 形似但不合规都判 false', () => {
    expect(isClipped('普通的一段结果')).toBe(false);
    expect(isClipped(undefined)).toBe(false);
    expect(isClipped('')).toBe(false);
    expect(isClipped('…[省略若干字]…')).toBe(false); // 必须是数字
    expect(isClipped('[省略12字]')).toBe(false); // 必须带前后省略号
  });
});
