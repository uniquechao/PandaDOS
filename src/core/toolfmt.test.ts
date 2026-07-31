/**
 * toolfmt 单测（v1 src/toolfmt.test.ts 平移）：describeToolUse 各工具的人话标题/正文
 * + jsonl.ts parseLines 集成（tool_use 带 title、input 为可读正文；tool_result 配回工具名）。
 */
import { test, expect } from 'bun:test';
import { describeToolUse } from './toolfmt';
import { parseLines } from './jsonl';

test('Edit：标题带文件名，正文是路径 + ±diff 行', () => {
  const d = describeToolUse('Edit', {
    file_path: '/root/app/src/Login.tsx',
    old_string: 'const a = 1;\nconst b = 2;',
    new_string: 'const a = 10;',
    replace_all: true,
  });
  expect(d.title).toBe('✏️ 改 Login.tsx');
  const lines = d.body.split('\n');
  expect(lines[0]).toBe('/root/app/src/Login.tsx（全部替换）');
  expect(lines).toContain('- const a = 1;');
  expect(lines).toContain('- const b = 2;');
  expect(lines).toContain('+ const a = 10;');
});

test('Edit：超长字段头尾截断且不撑爆正文', () => {
  const long = 'x'.repeat(5000);
  const d = describeToolUse('Edit', { file_path: 'a.ts', old_string: long, new_string: 'y' });
  expect(d.body).toContain('…[省略');
  expect(d.body.length).toBeLessThan(1000);
});

test('MultiEdit：标题带 ×N，diff 段用 ── 分隔', () => {
  const d = describeToolUse('MultiEdit', {
    file_path: '/x/y.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
    ],
  });
  expect(d.title).toBe('✏️ 改 y.ts ×2');
  expect(d.body.split('\n──\n').length).toBe(3); // 路径 + 2 段 diff
});

test('Write：标题带文件名，正文带字数', () => {
  const d = describeToolUse('Write', { file_path: '/tmp/note.md', content: 'hello world' });
  expect(d.title).toBe('📝 写 note.md');
  expect(d.body).toContain('（共 11 字）');
  expect(d.body).toContain('hello world');
});

test('Read：带行范围', () => {
  const d = describeToolUse('Read', { file_path: '/a/b.ts', offset: 10, limit: 20 });
  expect(d.title).toBe('📖 读 b.ts');
  expect(d.body).toBe('/a/b.ts（第 10 行起，读 20 行）');
});

test('Bash：优先 description 当标题，正文是 $ 命令', () => {
  const d = describeToolUse('Bash', { command: 'ls -la /tmp', description: '列出临时目录' });
  expect(d.title).toBe('💻 列出临时目录');
  expect(d.body).toBe('$ ls -la /tmp');
  const d2 = describeToolUse('Bash', { command: 'echo hi' });
  expect(d2.title).toBe('💻 echo hi');
});

test('Grep/Glob/TodoWrite/WebFetch 标题', () => {
  expect(describeToolUse('Grep', { pattern: 'foo', path: 'src' }).title).toBe('🔍 搜 foo');
  expect(describeToolUse('Grep', { pattern: 'foo', path: 'src' }).body).toContain('范围: src');
  expect(describeToolUse('Glob', { pattern: '**/*.ts' }).title).toBe('🔍 找 **/*.ts');
  const todo = describeToolUse('TodoWrite', {
    todos: [
      { content: '写测试', status: 'completed' },
      { content: '重启服务', status: 'in_progress' },
    ],
  });
  expect(todo.title).toBe('📋 待办 2 项');
  expect(todo.body).toBe('☑ 写测试\n◐ 重启服务');
  expect(describeToolUse('WebFetch', { url: 'https://example.com/a/b' }).title).toBe('🌐 读网页 example.com');
});

test('未知工具：key: value 列表兜底；非对象入参不炸', () => {
  const d = describeToolUse('FooBar', { alpha: '1', beta: { x: 2 } });
  expect(d.title).toBe('🔧 FooBar');
  expect(d.body).toBe('alpha: 1\nbeta: {"x":2}');
  expect(describeToolUse('FooBar', null).body).toBe('');
  expect(describeToolUse('FooBar', 'oops').title).toBe('🔧 FooBar');
});

test('parseLines 集成：tool_use 得到 title+人话 input，tool_result 配回工具名', () => {
  const use = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Edit',
          input: { file_path: '/a/Login.tsx', old_string: 'old', new_string: 'new' },
        },
      ],
    },
  });
  const res = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
  });
  const { msgs, nextSeq } = parseLines([use, res], 0);
  expect(msgs.length).toBe(2);
  expect(msgs[0]!.role).toBe('tool_use');
  expect(msgs[0]!.title).toBe('✏️ 改 Login.tsx');
  expect(msgs[0]!.input).toContain('- old');
  expect(msgs[0]!.input).toContain('+ new');
  expect(msgs[0]!.input).not.toContain('"file_path"'); // 不再是原始 JSON
  expect(msgs[1]!.role).toBe('tool_result');
  expect(msgs[1]!.tool).toBe('Edit'); // 按 tool_use_id 配回
  expect(nextSeq).toBe(2);
});

test('parseLines：配不上 id 的 tool_result 退化为无工具名', () => {
  const res = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_nope', content: 'x' }] },
  });
  const { msgs } = parseLines([res], 0);
  expect(msgs[0]!.tool).toBeUndefined();
});
