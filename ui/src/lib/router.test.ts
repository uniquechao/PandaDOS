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

describe('对话路由', () => {
  test('解析带对话 id 的深链', () => {
    expect(parseHash('#/p/3/chat')).toEqual({ name: 'chat', pid: 3 });
    expect(parseHash('#/p/3/chat/9f192461-16f4-4712-b604-2c7d33a56b74')).toEqual({
      name: 'chat',
      pid: 3,
      cid: '9f192461-16f4-4712-b604-2c7d33a56b74',
    });
  });

  test('畸形 cid 回落到不带 id 的对话页（不伪造选中项）', () => {
    expect(parseHash('#/p/3/chat/bad id')).toEqual({ name: 'chat', pid: 3 });
    expect(parseHash('#/p/3/chat/%E4%B8%AD')).toEqual({ name: 'chat', pid: 3 });
    expect(parseHash('#/p/3/chat/%')).toEqual({ name: 'chat', pid: 3 }); // 半截转义不能把路由炸掉
  });
});
