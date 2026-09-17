import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Board.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

/** #110：列表上「代理停下来等你澄清」必须一眼看得出，否则跟正常跑的 issue 长得一样 */
describe('工作台列表：等待澄清醒目化（#110）', () => {
  test('行状态徽标透传 awaitingClarify（由 StatusBadge 覆盖成「等待你澄清」）', () => {
    expect(source).toContain('awaitingClarify={issue.awaitingClarify}');
  });

  test('等待澄清的色带压过 review/blocked/doing（判定排在最前）', () => {
    const idxClarify = source.indexOf("' clarify'");
    const idxReview = source.indexOf("' review'");
    expect(idxClarify).toBeGreaterThan(0);
    expect(idxReview).toBeGreaterThan(idxClarify);
    // #275：色带改由 attentionKind 驱动，但老接口没有该字段时要能退回原来的状态判断
    expect(source).toContain("issue.awaitingClarify // 兜底：老接口没有 attentionKind");
  });

  // #275：原来「等你澄清 / 等你选择 / 澄清待答」是三块各自的判断，容易重复挂角标；
  // 现在统一由 AttentionBadge 一个承载，重复问题从结构上消失
  test('「在等什么」只挂一个角标，由后端派生的 attentionKind 驱动', () => {
    expect(source).toContain('<AttentionBadge kind={issue.attentionKind} />');
    expect(source).not.toContain('<WaitingBadge />');
    expect(source).not.toContain('issue.clarifyPending && !issue.awaitingClarify');
    // 同一行里只出现一次，不会既挂澄清又挂等待
    expect(source.split('<AttentionBadge').length - 1).toBe(1);
  });

  test('样式落地：实心橙徽标 + 行左色带', () => {
    expect(css).toContain('.b-clarify {');
    expect(css).toContain('.wb-row.clarify {');
  });
});

/** #115：新建时就能定批准档位，且按设备记住上次选的 */
describe('新建 issue：批准档位（#115）', () => {
  test('复用执行页顶栏那个切换钮（不另画一套下拉）', () => {
    expect(source).toContain("import { AutoApproveSwitch } from '../components/AutoApproveSwitch';");
    expect(source).toContain('<AutoApproveSwitch level={autoApprove} onChange={setAutoApprove} />');
  });

  test('初值取本机上次选择，创建成功后才落库', () => {
    expect(source).toContain('useState<AutoApproveLevel>(readNewIssueAutoApprove)');
    const post = source.indexOf('writeNewIssueAutoApprove(autoApprove)');
    const created = source.indexOf('onCreated();');
    expect(post).toBeGreaterThan(0);
    expect(post).toBeLessThan(created); // 在 await api(...) 之后、onCreated 之前 = 只有建成了才记
  });

  test('档位随创建请求提交', () => {
    expect(source).toContain('autoApprove,');
  });

  test('样式落地：档位行不是 label（点标题会误触发菜单）', () => {
    expect(css).toContain('.nia-aa {');
    expect(source).toContain('<div class="nia-aa">');
  });
});

describe('项目配置入口（Issue #10）', () => {
  test('看板头部只保留项目工作入口并转到独立配置页', () => {
    const start = source.indexOf('<div class="bacts">');
    const end = source.indexOf('{project?.goal', start);
    const headerActions = source.slice(start, end);
    const routes = ['/designs', '/chat', '/files', '/skills', '/term', '/git', '/settings'];
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(headerActions.match(/<button class="btn sm"/g)).toHaveLength(8);
    expect(headerActions).toContain("subscribed ? tr('board.subscribedLabel') : tr('board.subscribe')");
    for (const route of routes) expect(headerActions).toContain(`nav(\`/p/\${pid}${route}\`)`);
    for (let index = 1; index < routes.length; index += 1) {
      expect(headerActions.indexOf(routes[index])).toBeGreaterThan(headerActions.indexOf(routes[index - 1]));
    }
    expect(headerActions).not.toContain('setMembersOpen');
    expect(headerActions).not.toContain('setModulesOpen');
    expect(headerActions).not.toContain('SummaryButton');
  });

  test('Issue 列表顶部提供外部 issue 导入和新建入口', () => {
    const start = source.indexOf('class="wb-list-hd"');
    const end = source.indexOf('class="wb-groups"', start);
    const listHeader = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(listHeader).toContain("tr('externalImport.title')");
    expect(listHeader).toContain('nav(`/p/${pid}/external-issues`)');
    expect(listHeader).toContain('setCreating(true)');
  });
});

describe('新建 issue：高级工作流（Issue #33）', () => {
  test('按需加载启用模板，预览节点图并提交不可变模板选择', () => {
    expect(source).toContain('if (!advancedOpen || workflowLoaded || workflowLoading) return;');
    expect(source).toContain('`/api/projects/${pid}/workflows`');
    expect(source).toContain("item.template.status === 'active'");
    expect(source).toContain('<WorkflowGraph graph={selectedWorkflow.version.graph} compact />');
    expect(source).toContain('...(workflowTemplateId !== null ? { workflowTemplateId } : {})');
  });

  test('模板选择页与窄屏样式使用 PandaDOS 视觉令牌', () => {
    expect(source).toContain("tr('workflow.advanced')");
    expect(source).toContain('role="listbox"');
    expect(source).toContain('aria-selected={workflowTemplateId === item.template.id}');
    expect(css).toContain('.wf-pick-layout {');
    expect(css).toContain('background: var(--accent-weak)');
    expect(css).toContain('@media (max-width: 720px)');
  });
});
