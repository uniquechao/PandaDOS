/**
 * runstream —— 执行页的「AI 运行事件流」。
 * 把对话 ChatMessage[] 归约成 RunEvent[]（lib/runstream），逐条按事件种类选独立组件：
 *  思考摘要 / 工具调用 / 命令 / 普通消息（结果·异常并入工具·命令的展开区）。
 * 替代旧 ChatPane 的 Bubble/ToolBubble（一律气泡）——不同事件不同组件、工具默认折叠带状态·耗时。
 */
import { useMemo } from 'preact/hooks';
import type { ChatMessage } from '../../lib/types';
import { toRunEvents } from '../../lib/runstream';
import { ThinkingEvent } from './ThinkingEvent';
import { MessageEvent } from './MessageEvent';
import { ToolEvent } from './ToolEvent';
import { CommandEvent } from './CommandEvent';

export function RunStream({
  msgs,
  pid,
  onOpenImage,
}: {
  msgs: ChatMessage[];
  /** 项目 id + 开灯箱回调：透给 MessageEvent 渲染用户附图缩略图（点击开原图灯箱） */
  pid?: number;
  onOpenImage?: (path: string) => void;
}) {
  const events = useMemo(() => toRunEvents(msgs), [msgs]);
  return (
    <>
      {events.map((ev) => {
        // 键走稳定 off（合并去重后 seq 会跨帧相撞；off 全局唯一且前插不位移）；老数据无 off 退回 seq
        const k = ev.off ?? ev.seq;
        switch (ev.kind) {
          case 'thinking':
            return <ThinkingEvent key={k} text={ev.text} off={ev.off} />;
          case 'message':
            return (
              <MessageEvent
                key={k}
                role={ev.role}
                text={ev.text}
                images={ev.images}
                files={ev.files}
                ts={ev.ts}
                off={ev.off}
                pid={pid}
                onOpenImage={onOpenImage}
              />
            );
          case 'command':
            return <CommandEvent key={k} ev={ev} />;
          case 'tool':
            return <ToolEvent key={k} ev={ev} />;
        }
      })}
    </>
  );
}

export { ThinkingEvent } from './ThinkingEvent';
export { MessageEvent } from './MessageEvent';
export { ToolEvent } from './ToolEvent';
export { CommandEvent } from './CommandEvent';
export { ResultView } from './ResultView';
export { ExceptionView } from './ExceptionView';
export { DetailCtx, type DetailApi, type DetailState } from './detail';
