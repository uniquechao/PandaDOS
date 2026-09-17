import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  externalIssueSourceDefaults,
  externalIssueSourcePayload,
  formatValidationCommandLines,
  parseValidationCommandLines,
  projectSettingsDirty,
} from './ProjectSettings';

const source = readFileSync(new URL('./ProjectSettings.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('项目配置页外部 issue 来源请求', () => {
  test('空 token 不覆盖后端凭据，GitHub 不发送实例地址', () => {
    expect(externalIssueSourcePayload({
      provider: 'github', remoteName: 'origin', instanceUrl: 'https://ignored.example', apiToken: '  ', clearApiToken: false,
    })).toEqual({ provider: 'github', remoteName: 'origin' });
  });

  test('GitLab 自建实例、token 与清除意图显式传递', () => {
    expect(externalIssueSourcePayload({
      provider: 'gitlab', remoteName: 'upstream', instanceUrl: ' https://gitlab.example/team ', apiToken: ' secret ', clearApiToken: false,
    })).toEqual({ provider: 'gitlab', remoteName: 'upstream', instanceUrl: 'https://gitlab.example/team', apiToken: 'secret' });
    expect(externalIssueSourcePayload({
      provider: 'gitlab', remoteName: 'origin', instanceUrl: '', apiToken: '', clearApiToken: true,
    })).toEqual({ provider: 'gitlab', remoteName: 'origin', clearApiToken: true });
  });

  test('仅 github.com 自动选择 GitHub，其他 remote 自动选择 GitLab 和实例地址', () => {
    expect(externalIssueSourceDefaults({
      host: 'github.com', suggestedProvider: 'github', suggestedInstanceUrl: 'https://github.com',
    })).toEqual({ provider: 'github', instanceUrl: '' });
    expect(externalIssueSourceDefaults({
      host: 'gitlab.sunseed.tech',
    })).toEqual({ provider: 'gitlab', instanceUrl: 'https://gitlab.sunseed.tech' });
  });
});

