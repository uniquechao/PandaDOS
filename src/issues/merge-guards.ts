/**
 * issues/merge-guards —— 智能合并的**确定性**守卫（#289 / B-14）。
 *
 * 病灶：2026-09-06 当天同一批 issue 被连续合并四次、方向还发生了反转，宿主正文从
 * 1400~1700 字被压成 500~760 字的 LLM 摘要，代码定位（`engine.ts:6533` 这类行号）、
 * 量化依据与验收段全丢。#277 正文里明明写着「范围声明：本条独立，不得与 #276 合并」，
 * 合并器照样合了——因为候选正文是 `midTruncate` 保头保尾截到 500 字送进 LLM 的，
 * **声明恰好落在被省略的中段**。
 *
 * 所以这两条判据必须是**引擎侧的纯函数**，在候选进 LLM 之前就生效：
 * - `hasNoMergeDeclaration`：正文写了「别合并」就绝对不合并，不依赖 LLM 读到它；
 * - `looksTruncated`：正文本身就残缺时，任何合并判断都是在损坏数据上做不可逆决策。
 *
 * 取舍：**宁可漏合并，不可误合并**。合并是不可逆的（被并项被 cancel、宿主正文被改写），
 * 而漏掉一次合并的代价只是多起一次会话。所以这里的判据一律往「保守」偏。
 */

/**
 * 「不要合并」的声明写法。刻意做得宽松（发起人拍板：要认更宽松的自然语言表达），
 * 因为写声明的人不会去查我们支持什么格式，他只会用自己顺手的话。
 *
 * 中文侧覆盖：显式标记、`范围声明`、`本条/本 issue 独立`、`不得/不要/禁止/别…合并`、
 * `本条单独处理/单独做本条`（**必须指向本条 issue**，见下面的注释）、`不参与合并`、`排除在候选之外`。
 * 英文侧覆盖：`noMerge` / `no-merge` / `do not merge` / `don't merge` / `must not be merged`
 * / `keep separate` / `standalone issue`。
 */
const NO_MERGE_PATTERNS: readonly RegExp[] = [
  /\bno[\s_-]?merge\b/i,
  /范围声明/,
  /本(?:条|issue|任务)\s*(?:是)?独立/i,
  /(?:不得|不要|不能|禁止|别)(?:[^。；;\n]{0,20})合并/,
  /不参与合并/,
  // 「单独/独立做」必须**指向本条 issue 本身**才算声明。早期写成裸的
  // `/(?:单独|独立)(?:处理|执行|实施|完成|跑|做)/`，结果被过程页里那句「单独跑该文件 18 项全过」
  // （说的是复跑抖动用例）命中——那句话几乎每条 issue 都有，等于把合并整个静默关掉，
  // 连 `merge_skipped{reason}` 的分布也一起失真。拿生产库真实正文实测复现过。
  /(?:本条|本\s?issue|本任务|这条|该条)[^。；;\n]{0,12}(?:单独|独立)(?:处理|执行|实施|完成|跑|做)/i,
  /(?:单独|独立)(?:处理|执行|实施|完成|跑|做)(?:本条|本\s?issue|本任务|这条|该条)/i,
  /排除在(?:合并)?候选之外/,
  /(?:do\s*not|don['’]?t|must\s*not|shall\s*not|cannot)\s+(?:be\s+)?merge/i,
  /\bkeep\s+(?:it\s+)?separate\b/i,
  /\bstandalone\s+(?:issue|task)\b/i,
];

/**
 * 会把「不得合并」反过来的上下文——避免把「**可以**与 #276 合并」「合并不受限制」
 * 之类的正常表述误判成声明。命中任一条就要求另有更明确的声明才算数。
 */
const NO_MERGE_FALSE_POSITIVES: readonly RegExp[] = [
  /可以(?:[^。；;\n]{0,10})合并/,
  /建议(?:[^。；;\n]{0,10})合并/,
  /合并(?:不受限制|没有限制|即可)/,
];

/** 明确到不可能是误判的写法：命中它就直接算数，不再看上下文 */
const NO_MERGE_STRONG: readonly RegExp[] = [
  /\bno[\s_-]?merge\b/i,
  /范围声明/,
  /(?:不得|禁止)(?:[^。；;\n]{0,20})合并/,
  /(?:do\s*not|must\s*not)\s+(?:be\s+)?merge/i,
];

/**
 * 正文里有没有「别把我合并掉」的声明。
 *
 * **注意它读的是整篇正文**：调用方必须传原始正文，绝不能传截断过的版本——
 * 截断正是 #289 里声明失效的直接原因。
 */
export function hasNoMergeDeclaration(text: string | null | undefined): boolean {
  const body = String(text ?? '');
  if (!body.trim()) return false;
  if (NO_MERGE_STRONG.some((re) => re.test(body))) return true;
  if (!NO_MERGE_PATTERNS.some((re) => re.test(body))) return false;
  // 弱匹配再过一遍反例：只有「可以合并」这类正向表述时不算声明
  return !NO_MERGE_FALSE_POSITIVES.some((re) => re.test(body));
}

/** 正文被截断留下的痕迹（midTruncate 的省略标记、以及过程页解析缺陷留下的半截正文） */
const TRUNCATION_MARKERS: readonly RegExp[] = [
  /…\[中间省略\]…/,
  /\[省略\d+字\]/,
  /[（(][^）)]{0,12}截断[^）)]{0,12}[）)]/,
  /\.\.\.\[truncated\]/i,
];

