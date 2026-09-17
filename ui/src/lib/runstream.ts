/**
 * lib/runstream —— 把对话 ChatMessage[] 归约为「运行事件流」（执行页的展示模型）。
 * 纯函数、无副作用（可单测）：
 *  - tool_use ↔ tool_result 就近配对：有源协议调用 ID 时精确关联；旧记录无 ID 时，
 *    优先同工具名的最早未配对项，最后退化取最早未配对项；
 *  - 派生状态 running（未见结果）/ ok / error（结果 isError）；
 *  - 耗时 = 结果行 ts − 调用行 ts（两端时间戳都在且非负时）；
 *  - 识别命令（Bash/shell）与异常（isError），供执行页选不同组件渲染。
 * tool_use 与其结果折叠成单个工具事件；配套 tool_use 落在窗口外的孤儿结果单独成事件。
 */
import type { ChatMessage } from './types';

export type RunStatus = 'running' | 'ok' | 'error';

/** 工具/命令事件（tool_use 起，配到 tool_result 后补全 result/status/耗时） */
export interface RunToolEvent {
  kind: 'tool' | 'command'; // command = Bash/shell（终端风渲染）
  seq: number; // tool_use 的 seq（孤儿结果用 tool_result 的 seq）
  off?: number; // 跨连接稳定渲染键（源行字节 offset）——合并去重后 seq 会撞，键走 off
  /**
   * 结果那条消息自己的 off（issue #288）。入参与结果来自**两条**消息，折叠成一个事件后
   * 结果的 off 就没处放了；「查看完整内容」要按 off 分别回源，故单独留一格。
   * 孤儿结果事件里 off 与 resultOff 同值。
   */
  resultOff?: number;
  tool: string; // 工具名
  toolCallId?: string; // 源协议调用 ID（并行同名工具乱序返回时稳定关联）
  title?: string; // 人话标题（tool_use 带）
  input?: string; // 入参人话正文（路径/±diff/$命令）
  result?: string; // 配到的结果正文（未配到=undefined→运行中）
  status: RunStatus;
  isError?: boolean;
  startTs?: number; // 调用行 ts
  endTs?: number; // 结果行 ts
  durationMs?: number; // endTs − startTs（都在且非负时）
}

export interface RunMessageEvent {
  kind: 'message';
  seq: number;
  off?: number;
  role: 'user' | 'assistant';
  text: string;
  /** 用户消息附图的 cwd 相对路径（后端 ws/chat.ts 富化）；渲染成可点缩略图 → 灯箱预览 */
  images?: string[];
  /** 用户消息附件（非图片）的 cwd 相对路径；渲染成可下载的文件 chip */
  files?: string[];
  /** 消息行 ts：正文里的 UTC 时间点换算本地时间时当参照日（issue #116，见 lib/utctime） */
  ts?: number;
}

export interface RunThinkingEvent {
  kind: 'thinking';
  seq: number;
  off?: number;
  text: string;
}

export type RunEvent = RunToolEvent | RunMessageEvent | RunThinkingEvent;

/** tool 名是否为命令（Bash / codex shell）——大小写不敏感 */
export function isCommandTool(tool: string | undefined, input?: string): boolean {
  const t = (tool ?? '').toLowerCase();
  return t === 'bash' || t === 'shell' || (/^(?:exec|exec_command)$/.test(t) && /^\s*\$\s+/.test(input ?? ''));
}

function durationOf(startTs: number | undefined, endTs: number | undefined): number | undefined {
  if (startTs === undefined || endTs === undefined) return undefined;
  const d = endTs - startTs;
  return d >= 0 ? d : undefined;
}

/** 取一个未配对的 tool_use 事件：优先调用 ID，再按工具名/FIFO 兼容旧记录；取出即移除 */
function takeOpen(
  open: RunToolEvent[],
  toolCallId: string | undefined,
  tool: string | undefined,
): RunToolEvent | undefined {
  if (open.length === 0) return undefined;
  if (toolCallId) {
    const i = open.findIndex((e) => e.toolCallId === toolCallId);
    if (i >= 0) return open.splice(i, 1)[0];
  }
  if (tool) {
    const i = open.findIndex((e) => e.tool === tool);
    if (i >= 0) return open.splice(i, 1)[0];
  }
  return open.shift();
}

