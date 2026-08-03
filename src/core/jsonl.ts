/**
 * core/jsonl —— 会话 jsonl 的解析 + 增量 tail + 定位（claude jsonl + codex rollout 双格式，
 * 按行自动识别；v1 chat.ts 平移，评审钦定
 * 「全库唯一正确 tail」chat.ts:103-126 语义；底层 fs 换 Driver.readFileRange/statPath）。
 *
 * 铁律（评审 5.1#1 / H5 / H19）：
 * - 全 v2 只有这一份 tail 实现：字节 offset 推进 + 保留未写完的尾行 + size<offset 轮转重置；
 * - 短读防御：readFileRange 可能一次读不满（SFTP），循环读满目标区间；
 * - UTF-8 边界：在**字节层**找最后一个 '\n'(0x0A) 再解码，offset 永远推进到行边界，
 *   多字节字符被截一半只会留在未消费尾部，下一轮补齐；
 * - jsonl 定位严禁 cwd.replace(/\//g,'-') 硬算（编码漂移地雷）：对话 id 就是文件名，
 *   经 Driver.listDir 扫 claude projects 目录按 `<convId>.jsonl` 匹配，命中后缓存目录。
 *
 * 依赖方向：core 是最内层，不 import executor——用结构化最小接口 JsonlReader
 * （与 ExecutorDriver 的 statPath/readFileRange/listDir 结构兼容，调用方直接传 Driver）。
 */

import { describeToolUse } from './toolfmt';

// ---------- 消息类型（v1 types.ts ChatMessage 平移；core/types.ts 不许动，故定义在此） ----------

export interface ChatMessage {
  seq: number;
  role: 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'user';
  text?: string;
  tool?: string; // 工具名（tool_result 也带：按 tool_use_id 批内回配）
  title?: string; // tool_use 人话标题（如「✏️ 改 Login.tsx」，toolfmt 生成）
  input?: string; // 工具入参（人话正文：路径/±diff/$命令）
  result?: string;
  isError?: boolean;
  ts?: number; // 行级时间戳（毫秒）——执行流据此算工具耗时；无/非法时缺省
  /**
   * 跨连接稳定标识：本消息源行在 jsonl 文件里的绝对字节 offset（+ 行内序号，保证同一行多条消息也各不相同）。
   * 同一文件位置永远得同一个 off，故前端可据此去重/排序/合并 baseline+tail+history 三路帧、重连不丢。
   * 只有走 tailConversation / readOlder（带 startByte）的解析才会挂；parseLines 直解不挂。
   */
  off?: number;
  /**
   * 用户消息附图的 cwd 相对路径（对话里上传的截图）。jsonl 本身不带此字段：由 web/ws/chat.ts 发帧前
   * 从消息文本里 extractUploadRels 富化（并同步 stripImageHint 清正文），供前端缩略图/灯箱预览。
   */
  images?: string[];
}

// v1 chat.ts:4-6 气泡截断（评审 5.7：平移别瞎改；入参改走 toolfmt 人话正文后上限随 v1 提到 1600 兜底）
export const MAX_TEXT = 4000;
export const MAX_INPUT = 1600;
export const MAX_RESULT = 1600;

/** 头尾截断（v1 chat.ts brief） */
export function brief(s: string, n: number): string {
  s = String(s ?? '').trim();
  if (s.length <= n) return s;
  const half = Math.floor(n / 2);
  return `${s.slice(0, half)}\n…[省略${s.length - n}字]…\n${s.slice(-half)}`;
}

/** user.tool_result 的 content 可能是 string 或 [{type:"text",text}]（v1 双形态兼容） */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? JSON.stringify(c))))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** 行级 timestamp（ISO 8601 字符串或已是数字毫秒）→ 毫秒；非法/缺省返回 undefined。 */
function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/**
 * 解析一行 jsonl → 0..n 条 ChatMessage（v1 chat.ts parseLine 平移，含 thinking/redacted_thinking）。
 * 行级 timestamp（claude/codex 都在行顶层）解析成毫秒后挂到本行产出的所有消息（tool_use 取调用行、
 * tool_result 取结果行，前端据此算耗时）；无/非法则不挂。
 * toolNames：本批次 tool_use id→名字，给 tool_result 配回工具名（跨批次配不上就没有，退化为「结果」）。
 */
