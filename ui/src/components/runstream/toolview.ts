/**
 * 工具调用组件的折叠态头部派生（纯函数，便于单测）：
 * 一行三块——状态徽标（由 status 决定，组件内渲染）· 耗时 · 结果预览；
 * hasBody 决定是否可展开（有入参或结果时才有展开箭头）。
 */
import { fmtDuration, type RunToolEvent } from '../../lib/runstream';
import { firstLine } from './textutil';

export interface ToolHead {
  /** 折叠标题：人话 title，退化为「🔧 工具名」 */
  head: string;
  /** 人话耗时（''=无时间戳/运行中） */
  dur: string;
  /** 折叠态结果预览（''=无结果或已展开） */
  preview: string;
  /** 是否可展开（有入参或结果） */
  hasBody: boolean;
}

/** 结果预览最长字数（折叠态一行） */
export const PREVIEW_CHARS = 80;

export function toolHeadView(ev: RunToolEvent, open: boolean): ToolHead {
  return {
    head: ev.title ?? `🔧 ${ev.tool}`,
    dur: fmtDuration(ev.durationMs),
    preview: !open && ev.result ? firstLine(ev.result, PREVIEW_CHARS) : '',
    hasBody: Boolean(ev.input || ev.result),
  };
}
