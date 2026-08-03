import { describe, expect, test } from 'bun:test';
import { groupConversationMessages, messagesForIssue } from './conversationSegments';
import type { ChatMessage, ConversationSegment } from './types';

const msg = (seq: number, ts: number | undefined, text: string): ChatMessage => ({
  seq,
  role: 'assistant',
  text,
  ...(ts === undefined ? {} : { ts }),
});

const segments: ConversationSegment[] = [
  { id: 's1', issueId: 11, title: '旧任务', status: 'done', startTs: 100, endTs: 199 },
  { id: 's2', issueId: 12, title: '当前任务', status: 'implementing', startTs: 200, endTs: null },
];

describe('模块共享会话消息分段', () => {
  test('按持久化边界归组，边界前消息放入模块历史；无时间消息跟随前一段', () => {
    const groups = groupConversationMessages(
      [
        msg(0, 50, '更早模块上下文'),
        msg(1, 110, '旧任务开始'),
        msg(2, undefined, '旧任务连续消息'),
        msg(3, 210, '当前任务开始'),
      ],
      segments,
    );
    expect(groups.map((g) => [g.segment?.issueId ?? null, g.msgs.map((m) => m.text)])).toEqual([
      [null, ['更早模块上下文']],
      [11, ['旧任务开始', '旧任务连续消息']],
      [12, ['当前任务开始']],
    ]);
  });

  test('当前 issue 即使没有消息也保留空分段，供界面显示明显开始线', () => {
    const groups = groupConversationMessages([msg(0, 110, '旧任务')], segments);
    expect(groups.at(-1)).toEqual({ key: 's2', segment: segments[1], msgs: [] });
  });

  test('执行页只返回当前 issue 区间，严格排除开始前与结束后的消息', () => {
    const closed: ConversationSegment[] = [
      { id: 's1', issueId: 11, title: '前一个', status: 'done', startTs: 100, endTs: 199 },
      { id: 's2', issueId: 12, title: '当前', status: 'done', startTs: 200, endTs: 299 },
      { id: 's3', issueId: 13, title: '后一个', status: 'implementing', startTs: 400, endTs: null },
    ];
    const scoped = messagesForIssue(
      [
        msg(0, 150, '前一个 issue'),
        msg(1, 210, '当前 issue 开始'),
        msg(2, undefined, '当前 issue 续帧'),
        msg(3, 350, '当前 issue 结束后'),
        msg(4, undefined, '结束后的续帧'),
        msg(5, 410, '后一个 issue'),
      ],
      closed,
      12,
    );
    expect(scoped.map((m) => m.text)).toEqual(['当前 issue 开始', '当前 issue 续帧']);
  });
});
