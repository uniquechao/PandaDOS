/**
 * 工具调用：默认折叠，头部一行显示 状态徽标·耗时·结果预览；点开看入参与完整结果。
 * 运行中（尾部未见结果）状态徽标转圈 + 行 st-running（脉冲，样式见 style.css）；
 * 结果按成功/异常分派到 ResultView / ExceptionView。
 */
import { useState } from 'preact/hooks';
import type { RunToolEvent } from '../../lib/runstream';
import { DiffLines, RunStatusBadge } from './parts';
import { toolHeadView } from './toolview';
import { ResultView } from './ResultView';
import { ExceptionView } from './ExceptionView';
import { tr } from '../../i18n/runtime';

export function ToolEvent({ ev }: { ev: RunToolEvent }) {
  const [open, setOpen] = useState(false);
  const { head, dur, preview, hasBody } = toolHeadView(ev, open);
  return (
    <div class={`rs-tool st-${ev.status}`}>
      <div class={`rs-tool-h${hasBody ? '' : ' nobody'}`} onClick={() => hasBody && setOpen(!open)}>
        <RunStatusBadge status={ev.status} />
        <span class="rs-tool-title">{head}</span>
        {dur && <span class="rs-dur">{dur}</span>}
        {preview && <span class="rs-preview">{preview}</span>}
        {hasBody && <span class="rs-tw">{open ? '▾' : '▸'}</span>}
      </div>
      {open && (
        <div class="rs-tool-b">
          {ev.input && (
            <div class="rs-input">
              <DiffLines text={ev.input} />
            </div>
          )}
          {ev.result != null &&
            (ev.result === '' ? (
              <div class="rs-empty">{tr('ui.noOutput')}</div>
            ) : ev.isError ? (
              <ExceptionView text={ev.result} />
            ) : (
              <ResultView text={ev.result} />
            ))}
        </div>
      )}
    </div>
  );
}
