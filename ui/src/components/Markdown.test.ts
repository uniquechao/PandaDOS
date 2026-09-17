/**
 * Markdown 组件单测（issue #298）。
 * 没有 DOM 环境，但组件是纯函数：直接调用后把 preact vnode 树摊平成
 * 「标签 + 属性 + 文本」再断言，比对源码做字符串匹配靠谱得多。
 */
import { describe, expect, test } from 'bun:test';
import { Fragment, type VNode } from 'preact';
import { Markdown } from './Markdown';

interface El {
  tag: string;
  props: Record<string, unknown>;
  children: Node[];
}
type Node = string | El;

function isVNode(v: unknown): v is VNode<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && 'type' in v && 'props' in v;
}

/** 摊平 vnode：函数组件就地调用（纯函数），Fragment 透明，其余落成 El */
function flat(v: unknown, out: Node[]): void {
  if (v === null || v === undefined || typeof v === 'boolean') return;
  if (Array.isArray(v)) {
    for (const x of v) flat(x, out);
    return;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    out.push(String(v));
    return;
  }
  if (!isVNode(v)) return;
  const type = v.type as unknown;
  const props = (v.props ?? {}) as Record<string, unknown>;
  if (type === Fragment) {
    flat(props.children, out);
    return;
  }
  if (typeof type === 'function') {
    flat((type as (p: Record<string, unknown>) => unknown)(props), out);
    return;
  }
  const { children, ...rest } = props;
  const kids: Node[] = [];
  flat(children, kids);
  out.push({ tag: String(type), props: rest, children: kids });
}

function render(text: string): Node[] {
  const out: Node[] = [];
  flat(Markdown({ text }), out);
  return out;
}

function walk(nodes: Node[], visit: (el: El) => void): void {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    visit(n);
    walk(n.children, visit);
  }
}

function all(nodes: Node[], tag: string): El[] {
  const hit: El[] = [];
  walk(nodes, (el) => {
    if (el.tag === tag) hit.push(el);
  });
  return hit;
}

function textOf(nodes: Node[]): string {
  return nodes.map((n) => (typeof n === 'string' ? n : textOf(n.children))).join('');
}

describe('Markdown 渲染', () => {
  test('根节点带 .md，className 追加在后面', () => {
    const out: Node[] = [];
    flat(Markdown({ text: 'x', className: 'rs-msg-body' }), out);
    expect((out[0] as El).props.class).toBe('md rs-msg-body');
    expect((render('x')[0] as El).props.class).toBe('md');
  });

  test('段落保留软换行（原文一字不改）', () => {
    const p = all(render('第一行\n第二行'), 'p');
    expect(p.length).toBe(1);
    expect(textOf(p[0].children)).toBe('第一行\n第二行');
  });

  test('标题按级别落 h1~h6', () => {
    const out = render('# 一\n\n### 三\n\n###### 六');
    expect(all(out, 'h1').length).toBe(1);
    expect(all(out, 'h3').length).toBe(1);
    expect(all(out, 'h6').length).toBe(1);
  });

  test('行内语法落成对应标签', () => {
    const out = render('**粗** *斜* ~~删~~ `码`');
    expect(all(out, 'strong').length).toBe(1);
    expect(all(out, 'em').length).toBe(1);
    expect(all(out, 'del').length).toBe(1);
    expect(all(out, 'code').length).toBe(1);
    expect(textOf(out)).toBe('粗 斜 删 码');
  });

  test('链接新标签打开且带 noopener', () => {
    const a = all(render('[看这里](https://a.com/b)'), 'a');
    expect(a.length).toBe(1);
    expect(a[0].props.href).toBe('https://a.com/b');
    expect(a[0].props.target).toBe('_blank');
    expect(a[0].props.rel).toBe('noopener noreferrer');
  });

  test('javascript: 链接不产出 <a>，只留文字', () => {
    const out = render('[点我](javascript:alert(1))');
    expect(all(out, 'a').length).toBe(0);
    expect(textOf(out)).toBe('[点我](javascript:alert(1))');
  });

  test('列表：无序/有序起始序号/任务勾选', () => {
    expect(all(render('- 甲\n- 乙'), 'li').length).toBe(2);
    const ol = all(render('3. 甲\n4. 乙'), 'ol');
    expect(ol[0].props.start).toBe(3);
    const box = all(render('- [x] 做完了\n- [ ] 还没'), 'input');
    expect(box.map((b) => b.props.checked)).toEqual([true, false]);
    expect(box.every((b) => b.props.disabled === true)).toBe(true);
  });

  test('代码围栏落 pre>code 并带语言 class', () => {
    const out = render('```ts\nconst a = 1;\n```');
    const code = all(out, 'code');
    expect(all(out, 'pre').length).toBe(1);
    expect(code[0].props.class).toBe('lang-ts');
    expect(textOf(code[0].children)).toBe('const a = 1;');
  });

  test('引用与分隔线', () => {
    expect(all(render('> 引用'), 'blockquote').length).toBe(1);
    expect(all(render('---'), 'hr').length).toBe(1);
  });
});

