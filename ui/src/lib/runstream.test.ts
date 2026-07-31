import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './types';
import {
  fmtDuration,
  isCommandTool,
  lastToolErrored,
  producedFilesOf,
  toRunEvents,
  type RunToolEvent,
} from './runstream';

/** 便捷构造 ChatMessage（补默认字段） */
function msg(m: Partial<ChatMessage> & Pick<ChatMessage, 'seq' | 'role'>): ChatMessage {
  return m as ChatMessage;
}

describe('toRunEvents 配对与状态', () => {
  test('tool_use + tool_result 折叠成单个工具事件（ok + 耗时）', () => {
    const evs = toRunEvents([
      msg({ seq: 0, role: 'tool_use', tool: 'Read', title: '📖 看 a.ts', input: 'a.ts', ts: 1000 }),
      msg({ seq: 1, role: 'tool_result', tool: 'Read', result: 'file body', ts: 4000 }),
    ]);
    expect(evs.length).toBe(1);
    const t = evs[0] as RunToolEvent;
    expect(t.kind).toBe('tool');
    expect(t.seq).toBe(0);
    expect(t.status).toBe('ok');
    expect(t.result).toBe('file body');
    expect(t.title).toBe('📖 看 a.ts');
    expect(t.durationMs).toBe(3000);
  });

  test('Bash/shell → kind command', () => {
    const evs = toRunEvents([
      msg({ seq: 0, role: 'tool_use', tool: 'Bash', input: '$ ls', ts: 0 }),
      msg({ seq: 1, role: 'tool_result', tool: 'Bash', result: 'a\nb', ts: 500 }),
    ]);
    expect((evs[0] as RunToolEvent).kind).toBe('command');
    expect((evs[0] as RunToolEvent).durationMs).toBe(500);
  });

  test('结果 isError → status error', () => {
    const evs = toRunEvents([
      msg({ seq: 0, role: 'tool_use', tool: 'Edit', input: 'x.ts', ts: 0 }),
      msg({ seq: 1, role: 'tool_result', tool: 'Edit', result: 'boom', isError: true, ts: 200 }),
    ]);
    const t = evs[0] as RunToolEvent;
    expect(t.status).toBe('error');
    expect(t.isError).toBe(true);
  });

  test('未见结果的 tool_use（尾部执行中）→ status running、无 result', () => {
    const evs = toRunEvents([msg({ seq: 0, role: 'tool_use', tool: 'Bash', input: '$ sleep 9', ts: 0 })]);
    const t = evs[0] as RunToolEvent;
    expect(t.status).toBe('running');
    expect(t.result).toBeUndefined();
    expect(t.durationMs).toBeUndefined();
  });

  test('thinking / assistant / user 各成事件', () => {
    const evs = toRunEvents([
      msg({ seq: 0, role: 'thinking', text: '想一想' }),
      msg({ seq: 1, role: 'assistant', text: '好的' }),
      msg({ seq: 2, role: 'user', text: '继续' }),
    ]);
    expect(evs.map((e) => e.kind)).toEqual(['thinking', 'message', 'message']);
    expect(evs[1]).toMatchObject({ kind: 'message', role: 'assistant', text: '好的' });
    expect(evs[2]).toMatchObject({ kind: 'message', role: 'user', text: '继续' });
  });

  test('user 消息带附图 → message 事件透传 images；无图/非 user 不挂 images 字段', () => {
    const imgs = ['.mando/uploads/a/x.png', '.mando/uploads/b/y.jpg'];
    const evs = toRunEvents([
      msg({ seq: 0, role: 'user', text: '看这两张', images: imgs }),
      msg({ seq: 1, role: 'user', text: '纯文字' }), // 无图
      msg({ seq: 2, role: 'assistant', text: '收到' }), // 非 user
    ]);
    expect(evs[0]).toMatchObject({ kind: 'message', role: 'user', text: '看这两张', images: imgs });
    expect((evs[1] as { images?: string[] }).images).toBeUndefined();
    expect((evs[2] as { images?: string[] }).images).toBeUndefined();
  });

  test('并行同名工具：结果按调用顺序配对（FIFO）', () => {
    const evs = toRunEvents([
      msg({ seq: 0, role: 'tool_use', tool: 'Read', input: 'A', ts: 1000 }),
      msg({ seq: 1, role: 'tool_use', tool: 'Read', input: 'B', ts: 1000 }),
      msg({ seq: 2, role: 'tool_result', tool: 'Read', result: 'RA', ts: 1500 }),
      msg({ seq: 3, role: 'tool_result', tool: 'Read', result: 'RB', ts: 1600 }),
    ]);
    const tools = evs.filter((e): e is RunToolEvent => e.kind === 'tool' || e.kind === 'command');
    expect(tools.map((t) => [t.seq, t.result])).toEqual([
      [0, 'RA'],
      [1, 'RB'],
    ]);
  });

  test('孤儿结果（配套 tool_use 在窗口外）单独成事件', () => {
    const evs = toRunEvents([
      msg({ seq: 5, role: 'tool_result', tool: 'Grep', result: 'orphan', ts: 9 }),
    ]);
    expect(evs.length).toBe(1);
    const t = evs[0] as RunToolEvent;
    expect(t.seq).toBe(5);
    expect(t.result).toBe('orphan');
    expect(t.status).toBe('ok');
    expect(t.input).toBeUndefined();
  });

  test('时间戳缺失 → 无耗时，状态仍正确', () => {
    const evs = toRunEvents([
      msg({ seq: 0, role: 'tool_use', tool: 'Read', input: 'a' }),
      msg({ seq: 1, role: 'tool_result', tool: 'Read', result: 'ok' }),
    ]);
    const t = evs[0] as RunToolEvent;
    expect(t.status).toBe('ok');
    expect(t.durationMs).toBeUndefined();
  });
});

