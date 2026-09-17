/**
 * lib/markdown —— 对话正文的 markdown 解析（纯函数，无 JSX / 无 DOM，便于单测）。
 *
 * 为什么自己写而不引库：气泡正文是 AI 直出的、且被服务端 brief/clip 截断过
 * （正文里会平白多出 `…[省略N字]…`），要求是「尽量渲染、绝不吞字、绝不崩」；
 * 同时 SkillMD 定下的口径是**全部走文本节点、无 innerHTML**，引 marked 那类库
 * 反而要再配一层消毒。这里输出的是纯数据 AST，渲染层照着建节点即可。
 *
 * 表格是本模块的重点（issue #298）。AI 直出的表格经常不规范，故判定放宽到：
 *  - 竖线块只要连续 ≥2 行、每行 ≥2 个单元格即认表格，**分隔行可以整行缺失**；
 *  - 分隔行的横线可以是 `-` / `—` / `–` / `═` / `=` / `_`，也允许个别空单元格；
 *  - 外框竖线可有可无，全角 `｜` 与半角 `|` 等价；
 *  - 各行列数不齐 → 按最大列数右侧补空，不丢内容；
 *  - 另认 `+---+` 与 `┌─┬─┐` 两种画框表格（先于竖线表格判定，否则边框行会截断竖线块）。
 * 判不准就退化成 `{ type: 'text' }` 原样输出——宁可不渲染，也不能把内容改样。
 *
 * 刻意不支持 `_斜体_` / `__粗体__`：本项目正文里 `snake_case`、`__init__`、
 * `module_id` 满地都是，下划线强调的误伤率远高于收益。
 */

export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'del'; children: MdInline[] }
  | { type: 'link'; href: string; children: MdInline[] };

/** 表格一格 / 一行 */
export type MdCell = MdInline[];
export type MdRow = MdCell[];

export interface MdListItem {
  /** 条目正文按块解析（嵌套列表、条目内代码块、条目内表格都能落进来） */
  blocks: MdBlock[];
  /** GFM 任务列表 `- [ ]` / `- [x]`；非任务条目不带这个字段 */
  checked?: boolean;
}

export type MdBlock =
  | { type: 'heading'; level: number; children: MdInline[] }
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'hr' }
  | { type: 'table'; head: MdRow | null; rows: MdRow[]; align: MdAlign[] }
  /** 退化块：解析不确定时原样保留（渲染层按 pre-wrap 纯文本出） */
  | { type: 'text'; text: string };

// ---------- 行内 ----------

/** 反斜杠可转义的标点（与 CommonMark 同集，少了不影响、多了会吃掉正文） */
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;

/** 从 from 起找一段「恰好 n 个反引号」的游标位置；找不到返回 -1 */
function findBacktickRun(src: string, from: number, n: number): number {
  let j = from;
  while (j < src.length) {
    if (src[j] === '`') {
      let m = 0;
      while (src[j + m] === '`') m++;
      if (m === n) return j;
      j += m;
      continue;
    }
    j++;
  }
  return -1;
}

/**
 * 从 i（已确认以 delim 开头）找配对的收尾 delim，返回收尾游标；找不到返回 -1。
 * 规则：开头 delim 后不能紧跟空白、收尾 delim 前不能是空白（挡住 `2 * 3 * 4` 这类误配）；
 * **不跨行**——跨行配对会让上一行的孤立 `*` 和三行后的 `*` 连成一片斜体。
 */
function findEmphasisClose(src: string, i: number, delim: string): number {
  const dl = delim.length;
  const first = src[i + dl];
  if (first === undefined || /\s/.test(first)) return -1;
  let j = i + dl;
  while (j < src.length) {
    const c = src[j];
    if (c === '\n') return -1;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (src[j + n] === '`') n++;
      const close = findBacktickRun(src, j + n, n);
      j = close < 0 ? j + n : close + n;
      continue;
    }
    if (src.startsWith(delim, j)) {
      // `*` 撞上 `**` 时让位给粗体，别把 `**x**` 拆成 `*` + `*x*`
      if (delim === '*' && src[j + 1] === '*') {
        j += 2;
        continue;
      }
      if (j > i + dl && !/\s/.test(src[j - 1])) return j;
      j += dl;
      continue;
    }
    j++;
  }
  return -1;
}

