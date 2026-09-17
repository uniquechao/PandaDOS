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

/**
 * 只保留指定 issue 持久化时间区间内的消息。带时间的消息严格按 startTs/endTs 判定；
 * 无时间消息延续上一条带时间消息所属的分段，避免把相邻 issue 的工具续帧混入当前执行页。
 */
export function messagesForIssue(
  msgs: ChatMessage[],
  inputSegments: ConversationSegment[],
  issueId: number,
): ChatMessage[] {
  const segments = [...inputSegments].sort((a, b) => a.startTs - b.startTs || a.issueId - b.issueId);
  const out: ChatMessage[] = [];
  let owner: ConversationSegment | undefined;

  for (const msg of msgs) {
    if (msg.ts !== undefined) {
      owner = undefined;
      for (const segment of segments) {
        if (segment.startTs > msg.ts) break;
        if (segment.endTs === null || msg.ts <= segment.endTs) owner = segment;
        else owner = undefined;
      }
    }
    if (owner?.issueId === issueId) out.push(msg);
  }
  return out;
}

export function issueStartTs(segments: ConversationSegment[], issueId: number): number | undefined {
  const starts = segments.filter((s) => s.issueId === issueId).map((s) => s.startTs);
  return starts.length ? Math.min(...starts) : undefined;
}

/** 模块时间线上的一段：当前会话里的能展开看消息，更早会话的只给标题与起止。 */
export interface ModuleSegmentRow {
  key: string;
  segment: ConversationSegment;
  /** 这段就挂在当前打开的会话上（消息已经加载在本页） */
  inCurrentConv: boolean;
  msgs: ChatMessage[];
}

/**
 * 把「本模块的全部 segment」排成一条时间线（#277 / I-01）。
 *
 * 每条 issue 现在各有一条 transcript，模块历史因此散在多条 conv 上。只看当前 conv 会让人
 * 以为换了会话记录就没了，所以时间线按模块给全，另一条会话里的段照样列出来（标 issue 号
 * 与起止），只是展不开消息——那些 jsonl 不在本页加载范围内。
 *
 * `excludeIssueId` 用来去掉当前 issue 自己那段：它的消息就在下面的正文里，重复列一遍只是噪音。
 */
export function groupModuleSegments(
  msgs: ChatMessage[],
  segments: ConversationSegment[],
  convId: string | undefined,
  excludeIssueId?: number,
): ModuleSegmentRow[] {
  const mine = segments.filter((s) => convId !== undefined && s.convId === convId);
  const byKey = new Map(
    groupConversationMessages(msgs, mine).map((g) => [g.key, g.msgs] as const),
  );
  return [...segments]
    .sort((a, b) => a.startTs - b.startTs || a.issueId - b.issueId)
    .filter((s) => s.issueId !== excludeIssueId)
    .map((segment) => {
      const inCurrentConv = convId !== undefined && segment.convId === convId;
      return {
        key: segment.id,
        segment,
        inCurrentConv,
        msgs: inCurrentConv ? (byKey.get(segment.id) ?? []) : [],
      };
    });
}
