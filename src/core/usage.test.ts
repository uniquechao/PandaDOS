/**
 * core/usage 单测（#282 / I-08、I-09）——纯函数，样例行的形状取自真机 jsonl / rollout。
 */
import { describe, expect, test } from 'bun:test';
import {
  accumulateUsage,
  costOf,
  emptySeen,
  emptyUsage,
  isSkillRead,
  mergeUsage,
  parseUsageLine,
} from './usage';

const claudeAssistant = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-07T04:00:00.000Z',
  message: {
    id: 'msg_1',
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 868,
      cache_read_input_tokens: 660568,
      output_tokens: 142,
      output_tokens_details: { thinking_tokens: 40 },
    },
    content: [{ type: 'text', text: 'hi' }],
    ...over,
  },
});

const codexTokenCount = (total: Record<string, unknown>, ordinal = 7) => JSON.stringify({
  timestamp: '2026-09-06T15:45:52.949Z',
  ordinal,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: total,
      // 逐轮值故意给个大数：口径以 total 为准，认错了这里就会露馅
      last_token_usage: { input_tokens: 999_999, output_tokens: 999_999 },
      model_context_window: 272000,
    },
  },
});

describe('parseUsageLine：claude', () => {
  test('assistant 行取 message.usage；cache_creation 计入 input，只有 cache_read 算 cached', () => {
    const d = parseUsageLine(claudeAssistant());
    expect(d).toMatchObject({
      requests: 1,
      inputTokens: 870, // 2 + 868（cache_creation 是真花钱的写入）
      cachedInputTokens: 660568,
      outputTokens: 142,
      reasoningTokens: 40,
      requestId: 'msg_1',
    });
  });

  test('工具调用与 Skill 读取：按 tool_use 计数，id 一并带回供去重', () => {
    const d = parseUsageLine(claudeAssistant({
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/.claude/skills/panda-issue/SKILL.md' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 't3', name: 'Skill', input: { skill: 'panda-issue' } },
      ],
    }));
    expect(d.toolCalls).toBe(3);
    expect(d.toolCallIds).toEqual(['t1', 't2', 't3']);
    expect(d.skillReads).toBe(2); // 读 SKILL.md 的 Read + Skill 工具本身
  });

  test('压缩边界：新老两种标记都认', () => {
    expect(parseUsageLine(JSON.stringify({ type: 'system', subtype: 'compact_boundary' })).compactions).toBe(1);
    expect(parseUsageLine(JSON.stringify({ type: 'user', isCompactSummary: true })).compactions).toBe(1);
  });
});

describe('parseUsageLine：codex', () => {
  test('以 total_token_usage 为单调计量（逐轮 last 会重复上报，实测多算约 6.6%）', () => {
    const d = parseUsageLine(codexTokenCount({
      input_tokens: 19015,
      cached_input_tokens: 11904,
      cache_write_input_tokens: 0,
      output_tokens: 146,
      reasoning_output_tokens: 12,
    }));
    expect(d.cumulative).toEqual({
      inputTokens: 19015, cachedInputTokens: 11904, outputTokens: 146, reasoningTokens: 12,
    });
    // 逐轮值不参与累加，所以那个 999999 不该出现在任何字段里
    expect(d.inputTokens).toBe(0);
    expect(d.requests).toBe(0);
  });

  test('工具调用认三种 payload 类型，按 call_id 去重；压缩认顶层 compacted', () => {
    const exec = parseUsageLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'cat SKILL.md' },
    }));
    expect(exec).toMatchObject({ toolCalls: 1, skillReads: 1 });
    expect(exec.toolCallIds).toEqual(['c1']);

    expect(parseUsageLine(JSON.stringify({
      type: 'response_item', payload: { type: 'function_call', name: 'send_message', call_id: 'c2' },
    })).toolCalls).toBe(1);
    expect(parseUsageLine(JSON.stringify({ type: 'compacted', payload: {} })).compactions).toBe(1);
  });
});

describe('parseUsageLine：坏输入一律空增量，绝不抛错', () => {
  test('半行 / 空行 / 非 JSON / 不认识的行', () => {
    for (const line of ['', '   ', '{"type":"assis', 'not json', '[]', JSON.stringify({ type: 'user' })]) {
      const d = parseUsageLine(line);
      expect(d.requests).toBe(0);
      expect(d.requestId).toBeUndefined();
    }
  });

  test('字段缺失或类型不对当 0，不作废整行', () => {
    const d = parseUsageLine(JSON.stringify({
      type: 'assistant',
      message: { id: 'm', usage: { input_tokens: 'x', output_tokens: -5, cache_read_input_tokens: 7 } },
    }));
    expect(d).toMatchObject({ requests: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 7 });
  });
});