/** `[..]` 的配对右括号（支持一层嵌套方括号）；找不到返回 -1 */
function findBracketClose(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** `(..)` 的配对右括号（支持 url 里的成对括号）；找不到返回 -1 */
function findParenClose(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * 链接目标白名单：只放行 http(s) / mailto 与站内相对路径。
 * 不在白名单里（`javascript:` 这类）一律当普通文字，绝不产出可点的 href。
 */
export function isSafeHref(href: string): boolean {
  if (!href || /\s/.test(href)) return false;
  return /^(https?:\/\/|mailto:)/i.test(href) || /^[#/]/.test(href) || /^\.{1,2}\//.test(href);
}

/** 裸链尾部常粘着句读，回吐给正文（`见 https://a.com/b。` 不该把句号算进 url） */
const URL_TAIL = /[.,;:!?'")\]}】」』，。；：！？、）]+$/;

/** 行内解析：代码 / 粗体 / 斜体 / 删除线 / 链接（含 `<url>` 与裸 url）。 */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) {
      out.push({ type: 'text', text: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      let n = 0;
      while (src[i + n] === '`') n++;
      const close = findBacktickRun(src, i + n, n);
      if (close >= 0) {
        let text = src.slice(i + n, close);
        // CommonMark：两端各有一个空格且内容非空时各去掉一个（`` ` `code` ` `` 的写法）
        if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim()) {
          text = text.slice(1, -1);
        }
        flush();
        out.push({ type: 'code', text });
        i = close + n;
        continue;
      }
    }

    if (c === '*' && src[i + 1] === '*') {
      const close = findEmphasisClose(src, i, '**');
      if (close > 0) {
        flush();
        out.push({ type: 'strong', children: parseInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (c === '~' && src[i + 1] === '~') {
      const close = findEmphasisClose(src, i, '~~');
      if (close > 0) {
        flush();
        out.push({ type: 'del', children: parseInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (c === '*') {
      const close = findEmphasisClose(src, i, '*');
      if (close > 0) {
        flush();
        out.push({ type: 'em', children: parseInline(src.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const at = c === '!' ? i + 1 : i;
      const close = findBracketClose(src, at);
      if (close > 0 && src[close + 1] === '(') {
        const end = findParenClose(src, close + 1);
        if (end > 0) {
          const raw = src.slice(close + 2, end).trim();
          const href = raw.replace(/\s+["'][^"']*["']$/, '').trim();
          if (isSafeHref(href)) {
            const label = src.slice(at + 1, close);
            flush();
            out.push({
              type: 'link',
              href,
              children: label ? parseInline(label) : [{ type: 'text', text: href }],
            });
            i = end + 1;
            continue;
          }
        }
      }
    }

    if (c === '<') {
      const m = /^<(https?:\/\/[^>\s]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: 'link', href: m[1], children: [{ type: 'text', text: m[1] }] });
        i += m[0].length;
        continue;
      }
    }

    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(src.slice(i, i + 8))) {
      const m = /^https?:\/\/[^\s<>|｜]+/i.exec(src.slice(i));
      if (m) {
        const url = m[0].replace(URL_TAIL, '');
        if (url.length > 8) {
          flush();
          out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// ---------- 块级：行判定 ----------

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const LIST_START_RE = /^[ \t]*([-*+]|\d{1,9}[.)])([ \t]|$)/;
const PIPE_CH = /[|｜]/;
/** 画框表格的竖边（ASCII 与制表符两套） */
const FRAME_CH = /[|｜│┃║]/;

/** 单元格切分：反引号里的 `|` 不算分隔符，`\|` 也不算 */
function splitCells(line: string, bar: RegExp): string[] {
  let s = line.trim();
  if (s && bar.test(s[0])) s = s.slice(1);
  if (s && bar.test(s[s.length - 1])) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      // `\|` 落到单元格里应还原成普通竖线，其余转义原样留给 parseInline
      buf += bar.test(s[i + 1]) ? s[i + 1] : c + s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (s[i + n] === '`') n++;
      const close = findBacktickRun(s, i + n, n);
      if (close < 0) {
        buf += s.slice(i, i + n);
        i += n;
        continue;
      }
      buf += s.slice(i, close + n);
      i = close + n;
      continue;
    }
    if (bar.test(c)) {
      cells.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  cells.push(buf.trim());
  return cells;
}

/** 分隔行的单个格子：`---` / `:--` / `--:` / `:-:`，横线放宽到全/半角多种 */
const SEP_CELL = /^:?[-—–－─═=_~]+:?$/;

function isSeparatorCells(cells: string[]): boolean {
  const norm = cells.map((c) => c.replace(/\s+/g, ''));
  // 允许个别空格子（`|---|  |` 这种手抖），但至少得有一格是横线
  return norm.some((c) => SEP_CELL.test(c)) && norm.every((c) => c === '' || SEP_CELL.test(c));
}

function alignOf(cell: string): MdAlign {
  const c = cell.replace(/\s+/g, '');
  const left = c.startsWith(':');
  const right = c.length > 1 && c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/**
 * 一行能不能当竖线表格的行：有竖线，且不是标题/引用/列表/围栏。
 * `head=true`（表格的第一行）要求切出 ≥2 格——这是防止正文里恰好带根竖线就被认成表格的
 * 唯一硬约束；续行放宽到「带外框竖线的单格行」也收，否则 `| 1 |` 这种少写了列的行会
 * 直接把表格从中间截断（issue #298 实测：AI 漏写单元格比写全还常见）。
 */
function isPipeRowLine(line: string, head = true): boolean {
  const t = line.trim();
  if (!t || !PIPE_CH.test(t)) return false;
  if (/^ {0,3}#{1,6}([ \t]|$)/.test(line)) return false;
  if (QUOTE_RE.test(line)) return false;
  if (FENCE_OPEN.test(line)) return false;
  if (LIST_START_RE.test(line)) return false;
  if (splitCells(line, PIPE_CH).length >= 2) return true;
  return !head && PIPE_CH.test(t[0]) && PIPE_CH.test(t[t.length - 1]);
}

/** 画框表格的横边：`+---+`、`┌───┬───┐`、`╞═══╪═══╡` */
function isFrameBorder(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (!/^[+\-=\s┌┬┐├┼┤└┴┘─━═╔╦╗╠╬╣╚╩╝╞╪╡╌┄]+$/.test(t)) return false;
  return /[+┌┬┐├┼┤└┴┘╔╦╗╠╬╣╚╩╝╞╪╡]/.test(t) && /[-=─━═╌┄]/.test(t);
}

/** 画框表格的内容行：以竖边起头，且后面还有一根竖边 */
function isFrameRowLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 2 || !FRAME_CH.test(t[0])) return false;
  return FRAME_CH.test(t.slice(1));
}

// ---------- 块级：表格 ----------

function toRow(cells: string[], ncol: number): MdRow {
  const row: MdRow = cells.map((c) => parseInline(c));
  while (row.length < ncol) row.push([]);
  return row;
}

function buildTable(head: string[] | null, body: string[][], align: MdAlign[]): MdBlock | null {
  const all = head ? [head, ...body] : body;
  if (!all.length) return null;
  const ncol = all.reduce((n, r) => Math.max(n, r.length), 0);
  // 只有一列的「表格」几乎都是误判（正文里恰好带了根竖线），退化交给调用方
  if (ncol < 2) return null;
  const a: MdAlign[] = [];
  for (let k = 0; k < ncol; k++) a.push(align[k] ?? null);
  return {
    type: 'table',
    head: head ? toRow(head, ncol) : null,
    rows: body.map((r) => toRow(r, ncol)),
    align: a,
  };
}

/**
 * 竖线表格。分隔行可缺失、可出现在任意位置：
 * 落在第 0 行 = 没有表头；落在别处一律只取它的对齐信息、并把第 0 行当表头，
 * 其余行按原顺序进正文——这样无论 AI 把分隔行写到哪，都不会丢行也不会串位。
 */
function pipeTableAt(lines: string[], from: number): { block: MdBlock; next: number } | null {
  if (!isPipeRowLine(lines[from])) return null;
  let j = from + 1;
  while (j < lines.length && isPipeRowLine(lines[j], false)) j++;
  if (j - from < 2) return null;
  const cells = lines.slice(from, j).map((l) => splitCells(l, PIPE_CH));
  const sep = cells.findIndex((c) => isSeparatorCells(c));
  let head: string[] | null;
  let body: string[][];
  let align: MdAlign[] = [];
  if (sep === 0) {
    head = null;
    align = cells[0].map(alignOf);
    body = cells.slice(1);
  } else {
    head = cells[0];
    if (sep > 0) align = cells[sep].map(alignOf);
    body = cells.filter((_, k) => k !== 0 && k !== sep);
  }
  const block = buildTable(head, body, align);
  return block ? { block, next: j } : null;
}

/** 画框表格：边框行只用来划范围，内容全在竖边行里 */
function frameTableAt(lines: string[], from: number): { block: MdBlock; next: number } | null {
  let j = from;
  let borders = 0;
  const rows: string[][] = [];
  while (j < lines.length) {
    const line = lines[j];
    if (isFrameBorder(line)) {
      borders++;
      j++;
      continue;
    }
    if (isFrameRowLine(line)) {
      rows.push(splitCells(line, FRAME_CH));
      j++;
      continue;
    }
    break;
  }
  if (!borders || !rows.length || j - from < 2) return null;
  // 画框表格里也可能夹一条 `|---|---|`，它是分隔不是数据
  const body = rows.filter((c) => !isSeparatorCells(c));
  if (!body.length) return null;
  const head = body.length >= 2 ? body[0] : null;
  const block = buildTable(head, head ? body.slice(1) : body, []);
  return block ? { block, next: j } : null;
}

function tableAt(lines: string[], from: number): { block: MdBlock; next: number } | null {
  return frameTableAt(lines, from) ?? pipeTableAt(lines, from);
}

/** 这一行是不是「疑似表格的起点」——用于段落断行与退化兜底 */
function looksLikeTableStart(lines: string[], i: number): boolean {
  if (isFrameBorder(lines[i])) return true;
  return isPipeRowLine(lines[i]) && i + 1 < lines.length && isPipeRowLine(lines[i + 1]);
}

// ---------- 块级：主循环 ----------

/** 这一行是不是「新块的开头」——段落收集到它就得停 */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  if (line === undefined || !line.trim()) return true;
  if (FENCE_OPEN.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^ {0,3}#{1,6}([ \t]|$)/.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  if (LIST_START_RE.test(line)) return true;
  return looksLikeTableStart(lines, i);
}

function isOrderedMarker(marker: string): boolean {
  return /\d/.test(marker);
}

function parseListAt(lines: string[], from: number, depth: number): { block: MdBlock; next: number } {
  const first = LIST_RE.exec(lines[from])!;
  const ordered = isOrderedMarker(first[2]);
  const start = ordered ? parseInt(first[2], 10) || 1 : 1;
  const baseIndent = first[1].length;
  const buffers: string[][] = [];
  let cur: string[] | null = null;
  let contentIndent = 0;
  let blanks = 0;
  let j = from;
  while (j < lines.length) {
    const line = lines[j];
    const m = LIST_RE.exec(line);
    if (m && m[1].length <= baseIndent + 1 && isOrderedMarker(m[2]) === ordered) {
      if (cur) buffers.push(cur);
      cur = [m[4] ?? ''];
      contentIndent = m[1].length + m[2].length + (m[3] ? m[3].length : 1);
      blanks = 0;
      j++;
      continue;
    }
    if (!line.trim()) {
      blanks++;
      if (blanks >= 2) break;
      cur?.push('');
      j++;
      continue;
    }
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (indent >= contentIndent) {
      cur?.push(line.slice(contentIndent));
      blanks = 0;
      j++;
      continue;
    }
    // 懒续行：紧跟上一条、缩进不够但也不是新块（AI 常把长条目折行不缩进）
    if (blanks === 0 && cur && !startsBlock(lines, j)) {
      cur.push(line.trim());
      j++;
      continue;
    }
    break;
  }
  if (cur) buffers.push(cur);
  const items: MdListItem[] = buffers.map((buf) => {
    const task = /^\[([ xX])\][ \t]+/.exec(buf[0] ?? '');
    if (task) buf[0] = buf[0].slice(task[0].length);
    const blocks = parseBlocks(buf, depth + 1);
    return task ? { blocks, checked: task[1] !== ' ' } : { blocks };
  });
  return { block: { type: 'list', ordered, start, items }, next: j };
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  // 深度兜底：畸形的深嵌套不值得递归到栈溢出，直接原样吐出去
  if (depth > 6) {
    const text = lines.join('\n').trim();
    return text ? [{ type: 'text', text }] : [];
  }
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const mark = fence[1];
      const close = new RegExp(`^ {0,3}\\${mark[0]}{${mark.length},}[ \\t]*$`);
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        if (close.test(lines[i])) {
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      out.push({ type: 'code', lang: fence[2] ?? '', text: buf.join('\n') });
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ type: 'hr' });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '');
      out.push({ type: 'heading', level: heading[1].length, children: parseInline(text) });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && (QUOTE_RE.test(lines[i]) || (buf.length > 0 && lines[i].trim() !== ''))) {
        buf.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
        i++;
      }
      out.push({ type: 'quote', blocks: parseBlocks(buf, depth + 1) });
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      out.push(table.block);
      i = table.next;
      continue;
    }
    // 疑似表格但归一化失败（只切出一列之类）：整块原样退化，绝不吞行
    if (looksLikeTableStart(lines, i)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && (isFrameBorder(lines[i]) || isPipeRowLine(lines[i]))) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) {
        out.push({ type: 'text', text: buf.join('\n') });
        continue;
      }
    }

    if (LIST_START_RE.test(line)) {
      const list = parseListAt(lines, i, depth);
      out.push(list.block);
      i = list.next;
      continue;
    }

    const buf: string[] = [line];
    i++;
    while (i < lines.length && !startsBlock(lines, i)) {
      buf.push(lines[i]);
      i++;
    }
    // 段落内保留软换行：聊天里的断行是有意义的，交给渲染层按 pre-wrap 出
    out.push({ type: 'paragraph', children: parseInline(buf.join('\n')) });
  }
  return out;
}

/**
 * markdown → 块级 AST。任何意外（畸形输入把某条正则拖进死角）都兜底成整段纯文本，
 * 保证「渲染层永远有东西可画、且画出来的字和原文一致」。
 */
export function parseMarkdown(src: string): MdBlock[] {
  if (!src) return [];
  try {
    return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'), 0);
  } catch {
    return [{ type: 'text', text: src }];
  }
}
