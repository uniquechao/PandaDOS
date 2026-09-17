import { describe, expect, test } from 'bun:test';
import { BRAND_TITLE, docTitle } from './docTitle';

describe('docTitle', () => {
  test('有项目名时拼成「项目名-PandaDOS」', () => {
    expect(docTitle('panda')).toBe('panda-PandaDOS');
    expect(docTitle('全体页面布局')).toBe('全体页面布局-PandaDOS');
  });

  test('名称首尾空白被裁掉', () => {
    expect(docTitle('  panda  ')).toBe('panda-PandaDOS');
  });

  test('空名 / 全空白 / 未传 / null 时只留品牌名', () => {
    expect(docTitle('')).toBe(BRAND_TITLE);
    expect(docTitle('   ')).toBe(BRAND_TITLE);
    expect(docTitle()).toBe(BRAND_TITLE);
    expect(docTitle(null)).toBe(BRAND_TITLE);
  });
});