function parseLine(ln: string, seqStart: number, toolNames?: Map<string, string>): ChatMessage[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let e: any;
  try {
    e = JSON.parse(ln);
  } catch {
    return [];
  }
  const out = parseEntry(e, seqStart, toolNames);
  const ts = parseTs(e?.timestamp);
  if (ts !== undefined) for (const m of out) m.ts = ts;
  return out;
}

/**
 * 解析已 JSON.parse 的一行 entry → 0..n 条 ChatMessage（不含 ts；由 parseLine 统一挂）。
 * 含 claude（assistant/user）与 codex rollout（response_item）双格式，行 type 空间不相交。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseEntry(e: any, seqStart: number, toolNames?: Map<string, string>): ChatMessage[] {
  const out: ChatMessage[] = [];
  let seq = seqStart;

  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c.type === 'text' && c.text?.trim()) {
        out.push({ seq: seq++, role: 'assistant', text: brief(c.text, MAX_TEXT) });
      } else if (c.type === 'thinking' || c.type === 'redacted_thinking') {
        const t = c.thinking ?? c.text ?? '（已隐去的思考）';
        if (String(t).trim()) out.push({ seq: seq++, role: 'thinking', text: brief(t, MAX_TEXT) });
      } else if (c.type === 'tool_use') {
        if (c.id && toolNames) toolNames.set(String(c.id), String(c.name ?? ''));
        const d = describeToolUse(String(c.name ?? ''), c.input);
        out.push({
          seq: seq++,
          role: 'tool_use',
          tool: c.name,
          title: d.title,
          input: d.body ? brief(d.body, MAX_INPUT) : undefined,
        });
      }
    }
    return out;
  }
  if (e.type === 'user' && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c.type === 'tool_result') {
        out.push({
          seq: seq++,
          role: 'tool_result',
          tool: c.tool_use_id ? toolNames?.get(String(c.tool_use_id)) : undefined,
          result: brief(resultText(c.content), MAX_RESULT),
          isError: Boolean(c.is_error),
        });
      } else if (c.type === 'text' && c.text?.trim()) {
        out.push({ seq: seq++, role: 'user', text: brief(c.text, MAX_TEXT) });
      }
    }
    return out;
  }
  if (e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.trim()) {
    out.push({ seq: seq++, role: 'user', text: brief(e.message.content, MAX_TEXT) });
  }

  // ---------- claude 排队消息（issue #116：代理正忙时发进去的话）----------
  // 代理还在跑的时候注入的消息，CC 不当场记成 user 行，而是收进输入队列，等消费那一刻补记一行
  // {type:'attachment', attachment:{type:'queued_command', prompt, origin:{kind:'human'}}}。
  // 不认它就等于「执行过程中发的消息对话面板永远看不到，只有原生终端里有」（本 issue 现场）。
  // 契约（改这里必看）：
  // - 只认 queued_command 且 origin.kind==='human'：别的 attachment（文件/选区等）与非人来源不进气泡；
  // - 同一条话另有两行 {type:'queue-operation', operation:'enqueue'|'remove'}，一律不解析——
  //   解析了就是同一句话冒三个气泡；queued_command 那行每条恰好一行，是唯一进气泡的口子。
  if (
    e.type === 'attachment' &&
    e.attachment?.type === 'queued_command' &&
    e.attachment?.origin?.kind === 'human'
  ) {
    const prompt = typeof e.attachment.prompt === 'string' ? e.attachment.prompt : '';
    if (prompt.trim()) out.push({ seq: seq++, role: 'user', text: brief(prompt, MAX_TEXT) });
    return out;
  }

  // ---------- codex rollout（~/.codex/sessions/**/rollout-*.jsonl）----------
  // 行形态：{timestamp, type:'session_meta'|'response_item'|'event_msg'|…, payload:{…}}。
  // 只消费 response_item：event_msg 的 agent_message/user_message 与其重复，session_meta/
  // turn_context 等是元数据。与 claude 行 type 空间不相交，可在同一 parseLine 自动识别。
  if (e.type === 'response_item' && e.payload && typeof e.payload === 'object') {
    const p = e.payload;
    switch (p.type) {
      case 'message': {
        const text = codexContentText(p.content);
        if (p.role === 'assistant' && text.trim()) {
          out.push({ seq: seq++, role: 'assistant', text: brief(text, MAX_TEXT) });
        } else if (p.role === 'user' && text.trim() && !CODEX_SYNTH_RE.test(text.trim())) {
          // codex 把 <environment_context>/<permissions …> 等合成消息记成 user——不进气泡
          out.push({ seq: seq++, role: 'user', text: brief(text, MAX_TEXT) });
        }
        return out; // developer 等其余 role 不进气泡
      }
      case 'reasoning': {
        const sum = Array.isArray(p.summary)
          ? p.summary
              .map((s: unknown) => (typeof s === 'string' ? s : ((s as { text?: string })?.text ?? '')))
              .join('\n')
          : '';
        if (sum.trim()) out.push({ seq: seq++, role: 'thinking', text: brief(sum, MAX_TEXT) });
        return out;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = String(p.name ?? 'tool');
        if (p.call_id && toolNames) toolNames.set(String(p.call_id), name);
        let input: unknown = p.arguments ?? p.input;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            input = { input };
          }
        }
        const d = describeToolUse(name, input);
        out.push({
          seq: seq++,
          role: 'tool_use',
          tool: name,
          title: d.title,
          input: d.body ? brief(d.body, MAX_INPUT) : undefined,
        });
        return out;
      }
      case 'local_shell_call': {
        const cmd = Array.isArray(p.action?.command)
          ? p.action.command.join(' ')
          : String(p.action?.command ?? '');
        if (p.call_id && toolNames) toolNames.set(String(p.call_id), 'shell');
        out.push({
          seq: seq++,
          role: 'tool_use',
          tool: 'shell',
          title: `💻 ${cmd.slice(0, 60)}`,
          input: brief(`$ ${cmd}`, MAX_INPUT),
        });
        return out;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        out.push({
          seq: seq++,
          role: 'tool_result',
          tool: p.call_id ? toolNames?.get(String(p.call_id)) : undefined,
          result: brief(resultText(p.output), MAX_RESULT),
        });
        return out;
      }
      default:
        return out;
    }
  }
  return out;
}

