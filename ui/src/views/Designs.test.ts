import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const designs = readFileSync(new URL('./Designs.tsx', import.meta.url), 'utf8');
const workbench = readFileSync(new URL('./DesignWorkbench.tsx', import.meta.url), 'utf8');
const assetsPanel = readFileSync(new URL('./DesignAssetsPanel.tsx', import.meta.url), 'utf8');
const admin = readFileSync(new URL('./Admin.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('独立设计工作区', () => {
  test('采用 task rail + conversation + 单一 output，不嵌套 fullcol', () => {
    expect(designs).toContain('class="fullcol design-view"');
    expect(designs).toContain('class="design-task-rail"');
    expect(workbench).toContain('class="design-conversation"');
    expect(workbench).toContain('class="design-output"');
    expect(workbench).not.toContain('class="fullcol');
  });

  test('Output 只有 Document、Graph、Assets 三个顶级 tab', () => {
    expect(workbench).toContain('role="tablist"');
    expect(workbench).toContain("'document'");
    expect(workbench).toContain("'graph'");
    expect(workbench).toContain("'assets'");
    expect(workbench).toContain('data-inspector="readiness"');
    expect(workbench).toContain('data-inspector="reviews"');
  });

  test('未落地 capability 必须是禁用状态', () => {
    expect(workbench).toContain('capabilities.designWs');
    expect(workbench).toContain('assetCapability');
    expect(assetsPanel).toContain('capability?.enabled');
    expect(workbench).toContain('capabilities.issuePublish');
  });

  test('响应式以工作区容器为准并提供移动端语义 graph list', () => {
    expect(designs).toContain('useContainerWide');
    expect(css).toContain('container-type: inline-size');
    expect(workbench).toContain('graphSemanticRows');
    expect(workbench).toContain('class="design-mobile-switch"');
  });

  test('关键控件具备 tab/list/progressbar 语义', () => {
    expect(designs).toContain('aria-current={active ? \'page\' : undefined}');
    expect(workbench).toContain('role="progressbar"');
    expect(workbench).toContain('role="tab"');
  });

  test('创建弹窗的范围、Agent 选择与操作区具备统一视觉和完整触控契约', () => {
    expect(designs).toContain('function DesignScopeSelect');
    expect(designs).toContain('aria-haspopup="listbox"');
    expect(designs).toContain('role="listbox"');
    expect(designs).toContain('role="option"');
    expect(designs).not.toContain('<select value={moduleId');
    expect(css).toMatch(/\.design-scope-control\s*\{[^}]*min-height:\s*48px/s);
    expect(css).toMatch(/\.design-scope-menu\s*\{[^}]*background:\s*rgba\(255,\s*253,\s*248,\s*0\.98\)[^}]*box-shadow:\s*var\(--sh-3\)/s);
    expect(css).toMatch(/\.design-scope-option\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toContain('.design-scope-option.selected');
    expect(css).toContain('.design-scope-option:focus-visible');
    expect(designs).toContain('class="design-agent-options"');
    expect(designs).toContain('function DesignAgentLogo');
    expect(designs).toContain('<DesignAgentLogo kind={kind} />');
    expect(designs).toContain("agent === kind ? ' selected' : ''");
    expect(designs).toContain("optionDisabled ? ' disabled' : ''");
    expect(css).toMatch(/\.design-agent-options\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).toMatch(/\.design-agent-option\s*\{[^}]*min-height:\s*56px/s);
    expect(css).toContain('.design-agent-logo.claude');
    expect(css).toContain('.design-agent-logo.codex');
    expect(css).toContain('.design-agent-option.selected');
    expect(css).toContain('.design-agent-option:has(input:focus-visible)');
    expect(css).toContain('.design-agent-option.disabled');
    expect(css).toMatch(/\.design-create-form \.form-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(css).toMatch(/\.design-create-form \.form-actions \.btn\s*\{[^}]*width:\s*100%[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/@media \(max-width: 719px\)[\s\S]*?\.modal\s*\{[^}]*padding-bottom:\s*calc\(18px \+ env\(safe-area-inset-bottom\)\)/s);
  });

  test('结束组默认折叠，避免归档任务淹没当前工作', () => {
    expect(designs).toContain('section.key === \'closed\'');
    expect(designs).toContain('<details class="design-rail-group"');
  });

  test('列表与详情轮询都接入 latest-only guard，并在清理时作废在途响应', () => {
    expect(designs).toContain('new LatestOnlyRequestGuard()');
    expect(designs).toContain('{ signal: ticket.signal }');
    expect(designs).toContain('listGuardRef.current.invalidate()');
    expect(workbench).toContain('new LatestOnlyRequestGuard()');
    expect(workbench).toContain('{ signal: ticket.signal }');
    expect(workbench).toContain('refreshGuardRef.current.invalidate()');
  });

  test('活动流只渲染本地化事件标签，不暴露机器事件码', () => {
    expect(workbench).toContain('t(designEventLabelKey(event.kind))');
    expect(workbench).not.toContain('<code>{event.kind}</code>');
  });

  test('真实协作能力接入 run、发布、同步恢复、worktree、文件与资产端点', () => {
    expect(workbench).toContain('/runs`');
    expect(workbench).toContain('/graph/publish-confirmation');
    expect(workbench).toContain('/graph/publish`');
    expect(workbench).toContain('/recovery`');
    expect(workbench).toContain('/worktree`');
    expect(workbench).toContain('/start-execution`');
    expect(workbench).toContain('/complete-execution`');
    expect(workbench).toContain('/file-diff?expectedRevision=');
    expect(workbench).toContain('/publish-files`');
    expect(workbench).toContain('/assets`');
  });

  test('发布预览复用稳定幂等键，并在发布前锁定方案级执行工作区', () => {
    expect(workbench).toContain('publishKey: crypto.randomUUID()');
    expect(workbench).toContain('workspaceKey: crypto.randomUUID()');
    expect(workbench).toContain('idempotencyKey: publishPreview.workspaceKey');
    expect(workbench).toContain('idempotencyKey: publishPreview.publishKey');
    expect(workbench.indexOf('publishPreview.workspaceKey')).toBeLessThan(workbench.indexOf('publishPreview.publishKey'));
  });

  test('管理动作统一受 canManage 约束，移动端关键目标至少 44px', () => {
    expect(designs).toContain('canManage={canManage}');
    expect(workbench).toContain('disabled={!canManage');
    expect(css).toMatch(/min-height:\s*44px/);
  });

  test('Visual Assets 只提供三种受控 raster preset，绝不提供 diagram preset', () => {
    expect(assetsPanel).toContain("'full_page_mockup'");
    expect(assetsPanel).toContain("'component_states'");
    expect(assetsPanel).toContain("'visual_direction'");
    expect(assetsPanel).not.toContain("'diagram'");
    expect(assetsPanel).not.toContain("'flowchart'");
  });

  test('资产生成先确认外部处理与成本，并为生成和失败重试分配固定新 key', () => {
    expect(assetsPanel).toContain('acknowledgeExternalProcessingAndCost: true');
    expect(assetsPanel).toContain('requestKey: crypto.randomUUID()');
    expect(assetsPanel).toContain('idempotencyKey: confirmation.requestKey');
    expect(assetsPanel).toContain('/retry`');
    expect(assetsPanel).toContain('/cancel`');
  });

  test('资产保留历史版本、受保护内容、版本 CAS 功能细节与只读降级', () => {
    expect(assetsPanel).toContain('asset.designRevision === task.currentRevision');
    expect(assetsPanel).toContain('<ImageLightbox');
    expect(assetsPanel).toContain('expectedAssetVersion: editing.assetVersion');
    expect(assetsPanel).toContain('!canManage');
    expect(css).toContain('@media (max-width: 960px)');
    expect(css).toContain('@media (max-width: 719px)');
    expect(css).toContain('@media (max-width: 479px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('Graph 必须先展示完整契约并人工 approve，随后才能进入 publish', () => {
    expect(workbench).toContain('/approve-graph`');
    expect(workbench).toContain('<GraphContract graph={graph}');
    expect(workbench).toContain("['acceptanceCriteria','design.acceptanceCriteria']");
    expect(workbench).toContain("['testRecommendations','design.testRecommendations']");
    expect(workbench).toContain("['evidenceRequirements','design.evidenceRequirements']");
    expect(workbench.indexOf('/approve-graph`')).toBeLessThan(workbench.indexOf('/graph/publish`'));
  });

  test('粒度、workbench、文件发布、人格与真实 linked Issue 状态均接入服务端契约', () => {
    expect(workbench).toContain('/granularity`');
    expect(workbench).toContain('/workbench`');
    expect(workbench).toContain('response.workbench');
    expect(workbench).toContain('view.readinessReport.dimensions');
    expect(workbench).toContain('view.linkedIssues.map');
    expect(workbench).toContain("'publish-files'");
    expect(workbench).toContain('<DesignPersonaPanel');
    expect(workbench).toContain('personas={personas}');
  });

  test('latest run 与 run poll 都由 latest-only guard/AbortSignal 防止旧响应覆盖', () => {
    expect(workbench).toContain('runPollGuardRef.current.begin()');
    expect(workbench).toContain('runPollGuardRef.current.isCurrent(ticket)');
    expect(workbench).toContain('view.latestRun!.updatedTs >= current.updatedTs');
    expect(workbench).toContain('{ signal: ticket.signal }');
  });

  test('Workbench 从 immutable revision 合成文档并在 revision 或刷新错误时清理敏感交付状态', () => {
    expect(workbench).toContain('mergeWorkbenchDesignTask');
    expect(workbench).toContain('view.revision');
    expect(workbench).toContain('setFiles(null)');
    expect(workbench).toContain('setSensitiveEpoch');
  });

  test('同步决策只使用真实 executionSyncId，并保留 linkId 身份，不拼接 undefined', () => {
    expect(workbench).toContain('sync.executionSyncId');
    expect(workbench).toContain('sync.linkId');
    expect(workbench).not.toContain('sync.id}');
  });

  test('粒度持久化成功后以固定 request key 启动 graph run，并显示重新分解状态', () => {
    expect(workbench).toContain("mode: 'graph'");
    expect(workbench).toContain('idempotencyKey: graphRunKey');
    expect(workbench).toContain("t('design.redecomposing')");
  });

  test('Admin 提供人格 Git 市场源 CRUD 与同步治理', () => {
    expect(admin).toContain("'personaMarkets'");
    expect(admin).toContain('/api/admin/design-persona-markets');
    expect(admin).toContain("'DELETE'");
    expect(admin).toContain('/sync`');
  });

  test('桌面 Graph 使用 rank DAG 与 SVG 箭头，移动端保留语义列表', () => {
    expect(workbench).toContain('graphRankLayout');
    expect(workbench).toContain('<svg class="design-dag-edges"');
    expect(workbench).toContain('<marker id="design-dag-arrow"');
    expect(workbench).toContain('class="design-graph-semantic"');
  });

  test('run mode 来自 workbench capability，并支持 interrupted 本地化重试', () => {
    expect(workbench).toContain('view.capabilities.runModes');
    expect(workbench).toContain("run.status === 'interrupted'");
    expect(workbench).toContain("t('design.retryRun')");
  });

  test('发布确认 Modal 只渲染 immutable confirmation snapshot，不回查 live graph', () => {
    expect(workbench).toContain('<PublishConfirmationContract confirmation={publishPreview}');
    expect(workbench).not.toContain('publishPreview.orderedNodes.map((preview) => graph.nodes.find');
    expect(workbench).toContain('publishPreview.graphDigest');
    expect(workbench).toContain('publishPreview.revision');
    expect(workbench).toContain('confirmation.topologicalOrder');
    expect(workbench).toContain('confirmation.readiness');
    expect(workbench).toContain('confirmation.blockers');
    expect(workbench).toContain('node.bodyDigest');
    expect(workbench).toContain("['nonGoals','design.nonGoals']");
    expect(workbench).toContain("['completionInstructions','design.completionInstructions']");
  });
});