describe('Markdown 表格', () => {
  const src = ['| issue | 时长 |', '|---|---:|', '| #264 | 25.8 min |'].join('\n');

  test('套横向滚动容器，绝不撑宽气泡', () => {
    const wrap = all(render(src), 'div').filter((d) => d.props.class === 'md-tablewrap');
    expect(wrap.length).toBe(1);
    expect(all(wrap, 'table')[0].props.class).toBe('md-table');
  });

  test('表头进 thead>th，正文进 tbody>td', () => {
    const out = render(src);
    expect(all(all(out, 'thead'), 'th').map((c) => textOf(c.children))).toEqual(['issue', '时长']);
    expect(all(all(out, 'tbody'), 'td').map((c) => textOf(c.children))).toEqual(['#264', '25.8 min']);
  });

  test('对齐标记落到单元格 style 上', () => {
    const th = all(render(src), 'th');
    expect(th[0].props.style).toBeUndefined();
    expect(th[1].props.style).toEqual({ textAlign: 'right' });
  });

  test('没有分隔行的表格照样出表头', () => {
    const out = render('| 名字 | 数量 |\n| 甲 | 1 |');
    expect(all(out, 'th').map((c) => textOf(c.children))).toEqual(['名字', '数量']);
    expect(all(out, 'td').map((c) => textOf(c.children))).toEqual(['甲', '1']);
  });

  test('分隔行在首行 = 无表头，只出 tbody', () => {
    const out = render('|---|---|\n| 1 | 2 |');
    expect(all(out, 'thead').length).toBe(0);
    expect(all(out, 'td').length).toBe(2);
  });

  test('画框表格也能渲染成 table', () => {
    const out = render(
      ['┌──────┬─────┐', '│ name │ qty │', '├──────┼─────┤', '│ 甲   │ 1   │', '└──────┴─────┘'].join('\n'),
    );
    expect(all(out, 'table').length).toBe(1);
    expect(all(out, 'th').map((c) => textOf(c.children))).toEqual(['name', 'qty']);
  });

  test('判不准的块退化成 .md-raw 原样文本', () => {
    const out = render(['+---+', '| a |', '+---+'].join('\n'));
    expect(all(out, 'table').length).toBe(0);
    expect(textOf(out)).toBe('+---+| a |+---+');
  });
});

describe('Markdown 安全底线', () => {
  test('任何节点都不得用 dangerouslySetInnerHTML', () => {
    const samples = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '**粗** <b>粗</b>',
      '| a | b |\n|---|---|\n| <i>x</i> | y |',
    ];
    for (const s of samples) {
      const out = render(s);
      walk(out, (el) => {
        expect(el.props.dangerouslySetInnerHTML).toBeUndefined();
      });
    }
  });

  test('裸 HTML 一律当文字，不产生对应标签', () => {
    const out = render('<script>alert(1)</script>');
    expect(all(out, 'script').length).toBe(0);
    expect(textOf(out)).toBe('<script>alert(1)</script>');
  });
});
