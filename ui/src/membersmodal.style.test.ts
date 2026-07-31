/**
 * 项目成员弹窗（MembersModal）重设计的样式约束（issue #99，对齐 modulespanel.style.test.ts
 * 的字符串校验法）。守住：wide 弹窗、成员行紧凑单行（名称/活跃小字挤压省略、统计不缩）、
 * 操作胶囊 hover 隐藏只许包在 hover:hover 里（触屏常驻）、≤479px 折整洁两行、
 * 添加成员走候选下拉（不再手输用户名）、转让属主先 confirm。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const boardSrc = readFileSync(new URL('./views/Board.tsx', import.meta.url), 'utf8');
const modalSrc = boardSrc.match(/function MembersModal[\s\S]*?\nfunction /)?.[0] ?? '';

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('成员弹窗底座', () => {
  test('启用 wide 变体（桌面 640px，窄屏仍底部抽屉由 #90 约束守着）', () => {
    expect(modalSrc).toContain('<Modal title="项目成员" wide');
  });
});

describe('成员行紧凑单行', () => {
  test('基础态单行不换行；名称/活跃小字挤压省略、统计与徽标不缩', () => {
    const row = declarations('.memrow');
    expect(row).toContain('display: flex');
    expect(row).not.toContain('flex-wrap');
    expect(declarations('.memrow-main')).toContain('min-width: 0');
    expect(declarations('.memrow-name')).toContain('text-overflow: ellipsis');
    const meta = declarations('.memrow-meta');
    expect(meta).toContain('min-width: 0');
    expect(meta).toContain('text-overflow: ellipsis');
    expect(declarations('.memrow-stat')).toContain('flex-shrink: 0');
    expect(declarations('.memrow .badge')).toContain('flex-shrink: 0');
  });

  test('活跃时间/统计数据在行内呈现（登录·活跃 + issue 完成/总数，title 带完整信息）', () => {
    expect(modalSrc).toContain('actLine(m)');
    expect(modalSrc).toContain('actTitle(m)');
    expect(modalSrc).toMatch(/登录 \$\{m\.lastLoginTs \? timeAgo/);
    expect(modalSrc).toContain('issue {m.issueDone}/{m.issueTotal}');
  });
});

describe('操作胶囊（设为属主/移除）', () => {
  test('.memrow-act 是主页面同款胶囊（r-pill），danger 红字', () => {
    expect(declarations('.memrow-act')).toContain('border-radius: var(--r-pill)');
    expect(declarations('.memrow-act.danger')).toContain('#b91c1c');
  });

  test('opacity 隐藏只许出现在 hover:hover 块（触屏常驻），hover/focus-within 复原', () => {
    // 基础态不许带 opacity 隐藏
    expect(declarations('.memrow-acts')).not.toContain('opacity');
    const hoverBlock = css.match(/@media \(hover: hover\) \{[^@]*?\n  \.memrow-acts \{([^}]*)\}/)?.[1] ?? '';
    expect(hoverBlock).toContain('opacity: 0');
    expect(css).toMatch(/\.memrow:hover \.memrow-acts, \.memrow:focus-within \.memrow-acts \{ opacity: 1; \}/);
  });

  test('转让属主先 confirm 再请求，文案说明原属主降为成员', () => {
    const fn = modalSrc.match(/const makeOwner = async[\s\S]*?\n  };/)?.[0] ?? '';
    expect(fn).toContain('confirm(');
    expect(fn).toContain('原属主将降为成员');
    expect(fn.indexOf('confirm(')).toBeLessThan(fn.indexOf('transferOwner('));
    expect(modalSrc).toContain('设为属主');
  });
});

describe('窄屏与添加交互', () => {
  test('≤479px 折两行：名称占满首行，操作钮右对齐次行', () => {
    const narrow = css.match(/@media \(max-width: 479px\) \{[^@]*\.memrow \{([^}]*)\}/)?.[1] ?? '';
    expect(narrow).toContain('flex-wrap: wrap');
    const block = css.match(/@media \(max-width: 479px\) \{[^@]*\.memrow-acts[^@]*?\}/)?.[0] ?? '';
    expect(block).toContain('.memrow-main { flex-basis: 100%; }');
    expect(block).toContain('.memrow-acts { margin-left: auto; }');
  });

  test('添加成员走候选下拉（member-candidates），不再手输用户名', () => {
    expect(modalSrc).toContain('listMemberCandidates');
    expect(modalSrc).toContain('<select');
    expect(modalSrc).not.toContain('placeholder="输入用户名添加成员"');
    // 没有候选时下拉给出空态提示
    expect(modalSrc).toContain('没有可添加的用户');
  });
});
