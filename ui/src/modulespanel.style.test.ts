/**
 * 项目模块面板（ModulesPanel）重设计的样式约束（issue #90，对齐 imgpreview.style.test.ts 的字符串校验法）。
 * 守住：wide 弹窗桌面加宽且窄屏仍是底部抽屉、模块行紧凑单行不换行（slug 优先截断）、
 * 操作钮是主页面同款胶囊且触屏常驻（hover 隐藏只许包在 hover:hover 里）、
 * 窄屏说明省略/隐藏不挤爆、行内改名不触发 iOS 聚焦缩放（不许改小字号）。
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

describe('模块列表紧凑行', () => {
  test('行是不换行的单行 flex（挤压靠截断，不靠 wrap 堆行）', () => {
    const d = declarations('.mrow');
    expect(d).toMatch(/display\s*:\s*flex/);
    expect(d).toMatch(/align-items\s*:\s*center/);
    expect(d).not.toMatch(/flex-wrap/);
  });

  test('名称区可挤压：容器 min-width:0，显示名/slug 都有省略号', () => {
    expect(declarations('.mrow-main')).toMatch(/min-width\s*:\s*0/);
    expect(declarations('.mrow-name')).toMatch(/text-overflow\s*:\s*ellipsis/);
    expect(declarations('.mrow-slug')).toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  test('slug 优先于显示名被截断（flex-shrink 更大）', () => {
    expect(declarations('.mrow-slug')).toMatch(/flex-shrink\s*:\s*3/);
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

  test('超窄屏模块行折两行（触屏操作钮常驻，单行会把名称挤没）', () => {
    const m = css.match(/@media \(max-width: 479px\) \{\s*\n(?:[^@]*?)\.mrow \{([^}]*)\}/)?.[1] ?? '';
    expect(m).toMatch(/flex-wrap\s*:\s*wrap/);
    expect(css).toMatch(/@media \(max-width: 479px\) \{[^@]*\.mrow-main \{ flex-basis: 100%/);
  });
});
