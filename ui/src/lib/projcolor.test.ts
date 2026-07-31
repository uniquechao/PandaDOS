/**
 * projcolor 单测：图标色块/首字母必须「确定性」——同名同色，方便一眼认项目。
 */
import { describe, expect, test } from 'bun:test';
import { projAvatar, projColor, projInitial } from './projcolor';

describe('projInitial', () => {
  test('拉丁字母 → 大写首字母', () => {
    expect(projInitial('tmux-butler')).toBe('T');
    expect(projInitial('anthology')).toBe('A');
  });
  test('前导空格忽略', () => {
    expect(projInitial('  yubin')).toBe('Y');
  });
  test('中文取首字（不改动）', () => {
    expect(projInitial('曼拓项目')).toBe('曼');
  });
  test('数字/符号取首字符', () => {
    expect(projInitial('3d-engine')).toBe('3');
  });
  test('空名 → #', () => {
    expect(projInitial('')).toBe('#');
    expect(projInitial('   ')).toBe('#');
  });
});

describe('projColor', () => {
  test('确定性：同种子同色', () => {
    expect(projColor('anthology')).toEqual(projColor('anthology'));
  });
  test('不同种子一般不同色相', () => {
    expect(projColor('anthology')).not.toEqual(projColor('tmux-butler'));
  });
  test('输出是合法 hsl 三元组', () => {
    const c = projColor('yubin');
    expect(c.bg).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    expect(c.fg).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    expect(c.ring).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });
});

describe('projAvatar', () => {
  test('合成 首字母 + 配色，且与分件一致', () => {
    const a = projAvatar({ name: 'tmux-butler' });
    expect(a.initial).toBe('T');
    expect({ bg: a.bg, fg: a.fg, ring: a.ring }).toEqual(projColor('tmux-butler'));
  });
});
