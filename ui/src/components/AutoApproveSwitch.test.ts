import { describe, expect, test } from 'bun:test';

const switchUrl = new URL('./AutoApproveSwitch.tsx', import.meta.url);
const chatUrl = new URL('../views/Chat.tsx', import.meta.url);
const issueUrl = new URL('../views/IssueDetail.tsx', import.meta.url);
const cssUrl = new URL('../style.css', import.meta.url);

describe('AutoApproveSwitch（issue #108，#111 改下拉，#113 Apple pull-down）', () => {
  test('三档中文标签，档位与后端枚举同名', async () => {
    const source = await Bun.file(switchUrl).text();

    expect(source).toContain("level: 'cautious'");
    expect(source).toContain("level: 'medium'");
    expect(source).toContain("level: 'auto'");
    expect(source).toContain('谨慎');
    expect(source).toContain('中等');
    expect(source).toContain('全自动');
  });

  test('收起态按钮显示当前档：缺失/脏值兜底 medium，选回当前档不重复发请求', async () => {
    const source = await Bun.file(switchUrl).text();

    expect(source).toContain('class="aa-btn"');
    expect(source).toContain('{curMeta?.label}');
    expect(source).toContain('const cur = normalize(level)');
    // 归一：认不出来的值不能让收起态空着
    expect(source).toContain("v === 'cautious' || v === 'medium' || v === 'auto' ? v : 'medium'");
    // 选回当前档不重复发请求
    expect(source).toContain('if (next !== cur) onChange(next)');
  });

  test('#113 菜单 createPortal 到 body + fixed 定位（#111 的 .runctl 横向滚动裁剪教训 + #79 约束）', async () => {
    const source = await Bun.file(switchUrl).text();

    expect(source).toContain("import { createPortal } from 'preact/compat'");
    expect(source).toMatch(/createPortal\(/);
    expect(source).toMatch(/,\s*document\.body,?\s*\)/);
    // 锚点现量视口坐标 + 横向夹在视口内
    expect(source).toContain('getBoundingClientRect()');
    expect(source).toContain('clampX(');
    // 菜单卡 fixed（CSS 侧）
    const css = await Bun.file(cssUrl).text();
    expect(css).toMatch(/\.aa-menu\s*\{[^}]*position:\s*fixed/);
  });

  test('#113 选中项打 ✓、每档带说明小字；点外/Esc/滚动都收起', async () => {
    const source = await Bun.file(switchUrl).text();

    expect(source).toContain("{l.level === cur ? '✓' : ''}");
    expect(source).toContain('aa-item-d');
    expect(source).toContain("desc:");
    expect(source).toContain("document.addEventListener('click', close)");
    expect(source).toContain("if (e.key === 'Escape') close()");
    expect(source).toContain("window.addEventListener('scroll', close, true)");
  });

  test('title 说清行为：可改时给当前档语义，置灰时给不可改的原因', async () => {
    const source = await Bun.file(switchUrl).text();

    expect(source).toContain('disabled={disabled}');
    expect(source).toContain("title={disabled ? (disabledHint ?? '当前状态不能改自动批准档位') : hint}");
    expect(source).toContain('const hint = curMeta ? `${curMeta.label}：${curMeta.desc}` : ');
  });

  test('两处视图都把它接进头行插槽：对话用对话级档位、issue 用 issue 级档位', async () => {
    const chat = await Bun.file(chatUrl).text();
    expect(chat).toContain('<AutoApproveSwitch level={autoApprove} onChange={onAutoApprove} />');
    expect(chat).toContain("selectedConv?.autoApprove ?? 'cautious'");
    expect(chat).toContain('setConvAutoApprove(pid, id, level)');
    expect(chat).toContain('<NativeModeSwitch mode={mode} onChange={onModeChange} />');

    const issue = await Bun.file(issueUrl).text();
    // 老后端还没下发 auto_approve 时也得显示出当前档（#111 的主因）
    expect(issue).toContain("level={issue.autoApprove ?? 'medium'}");
    expect(issue).toContain('setIssueAutoApprove(pid, iid, level)');
  });

  test('#111 已完成/已取消的 issue 置灰（受阻仍可改，对话侧不受限）', async () => {
    const issue = await Bun.file(issueUrl).text();
    expect(issue).toContain("const aaLocked = issue.status === 'done' || issue.status === 'cancelled'");
    expect(issue).toContain('disabled={aaLocked}');
    expect(issue).toContain('不会再有弹窗，档位不可改');

    // 对话没有「完成」概念，切换钮永远可用
    const chat = await Bun.file(chatUrl).text();
    expect(chat).not.toContain('<AutoApproveSwitch level={autoApprove} onChange={onAutoApprove} disabled');
  });

  test('样式已定义（.aa-pick 前缀 + .aa-btn 收起态含置灰、.aa-menu/.aa-item 菜单卡）', async () => {
    const css = await Bun.file(cssUrl).text();
    expect(css).toContain('.aa-pick {');
    expect(css).toContain('.aa-pick-t {');
    expect(css).toContain('.aa-btn {');
    expect(css).toContain('.aa-btn:disabled {');
    expect(css).toContain('.aa-menu {');
    expect(css).toContain('.aa-item {');
    // 收起态按钮在 .runctl 行内不许被全局 select/按钮宽度规则撑爆
    expect(css).toContain('width: auto');
  });
});
