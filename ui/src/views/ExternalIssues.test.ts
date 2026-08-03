import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ExternalIssueCandidate, ProjectModule } from '../lib/types';
import { externalIssueIdentity, externalIssueImportPayload } from './ExternalIssues';

const candidate: ExternalIssueCandidate = {
  provider: 'github', sourceKey: 'github:github.com/acme/repo', externalId: '100', externalNumber: '7',
  title: '远端标题', body: '远端正文', url: 'https://github.com/acme/repo/issues/7', author: 'alice', labels: ['bug'], createdAt: null, updatedAt: null,
};
const modules: ProjectModule[] = [{ id: 9, projectId: 1, slug: 'api', displayName: 'API', agent: 'codex', source: 'manual', status: 'active', conversationId: null, lastUsedTs: null }];
const pageSource = readFileSync(new URL('./ExternalIssues.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./ProjectSettings.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('外部 issue 导入页面', () => {
  test('页面挂载不调用远端 fetch，只有按钮处理函数调用', () => {
    const effect = pageSource.slice(pageSource.indexOf('useEffect(() => {'), pageSource.indexOf('const fetchCandidates'));
    expect(effect).not.toContain('/external-issues/fetch');
    expect(pageSource.slice(pageSource.indexOf('const fetchCandidates'))).toContain('/external-issues/fetch');
  });

  test('忽略请求只携带稳定远端身份', () => {
    expect(externalIssueIdentity(candidate)).toEqual({ externalId: '100', externalNumber: '7', externalUrl: candidate.url });
  });

  test('确认导入使用编辑后的字段，并把已选模块转成 moduleId', () => {
    expect(externalIssueImportPayload(candidate, {
      title: ' 修改后的标题 ', body: '修改后的正文', category: 'debug', module: 'api', agent: 'claude', autoApprove: 'cautious',
      gitBranch: { targetBranch: 'feature/import', sourceRef: 'origin/main' },
    }, modules)).toEqual({
      externalId: '100', externalNumber: '7', externalUrl: candidate.url, title: '修改后的标题', body: '修改后的正文', category: 'debug',
      moduleId: 9, agent: 'codex', autoApprove: 'cautious', targetBranch: 'feature/import', sourceRef: 'origin/main',
    });
  });

  test('新增页面为图标按钮、错误和异步状态提供无障碍语义', () => {
    expect(pageSource).toContain('aria-label={t(\'ui.back\')}');
    expect(settingsSource).toContain('aria-label={t(\'ui.back\')}');
    expect(pageSource).toContain('role="alert"');
    expect(settingsSource).toContain('role="alert"');
    expect(pageSource).toContain('role="status" aria-live="polite"');
  });

  test('项目配置和外部导入页面在窄屏下使用单列响应式布局', () => {
    expect(css).toContain('@media (max-width: 719px)');
    expect(css).toContain('.page.ei-page');
    expect(css).toContain('.ei-form-row { align-items: stretch; flex-direction: column; }');
    expect(css).toContain('@media (max-width: 760px)');
    expect(css).toContain('.ps-console { max-width: 1180px; margin: 0 auto; }');
    expect(css).toContain('.ps-form-grid, .ps-repository-grid, .ps-source-grid { grid-template-columns: 1fr; }');
  });
});