/** codex message.content：[{type:'input_text'|'output_text', text}] → 拼接文本 */
function codexContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? '')))
    .filter(Boolean)
    .join('\n');
}

/** codex 合成 user 消息（<environment_context>、<permissions instructions> 等 XML 标签开头） */
const CODEX_SYNTH_RE = /^<[a-zA-Z_]+[\s>]/;

/**
 * 在**字节层**按 '\n' 切行解析，并给每条消息挂稳定标识 off（源行字节 offset + 行内序号）。
 * off = startByte + 行在 chunk 内的起始字节 + 行内第 k 条——因 JSON 行长恒 ≫ 行内消息数（每条消息
 * 至少对应几十字节内容），行内偏移绝不会撞到下一行，故 off 全局唯一、随文件位置单调递增、跨连接稳定。
 * 语义与 parseLines 一致（连续 seq、批内 tool 名回配），仅多挂 off；tailConversation/readOlder 专用。
 */
function parseChunkWithOffsets(
  bytes: Uint8Array,
  startByte: number,
  startSeq: number,
): { msgs: ChatMessage[]; nextSeq: number } {
  const msgs: ChatMessage[] = [];
  const toolNames = new Map<string, string>();
  const dec = new TextDecoder('utf-8');
  let seq = startSeq;
  let lineStart = 0; // 行首在 bytes 内的字节下标
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      if (i > lineStart) {
        const ln = dec.decode(bytes.subarray(lineStart, i));
        if (ln.trim()) {
          const got = parseLine(ln, seq, toolNames);
          let k = 0;
          for (const m of got) {
            m.off = startByte + lineStart + k;
            seq = m.seq + 1;
            msgs.push(m);
            k++;
          }
        }
      }
      lineStart = i + 1;
    }
  }
  return { msgs, nextSeq: seq };
}

