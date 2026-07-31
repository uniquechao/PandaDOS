/**
 * 命令：Bash/shell 调用的「终端风」独立渲染——$ 命令行（等宽·深底，样式见 style.css）
 * + 状态徽标·耗时；结果就近呈现：折叠态在命令下方给一行 stdout 预览，点开看完整输出。
 * 报错（isError）的输出走醒目的「异常」组件。
 */
import { useState } from 'preact/hooks';
import type { RunToolEvent } from '../../lib/runstream';
import { RunStatusBadge } from './parts';
import { cmdHeadView } from './cmdview';
import { ResultView } from './ResultView';
import { ExceptionView } from './ExceptionView';

export function CommandEvent({ ev }: { ev: RunToolEvent }) {
  const [open, setOpen] = useState(false);
  const { cmd, dur, preview, hasOut } = cmdHeadView(ev, open);
  return (
    <div class={`rs-cmd st-${ev.status}`}>
      <div class={`rs-cmd-h${hasOut ? '' : ' nobody'}`} onClick={() => hasOut && setOpen(!open)}>
        <span class="rs-cmd-prompt">$</span>
        <span class="rs-cmd-line">{cmd}</span>
        <span class="rs-cmd-meta">
          <RunStatusBadge status={ev.status} />
          {dur && <span class="rs-dur">{dur}</span>}
          {hasOut && <span class="rs-tw">{open ? '▾' : '▸'}</span>}
        </span>
      </div>
      {!open && preview && <div class="rs-cmd-preview">{preview}</div>}
      {open && ev.result != null && (
        <div class="rs-cmd-out">
          {ev.isError ? <ExceptionView text={ev.result} /> : <ResultView text={ev.result} />}
        </div>
      )}
    </div>
  );
}
