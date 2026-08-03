import { describe, expect, test } from 'bun:test';
import { parseHash } from './router';

describe('项目配置路由', () => {
  test('解析项目配置页且不影响账户设置页', () => {
    expect(parseHash('#/p/12/settings')).toEqual({ name: 'project-settings', pid: 12 });
    expect(parseHash('#/p/12/external-issues')).toEqual({ name: 'external-issues', pid: 12 });
    expect(parseHash('#/settings')).toEqual({ name: 'settings' });
  });
});