/** 把一批行解析成消息，连续编号（v1 chat.ts parseLines 平移） */
export function parseLines(lines: string[], startSeq: number): { msgs: ChatMessage[]; nextSeq: number } {
  const msgs: ChatMessage[] = [];
  const toolNames = new Map<string, string>(); // 批内 tool_use id→名字，结果气泡带上工具名
  let seq = startSeq;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const got = parseLine(ln, seq, toolNames);
    for (const m of got) {
      msgs.push(m);
      seq = m.seq + 1;
    }
  }
  return { msgs, nextSeq: seq };
}

// ---------- Driver 最小接口 ----------

/** 与 ExecutorDriver 结构兼容的只读文件接口（statPath/readFileRange/listDir 子集） */
export interface JsonlReader {
  /** mtimeMs 可选：真 Driver 一直给，老 stub 不给——判死硬闸（issue #97）用它当「代理还在写」的证据 */
  statPath(path: string): Promise<{ size: number; mtimeMs?: number } | null>;
  readFileRange(path: string, offset: number, limit: number): Promise<{ data: Uint8Array; size: number }>;
  listDir(path: string): Promise<Array<{ name: string; type: string }>>;
}

/** 单次 readFileRange 的最大字节数（区间大时分块循环读满） */
const READ_CHUNK = 256 * 1024;

/**
 * 循环读满 [offset, offset+want)：短读（SFTP）时继续补读；读到空块（文件被截）提前返回已读部分。
 * 导出供 core/model-probe 复用（短读补齐这段逻辑只该有一份）。
 */
