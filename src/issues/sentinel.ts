/**
 * issues/sentinel —— 哨兵协议解析（v1 autopilot.ts:164-188 的地雷修复版，评审 H6/5.2#1）。
 *
 * 协议（prompts.ts 与本文件配套，两头要改一起改）：
 *   STAGE_DONE:<issueId>:<stage>      —— 阶段完成（implementing/testing）
 *   SUBTASK_DONE:<issueId>            —— seq 模式当前子任务完成
 *   TESTS_FAILED:<issueId> 原因       —— testing 阶段测试未通过（回退 implementing）
 *   ISSUE_BLOCKED:<issueId> 原因      —— 卡住，转 blocked
 *   SUBTASKS_BEGIN / SUBTASKS_END     —— planning 阶段子任务块（各自独占一行）
 *
 * 一次还清 v1 三笔债：
 * 1. **整行匹配**（行 trim 后必须整行等于哨兵，子串出现=拒）——v1 子串匹配是事故源；
 * 2. **核对 issueId 与 stage**（v1 捕获 id 后丢弃）；
 * 3. **只认 assistant 文本**：调用方必须先 extractAssistantTexts 过滤，
 *    tool_result / user 回显（grep 旧 prompt、cat 日志）永远进不来。
 */
import type { ChatMessage } from '../core/jsonl';

/** 哨兵覆盖的阶段（planning 的产物是 SUBTASKS 块，不用 STAGE_DONE） */
export type SentinelStage = 'implementing' | 'testing';

// 整行锚定；id 只认数字（v2 issue id = DB 自增）；分隔符宽容（v1 风格保留）
const STAGE_DONE_RE = /^STAGE_DONE:\s*(\d+)\s*:\s*([a-z_]+)\s*$/;
const SUBTASK_DONE_RE = /^SUBTASK_DONE:\s*(\d+)\s*$/;
const TESTS_FAILED_RE = /^TESTS_FAILED:\s*(\d+)\s*[:：\-]?\s*(.*)$/;
const ISSUE_BLOCKED_RE = /^ISSUE_BLOCKED:\s*(\d+)\s*[:：\-]?\s*(.*)$/;
// 执行中澄清：代理在驱动阶段声明「必须先问清才能继续」（配套 prompts.ts 的 NEED_CLARIFY 协议）
const NEED_CLARIFY_RE = /^NEED_CLARIFY:\s*(\d+)\s*$/;

/**
 * 澄清问题抽取上限（#110 放宽：代理常把选项 A/B/C 写成续行、问题也不止 5 条，
 * 旧口径 5 条/300 字会把真问题整条丢掉，看着就是「澄清内容显示不全」）
 */
export const MAX_CLARIFY_QUESTIONS = 10;
const MAX_CLARIFY_QUESTION_CHARS = 1000;
/** 澄清原文留档上限（extractClarifyText；存进 clarify_questions 事件供 UI 完整展示） */
export const MAX_CLARIFY_TEXT_CHARS = 4000;
/** 行首编号/列表符（数字点、括号数字、-*• 项）——只把「列成清单的行」当问题，散文不算 */
const CLARIFY_ITEM_RE = /^(?:[-*•]|\d+[.)、]|\(\d+\))\s*(.+)$/;
/** 「无/没有/none/n\/a」类占位（代理表示无需澄清时可能留一行）——跳过 */
const CLARIFY_NONE_RE = /^[（(]?(无|没有|none|n\/a)[）)]?[。.]?$/i;

/** 只取 assistant 文本（哨兵唯一合法来源）；tool_result/user/thinking 全排除 */
export function extractAssistantTexts(msgs: ChatMessage[]): string[] {
  return msgs
    .filter((m) => m.role === 'assistant' && typeof m.text === 'string' && m.text.length > 0)
    .map((m) => m.text!);
}

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim());
}

/** STAGE_DONE:<id>:<stage>，id 与 stage 都必须与当前一致才算命中 */
export function findStageDone(assistantText: string, issueId: number, stage: SentinelStage): boolean {
  for (const l of lines(assistantText)) {
    const m = l.match(STAGE_DONE_RE);
    if (m && Number(m[1]) === issueId && m[2] === stage) return true;
  }
  return false;
}

/** SUBTASK_DONE:<id> 计数（v1 hasSubtaskDone 是布尔，同批两个 DONE 丢一个——改计数） */
export function countSubtaskDone(assistantText: string, issueId: number): number {
  let n = 0;
  for (const l of lines(assistantText)) {
    const m = l.match(SUBTASK_DONE_RE);
    if (m && Number(m[1]) === issueId) n++;
  }
  return n;
}

/** TESTS_FAILED:<id> 原因（testing 阶段回退信号），id 不符=拒 */
export function findTestsFailed(assistantText: string, issueId: number): { note: string } | null {
  for (const l of lines(assistantText)) {
    const m = l.match(TESTS_FAILED_RE);
    if (m && Number(m[1]) === issueId) return { note: (m[2] || '').trim().slice(0, 200) };
  }
  return null;
}

