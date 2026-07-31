import { useEffect, useMemo, useState } from 'preact/hooks';
import { groupConversationMessages } from '../lib/conversationSegments';
import { STATUS_LABEL, type ChatMessage, type ConversationSegment } from '../lib/types';
import { RunStream } from './runstream';

export function ConversationSegments({
  msgs,
  segments,
  currentIssueId,
  pid,
  onOpenImage,
}: {
  msgs: ChatMessage[];
  segments: ConversationSegment[];
  currentIssueId: number;
  pid: number;
  onOpenImage: (path: string) => void;
}) {
  const groups = useMemo(() => groupConversationMessages(msgs, segments), [msgs, segments]);
  const currentKey = [...groups].reverse().find((g) => g.segment?.issueId === currentIssueId)?.key ?? '';
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(currentKey ? [currentKey] : []));

  useEffect(() => {
    setExpanded(new Set(currentKey ? [currentKey] : []));
  }, [currentKey]);

  const toggle = (key: string): void => {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      {groups.map((group) => {
        const current = group.key === currentKey;
        const open = current || expanded.has(group.key);
        const segment = group.segment;
        const label = segment
          ? `Issue #${segment.issueId} · ${segment.title}`
          : `更早的模块上下文 · ${group.msgs.length} 条`;
        return (
          <section key={group.key} class={`conv-segment${current ? ' current' : ''}`}>
            <button class="conv-segment-line" onClick={() => !current && toggle(group.key)}>
              <span class="conv-segment-rule" />
              <span class="conv-segment-title">{label}</span>
              {segment && <span class="conv-segment-status">{STATUS_LABEL[segment.status]}</span>}
              {!current && <span class="conv-segment-toggle">{open ? '收起' : `展开 · ${group.msgs.length}`}</span>}
              <span class="conv-segment-rule" />
            </button>
            {open && (
              <div class="conv-segment-body">
                {group.msgs.length ? (
                  <RunStream msgs={group.msgs} pid={pid} onOpenImage={onOpenImage} />
                ) : (
                  <div class="conv-segment-empty">当前 Issue 尚无对话消息</div>
                )}
              </div>
            )}
            {open && segment && segment.endTs !== null && (
              <div class="conv-segment-end">
                <span />
                Issue #{segment.issueId} · {STATUS_LABEL[segment.status]}
                <span />
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
