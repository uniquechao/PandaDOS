import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDriver } from '../executor/local';
import { JsonlLocator, parseLines, readOlder, readRecentMessages, tailConversation } from './jsonl';

let dir: string;
const driver = new LocalDriver();

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-jsonl-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function asst(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}
function toolResult(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
}

describe('parseLines（v1 chat.ts 平移）', () => {
  test('assistant/thinking/tool_use/tool_result/user 全形态', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '你好' },
            { type: 'thinking', thinking: '想一想' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok' }], is_error: false }] },
      }),
      JSON.stringify({ type: 'user', message: { content: '手动输入' } }),
      '不是 json 的行',
    ];
    const { msgs, nextSeq } = parseLines(lines, 0);
    expect(msgs.map((m) => m.role)).toEqual(['assistant', 'thinking', 'tool_use', 'tool_result', 'user']);
    expect(msgs[0]!.text).toBe('你好');
    expect(msgs[3]!.result).toBe('ok');
    expect(nextSeq).toBe(5);
  });
});

describe('claude 排队消息（issue #116：代理正忙时发进去的话）', () => {
  const PROMPT = '这里看起来也很 low';
  /** 生产实测三行：enqueue → remove → 消费时补记的 attachment（顺序与文件里一致） */
  function queuedTriple(prompt: string): string[] {
    return [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: prompt }),
      JSON.stringify({ type: 'queue-operation', operation: 'remove', content: prompt }),
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-07-29T05:12:53.036Z',
        attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' } },
      }),
    ];
  }

  test('排队行进气泡（user 角色 + 行级 ts），queue-operation 行不进', () => {
    const { msgs, nextSeq } = parseLines(queuedTriple(PROMPT), 0);
    expect(msgs.map((m) => m.role)).toEqual(['user']);
    expect(msgs[0]!.text).toBe(PROMPT);
    expect(msgs[0]!.ts).toBe(Date.parse('2026-07-29T05:12:53.036Z'));
    expect(nextSeq).toBe(1);
  });

  test('同一条话只出一个气泡，且不影响常规 user 行', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '空闲时发的' } }),
      ...queuedTriple(PROMPT),
      asst('好的'),
    ];
    const { msgs } = parseLines(lines, 0);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(msgs.map((m) => m.text)).toEqual(['空闲时发的', PROMPT, '好的']);
  });

  test('非人来源 / 非 queued_command 的 attachment 不进气泡', () => {
    const lines = [
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: '系统塞的', origin: { kind: 'system' } },
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'selected_lines_in_ide', prompt: '选区', origin: { kind: 'human' } },
      }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'human' } } }),
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: '   ', origin: { kind: 'human' } },
      }),
    ];
    expect(parseLines(lines, 0).msgs).toEqual([]);
  });
});

describe('行级 timestamp → ts（毫秒，供执行流算耗时）', () => {
  test('claude 行 timestamp 挂到该行所有消息', () => {
    const iso = '2024-06-01T12:34:56.000Z';
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: iso,
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const { msgs } = parseLines([line], 0);
    const ms = Date.parse(iso);
    expect(msgs.length).toBe(2);
    expect(msgs.every((m) => m.ts === ms)).toBe(true);
  });

  test('tool_use / tool_result 各取所在行 timestamp（可算耗时）', () => {
    const t0 = '2024-06-01T00:00:00.000Z';
    const t1 = '2024-06-01T00:00:03.000Z';
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: t0,
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 3' } }] },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: t1,
        message: { content: [{ type: 'tool_result', content: 'done' }] },
      }),
    ];
    const { msgs } = parseLines(lines, 0);
    expect(msgs[0]!.ts).toBe(Date.parse(t0));
    expect(msgs[1]!.ts).toBe(Date.parse(t1));
    expect(msgs[1]!.ts! - msgs[0]!.ts!).toBe(3000);
  });

  test('无 / 非法 timestamp → ts 缺省 undefined', () => {
    const noTs = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } });
    const badTs = JSON.stringify({
      type: 'assistant',
      timestamp: 'not-a-date',
      message: { content: [{ type: 'text', text: 'b' }] },
    });
    const { msgs } = parseLines([noTs, badTs], 0);
    expect(msgs[0]!.ts).toBeUndefined();
    expect(msgs[1]!.ts).toBeUndefined();
  });

  test('codex response_item timestamp 同样提取', () => {
    const iso = '2025-01-02T03:04:05.000Z';
    const line = JSON.stringify({
      timestamp: iso,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    });
    const { msgs } = parseLines([line], 0);
    expect(msgs[0]!.ts).toBe(Date.parse(iso));
  });
});

