/**
 * markdown 解析单测（issue #298）。
 * 重点在「不规范表格」的容错口径与「判不准就原样退化」这条底线：
 * 表格判错顶多少个边框，把正文吞了才是真事故。
 */
import { describe, expect, test } from 'bun:test';
import { parseInline, parseMarkdown, isSafeHref, type MdBlock, type MdRow } from './markdown';

/** 把一行单元格压回纯文本，方便断言（只关心切分与补齐，不关心行内 AST） */
function textOf(nodes: ReturnType<typeof parseInline>): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text;
        default:
          return textOf(n.children);
      }
    })
    .join('');
}

function rowsOf(row: MdRow | null): string[] {
  return row ? row.map(textOf) : [];
}

function table(md: string): Extract<MdBlock, { type: 'table' }> {
  const blocks = parseMarkdown(md);
  const t = blocks.find((b) => b.type === 'table');
  if (!t || t.type !== 'table') throw new Error(`没解析出表格：${JSON.stringify(blocks)}`);
  return t;
}

describe('parseMarkdown 表格（规范）', () => {
  test('标准 GFM 表格：表头 + 分隔行 + 正文', () => {
    const t = table(['| issue | 时长 |', '|---|---|', '| #264 | 25.8 min |', '| #269 | 15.3 min |'].join('\n'));
    expect(rowsOf(t.head)).toEqual(['issue', '时长']);
    expect(t.rows.map(rowsOf)).toEqual([
      ['#264', '25.8 min'],
      ['#269', '15.3 min'],
    ]);
  });

  test('对齐标记 :--- / :---: / ---:', () => {
    const t = table(['| a | b | c | d |', '|:---|:---:|---:|---|', '| 1 | 2 | 3 | 4 |'].join('\n'));
    expect(t.align).toEqual(['left', 'center', 'right', null]);
  });

  test('单元格里的行内语法照常解析', () => {
    const t = table(['| 名字 | 说明 |', '|---|---|', '| **粗** | `a|b` |'].join('\n'));
    // 反引号里的竖线不当分隔符
    expect(rowsOf(t.rows[0])).toEqual(['粗', 'a|b']);
    expect(t.rows[0][0][0].type).toBe('strong');
  });

  test('转义竖线 \\| 还原成普通字符', () => {
    const t = table(['| a | b |', '|---|---|', '| x \\| y | z |'].join('\n'));
    expect(rowsOf(t.rows[0])).toEqual(['x | y', 'z']);
  });
});

