import { useMemo, useState } from 'preact/hooks';
import { groupModuleSegments } from '../lib/conversationSegments';
import { type ChatMessage, type ConversationSegment } from '../lib/types';
import { issueStatusLabel } from '../lib/labels';
import { fmtTime } from '../lib/fmt';
import { tr } from '../i18n/runtime';
import { RunStream } from './runstream';

/**
 * 本模块的历史工作段时间线（#277 / I-01）。
 *
 * 每条 issue 现在各有一条独立 transcript，模块历史散在多条 conv 上。这一条时间线按**模块**
 * 归组，把当前 issue 之前的每一段都列出来（issue 号 + 起止 + 结论状态），当前会话里的那几段
 * 可以就地展开看消息；更早会话里的段只列不展开——那些 jsonl 不在本页的加载范围内，但至少
 * 用户看得见「记录还在，只是换了一条会话」，而不是以为被清了。
 */
export function ConversationSegments({
  msgs,
  segments,
  convId,
  currentIssueId,
  pid,
  onOpenImage,
}: {
  msgs: ChatMessage[];
  /** 本模块的全部 segment（跨会话，接口 moduleSegments） */
  segments: ConversationSegment[];
  /** 当前打开的会话 id：等于它的段才有消息可展开 */
  convId?: string;
  currentIssueId: number;
  pid: number;
  onOpenImage: (path: string) => void;
}) {
  const rows = useMemo(
    () => groupModuleSegments(msgs, segments, convId, currentIssueId),
    [msgs, segments, convId, currentIssueId],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (key: string): void => {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (rows.length === 0) return null;

  return (
    <div class="conv-segments">
      <div class="conv-segment-head mut">{tr('ui.moduleHistory')}</div>
      {rows.map(({ key, segment, inCurrentConv, msgs: rowMsgs }) => {
        const open = expanded.has(key);
        const span = `${fmtTime(segment.startTs)} → ${segment.endTs === null ? '…' : fmtTime(segment.endTs)}`;
        return (
          <section key={key} class="conv-segment">
            <button class="conv-segment-line" onClick={() => toggle(key)}>
              <span class="conv-segment-rule" />
              <span class="conv-segment-title">Issue #{segment.issueId} · {segment.title}</span>
              <span class="conv-segment-status">{issueStatusLabel(segment.status)}</span>
              <span class="conv-segment-toggle">{span}</span>
              <span class="conv-segment-rule" />
            </button>
            {open && (
              <div class="conv-segment-body">
                {!inCurrentConv ? (
                  <div class="conv-segment-empty">{tr('ui.segmentInEarlierConv')}</div>
                ) : rowMsgs.length ? (
                  <RunStream msgs={rowMsgs} pid={pid} onOpenImage={onOpenImage} />
                ) : (
                  <div class="conv-segment-empty">{tr('ui.issueNoMessages')}</div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