/** 判「疑似截断」时，只剩这么短的正文就已经很可疑了 */
export const TRUNCATED_BODY_CHARS = 120;

export interface MergeCandidateLike {
  title: string;
  body: string | null;
  /** 协作过程页路径（045）；有过程页却几乎没有正文 = 十有八九是解析缺陷留下的残文 */
  docPath?: string | null;
}

/**
 * 正文是不是「疑似被截断」。命中就跳过本轮合并——#289 的第一次误合并正是发生在
 * 三条 issue 的正文都因过程页解析缺陷被截成首行的时候：在合并器眼里它们高度相似，
 * 于是做出了一个在完整正文下根本不会做的决定。
 *
 * 判据三条，任一命中即算：
 * 1. 正文里有明确的截断标记；
 * 2. 正文以省略号收尾（半句话结束）；
 * 3. 有过程页（`docPath`）却几乎没有正文——过程页里写了一大篇，库里只剩标题行。
 */
export function looksTruncated(candidate: MergeCandidateLike): boolean {
  const body = (candidate.body ?? '').trim();
  if (TRUNCATION_MARKERS.some((re) => re.test(body))) return true;
  if (/[…]$|\.{3}$/.test(body)) return true;
  if (candidate.docPath && body.length < TRUNCATED_BODY_CHARS) return true;
  return false;
}

// ---------- 合并后的正文拼装（#289 / B-14）----------

/** 合并快照里的一条：拆回的唯一依据，所以字段必须齐 */
export interface MergeSnapshotEntry {
  id: number;
  title: string;
  body: string | null;
  clarifyFeedback?: string | null;
}

/** 分节标题的固定写法：拆回与人工排查都靠它定位 */
export function mergedSectionHeading(entry: Pick<MergeSnapshotEntry, 'id' | 'title'>): string {
  return `### #${entry.id} ${entry.title}`;
}

/** 某一节因为总长超限被省略时留下的说明（别让人以为原文丢了） */
export const MERGED_SECTION_OMITTED = '（原文过长已省略，完整内容见 tasks_merged 事件快照，可一键拆回）';

/**
 * 合并后的宿主正文：**摘要在前，各分支原文按 #id 分节追加**。
 *
 * 截断口径（正文列上限 8000 字）：摘要与靠前的分节优先保全，装不下的分节从**最后一节**开始
 * 逐节替换成一行说明。理由是原文的完整副本已经在 `tasks_merged` 的快照里了，正文这里
 * 保证的是「看得见有哪些分支、前面的原文能直接读」，而不是「一字不差全塞进来」。
 */
export function composeMergedBody(
  summary: string,
  entries: readonly MergeSnapshotEntry[],
  limit = 8_000,
): string {
  const head = summary.trim();
  const sections = entries.map((entry) => ({
    heading: mergedSectionHeading(entry),
    body: (entry.body ?? '').trim(),
  }));
  const render = (kept: number): string => [
    head,
    ...sections.map((section, index) => [
      section.heading,
      index < kept ? (section.body || MERGED_SECTION_OMITTED) : MERGED_SECTION_OMITTED,
    ].join('\n')),
  ].filter((part) => part.length > 0).join('\n\n');

  for (let kept = sections.length; kept >= 0; kept--) {
    const text = render(kept);
    if (text.length <= limit) return text;
  }
  // 连「摘要 + 全部标题」都塞不下：摘要本身就超限了，退回硬截断（正文列有上限，必须给个结果）
  return render(0).slice(0, limit);
}
