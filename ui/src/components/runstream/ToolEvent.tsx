/**
 * 工具调用：默认折叠，头部一行显示 状态徽标·耗时·结果预览；点开看入参与完整结果。
 * 运行中（尾部未见结果）状态徽标转圈 + 行 st-running（脉冲，样式见 style.css）；
 * 结果按成功/异常分派到 ResultView / ExceptionView。
 *
 * 展开区（issue #288）：入参与结果各成一块，各自带「复制」；被服务端截断过的那块
 * 还能点「查看完整内容」按各自的 off 回源（入参用 ev.off，结果用 ev.resultOff）。
 */
import { useState } from 'preact/hooks';
import type { RunToolEvent } from '../../lib/runstream';
import { DiffLines, RunStatusBadge } from './parts';
import { toolHeadView } from './toolview';
import { DetailBody } from './detail';
import { ResultView } from './ResultView';
import { ExceptionView } from './ExceptionView';
import { tr } from '../../i18n/runtime';

export function ToolEvent({ ev }: { ev: RunToolEvent }) {
  const [open, setOpen] = useState(false);
  const { head, dur, preview, hasBody } = toolHeadView(ev, open);
  const summary = (
    <>
      <span class="rs-tool-title">{head}</span>
      {preview && <span class="rs-preview">{preview}</span>}
      <span class="rs-tool-meta">
        <RunStatusBadge status={ev.status} />
        {dur && <span class="rs-dur">{dur}</span>}
        {hasBody && <span class="rs-tw" aria-hidden="true">{open ? '⌄' : '›'}</span>}
      </span>
    </>
  );
  return (
    <div class={`rs-tool st-${ev.status}`}>
      {hasBody ? (
        <button type="button" class="rs-tool-h" aria-expanded={open} onClick={() => setOpen(!open)}>
          {summary}
        </button>
      ) : (
        <div class="rs-tool-h nobody">{summary}</div>
      )}
      {open && (
        <div class="rs-tool-b">
          {ev.input !== undefined && (
            <div class="rs-detail rs-input">
              <DetailBody
                text={ev.input}
                off={ev.off}
                tool={ev.tool}
                render={(t) => <DiffLines text={t} />}
              />
            </div>
          )}
          {ev.result != null && (
            <div class="rs-detail rs-output">
              {ev.result === '' ? (
                <div class="rs-empty">{tr('ui.noOutput')}</div>
              ) : (
                <DetailBody
                  text={ev.result}
                  off={ev.resultOff}
                  tool={ev.tool}
                  render={(t) => (ev.isError ? <ExceptionView text={t} /> : <ResultView text={t} />)}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