/** ISSUE_BLOCKED:<id> 原因，id 不符=拒 */
export function findBlocked(assistantText: string, issueId: number): { note: string } | null {
  for (const l of lines(assistantText)) {
    const m = l.match(ISSUE_BLOCKED_RE);
    if (m && Number(m[1]) === issueId) return { note: (m[2] || '').trim().slice(0, 200) };
  }
  return null;
}

/**
 * NEED_CLARIFY:<id>：代理在驱动阶段（planning/implementing/testing）声明「必须先问清才能
 * 继续」。整行锚定 + 核 id（子串/错 id/占位符一律拒，与其它哨兵同纪律）。
 */
export function findNeedClarify(assistantText: string, issueId: number): boolean {
  for (const l of lines(assistantText)) {
    const m = l.match(NEED_CLARIFY_RE);
    if (m && Number(m[1]) === issueId) return true;
  }
  return false;
}

/**
 * 从同一条 assistant 文本抽取「按编号列出」的澄清问题（配合 NEED_CLARIFY 协议）：
 * **块级**抽取（#110）——编号/列表行起头开一条，其后的续行（缩进说明、A/B/C 子选项、
 * 换行续写）并入同一条，直到下一个清单项或**空行**才断开（空行断开 = 清单后面的散文段
 * 不会被吸进最后一条）。散文行在开条之前出现一律跳过，NEED_CLARIFY 哨兵行本身也跳过，
 * 「无」类占位丢弃；单条截 1000 字、最多 10 条。
 * 抽不到（代理没规范列编号）返回 []——上层仍据 NEED_CLARIFY 标记等待，问题清单可空，
 * 完整原文另由 extractClarifyText 留档。
 */
export function parseClarifyQuestions(assistantText: string): string[] {
  const out: string[] = [];
  let cur: string[] = []; // 当前问题：首行 + 续行
  /** 收口当前条；返回是否已达条数上限 */
  const flush = (): boolean => {
    if (cur.length > 0) {
      const q = cur.join('\n').trim();
      cur = [];
      if (q && !CLARIFY_NONE_RE.test(q)) out.push(q.slice(0, MAX_CLARIFY_QUESTION_CHARS));
    }
    return out.length >= MAX_CLARIFY_QUESTIONS;
  };
  for (const l of lines(assistantText)) {
    if (!l || NEED_CLARIFY_RE.test(l)) {
      if (flush()) break; // 空行/哨兵行：断开续行，两者都不入内容
      continue;
    }
    const m = l.match(CLARIFY_ITEM_RE);
    if (m) {
      if (flush()) break;
      cur = [m[1]!.trim()];
      continue;
    }
    if (cur.length > 0) cur.push(l); // 续行并入当前条；开条前的散文行跳过
  }
  flush();
  return out.slice(0, MAX_CLARIFY_QUESTIONS);
}

/**
 * 澄清原文留档（#110）：把代理提问那条消息原样留下（只剔除 NEED_CLARIFY 哨兵行、
 * 首尾留白，截 4000 字），存进 clarify_questions 事件的 text 字段供 UI 完整展示——
 * parseClarifyQuestions 只抽清单项，交代前提/现状的散文段会丢，用户看到的就是「显示不全」。
 */
export function extractClarifyText(assistantText: string): string {
  return assistantText
    .split('\n')
    .filter((l) => !NEED_CLARIFY_RE.test(l.trim()))
    .join('\n')
    .trim()
    .slice(0, MAX_CLARIFY_TEXT_CHARS);
}

/**
 * planning 阶段子任务块：SUBTASKS_BEGIN / SUBTASKS_END 必须各自**独占一行**
 * （v1 拼接子串匹配可被 assistant 复述格式说明误触发，评审 3.1-2）。
 * 行内清洗（去序号/上限 40/单条 500 字）沿用 v1 parseSubtasks。
 */
export function parseSubtasksBlock(assistantText: string): string[] | null {
  const ls = assistantText.split('\n');
  let begin = -1;
  for (let i = 0; i < ls.length; i++) {
    if (ls[i]!.trim() === 'SUBTASKS_BEGIN') {
      begin = i;
      break;
    }
  }
  if (begin < 0) return null;
  let end = -1;
  for (let i = begin + 1; i < ls.length; i++) {
    if (ls[i]!.trim() === 'SUBTASKS_END') {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const items = ls
    .slice(begin + 1, end)
    .map((l) => l.replace(/^\s*[-*]?\s*\d+[.、)]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 40)
    .map((t) => t.slice(0, 500));
  return items.length ? items : null;
}

/**
 * 用量/速率限制识别（v1 looksRateLimited 收紧版，评审 M1）：
 * 去掉过宽的 `resets? at`（正常叙述句即误伤）；只应喂 assistant 文本。
 * issue #48 补齐 codex 措辞：`You've hit your session limit · resets 5:50am (UTC)`
 * 之前一个词都对不上——加 session limit 与 hit your … limit（后者兜未来变体，如
 * weekly/monthly limit；限定 hit your 前缀避免叙述句里的普通 limit 误伤）。
 */
export function looksRateLimited(assistantText: string): boolean {
  return /rate limit|usage limit|session limit|limit reached|hit your [\w-]*\s?limit|temporarily limiting/i.test(
    assistantText,
  );
}

/** limit 退避时长（v1 agent.ts:564 的 5min 平移；做成常量可配） */
export const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
