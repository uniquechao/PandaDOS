import { describe, expect, test } from 'bun:test';
import { admitHash, parseHash, resetLeaveGuardForTest, setLeaveGuard, type Route } from './router';

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

describe('文件页旧深链（issue #310）→ 工作区（#388）', () => {
  test('不带路径 → 工作区全部文件', () => {
    expect(parseHash('#/p/3/files')).toEqual({ name: 'workspace', pid: 3, loc: { view: 'files' } });
  });

  test('路径整体转义成一段，不被 split("/") 拆开；目录保留尾斜杠', () => {
    expect(parseHash('#/p/3/files/docs%2Fa.md')).toEqual({
      name: 'workspace',
      pid: 3,
      loc: { view: 'files', path: 'docs/a.md' },
    });
    expect(parseHash('#/p/3/files/runs%2F')).toEqual({ name: 'workspace', pid: 3, loc: { view: 'files', path: 'runs/' } });
  });

  test('半截转义/越界按「没带路径」处理，不崩', () => {
    expect(parseHash('#/p/3/files/%E4%B8')).toEqual({ name: 'workspace', pid: 3, loc: { view: 'files' } });
    expect(parseHash('#/p/3/files/..%2F..%2Fetc')).toEqual({ name: 'workspace', pid: 3, loc: { view: 'files' } });
  });

  test('旧 Git 页 → 工作区当前改动', () => {
    expect(parseHash('#/p/3/git')).toEqual({ name: 'workspace', pid: 3, loc: { view: 'changes' } });
  });
});

describe('工作区深链', () => {
  test('各状态可解析', () => {
    expect(parseHash('#/p/3/workspace')).toEqual({ name: 'workspace', pid: 3, loc: { view: 'files' } });
    expect(parseHash('#/p/3/workspace/changes/staged/src%2Fa.ts')).toEqual({
      name: 'workspace', pid: 3, loc: { view: 'changes', group: 'staged', path: 'src/a.ts' },
    });
    expect(parseHash('#/p/3/workspace/commit/abc1234/a.md')).toEqual({
      name: 'workspace', pid: 3, loc: { view: 'commit', sha: 'abc1234', path: 'a.md' },
    });
    expect(parseHash('#/p/3/workspace/detail/abc1234')).toEqual({ name: 'workspace', pid: 3, loc: { view: 'detail', sha: 'abc1234' } });
    expect(parseHash('#/p/3/workspace/search/content/foo%20bar')).toEqual({
      name: 'workspace', pid: 3, loc: { view: 'search', mode: 'content', q: 'foo bar' },
    });
    expect(parseHash('#/p/3/workspace/commit/not-a-sha')).toEqual({ name: 'workspace', pid: 3, loc: { view: 'files' } });
  });
});


describe('离开守卫（#388 未保存编辑）', () => {
  const fakeLoc = (hash: string) => {
    const loc = {
      hash,
      pathname: '/',
      search: '',
      replaced: [] as string[],
      replace(url: string) { loc.replaced.push(url); loc.hash = url.slice(url.indexOf('#')); },
    };
    return loc;
  };

  test('全局导航离开被拦下：地址栏换回原 hash，确认后 proceed 放行且不再询问', () => {
    resetLeaveGuardForTest();
    const loc = fakeLoc('#/p/1/workspace/files/a.md');
    expect(admitHash(loc)).toBe(true); // 首次结算
    const asked: Route[] = [];
    let proceed: (() => void) | null = null;
    const off = setLeaveGuard((to, go) => {
      if (to.name === 'workspace' && to.pid === 1) return false;
      asked.push(to);
      proceed = go;
      return true;
    });
    // 同工作区内部深链：放行
    loc.hash = '#/p/1/workspace/files/b.md';
    expect(admitHash(loc)).toBe(true);
    // 点项目导航：拦下并恢复
    loc.hash = '#/p/1';
    expect(admitHash(loc)).toBe(false);
    expect(loc.hash).toBe('#/p/1/workspace/files/b.md');
    expect(asked).toEqual([{ name: 'board', pid: 1 }]);
    // 恢复触发的那次 hashchange 放行（路由不变）
    expect(admitHash(loc)).toBe(true);
    // 用户选择放弃/保存 → proceed：直达目标，守卫不再询问
    proceed!();
    expect(loc.hash).toBe('#/p/1');
    expect(admitHash(loc)).toBe(true);
    expect(asked.length).toBe(1);
    off();
    loc.hash = '#/settings';
    expect(admitHash(loc)).toBe(true);
  });

  test('注销只清自己：旧守卫晚于新守卫卸载不会把新守卫清掉', () => {
    resetLeaveGuardForTest();
    const loc = fakeLoc('#/p/1/workspace');
    admitHash(loc);
    const offOld = setLeaveGuard(() => true);
    setLeaveGuard(() => true);
    offOld();
    loc.hash = '#/';
    expect(admitHash(loc)).toBe(false);
    resetLeaveGuardForTest();
  });
});
