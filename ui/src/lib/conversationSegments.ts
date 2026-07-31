import type { ChatMessage, ConversationSegment } from './types';

export interface ConversationMessageGroup {
  key: string;
  segment?: ConversationSegment;
  msgs: ChatMessage[];
}

/**
 * JSONL 消息按持久化 issue 边界归组。时间缺失的工具/消息跟随前一个已知分段；
 * 边界之前的模块上下文单独成组，避免错误冒充第一条有记录的 issue。
 */
export function groupConversationMessages(
  msgs: ChatMessage[],
  inputSegments: ConversationSegment[],
): ConversationMessageGroup[] {
  const segments = [...inputSegments].sort((a, b) => a.startTs - b.startTs || a.issueId - b.issueId);
  const groups: ConversationMessageGroup[] = [];
  let current = -1;
  const before: ChatMessage[] = [];
  const bySegment = segments.map(() => [] as ChatMessage[]);
  for (const msg of msgs) {
    if (msg.ts !== undefined) {
      while (current + 1 < segments.length && msg.ts >= segments[current + 1]!.startTs) current++;
    }
    if (current < 0) before.push(msg);
    else bySegment[current]!.push(msg);
  }
  if (before.length) groups.push({ key: 'module-history', msgs: before });
  segments.forEach((segment, i) => {
    groups.push({ key: segment.id, segment, msgs: bySegment[i]! });
  });
  return groups;
}