export async function readRange(r: JsonlReader, path: string, offset: number, want: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let pos = offset;
  let remain = want;
  while (remain > 0) {
    const { data } = await r.readFileRange(path, pos, Math.min(remain, READ_CHUNK));
    if (data.length === 0) break;
    parts.push(data);
    pos += data.length;
    remain -= data.length;
  }
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * 从 offset 起读新增的**完整行**（保留未写完的尾行不消费），解析成消息。
 * 语义与 v1 chat.ts tailConversation 完全一致；换行查找在字节层做（0x0A），
 * offset 推进字节精确，天然规避 UTF-8 多字节边界问题。
 */
export async function tailConversation(
  r: JsonlReader,
  jsonl: string,
  offset: number,
  seqStart: number,
): Promise<{ msgs: ChatMessage[]; offset: number; nextSeq: number }> {
  const st = await r.statPath(jsonl).catch(() => null);
  if (!st) return { msgs: [], offset, nextSeq: seqStart };
  const size = st.size;
  if (size <= offset) {
    // 文件被截断/轮转：重置 offset，避免读到错位内容（v1 chat.ts:108-110）
    return { msgs: [], offset: size < offset ? size : offset, nextSeq: seqStart };
  }
  let chunk: Uint8Array;
  try {
    chunk = await readRange(r, jsonl, offset, size - offset);
  } catch {
    return { msgs: [], offset, nextSeq: seqStart };
  }
  // 字节层找最后一个 '\n'
  let lastNl = -1;
  for (let i = chunk.length - 1; i >= 0; i--) {
    if (chunk[i] === 0x0a) {
      lastNl = i;
      break;
    }
  }
  if (lastNl < 0) return { msgs: [], offset, nextSeq: seqStart }; // 还没写完一整行
  const consumed = chunk.subarray(0, lastNl + 1);
  // 字节层解析并挂 off（源行绝对字节 = 本轮起始 offset + 行在 chunk 内的字节位置）
  const { msgs, nextSeq } = parseChunkWithOffsets(consumed, offset, seqStart);
  return { msgs, offset: offset + consumed.length, nextSeq };
}

/** 向后翻页窗口默认字节数（与 baseline 窗口同量级；一页拉这么多旧内容） */
export const HISTORY_WINDOW_BYTES = 256 * 1024;

export interface RecentConversationPage {
  msgs: ChatMessage[];
  /** 已消费到的完整行尾；后续实时 tail 从这里继续。 */
  offset: number;
  nextSeq: number;
  /** 返回的最旧消息之前是否仍有文件内容。 */
  hasMore: boolean;
}

/**
 * 按“可解析消息数”读取会话末页。
 *
 * JSONL 的单条工具结果可能远大于常规字节窗口；固定读取末尾 256KB 时，窗口可能落在一条
 * 超长 JSON 行中间，导致首屏只剩该行之后的少量消息。这里从 initialWindowBytes 开始逐次
 * 向前翻倍，直到拿到 maxMessages 条可解析消息或抵达文件头，再只返回末尾 maxMessages 条。
 */
export async function readRecentConversationPage(
  r: JsonlReader,
  jsonl: string,
  maxMessages: number,
  initialWindowBytes: number = HISTORY_WINDOW_BYTES,
): Promise<RecentConversationPage> {
  const st = await r.statPath(jsonl).catch(() => null);
  if (!st || st.size === 0 || maxMessages <= 0) {
    return { msgs: [], offset: st?.size ?? 0, nextSeq: 0, hasMore: false };
  }

  let windowBytes = Math.max(1, initialWindowBytes);
  for (;;) {
    const start = Math.max(0, st.size - windowBytes);
    const tail = await tailConversation(r, jsonl, start, 0);
    if (tail.msgs.length >= maxMessages || start === 0) {
      const msgs = tail.msgs.slice(-maxMessages);
      return {
        msgs,
        offset: tail.offset,
        nextSeq: tail.nextSeq,
        hasMore: msgs.length > 0 && (msgs[0]!.off ?? 0) > 0,
      };
    }
    windowBytes *= 2;
  }
}

/**
 * 「向后读更早窗口」——给定 endOffset（当前已加载的最旧一行的字节起点，必须落在行边界），
 * 往前读一段、按 '\n' 对齐取出 endOffset 之前的整行消息，供前端向上翻页时前插。
 *
 * 返回 { msgs, offset, hasMore }：
 * - msgs：[offset, endOffset) 区间内的更早消息（已挂稳定 off，可直接前插/去重）；
 * - offset：本轮取到的最旧一行的字节起点（= 下次翻页要传的 endOffset）；到文件头则为 0；
 * - hasMore：offset>0，即前面还有更早内容。
 *
 * 边界：endOffset≤0 → 空、到顶；文件被截短（endOffset>size）→ 夹到 size；窗口内没有换行
 * （单行长于一窗，极罕见）→ 本轮无消息但把 offset 退到 winStart 让调用方续拉，保证有进展不卡死。
 */
export async function readOlder(
  r: JsonlReader,
  jsonl: string,
  endOffset: number,
  windowBytes: number = HISTORY_WINDOW_BYTES,
): Promise<{ msgs: ChatMessage[]; offset: number; hasMore: boolean }> {
  if (endOffset <= 0) return { msgs: [], offset: 0, hasMore: false };
  const st = await r.statPath(jsonl).catch(() => null);
  if (!st) return { msgs: [], offset: endOffset, hasMore: endOffset > 0 };
  const end = Math.min(endOffset, st.size); // 文件被截短：不越过真实 EOF
  if (end <= 0) return { msgs: [], offset: 0, hasMore: false };
  // 从 windowBytes 起，若一窗内装不下一整条更早的行（原始 jsonl 单行可能达 MB，如超大工具输出）
  // 就翻倍扩窗重读，直到取到 ≥1 条完整旧行或退到文件头——保证每次调用都有进展、翻页不卡死。
  let win = Math.max(1, windowBytes);
  for (;;) {
    const winStart = Math.max(0, end - win);
    let chunk: Uint8Array;
    try {
      chunk = await readRange(r, jsonl, winStart, end - winStart);
    } catch {
      return { msgs: [], offset: endOffset, hasMore: endOffset > 0 };
    }
    let firstLineRel = 0; // 完整首行在 chunk 内的起点
    if (winStart > 0) {
      // 窗口不含文件头 → 首行多半是半截的上一行，跳到第一个 '\n' 之后
      let nl = -1;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) {
          nl = i;
          break;
        }
      }
      firstLineRel = nl < 0 ? chunk.length : nl + 1;
    }
    const absStart = winStart + firstLineRel;
    if (absStart < end) {
      const { msgs } = parseChunkWithOffsets(chunk.subarray(firstLineRel), absStart, 0);
      return { msgs, offset: absStart, hasMore: absStart > 0 };
    }
    // 本窗只覆盖到末行的行尾换行、没装下任何完整旧行 → 扩窗重试（winStart 已 0 时 absStart=0<end，不会到这）
    win *= 2;
  }
}

