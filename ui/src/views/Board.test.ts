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
  });

  test('「澄清待答」提到 amber 级，且不与「等待你澄清」重复挂两个角标', () => {
    expect(source).toContain('issue.clarifyPending && !issue.awaitingClarify');
    expect(source).toContain("badge b-amber\" title={tr('board.clarifyOptional')}");
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