describe('项目设置控制台', () => {
  test('项目字段通过规范化快照派生未保存状态', () => {
    const saved = { name: 'PandaDOS', goal: 'Ship', validationCommands: '' };
    expect(projectSettingsDirty(saved, saved)).toBeFalse();
    expect(projectSettingsDirty(saved, { ...saved, name: ' PandaDOS ' })).toBeFalse();
    expect(projectSettingsDirty(saved, { ...saved, goal: 'New goal' })).toBeTrue();
  });

  test('设置控制台移除自动化，并将执行机归入仓库章节，issue 订阅、成员和模块保持独立', () => {
    expect(source).toContain('class="ps-console"');
    expect(source).not.toContain('class="ps-nav"');
    expect(source).toContain('id="settings-general"');
    expect(source).not.toContain('id="settings-automation"');
    expect(source).toContain('id="settings-repository"');
    expect(source).not.toContain('id="settings-executor"');
    expect(source).toContain('class="ps-executor-block"');
    expect(source).toContain("t('projectSettings.executor')");
    expect(source).toContain('id="settings-issue-subscription"');
    expect(source).toContain('id="settings-members"');
    expect(source).toContain('id="settings-modules"');
    expect(source).toContain('id="settings-workflows"');
    expect(source).toContain('nav(`/p/${pid}/workflows`)');
    expect(source).not.toContain('id="settings-people"');
    expect(source).not.toContain('nav(`/p/${pid}/external-issues`)');
    expect(source).not.toContain("t('project.workBranch')");
    expect(source).not.toContain('workBranch: currentFields');
    expect(source).not.toContain('manualReview: currentFields');
    expect(source.match(/void saveProject\(\)/g)?.length).toBe(1);
    expect(source).toContain("addEventListener('beforeunload'");
    expect(source).toContain('void saveSource()');
    expect(source).toContain("api<ExecutorLite[]>('/api/executors')");
    expect(source).toContain("executor.status === 'online' ? 'status.online'");
  });

  test('内容区满宽，窄屏保留底部保存栏和单列内容', () => {
    expect(styles).toContain('.ps-console');
    expect(styles).not.toContain('.ps-nav');
    expect(styles).toContain('.ps-savebar');
    expect(styles).toContain('.ps-repository-grid');
    expect(styles).toContain('.ps-executor-card');
    expect(styles).toContain('.ps-executor-agents');
    expect(styles).toContain('grid-template-columns: minmax(220px, 0.8fr) minmax(320px, 1.2fr)');
    expect(styles).toContain('.ps-module-list');
    expect(styles).toContain('@media (max-width: 760px)');
    expect(styles).toContain('position: fixed');
    expect(styles).toContain('env(safe-area-inset-bottom)');
  });

  test('设置页颜色复用全局前端 Token，不维护独立色板', () => {
    expect(styles).toContain('.ps-section-head > div > span { color: var(--accent-2)');
    expect(styles).toContain('.ps-summary { padding: 12px 14px; background: var(--fill)');
    expect(styles).toContain('.ps-status.ok { background: var(--run-weak); color: var(--run-2); }');
    expect(styles).toContain('background: var(--run); box-shadow: 0 0 0 3px var(--run-weak)');
    expect(styles).toContain('color: var(--fg); background: var(--fill); border: 1px solid var(--line)');
    expect(styles).toContain('background: var(--mat);');
  });

  test('基本信息在宽屏并排显示名称和目标，避免首屏纵向浪费', () => {
    expect(source).not.toContain('field ps-field-wide');
    expect(source).toContain('<textarea rows={3}');
    expect(source).toContain("t('projectSettings.manualUpdate')");
  });

  test('成员新增入口位于分区头部，模块分区直接展示详细列表', () => {
    expect(source).toContain('class="ps-member-add"');
    expect(source).toContain('class="ps-module-list"');
    expect(source).toContain('module.displayName');
    expect(source).toContain("t('ui.moduleIssueCount'");
  });

  test('仓库分区展示同步摘要、原始错误和手动立即同步入口', () => {
    expect(source).toContain('class={`ps-sync-card');
    expect(source).toContain('`/api/projects/${pid}/sync`');
    expect(source).toContain("t('projectSettings.syncNow')");
    expect(source).toContain('syncStatus.detectedUpdates');
    expect(source).toContain('syncStatus.details.map');
    expect(styles).toContain('.ps-sync-errors');
  });
});

describe('门禁命令编辑（#279 / I-03）', () => {
  test('一行一条、参数空格分隔；空行与注释忽略', () => {
    expect(parseValidationCommandLines('bun run typecheck\n\n  bun run test  \n# 注释')).toEqual([
      { label: 'run typecheck', argv: ['bun', 'run', 'typecheck'] },
      { label: 'run test', argv: ['bun', 'run', 'test'] },
    ]);
  });

  test('留空 = null（未配置，交后端按 package.json 探测），不是「不跑门禁」', () => {
    expect(parseValidationCommandLines('')).toBeNull();
    expect(parseValidationCommandLines('   \n\n')).toBeNull();
  });

  test('回填与解析是一对：未配置显示为空', () => {
    expect(formatValidationCommandLines([{ label: 'x', argv: ['make', 'ci'] }])).toBe('make ci');
    expect(formatValidationCommandLines(null)).toBe('');
    expect(formatValidationCommandLines(undefined)).toBe('');
  });

  test('门禁命令进入未保存判定，且只按规范化结果比较', () => {
    const saved = { name: 'p', goal: 'g', validationCommands: 'bun run test' };
    expect(projectSettingsDirty(saved, { ...saved, validationCommands: '  bun   run test  ' })).toBeFalse();
    expect(projectSettingsDirty(saved, { ...saved, validationCommands: 'make ci' })).toBeTrue();
    expect(projectSettingsDirty(saved, { ...saved, validationCommands: '' })).toBeTrue();
  });
});