describe('accumulateUsage：claude 同一请求写多行，必须按 message.id 去重', () => {
  test('重复行不重复计（实测 1670 行只对应 1195 个请求，直接求和多算约 28%）', () => {
    const seen = emptySeen();
    let total = emptyUsage();
    const line = claudeAssistant();
    total = accumulateUsage(total, parseUsageLine(line), seen);
    total = accumulateUsage(total, parseUsageLine(line), seen); // 同 id 重复行
    expect(total).toMatchObject({ requests: 1, inputTokens: 870, outputTokens: 142 });
  });

  test('工具调用按 id 去重；没有 id 的老数据退化成按行计数', () => {
    const seen = emptySeen();
    let total = emptyUsage();
    const withTools = claudeAssistant({
      id: 'msg_2',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
    });
    total = accumulateUsage(total, parseUsageLine(withTools), seen);
    total = accumulateUsage(total, parseUsageLine(withTools), seen);
    expect(total.toolCalls).toBe(1);

    total = accumulateUsage(total, {
      ...parseUsageLine(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'x' } })),
    }, seen);
    expect(total.toolCalls).toBe(2); // 无 id → 按行计
  });

  test('压缩不参与请求去重（它本来就是独立的一行）', () => {
    const seen = emptySeen();
    let total = emptyUsage();
    const compact = JSON.stringify({ type: 'compacted' });
    total = accumulateUsage(total, parseUsageLine(compact), seen);
    total = accumulateUsage(total, parseUsageLine(compact), seen);
    expect(total.compactions).toBe(2);
  });

  test('codex 单调计量取差值：累计到多少就是多少，重复上报不灌水', () => {
    const seen = emptySeen();
    let total = emptyUsage();
    total = accumulateUsage(total, parseUsageLine(codexTokenCount({ input_tokens: 10, output_tokens: 1 }, 1)), seen);
    total = accumulateUsage(total, parseUsageLine(codexTokenCount({ input_tokens: 30, output_tokens: 5 }, 2)), seen);
    // 累加结果 = 最后一次的 total（离线对账天然对得上），不是 10+30
    expect(total).toMatchObject({ requests: 2, inputTokens: 30, outputTokens: 5 });

    // 与上一条完全相同的重复上报：不加 token，也不加请求数
    total = accumulateUsage(total, parseUsageLine(codexTokenCount({ input_tokens: 30, output_tokens: 5 }, 3)), seen);
    expect(total).toMatchObject({ requests: 2, inputTokens: 30, outputTokens: 5 });
  });

  test('累计值倒退（换会话/重置）按「从头开始」处理，绝不产生负数', () => {
    const seen = emptySeen();
    let total = emptyUsage();
    total = accumulateUsage(total, parseUsageLine(codexTokenCount({ input_tokens: 100, output_tokens: 10 }, 1)), seen);
    total = accumulateUsage(total, parseUsageLine(codexTokenCount({ input_tokens: 7, output_tokens: 2 }, 2)), seen);
    expect(total.inputTokens).toBe(107);
    expect(total.outputTokens).toBe(12);
  });
});

describe('mergeUsage / isSkillRead', () => {
  test('两份累计逐项相加', () => {
    const a = { ...emptyUsage(), requests: 1, inputTokens: 10, toolCalls: 2 };
    const b = { ...emptyUsage(), requests: 2, inputTokens: 5, compactions: 1 };
    expect(mergeUsage(a, b)).toMatchObject({ requests: 3, inputTokens: 15, toolCalls: 2, compactions: 1 });
  });

  test('isSkillRead：Skill 工具或入参点名 SKILL.md', () => {
    expect(isSkillRead('Skill', undefined)).toBe(true);
    expect(isSkillRead('Read', { file_path: '/a/SKILL.md' })).toBe(true);
    expect(isSkillRead('Read', { file_path: '/a/README.md' })).toBe(false);
    expect(isSkillRead('Bash', 'cat x/SKILL.md')).toBe(true);
    expect(isSkillRead('Bash', null)).toBe(false);
  });
});

describe('costOf：金额折算（#282 / Q2）', () => {
  const pricing = {
    currency: 'USD', inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10, reasoningPerMTok: 0,
  };

  test('按每百万 token 单价折算，三项相加', () => {
    const cost = costOf(
      { ...emptyUsage(), inputTokens: 1_000_000, cachedInputTokens: 2_000_000, outputTokens: 100_000 },
      pricing,
    );
    expect(cost).toBeCloseTo(1.25 + 0.25 + 1.0, 6);
  });

  test('推理 token 默认不单独计价：它本来就含在 output 里，再乘一遍就是重复收费', () => {
    const totals = { ...emptyUsage(), outputTokens: 1_000_000, reasoningTokens: 400_000 };
    expect(costOf(totals, pricing)).toBeCloseTo(10, 6);
    // 真出现单独计价的模型时，配上单价即可，不用改代码
    expect(costOf(totals, { ...pricing, reasoningPerMTok: 5 })).toBeCloseTo(12, 6);
  });

  test('空用量 = 0 元', () => {
    expect(costOf(emptyUsage(), pricing)).toBe(0);
  });
});