/** ChatMessage[] → RunEvent[]（顺序保持；tool_use/result 折叠成单个工具事件） */
export function toRunEvents(msgs: ChatMessage[]): RunEvent[] {
  const out: RunEvent[] = [];
  const open: RunToolEvent[] = []; // 未配对的 tool_use 事件（保持调用顺序）
  for (const m of msgs) {
    if (m.role === 'thinking') {
      out.push({ kind: 'thinking', seq: m.seq, off: m.off, text: m.text ?? '' });
    } else if (m.role === 'assistant' || m.role === 'user') {
      out.push({
        kind: 'message',
        seq: m.seq,
        off: m.off,
        role: m.role,
        text: m.text ?? '',
        ...(m.images && m.images.length ? { images: m.images } : {}),
        ...(m.files && m.files.length ? { files: m.files } : {}),
        ...(m.ts !== undefined ? { ts: m.ts } : {}),
      });
    } else if (m.role === 'tool_use') {
      const ev: RunToolEvent = {
        kind: isCommandTool(m.tool, m.input) ? 'command' : 'tool',
        seq: m.seq,
        off: m.off,
        tool: m.tool ?? 'tool',
        ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
        ...(m.title !== undefined ? { title: m.title } : {}),
        ...(m.input !== undefined ? { input: m.input } : {}),
        status: 'running',
        ...(m.ts !== undefined ? { startTs: m.ts } : {}),
      };
      out.push(ev);
      open.push(ev);
    } else if (m.role === 'tool_result') {
      const ev = takeOpen(open, m.toolCallId, m.tool);
      if (ev) {
        ev.result = m.result ?? '';
        if (m.off !== undefined) ev.resultOff = m.off;
        ev.isError = Boolean(m.isError);
        ev.status = m.isError ? 'error' : 'ok';
        if (m.ts !== undefined) ev.endTs = m.ts;
        ev.durationMs = durationOf(ev.startTs, ev.endTs);
      } else {
        // 孤儿结果（配套 tool_use 落在 baseline 窗口外）——单独成事件，只有结果
        out.push({
          kind: isCommandTool(m.tool) ? 'command' : 'tool',
          seq: m.seq,
          off: m.off,
          tool: m.tool ?? 'tool',
          ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
          ...(m.off !== undefined ? { resultOff: m.off } : {}),
          result: m.result ?? '',
          isError: Boolean(m.isError),
          status: m.isError ? 'error' : 'ok',
          ...(m.ts !== undefined ? { endTs: m.ts } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * 最近一次「已完成」的工具结果是否为异常（运行操作栏据此判断是否可重试）。
 * 从尾部找第一条 tool_result：错→true、对→false；无结果（如尾部仍在跑）→false。
 */
export function lastToolErrored(msgs: ChatMessage[]): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === 'tool_result') return Boolean(m.isError);
  }
  return false;
}

/** 写文件类工具（后端 toolfmt：Write/Edit 的 input 首行即 file_path；codex 补 apply_patch/create_file） */
const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'create_file', 'apply_patch',
]);

/**
 * 从对话消息里解析「本轮产出/改动的文件路径」（顺序去重）：扫 tool_use 的写文件类工具，
 * 取 input 首行去掉 toolfmt 追加的「（…）」得到相对路径。用于文件侧栏自动预览产出图片。
 * 注：Bash 脚本生成的文件（如 matplotlib 存图）不走写文件工具，靠文件列表刷新补齐。
 */
export function producedFilesOf(msgs: ChatMessage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'tool_use' || !m.tool || !WRITE_TOOLS.has(m.tool)) continue;
    const first = (m.input ?? '').split('\n')[0] ?? '';
    const path = first.split('（')[0].trim();
    if (path && !path.includes(' ') && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/** 耗时毫秒 → 人话（820ms / 3.0s / 1m2s）；无/负 → 空串 */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}
