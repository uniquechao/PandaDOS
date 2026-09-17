/**
 * 命令：Bash/shell 调用的「终端风」独立渲染——$ 命令行（等宽·深底，样式见 style.css）
 * + 状态徽标·耗时；结果就近呈现：折叠态在命令下方给一行 stdout 预览，点开看完整输出。
 * 报错（isError）的输出走醒目的「异常」组件。
 *
 * 展开区（issue #288）：头部那行命令是 nowrap + ellipsis 的单行摘要，长命令根本看不全，
 * 所以展开时**先给一整块换行显示的完整命令**再给输出，两块各自可复制、可长按拖选；
 * 被服务端截断过的还能点「查看完整内容」按 off 回源。故命令卡一律可展开——哪怕没有输出，
 * 「看全这条命令」本身就是要展开的理由。
 */
import { useState } from 'preact/hooks';
import type { RunToolEvent } from '../../lib/runstream';
import { RunStatusBadge } from './parts';
import { cmdHeadView } from './cmdview';
import { DetailBody } from './detail';
import { ResultView } from './ResultView';
import { ExceptionView } from './ExceptionView';
import { tr } from '../../i18n/runtime';

export function CommandEvent({ ev }: { ev: RunToolEvent }) {
  const [open, setOpen] = useState(false);
  const { cmd, dur, preview } = cmdHeadView(ev, open);
  return (
    <div class={`rs-cmd st-${ev.status}`}>
      <button type="button" class="rs-cmd-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="rs-cmd-prompt" aria-hidden="true">$</span>
        <span class="rs-cmd-line">{cmd}</span>
        <span class="rs-cmd-meta">
          <RunStatusBadge status={ev.status} />
          {dur && <span class="rs-dur">{dur}</span>}
          <span class="rs-tw" aria-hidden="true">{open ? '⌄' : '›'}</span>
        </span>
      </button>
      {!open && preview && <div class="rs-cmd-preview">{preview}</div>}
      {open && (
        <div class="rs-cmd-full">
          <DetailBody
            text={ev.input ?? `$ ${cmd}`}
            off={ev.off}
            tool={ev.tool}
            render={(t) => <PlainLines text={t} />}
          />
        </div>
      )}
      {open && ev.result != null && (
        <div class="rs-cmd-out">
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
  );
}

/** 完整命令：逐行输出保留换行与缩进（不着色——命令不是 diff），空行占位保高 */
function PlainLines({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((l, k) => (
        <div key={k}>{l || ' '}</div>
      ))}
    </>
  );
}
