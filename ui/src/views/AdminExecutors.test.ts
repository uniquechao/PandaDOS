import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'Admin.tsx'), 'utf8');

describe('Admin 执行机配置源码契约', () => {
  test('系统本机保护、检测建议与三个执行机目录入口齐全，新建草稿连接也可操作', () => {
    expect(source).toContain('!x.isSystemLocal');
    expect(source).toContain('/detect');
    expect(source).toContain("tr('admin.useSuggestion')");
    expect(source).toContain("tr('admin.chooseDirectory')");
    for (const field of ['workspaceRoot', 'claudeDir', 'codexDir']) {
      expect(source).toContain(field);
    }
    expect(source).not.toContain('disabled={!exec}');
    expect(source).not.toContain('保存后可浏览远端目录');
    expect(source).toContain('/api/admin/executors/preview/detect');
    expect(source).toContain('previewConnection');
  });
});

describe('成本视图页（#282 / I-08、I-09）', () => {
  test('作为独立 admin tab 接上 /api/admin/usage，并支持项目与时间窗筛选', () => {
    expect(source).toContain("| 'cost'");
    expect(source).toContain("['cost', tr('admin.cost')]");
    expect(source).toContain("{tab === 'cost' && <CostTab />}");
    expect(source).toContain('/api/admin/usage');
    expect(source).toContain("params.set('projectId'");
    expect(source).toContain("params.set('from'");
  });

  test('三档聚合都渲染，且非 Issue 会话与未归因分别单列', () => {
    const tab = source.slice(source.indexOf('function CostTab'), source.indexOf('function OverviewTab'));
    expect(tab).toContain("tr('admin.costChat')");
    expect(tab).toContain("tr('admin.costUnattributed')");
    expect(tab).toContain('data?.projects');
    expect(tab).toContain('data?.chat');
    expect(tab).toContain('data?.unattributed');
    // issue 档要带上引擎侧指标（返工 / nudge / judge / 门禁耗时）
    expect(tab).toContain('r.testRetries');
    expect(tab).toContain('r.nudges');
    expect(tab).toContain('r.judged');
    expect(tab).toContain('r.validationMs');
  });

  test('时间窗的适用范围要写在界面上：汇总是累计值，不随窗口变', () => {
    expect(source).toContain("tr('admin.costWindowNote')");
  });

  test('金额按后台单价折算并展示，回扫入口在页面上（#282 / Q2、Q3）', () => {
    const tab = source.slice(source.indexOf('function CostTab'), source.indexOf('function OverviewTab'));
    expect(tab).toContain("tr('admin.costAmount')");
    expect(tab).toContain('money(data.grandCostUsd)');
    expect(tab).toContain('money(r.costUsd)');
    expect(tab).toContain("api('/api/admin/usage/rescan'");
    // 单价来自接口，不在前端写死
    expect(tab).not.toContain('1.25');
    expect(tab).not.toContain('10.0');
  });
});
