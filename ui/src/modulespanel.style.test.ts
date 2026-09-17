/**
 * 项目模块面板（ModulesPanel）重设计的样式约束（issue #90，对齐 imgpreview.style.test.ts 的字符串校验法）。
 * 守住：wide 弹窗桌面加宽且窄屏仍是底部抽屉、模块行主次信息稳定分区、
 * 操作钮是主页面同款胶囊且触屏常驻（hover 隐藏只许包在 hover:hover 里）、
 * 窄屏次级信息换行不挤爆、行内改名不触发 iOS 聚焦缩放（不许改小字号）。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const panelSrc = readFileSync(new URL('./components/ModulesPanel.tsx', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function maxWidthOf(selector: string): number {
  return Number(declarations(selector).match(/max-width\s*:\s*(\d+)px/)?.[1] ?? '0');
}

describe('Modal wide 变体', () => {
  test('.modal.wide 桌面加宽（比基础 .modal 宽）', () => {
    expect(maxWidthOf('.modal.wide')).toBeGreaterThan(maxWidthOf('.modal'));
  });

  test('窄屏仍是底部抽屉：≤719px 里 .modal 放开 max-width，wide 一并被覆盖', () => {
    const mobile = css.match(/@media \(max-width: 719px\) \{[^@]*\.modal \{([^}]*)\}/)?.[1] ?? '';
    expect(mobile).toMatch(/max-width\s*:\s*none/);
  });

  test('ModulesPanel 启用 wide', () => {
    expect(panelSrc).toContain("<Modal title={t('ui.projectModules')} wide");
  });
});

describe('模块列表主次信息布局', () => {
  test('行使用两区 grid，名称区始终保留可用宽度', () => {
    const d = declarations('.mrow');
    expect(d).toMatch(/display\s*:\s*grid/);
    expect(d).toMatch(/grid-template-columns\s*:\s*minmax\(0, 1fr\) auto/);
    expect(d).toMatch(/align-items\s*:\s*center/);
  });

  test('主信息按显示名和 slug 纵向分层，长文本安全省略', () => {
    expect(declarations('.mrow-main')).toMatch(/min-width\s*:\s*0/);
    expect(declarations('.mrow-main')).toMatch(/flex-direction\s*:\s*column/);
    expect(declarations('.mrow-name')).toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(declarations('.mrow-slug')).toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  test('agent 选择器覆盖全局表单宽度，不再挤掉模块名称', () => {
    const d = declarations('.mrow-agent');
    expect(d).toMatch(/width\s*:\s*auto/);
    expect(d).toMatch(/min-width\s*:\s*104px/);
    expect(d).toMatch(/max-width\s*:\s*132px/);
    expect(panelSrc).toContain('class="mrow-meta"');
  });

  test('不再借用成员列表的 memrow', () => {
    expect(panelSrc).not.toContain('memrow');
  });
});

describe('胶囊操作钮（主页面 .pcard-act 同款）', () => {
  test('改名/归档与方案卡执行钮都是胶囊圆角', () => {
    expect(declarations('.mrow-act')).toMatch(/border-radius\s*:\s*var\(--r-pill\)/);
    expect(declarations('.org-apply')).toMatch(/border-radius\s*:\s*var\(--r-pill\)/);
  });

  test('操作钮有明确键盘焦点，禁用态没有动效', () => {
    expect(declarations('.mrow-act:focus-visible')).toMatch(/outline\s*:\s*2px solid var\(--pd-yellow\)/);
    const disabled = declarations('.mrow-act:disabled');
    expect(disabled).toMatch(/opacity\s*:\s*0\.45/);
    expect(disabled).toMatch(/cursor\s*:\s*not-allowed/);
    expect(disabled).toMatch(/transition\s*:\s*none/);
  });

  test('触屏常驻：基础 .mrow-acts 不许藏（opacity 隐藏只出现在 hover:hover 媒体块里）', () => {
    expect(declarations('.mrow-acts')).not.toMatch(/opacity/);
    expect(css).toMatch(/@media \(hover: hover\) \{[^@]*\.mrow-acts \{ opacity: 0/);
    expect(css).toMatch(/\.mrow:hover \.mrow-acts,\s*\.mrow:focus-within \.mrow-acts \{ opacity: 1/);
  });
});

describe('窄屏不挤爆', () => {
  test('org-bar 说明可挤压省略，超窄屏整个隐藏', () => {
    const hint = declarations('.org-bar .org-hint');
    expect(hint).toMatch(/min-width\s*:\s*0/);
    expect(hint).toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(css).toMatch(/@media \(max-width: 479px\) \{ \.org-bar \.org-hint \{ display: none; \} \}/);
  });

  test('方案卡动作行文字列可挤压（min-width:0），执行钮不被压瘪', () => {
    expect(declarations('.org-item-tx')).toMatch(/min-width\s*:\s*0/);
    expect(declarations('.org-apply')).toMatch(/flex-shrink\s*:\s*0/);
  });

  test('行内改名 input 不许改小字号（<16px 会触发 iOS 聚焦缩放）', () => {
    expect(declarations('.mrow-edit')).not.toMatch(/font-size/);
  });

  test('窄屏主信息独占首行，次级信息可换行且操作区不挤名称', () => {
    const responsive = css.slice(css.indexOf('/* 窄屏将次级信息放到第二行'));
    expect(responsive).toMatch(/@media \(max-width: 719px\) \{[^@]*\.mrow \{ grid-template-columns: minmax\(0, 1fr\)/);
    expect(responsive).toMatch(/@media \(max-width: 719px\) \{[^@]*\.mrow-meta \{[^}]*flex-wrap: wrap/);
    expect(responsive).toMatch(/@media \(max-width: 479px\) \{[^@]*\.mrow-acts \{[^}]*width: 100%/);
  });
});

describe('模块推理档（#281 / I-04）', () => {
  test('每行有模块默认档选择，且提示只对之后启动的会话生效', () => {
    expect(panelSrc).toContain("void changeReasoning(m, e.currentTarget.value)");
    expect(panelSrc).toContain("t('ui.reasoningInherit')");
    expect(panelSrc).toContain("t('ui.reasoningCodexOnly')");
    expect(panelSrc).toContain("{ reasoningEffort: next }");
  });
});
