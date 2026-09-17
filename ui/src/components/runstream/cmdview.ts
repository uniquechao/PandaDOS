/**
 * 命令组件的折叠态头部派生（纯函数，便于单测）。
 * 终端风：$ 命令行 + 状态·耗时；stdout/结果就近呈现（折叠态一行预览，展开看全文）。
 */
import { fmtDuration, type RunToolEvent } from '../../lib/runstream';
import { firstLine } from './textutil';

export interface CmdHead {
  /** 命令行文本（去掉前导 $；退化用 title / tool 名） */
  cmd: string;
  /** 人话耗时（''=无时间戳/运行中） */
  dur: string;
  /** 折叠态 stdout 预览（''=无结果或已展开） */
  preview: string;
  /** 是否有结果可展开 */
  hasOut: boolean;
}

/** stdout 预览最长字数 */
export const CMD_PREVIEW_CHARS = 80;

/** input 形如 `$ cmd`（toolfmt Bash / codex shell），去掉前导 $；退化用 title / tool 名。 */
export function commandLine(ev: RunToolEvent): string {
  const inp = (ev.input ?? '').trim();
  if (inp.startsWith('$ ')) return inp.slice(2).trim();
  if (inp.startsWith('$')) return inp.slice(1).trim();
  if (inp) return inp;
  const title = (ev.title ?? '').replace(/^💻\s*/, '').trim();
  return title || ev.tool;
}

export function cmdHeadView(ev: RunToolEvent, open: boolean): CmdHead {
  return {
    cmd: commandLine(ev),
    dur: fmtDuration(ev.durationMs),
    preview: !open && ev.result ? firstLine(ev.result, CMD_PREVIEW_CHARS) : '',
    hasOut: ev.result !== undefined,
  };
}