describe('tailConversation（字节 offset + 保留未完成尾行 + 轮转重置）', () => {
  test('增量消费：只吃完整行，半行留给下一轮', async () => {
    const f = path.join(dir, 'tail-1.jsonl');
    await fsp.writeFile(f, asst('第一条') + '\n');
    let t = await tailConversation(driver, f, 0, 0);
    expect(t.msgs.map((m) => m.text)).toEqual(['第一条']);
    const off1 = t.offset;

    // 写半行（无换行）→ 不消费
    const half = asst('第二条');
    await fsp.appendFile(f, half.slice(0, 10));
    t = await tailConversation(driver, f, off1, t.nextSeq);
    expect(t.msgs).toEqual([]);
    expect(t.offset).toBe(off1);

    // 补齐 + 换行 → 消费
    await fsp.appendFile(f, half.slice(10) + '\n');
    t = await tailConversation(driver, f, t.offset, t.nextSeq);
    expect(t.msgs.map((m) => m.text)).toEqual(['第二条']);
  });

  test('UTF-8 多字节边界：中文被切一半不产生乱码、不丢字节', async () => {
    const f = path.join(dir, 'tail-utf8.jsonl');
    const line = Buffer.from(asst('中文哨兵内容确认') + '\n', 'utf-8');
    // 先写到一个多字节字符中间（第一行完整 + 第二行切在汉字第 2 字节处）
    const l2 = Buffer.from(asst('第二行中文') + '\n', 'utf-8');
    const cut = l2.length - 8; // 切进「中文」尾部多字节区
    await fsp.writeFile(f, Buffer.concat([line, l2.subarray(0, cut)]));
    let t = await tailConversation(driver, f, 0, 0);
    expect(t.msgs.map((m) => m.text)).toEqual(['中文哨兵内容确认']); // 只吃第一整行
    expect(t.offset).toBe(line.length);
    await fsp.appendFile(f, l2.subarray(cut));
    t = await tailConversation(driver, f, t.offset, t.nextSeq);
    expect(t.msgs.map((m) => m.text)).toEqual(['第二行中文']);
    expect(t.offset).toBe(line.length + l2.length);
  });

  test('轮转/截断：size < offset 时重置 offset 不读错位', async () => {
    const f = path.join(dir, 'tail-rotate.jsonl');
    await fsp.writeFile(f, asst('很长很长的旧内容'.repeat(10)) + '\n');
    const st = await fsp.stat(f);
    await fsp.writeFile(f, ''); // 截断
    const t = await tailConversation(driver, f, st.size, 0);
    expect(t.msgs).toEqual([]);
    expect(t.offset).toBe(0);
  });

  test('文件不存在：不抛错，原样返回', async () => {
    const t = await tailConversation(driver, path.join(dir, 'no-such.jsonl'), 5, 3);
    expect(t).toEqual({ msgs: [], offset: 5, nextSeq: 3 });
  });

  test('挂稳定 off：每条消息带源行字节 offset，全程严格递增且首条为 0', async () => {
    const f = path.join(dir, 'tail-off.jsonl');
    const lines = Array.from({ length: 5 }, (_, i) => asst(`第${i}条`));
    await fsp.writeFile(f, lines.join('\n') + '\n');
    const t = await tailConversation(driver, f, 0, 0);
    expect(t.msgs.length).toBe(5);
    const offs = t.msgs.map((m) => m.off!);
    expect(offs[0]).toBe(0); // 首行在字节 0
    for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThan(offs[i - 1]!); // 严格递增
    // off 即源行字节起点：第 i 行 = 前 i 行（含各自 '\n'）的字节和
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      expect(offs[i]).toBe(acc);
      acc += Buffer.byteLength(lines[i]!, 'utf8') + 1;
    }
  });

  test('同一行多条消息：off 各不相同、行内有序', async () => {
    const f = path.join(dir, 'tail-multi.jsonl');
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'A' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    await fsp.writeFile(f, line + '\n');
    const t = await tailConversation(driver, f, 0, 0);
    expect(t.msgs.map((m) => m.role)).toEqual(['assistant', 'tool_use']);
    expect(t.msgs[0]!.off).toBe(0);
    expect(t.msgs[1]!.off).toBe(1); // 同行第 2 条 = 行首 offset + 行内序号
    expect(new Set(t.msgs.map((m) => m.off)).size).toBe(2); // 唯一
  });
});

