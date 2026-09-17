import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('runstream 布局约束', () => {
  test('命令卡在可滚动的纵向 flex 消息流中不可被压成边框', () => {
    expect(declarations('.rs-cmd')).toMatch(/(?:^|;)\s*flex-shrink\s*:\s*0\s*(?:;|$)/);
  });
});

describe('展开区看全 + 复制（issue #288）', () => {
  test('展开区显式可长按/拖选——头行的 user-select:none 不得连坐正文', () => {
    const rule = declarations('.rs-tool-b, .rs-cmd-out, .rs-cmd-full, .rs-think-b, .rs-msg');
    expect(rule).toMatch(/(?:^|;)\s*user-select\s*:\s*text\s*(?:;|$)/);
    // 操作条自己反过来不可选，否则「全选复制」会把按钮文案也框进去
    expect(declarations('.rs-body-bar')).toMatch(/(?:^|;)\s*user-select\s*:\s*none\s*(?:;|$)/);
  });

  test('完整命令块换行显示（头行那句是 nowrap 摘要，这里必须是原文）', () => {
    expect(declarations('.rs-body-tx')).toMatch(/white-space\s*:\s*pre-wrap/);
    expect(declarations('.rs-cmd-full')).toMatch(/overflow\s*:\s*auto/);
  });

  test('拿到全文后展开区放宽高度（.rs-body.full 是 DetailBody 挂的抓手）', () => {
    expect(css).toContain('.rs-tool-b:has(.rs-body.full)');
    expect(css).toContain('.rs-cmd-out:has(.rs-body.full)');
    expect(
      declarations(
        '.rs-tool-b:has(.rs-body.full), .rs-cmd-out:has(.rs-body.full),\n.rs-cmd-full:has(.rs-body.full), .rs-think-b:has(.rs-body.full)',
      ),
    ).toMatch(/max-height\s*:\s*min\(70vh, 720px\)/);
  });
});

describe('复制钮浮层（issue #299）', () => {
  test('浮层槽零占位、压在正文之上，且自己不可选', () => {
    // 槽一旦回到正文的流里，就又变回原来那条自己折行的操作条——这条改动的全部意义就没了
    const slot = declarations('.rs-copy-slot');
    expect(slot).toMatch(/position\s*:\s*absolute/);
    expect(slot).toMatch(/z-index\s*:\s*2/);
    expect(slot).toMatch(/user-select\s*:\s*none/);
    // 定位参照必须是这块正文自己，否则钮会飞到外层卡片的角上
    expect(declarations('.rs-body')).toMatch(/position\s*:\s*relative/);
  });

  test('内滚展开区里改 sticky：钮不许跟着正文滚出视野', () => {
    const rule = declarations(
      '.rs-cmd-full .rs-copy-slot, .rs-cmd-out .rs-copy-slot,\n.rs-tool-b .rs-copy-slot, .rs-think-b .rs-copy-slot',
    );
    expect(rule).toMatch(/position\s*:\s*sticky/);
    // sticky 得留在流里，所以只能靠 height:0 + 负 margin 抵掉 .rs-body 的 gap
    expect(rule).toMatch(/height\s*:\s*0/);
    expect(rule).toMatch(/margin\s*:\s*0 -2px -5px 0/);
  });

  test('图标钮常驻可见（手机没有 hover，绝不能做成点一下才出现）', () => {
    const copy = declarations('.rs-copy');
    const opacity = Number(copy.match(/(?:^|;)\s*opacity\s*:\s*([\d.]+)/)?.[1]);
    expect(opacity).toBeGreaterThan(0.5);
    // 圆形小钮：等宽高 + 药丸圆角
    expect(copy).toMatch(/width\s*:\s*22px/);
    expect(copy).toMatch(/height\s*:\s*22px/);
    expect(copy).toMatch(/border-radius\s*:\s*var\(--r-pill\)/);
  });

  test('浮层底色必须不透明，否则底下的正文会从钮里透出来', () => {
    expect(declarations('.rs-copy')).toMatch(/background\s*:\s*var\(--card\)/);
    expect(declarations('.rs-cmd-full .rs-copy, .rs-cmd-out .rs-copy')).toMatch(/background\s*:\s*#23252c/);
  });
});

describe('气泡内 markdown 排版（issue #298）', () => {
  test('.md 关掉 .rs-msg 的 pre-wrap，只在段落/列表项/退化块开回来', () => {
    // 不关的话标签间的缩进会变成真空白，表格与列表整个错位
    expect(declarations('.md')).toMatch(/white-space\s*:\s*normal/);
    expect(declarations('.md p, .md li, .md-raw')).toMatch(/white-space\s*:\s*pre-wrap/);
  });

  test('表格必须在自己的容器里横滚，绝不撑宽气泡', () => {
    expect(declarations('.md-tablewrap')).toMatch(/overflow-x\s*:\s*auto/);
    expect(declarations('.md-tablewrap')).toMatch(/max-width\s*:\s*100%/);
    // 单元格给 min-width 而不是 nowrap：短格子不被挤成竖条，长格子照常折行
    expect(declarations('.md-table th, .md-table td')).toMatch(/min-width\s*:\s*3\.5em/);
    expect(declarations('.md-table th, .md-table td')).toMatch(/word-break\s*:\s*break-word/);
  });
});