describe('parseMarkdown 表格（不规范）', () => {
  test('整行缺分隔行：第一行当表头', () => {
    const t = table(['| 名字 | 数量 |', '| 甲 | 1 |', '| 乙 | 2 |'].join('\n'));
    expect(rowsOf(t.head)).toEqual(['名字', '数量']);
    expect(t.rows.map(rowsOf)).toEqual([
      ['甲', '1'],
      ['乙', '2'],
    ]);
  });

  test('没有外框竖线', () => {
    const t = table(['名字 | 数量', '--- | ---', '甲 | 1'].join('\n'));
    expect(rowsOf(t.head)).toEqual(['名字', '数量']);
    expect(t.rows.map(rowsOf)).toEqual([['甲', '1']]);
  });

  test('全角竖线 ｜ 等价于半角', () => {
    const t = table(['｜名字｜数量｜', '｜---｜---｜', '｜甲｜1｜'].join('\n'));
    expect(rowsOf(t.head)).toEqual(['名字', '数量']);
    expect(t.rows.map(rowsOf)).toEqual([['甲', '1']]);
  });

  test('分隔行用全角/长横线也认', () => {
    const t = table(['| a | b |', '| —— | —— |', '| 1 | 2 |'].join('\n'));
    expect(rowsOf(t.head)).toEqual(['a', 'b']);
    expect(t.rows.map(rowsOf)).toEqual([['1', '2']]);
  });

  test('分隔行里夹空格子也认', () => {
    const t = table(['| a | b |', '| --- |  |', '| 1 | 2 |'].join('\n'));
    expect(t.rows.map(rowsOf)).toEqual([['1', '2']]);
  });

  test('列数不齐：按最大列右侧补空，一行都不丢', () => {
    const t = table(['| a | b | c |', '|---|---|---|', '| 1 |', '| 1 | 2 | 3 | 4 |'].join('\n'));
    expect(t.align.length).toBe(4);
    expect(rowsOf(t.head)).toEqual(['a', 'b', 'c', '']);
    expect(t.rows.map(rowsOf)).toEqual([
      ['1', '', '', ''],
      ['1', '2', '3', '4'],
    ]);
  });

  test('分隔行跑到中间：只取它的对齐，其余行按原顺序留在正文', () => {
    const t = table(['| a | b |', '| 1 | 2 |', '|---|---:|', '| 3 | 4 |'].join('\n'));
    expect(rowsOf(t.head)).toEqual(['a', 'b']);
    expect(t.align).toEqual([null, 'right']);
    expect(t.rows.map(rowsOf)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  test('分隔行在第一行：没有表头', () => {
    const t = table(['|---|---|', '| 1 | 2 |'].join('\n'));
    expect(t.head).toBeNull();
    expect(t.rows.map(rowsOf)).toEqual([['1', '2']]);
  });

  test('+---+ ASCII 画框表格', () => {
    const t = table(
      ['+------+-----+', '| name | qty |', '+======+=====+', '| 甲   | 1   |', '+------+-----+'].join('\n'),
    );
    expect(rowsOf(t.head)).toEqual(['name', 'qty']);
    expect(t.rows.map(rowsOf)).toEqual([['甲', '1']]);
  });

  test('┌─┬─┐ 制表符画框表格', () => {
    const t = table(
      ['┌──────┬─────┐', '│ name │ qty │', '├──────┼─────┤', '│ 甲   │ 1   │', '└──────┴─────┘'].join('\n'),
    );
    expect(rowsOf(t.head)).toEqual(['name', 'qty']);
    expect(t.rows.map(rowsOf)).toEqual([['甲', '1']]);
  });

  test('表格紧贴上文没有空行也能切出来', () => {
    const blocks = parseMarkdown(['结论如下。', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n'));
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table']);
  });
});

describe('parseMarkdown 表格（退化不吞字）', () => {
  test('只有一列的画框块 → 不当表格，但字一个不少', () => {
    const src = ['+---+', '| a |', '+---+'].join('\n');
    const blocks = parseMarkdown(src);
    expect(blocks.some((b) => b.type === 'table')).toBe(false);
    const shown = blocks
      .map((b) => (b.type === 'text' ? b.text : b.type === 'paragraph' ? textOf(b.children) : ''))
      .join('\n');
    expect(shown).toBe(src);
  });

  test('单独一行带竖线不算表格', () => {
    const blocks = parseMarkdown('用 a | b 表示两种情况。');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph']);
  });

  test('列表项里的竖线不被误判成表格', () => {
    const blocks = parseMarkdown(['- 甲 | 乙', '- 丙 | 丁'].join('\n'));
    expect(blocks.map((b) => b.type)).toEqual(['list']);
  });

  test('围栏代码块里的表格保持原样不解析', () => {
    const blocks = parseMarkdown(['```', '| a | b |', '|---|---|', '```'].join('\n'));
    expect(blocks).toEqual([{ type: 'code', lang: '', text: '| a | b |\n|---|---|' }]);
  });

  test('服务端截断标记落在表格中间也不崩', () => {
    const t = table(['| a | b |', '|---|---|', '| 1 | 2 |', '…[省略120字]…', '| 3 | 4 |'].join('\n'));
    expect(t.rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseMarkdown 其他块级', () => {
  test('标题 1~6 级', () => {
    const blocks = parseMarkdown(['# 一', '### 三', '###### 六'].join('\n'));
    expect(blocks.map((b) => (b.type === 'heading' ? b.level : -1))).toEqual([1, 3, 6]);
  });

  test('无序列表 + 嵌套', () => {
    const blocks = parseMarkdown(['- 甲', '  - 甲一', '- 乙'].join('\n'));
    const list = blocks[0];
    if (list.type !== 'list') throw new Error('不是列表');
    expect(list.ordered).toBe(false);
    expect(list.items.length).toBe(2);
    expect(list.items[0].blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
  });

  test('有序列表保留起始序号', () => {
    const blocks = parseMarkdown(['3. 甲', '4. 乙'].join('\n'));
    const list = blocks[0];
    if (list.type !== 'list') throw new Error('不是列表');
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    expect(list.items.length).toBe(2);
  });

  test('任务列表勾选状态', () => {
    const blocks = parseMarkdown(['- [x] 做完了', '- [ ] 还没'].join('\n'));
    const list = blocks[0];
    if (list.type !== 'list') throw new Error('不是列表');
    expect(list.items.map((it) => it.checked)).toEqual([true, false]);
  });

  test('围栏代码块带语言标注', () => {
    const blocks = parseMarkdown(['```ts', 'const a = 1;', '```'].join('\n'));
    expect(blocks).toEqual([{ type: 'code', lang: 'ts', text: 'const a = 1;' }]);
  });

  test('未闭合的围栏吃到结尾，不吞字', () => {
    const blocks = parseMarkdown(['```', 'x', 'y'].join('\n'));
    expect(blocks).toEqual([{ type: 'code', lang: '', text: 'x\ny' }]);
  });

  test('引用块递归解析', () => {
    const blocks = parseMarkdown(['> ## 标题', '> 正文'].join('\n'));
    const q = blocks[0];
    if (q.type !== 'quote') throw new Error('不是引用');
    expect(q.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
  });

  test('分隔线', () => {
    expect(parseMarkdown('---')).toEqual([{ type: 'hr' }]);
    expect(parseMarkdown('***')).toEqual([{ type: 'hr' }]);
  });

  test('段落保留软换行（聊天里的断行有意义）', () => {
    const blocks = parseMarkdown(['第一行', '第二行'].join('\n'));
    expect(blocks.length).toBe(1);
    if (blocks[0].type !== 'paragraph') throw new Error('不是段落');
    expect(textOf(blocks[0].children)).toBe('第一行\n第二行');
  });

  test('空串 → 空数组', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});

describe('parseInline', () => {
  test('行内代码', () => {
    expect(parseInline('见 `a.ts` 文件')).toEqual([
      { type: 'text', text: '见 ' },
      { type: 'code', text: 'a.ts' },
      { type: 'text', text: ' 文件' },
    ]);
  });

  test('粗体优先于斜体，不会把 **x** 拆成 *、*x*', () => {
    const nodes = parseInline('**重点**');
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe('strong');
  });

  test('斜体与删除线', () => {
    expect(parseInline('*斜*').map((n) => n.type)).toEqual(['em']);
    expect(parseInline('~~删~~').map((n) => n.type)).toEqual(['del']);
  });

  test('snake_case 不被当成斜体（刻意不支持下划线强调）', () => {
    expect(parseInline('module_id 与 __init__')).toEqual([{ type: 'text', text: 'module_id 与 __init__' }]);
  });

  test('乘法星号不会误配成斜体', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
  });

  test('强调不跨行配对', () => {
    expect(parseInline('a *b\nc* d')).toEqual([{ type: 'text', text: 'a *b\nc* d' }]);
  });

  test('链接与裸链', () => {
    const link = parseInline('[看这里](https://a.com/b)');
    expect(link).toEqual([
      { type: 'link', href: 'https://a.com/b', children: [{ type: 'text', text: '看这里' }] },
    ]);
    const bare = parseInline('见 https://a.com/b。');
    expect(bare[1]).toEqual({ type: 'link', href: 'https://a.com/b', children: [{ type: 'text', text: 'https://a.com/b' }] });
    expect(bare[2]).toEqual({ type: 'text', text: '。' });
  });

  test('javascript: 这类链接退回纯文字，不产出可点 href', () => {
    const nodes = parseInline('[点我](javascript:alert(1))');
    expect(nodes.every((n) => n.type !== 'link')).toBe(true);
    expect(textOf(nodes)).toBe('[点我](javascript:alert(1))');
  });

  test('反斜杠转义', () => {
    expect(parseInline('\\*不是斜体\\*')).toEqual([{ type: 'text', text: '*不是斜体*' }]);
  });

  test('未闭合的标记原样保留', () => {
    expect(parseInline('未闭合 **粗体')).toEqual([{ type: 'text', text: '未闭合 **粗体' }]);
    expect(parseInline('未闭合 `代码')).toEqual([{ type: 'text', text: '未闭合 `代码' }]);
  });
});

describe('isSafeHref', () => {
  test('放行 http(s)/mailto/相对路径', () => {
    expect(isSafeHref('https://a.com')).toBe(true);
    expect(isSafeHref('mailto:a@b.c')).toBe(true);
    expect(isSafeHref('/p/1')).toBe(true);
    expect(isSafeHref('#top')).toBe(true);
    expect(isSafeHref('./a.md')).toBe(true);
  });

  test('挡掉脚本与未知协议', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,x')).toBe(false);
    expect(isSafeHref('')).toBe(false);
  });
});