describe('readOlder（向后翻页：读 endOffset 之前的更早整行）', () => {
  const build = async (name: string, n: number) => {
    const f = path.join(dir, name);
    const lines = Array.from({ length: n }, (_, i) => asst(`m${i}`));
    await fsp.writeFile(f, lines.join('\n') + '\n');
    const st = await fsp.stat(f);
    return { f, size: st.size, texts: lines.map((_, i) => `m${i}`) };
  };

  test('整窗覆盖全文：一次拿全、offset 归 0、hasMore=false，与 tail 前向一致', async () => {
    const { f, size, texts } = await build('older-whole.jsonl', 12);
    const r = await readOlder(driver, f, size, 1 << 20);
    expect(r.msgs.map((m) => m.text)).toEqual(texts);
    expect(r.offset).toBe(0);
    expect(r.hasMore).toBe(false);
    // 与前向 tail 的 off 完全一致（同一稳定标识，两路解析对齐）
    const fwd = await tailConversation(driver, f, 0, 0);
    expect(r.msgs.map((m) => m.off)).toEqual(fwd.msgs.map((m) => m.off));
  });

  test('小窗逐页向后：拼回全文、无缺无重、off 严格递增、末页到顶', async () => {
    const { f, size, texts } = await build('older-page.jsonl', 30);
    let end = size;
    const collected: string[] = [];
    const offs: number[] = [];
    let firstHasMore: boolean | null = null;
    let guard = 0;
    while (end > 0 && guard++ < 100) {
      const r = await readOlder(driver, f, end, 64); // 小窗强制多页
      if (firstHasMore === null) firstHasMore = r.hasMore;
      collected.unshift(...r.msgs.map((m) => m.text!));
      offs.unshift(...r.msgs.map((m) => m.off!));
      if (r.offset >= end) break; // 无进展兜底（不会发生，windowBytes≥1）
      if (!r.hasMore) {
        expect(r.offset).toBe(0);
        break;
      }
      end = r.offset;
    }
    expect(collected).toEqual(texts); // 逐页拼回 = 全文，顺序对
    expect(firstHasMore).toBe(true);
    for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThan(offs[i - 1]!); // 全局递增、无重
  });

  test('到顶/越界边界', async () => {
    const { f, size } = await build('older-edge.jsonl', 3);
    expect(await readOlder(driver, f, 0, 1 << 20)).toEqual({ msgs: [], offset: 0, hasMore: false });
    // endOffset 超过真实大小（文件被截短）→ 夹到 size，仍能读到全文头
    const over = await readOlder(driver, f, size + 9999, 1 << 20);
    expect(over.offset).toBe(0);
    expect(over.hasMore).toBe(false);
    // 文件不存在：原样返回 endOffset，hasMore 由 endOffset 决定
    const none = await readOlder(driver, path.join(dir, 'nope.jsonl'), 100, 1 << 20);
    expect(none).toEqual({ msgs: [], offset: 100, hasMore: true });
  });
});