describe('lastToolErrored', () => {
  test('最后一条工具结果为异常 → true', () => {
    expect(
      lastToolErrored([
        msg({ seq: 0, role: 'tool_result', result: 'ok' }),
        msg({ seq: 1, role: 'tool_result', result: 'boom', isError: true }),
      ]),
    ).toBe(true);
  });

  test('最后一条工具结果正常 → false（即便更早有异常）', () => {
    expect(
      lastToolErrored([
        msg({ seq: 0, role: 'tool_result', result: 'boom', isError: true }),
        msg({ seq: 1, role: 'tool_result', result: 'ok' }),
      ]),
    ).toBe(false);
  });

  test('尾部是运行中的 tool_use / assistant：回看最近的结果', () => {
    expect(
      lastToolErrored([
        msg({ seq: 0, role: 'tool_result', result: 'boom', isError: true }),
        msg({ seq: 1, role: 'assistant', text: '我看看' }),
        msg({ seq: 2, role: 'tool_use', tool: 'Bash', input: '$ retry' }),
      ]),
    ).toBe(true);
  });

  test('无任何工具结果 → false', () => {
    expect(lastToolErrored([msg({ seq: 0, role: 'assistant', text: 'hi' })])).toBe(false);
    expect(lastToolErrored([])).toBe(false);
  });
});

describe('isCommandTool', () => {
  test('bash/shell（大小写不敏感）为真，其余为假', () => {
    expect(isCommandTool('Bash')).toBe(true);
    expect(isCommandTool('bash')).toBe(true);
    expect(isCommandTool('shell')).toBe(true);
    expect(isCommandTool('SHELL')).toBe(true);
    expect(isCommandTool('Read')).toBe(false);
    expect(isCommandTool(undefined)).toBe(false);
  });
});

describe('fmtDuration', () => {
  test('ms / s / m 分档，负与空为空串', () => {
    expect(fmtDuration(820)).toBe('820ms');
    expect(fmtDuration(3000)).toBe('3.0s');
    expect(fmtDuration(62000)).toBe('1m2s');
    expect(fmtDuration(60000)).toBe('1m0s');
    expect(fmtDuration(0)).toBe('0ms');
    expect(fmtDuration(undefined)).toBe('');
    expect(fmtDuration(-5)).toBe('');
  });
});

describe('producedFilesOf', () => {
  test('抓 Write/Edit 的 file_path（首行去「（…）」）、顺序去重、跳过 Bash/Read', () => {
    const paths = producedFilesOf([
      msg({ seq: 0, role: 'tool_use', tool: 'Write', input: 'out/chart.png（共 1024 字）\n<binary>' }),
      msg({ seq: 1, role: 'tool_use', tool: 'Edit', input: 'src/App.tsx（全部替换）\n- a\n+ b' }),
      msg({ seq: 2, role: 'tool_use', tool: 'Bash', input: '$ python gen.py' }), // 不算
      msg({ seq: 3, role: 'tool_use', tool: 'Read', input: 'README.md' }), // 不算
      msg({ seq: 4, role: 'tool_use', tool: 'Write', input: 'out/chart.png（共 2048 字）' }), // 去重
    ]);
    expect(paths).toEqual(['out/chart.png', 'src/App.tsx']);
  });

  test('无写文件工具 → 空', () => {
    expect(producedFilesOf([msg({ seq: 0, role: 'assistant', text: 'hi' })])).toEqual([]);
  });
});
