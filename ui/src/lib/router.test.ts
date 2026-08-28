import { describe, expect, test } from 'bun:test';
import { parseHash } from './router';

describe('项目配置路由', () => {
  test('解析项目配置页且不影响账户设置页', () => {
    expect(parseHash('#/p/12/settings')).toEqual({ name: 'project-settings', pid: 12 });
    expect(parseHash('#/p/12/external-issues')).toEqual({ name: 'external-issues', pid: 12 });
    expect(parseHash('#/p/12/workflows')).toEqual({ name: 'workflows', pid: 12 });
    expect(parseHash('#/settings')).toEqual({ name: 'settings' });
  });
});

describe('设计工作区路由', () => {
  test('解析列表与正整数详情深链', () => {
    expect(parseHash('#/p/12/designs')).toEqual({ name: 'designs', pid: 12 });
    expect(parseHash('#/p/12/designs/7')).toEqual({ name: 'design', pid: 12, did: 7 });
  });

  test('非法 design id 回落列表而不是伪造 id=0', () => {
    expect(parseHash('#/p/12/designs/0')).toEqual({ name: 'designs', pid: 12 });
    expect(parseHash('#/p/12/designs/nope')).toEqual({ name: 'designs', pid: 12 });
  });
});
