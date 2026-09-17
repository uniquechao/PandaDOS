/**
 * shared/blocked —— 受阻原因的三段式解析（#301）。
 *
 * 写端在 `src/issues/prompts.ts:sentinelBoundary`：代理发 `ISSUE_BLOCKED:<id>` 时，原因按
 * 「在做什么｜卡在哪｜要我做什么」三段写、用 `｜`（或半角 `|`）分隔——不额外花一次调用，
 * 也不用 PM 事后再总结一遍。读端只有这一处，UI 据此把一句话拆成三行带标签展示，
 * 让用户一眼看出「要我做什么」。两头要改一起改。
 *
 * 解析失败（老 issue、引擎自己判的受阻如止损/工作区不可用）一律返回 null，
 * 由调用方退回展示原句——这是刻意的：宁可少一层加工，也不猜。
 */

/** 三段式受阻原因 */
export interface BlockedNoteParts {
  /** 在做什么 */
  doing: string;
  /** 卡在哪 */
  stuck: string;
  /** 需要用户做什么 */
  action: string;
}

/** 段分隔符：全角 `｜` 为主，半角 `|` 宽容 */
const SEPARATOR_RE = /[|｜]/;

/**
 * 段首标签（代理常在段内再写一遍「在做：」）——展示时 UI 自己出标签，这里剥掉避免重复。
 * 只剥「标签 + 冒号」这一种确定形态，剥不掉就原样留着。
 */
const LABEL_RE = /^(?:在做什么|正在做|在做|卡在哪里|卡在哪|卡在|卡点|要我做什么|需要我做什么|需要你做什么|要我|要你做什么|要你|doing|stuck|blocked on|you|i need you to|action|need)\s*[:：]\s*/i;

/**
 * 把受阻原因解析成三段。三段齐全（trim 后都非空）才算结构化，否则返回 null。
 * 多于三段时按「多余的并回最后一段」处理——正文里本来就带 `|` 的情况不该整条判废。
 */
export function parseBlockedNote(note: string | null | undefined): BlockedNoteParts | null {
  if (typeof note !== 'string') return null;
  const raw = note.split(SEPARATOR_RE).map((s) => s.trim());
  if (raw.length < 3) return null;
  const parts = [raw[0]!, raw[1]!, raw.slice(2).join('｜').trim()];
  if (parts.some((p) => p.length === 0)) return null;
  const [doing, stuck, action] = parts.map((p) => p.replace(LABEL_RE, '').trim());
  if (!doing || !stuck || !action) return null;
  return { doing, stuck, action };
}
