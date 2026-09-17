/**
 * toolfmt 单测（v1 src/toolfmt.test.ts 平移）：describeToolUse 各工具的人话标题/正文
 * + jsonl.ts parseLines 集成（tool_use 带 title、input 为可读正文；tool_result 配回工具名）。
 */
import { test, expect } from 'bun:test';
import { describeToolUse, normalizeToolResult } from './toolfmt';
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

test('Codex exec：提取真实命令并剥离编排结果头', () => {
  const d = describeToolUse('exec', {
    input: 'const r = await tools.exec_command({cmd:"git status --short",workdir:"/repo",yield_time_ms:10000}); text(r.output);',
  });
  expect(d.title).toBe('💻 git status --short');
  expect(d.body).toBe('$ git status --short');
  expect(normalizeToolResult('exec', 'Script completed\nWall time 0.1 seconds\nOutput: M src/a.ts')).toBe('M src/a.ts');
  expect(normalizeToolResult('Read', 'Script completed\nWall time 0.1 seconds\nOutput: raw')).toContain('Script completed');
});

test('Codex exec：多调用保留全部真实命令且不暴露 JavaScript 包装', () => {
  const d = describeToolUse('exec', {
    input: `const [status, tests] = await Promise.all([
      tools.exec_command({"cmd":"git status --short","workdir":"/repo"}),
      tools.exec_command({cmd:"bun test",workdir:"/repo"}),
    ]); text(status.output); text(tests.output);`,
  });
  expect(d.title).toBe('💻 git status --short ×2');
  expect(d.body).toBe('$ git status --short\n──\n$ bun test');
  expect(d.body).not.toContain('tools.exec_command');
  expect(d.body).not.toContain('Promise.all');
});

test('Codex exec：非命令包装保留嵌套工具参数且不暴露包装源码', () => {
  const d = describeToolUse('exec', {
    input: 'const r = await tools.view_image({"path":"/repo/image.png","detail":"original"}); image(r.image_url);',
  });
  expect(d.title).toBe('🔧 view_image');
  expect(d.body).toBe('path: /repo/image.png\ndetail: original');
  expect(d.body).not.toContain('const r');
  expect(d.body).not.toContain('tools.view_image');
});

test('Codex apply_patch：保留目标路径与 diff，不显示 input 字段包装', () => {
  const d = describeToolUse('apply_patch', {
    input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch',
  });
  expect(d.title).toBe('✏️ 改 a.ts');
  expect(d.body).toBe('src/a.ts\n@@\n-old\n+new');
  expect(d.body).not.toContain('input:');
  expect(d.body).not.toContain('*** Begin Patch');
});

test('Codex exec：解析字符串常量传入的 apply_patch 并保留 diff', () => {
  const d = describeToolUse('exec', {
    input: 'const patch = "*** Begin Patch\\n*** Update File: src/b.ts\\n@@\\n-before\\n+after\\n*** End Patch"; text(await tools.apply_patch(patch));',
  });
  expect(d.title).toBe('✏️ 改 b.ts');
  expect(d.body).toBe('src/b.ts\n@@\n-before\n+after');
  expect(d.body).not.toContain('const patch');
  expect(d.body).not.toContain('tools.apply_patch');
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

// ---------- full 模式（issue #288「查看完整内容」按 off 回源重解析时用） ----------

test('full=true：Edit 的超长 ±diff 一个字都不截', () => {
  const long = 'x'.repeat(5000);
  const d = describeToolUse('Edit', { file_path: 'a.ts', old_string: long, new_string: 'y' }, true);
  expect(d.body).not.toContain('…[省略');
  expect(d.body).toContain(`- ${long}`);
  expect(d.title).toBe('✏️ 改 a.ts'); // 标题仍是一行摘要，不随 full 变长
});

test('full=true：Bash 超长命令不截；默认仍按 600 截', () => {
  const cmd = `echo ${'y'.repeat(3000)}`;
  expect(describeToolUse('Bash', { command: cmd }, true).body).toBe(`$ ${cmd}`);
  expect(describeToolUse('Bash', { command: cmd }).body).toContain('…[省略');
});

test('full=true：Write / Task / ExitPlanMode 的正文字段不截', () => {
  const long = 'z'.repeat(2000);
  expect(describeToolUse('Write', { file_path: 'a.md', content: long }, true).body).toContain(long);
  expect(describeToolUse('Task', { description: 'x', prompt: long }, true).body).toBe(long);
  expect(describeToolUse('ExitPlanMode', { plan: long }, true).body).toBe(long);
});

test('full=true：apply_patch 与 codex exec 包装都透传不截', () => {
  const body = 'a'.repeat(4000);
  const patch = `*** Begin Patch\n*** Update File: src/a.ts\n${body}\n*** End Patch`;
  expect(describeToolUse('apply_patch', { input: patch }, true).body).toContain(body);
  expect(describeToolUse('apply_patch', { input: patch }).body).toContain('…[省略');

  const cmd = `ls ${'b'.repeat(3000)}`;
  expect(describeToolUse('exec', { cmd }, true).body).toBe(`$ ${cmd}`);
  const wrapped = `tools.exec_command({cmd: ${JSON.stringify(cmd)}})`;
  expect(describeToolUse('exec', { input: wrapped }, true).body).toBe(`$ ${cmd}`);
});

test('full=true：未知工具的 key: value 列表不截', () => {
  const long = 'w'.repeat(1000);
  const d = describeToolUse('SomeMcpTool', { detail: long }, true);
  expect(d.body).toBe(`detail: ${long}`);
  expect(describeToolUse('SomeMcpTool', { detail: long }).body).toContain('…[省略');
});