/**
 * 读文件末尾至多 maxBytes 字节并解析（judgeDone 兜底窗口用，v1 fallbackDoneCheck 16000B）。
 * 容忍脏头（可能从行中间开始，首行解析失败即丢——v1 同语义）。
 */
export async function readRecentMessages(
  r: JsonlReader,
  jsonl: string,
  maxBytes: number,
): Promise<ChatMessage[]> {
  const st = await r.statPath(jsonl).catch(() => null);
  if (!st || st.size === 0) return [];
  const offset = Math.max(0, st.size - maxBytes);
  let chunk: Uint8Array;
  try {
    chunk = await readRange(r, jsonl, offset, st.size - offset);
  } catch {
    return [];
  }
  const str = new TextDecoder('utf-8').decode(chunk);
  return parseLines(str.split('\n'), 0).msgs;
}

// ---------- jsonl 定位（列目录按 id 匹配，弃 cwd 硬算） ----------

/**
 * 对话 id → jsonl 绝对路径。扫 `<claudeProjectsDir>/<任意子目录>/<convId>.jsonl`，
 * 命中缓存；缓存路径 stat 失效则重扫（jsonl 不会移动，失效≈被删）。
 */
export class JsonlLocator {
  private cache = new Map<string, string>();

  constructor(
    private readonly r: JsonlReader,
    private readonly claudeProjectsDir: string,
  ) {}

  invalidate(convId: string): void {
    this.cache.delete(convId);
  }

  async locate(convId: string): Promise<string | null> {
    const hit = this.cache.get(convId);
    if (hit) {
      if (await this.r.statPath(hit).catch(() => null)) return hit;
      this.cache.delete(convId);
    }
    const root = this.claudeProjectsDir.replace(/\/+$/, '');
    const file = `${convId}.jsonl`;
    let dirs: Array<{ name: string; type: string }>;
    try {
      dirs = await this.r.listDir(root);
    } catch {
      return null;
    }
    for (const d of dirs) {
      if (d.type !== 'dir') continue;
      const sub = `${root}/${d.name}`;
      let files: Array<{ name: string; type: string }>;
      try {
        files = await this.r.listDir(sub);
      } catch {
        continue;
      }
      if (files.some((f) => f.name === file && f.type !== 'dir')) {
        const p = `${sub}/${file}`;
        this.cache.set(convId, p);
        return p;
      }
    }
    return null;
  }
}