describe('readRecentMessages（judge 窗口，容忍脏头）', () => {
  test('只读末尾窗口，从行中间开始的首行被安静丢弃', async () => {
    const f = path.join(dir, 'recent.jsonl');
    const lines = Array.from({ length: 20 }, (_, i) => asst(`第 ${i} 条内容内容内容`)).join('\n') + '\n';
    await fsp.writeFile(f, lines);
    const msgs = await readRecentMessages(driver, f, 200);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[msgs.length - 1]!.text).toContain('第 19 条');
  });
});

describe('JsonlLocator（列目录按 id 匹配，弃 cwd 硬算）', () => {
  test('跨编码目录命中 + 缓存 + 失效重扫', async () => {
    const root = path.join(dir, 'claude-projects');
    // 模拟 CC 的两种编码目录并存（评审 H5 实证）
    await fsp.mkdir(path.join(root, '-root-user-space'), { recursive: true });
    await fsp.mkdir(path.join(root, '-root-user_space'), { recursive: true });
    const conv = 'aaaa-bbbb-cccc';
    const f = path.join(root, '-root-user_space', `${conv}.jsonl`);
    await fsp.writeFile(f, asst('hi') + '\n');

    const loc = new JsonlLocator(driver, root);
    expect(await loc.locate(conv)).toBe(f);
    expect(await loc.locate(conv)).toBe(f); // 缓存命中
    expect(await loc.locate('not-exist')).toBeNull();

    // 文件被删 → 缓存失效 → 重扫返回 null
    await fsp.rm(f);
    expect(await loc.locate(conv)).toBeNull();
  });
});

describe('parseLines codex rollout（response_item 自动识别）', () => {
  const ri = (payload: unknown): string => JSON.stringify({ timestamp: 't', type: 'response_item', payload });

  test('message/reasoning/function_call/output 全形态 + 合成消息过滤', () => {
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 's-1', cwd: '/ws' } }),
      ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n…</environment_context>' }] }),
      ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实提问' }] }),
      ri({ type: 'reasoning', summary: [{ type: 'summary_text', text: '想一想' }] }),
      ri({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["ls","-l"]}' }),
      ri({ type: 'function_call_output', call_id: 'c1', output: '{"output":"total 0","metadata":{}}' }),
      ri({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '搞定' }] }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '搞定' } }), // 与上重复，须跳过
    ];
    const { msgs } = parseLines(lines, 0);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'thinking', 'tool_use', 'tool_result', 'assistant']);
    expect(msgs[0]!.text).toBe('真实提问');
    expect(msgs[2]!.tool).toBe('shell');
    expect(msgs[3]!.tool).toBe('shell'); // call_id 关联回工具名
    expect(msgs[4]!.text).toBe('搞定');
  });

  test('local_shell_call + custom_tool_call + developer role 跳过', () => {
    const lines = [
      ri({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '系统注入' }] }),
      ri({ type: 'local_shell_call', call_id: 'c2', action: { command: ['echo', 'hi'] } }),
      ri({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c3', input: 'patch 内容' }),
      ri({ type: 'custom_tool_call_output', call_id: 'c3', output: 'Done!' }),
    ];
    const { msgs } = parseLines(lines, 0);
    expect(msgs.map((m) => m.role)).toEqual(['tool_use', 'tool_use', 'tool_result']);
    expect(msgs[0]!.input).toBe('$ echo hi');
    expect(msgs[2]!.tool).toBe('apply_patch');
    expect(msgs[2]!.result).toBe('Done!');
  });
});
