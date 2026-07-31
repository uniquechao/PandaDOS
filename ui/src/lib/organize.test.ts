import { describe, expect, test } from 'bun:test';
import {
  actionKindLabel,
  actionLabel,
  hasPendingSuggestion,
  visibleSuggestion,
  type OrganizeActionView,
  type OrganizeStatus,
} from './organize';
import { filterModules } from '../components/ModuleSelect';
import type { ProjectModule } from './types';

function st(actions: OrganizeActionView[], ts = 100): OrganizeStatus {
  return {
    running: false,
    suggestion: { ts, agent: 'claude', moduleCount: 3, actions },
    failed: null,
  };
}
const act = (over: Partial<OrganizeActionView>): OrganizeActionView => ({
  kind: 'create',
  reason: 'r',
  applied: false,
  ...over,
});

describe('actionLabel / actionKindLabel', () => {
  test('四种动作各有人话描述（模块名用事件快照）', () => {
    expect(actionKindLabel('move')).toBe('挪 issue');
    expect(
      actionLabel(act({ kind: 'create', slug: 'file-preview', displayName: '文件预览', agent: 'claude' })),
    ).toBe('新建模块「文件预览」（file-preview · claude）');
    expect(
      actionLabel(
        act({ kind: 'rename', moduleId: 3, moduleName: 'Git 页面', fromSlug: 'legacy-module-01', slug: 'git-pages' }),
      ),
    ).toBe('「Git 页面」：legacy-module-01 → git-pages');
    expect(
      actionLabel(
        act({
          kind: 'rename',
          moduleName: '旧名',
          fromSlug: 'legacy-module-02',
          slug: 'exec-flow',
          displayName: '执行流',
        }),
      ),
    ).toContain('显示名改为「执行流」');
    expect(
      actionLabel(act({ kind: 'merge', targetName: '执行', sourceNames: ['执行页面', '控制台'] })),
    ).toBe('「执行页面」「控制台」 并入「执行」');
    expect(
      actionLabel(act({ kind: 'move', issueIds: [3, 7], toName: '文件预览' })),
    ).toBe('#3 #7 挪入「文件预览」');
    expect(actionLabel(act({ kind: 'move', issueIds: [1], to: { slug: 'file-preview' } }))).toBe(
      '#1 挪入「file-preview」',
    );
  });
});

describe('visibleSuggestion / hasPendingSuggestion', () => {
  test('无方案/空动作/同批已忽略 → 不展示；新方案（更大 ts）重新出现', () => {
    expect(visibleSuggestion(null, null)).toBeNull();
    expect(visibleSuggestion(st([]), null)).toBeNull();
    const s = st([act({})]);
    expect(visibleSuggestion(s, null)).not.toBeNull();
    expect(visibleSuggestion(s, 100)).toBeNull(); // 同批已忽略
    expect(visibleSuggestion(st([act({})], 200), 100)).not.toBeNull();
  });

  test('全部已执行 → 本批收尾不再展示；还剩未执行项照常展示（#89）', () => {
    expect(visibleSuggestion(st([act({ applied: true }), act({ applied: true })]), null)).toBeNull();
    expect(visibleSuggestion(st([act({ applied: true }), act({})]), null)).not.toBeNull();
  });

  test('角标条件：有未执行项才亮；全执行完不亮', () => {
    expect(hasPendingSuggestion(st([act({}), act({ applied: true })]), null)).toBe(true);
    expect(hasPendingSuggestion(st([act({ applied: true })]), null)).toBe(false);
    expect(hasPendingSuggestion(st([act({})]), 100)).toBe(false); // 已忽略
  });
});

describe('filterModules（ModuleSelect）', () => {
  const mod = (id: number, slug: string, displayName: string): ProjectModule => ({
    id,
    projectId: 1,
    slug,
    displayName,
    agent: 'claude',
    source: 'legacy',
    status: 'active',
    conversationId: null,
    lastUsedTs: null,
  });
  const list = [mod(1, 'git-pages', 'Git 页面'), mod(2, 'exec-flow', '执行'), mod(3, 'file-preview', '文件预览')];

  test('空查询给全量；按显示名/slug 不分大小写包含匹配', () => {
    expect(filterModules(list, '')).toHaveLength(3);
    expect(filterModules(list, '  ')).toHaveLength(3);
    expect(filterModules(list, '执行').map((m) => m.id)).toEqual([2]);
    expect(filterModules(list, 'GIT').map((m) => m.id)).toEqual([1]);
    expect(filterModules(list, 'preview').map((m) => m.id)).toEqual([3]);
    expect(filterModules(list, '不存在')).toEqual([]);
  });
});
