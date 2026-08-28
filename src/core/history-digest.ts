/**
 * core/history-digest —— 项目历史会话摘要（喂给 Agent 读的纯文本）。
 *
 * 用途：「Agent 认知总结」新模式（子任务 3 的 runner）在拉起 claude/codex 前，先把本项目
 * 全部对话的关键往来压成一段带上限、会截断的纯文本，写到执行机临时文件里让 Agent 去读——
 * 因为提示词注入有 MAX_INJECT_CHARS≈2000 的硬限，历史塞不进提示词，只能落文件。
 *
 * 复用：
 * - 定位 jsonl 走 {locate}（JsonlLocator=claude / AgentJsonlLocator=claude+codex 都结构兼容）；
 * - 读+解析走 core/jsonl.ts 的 readRecentMessages（读每条会话末尾 perConvBytes 字节 → ChatMessage[]）；
 * - 每条消息再用 brief 二次截断到 perMsgChars。
 *
 * 只保留「关键往来」= 用户提问 + 助手回答 + 工具动作标题；thinking / tool_result 噪声丢掉。
 * 空历史（无对话 / 对话都定位不到 jsonl / 都只有噪声）返回可读占位，调用方照样能喂给 Agent。
 *
 * 依赖方向：core 最内层，不 import executor——reader 用 jsonl.ts 的 JsonlReader（Driver 结构兼容）。
 */
import type { Database } from 'bun:sqlite';
import { brief, type ChatMessage, type JsonlReader, readRecentMessages } from './jsonl';
import type { AgentKind } from './types';

/** {locate} 最小接口（JsonlLocator / AgentJsonlLocator 都满足） */
export interface DigestLocator {
  locate(convId: string): Promise<string | null>;
}

export interface HistoryDigestDeps {
  db: Database;
  /** 读 jsonl 字节（Driver 结构兼容） */
  reader: JsonlReader;
  /** 对话 id → jsonl 路径（claude/codex 通吃） */
  locator: DigestLocator;
}

export interface HistoryDigestOptions {
  /** 最终摘要总字符上限（硬截断，含截断标记） */
  maxChars?: number;
  /** 最多纳入多少条会话（新→旧） */
  maxConvs?: number;
  /** 每条会话读末尾多少字节（readRecentMessages 窗口） */
  perConvBytes?: number;
  /** 每条会话最多保留多少条往来 */
  maxMsgsPerConv?: number;
  /** 每条往来正文再截断到多少字符 */
  perMsgChars?: number;
  /** 是否纳入已归档会话（默认纳入：归档不代表无价值） */
  includeArchived?: boolean;
}

const DEFAULTS: Required<HistoryDigestOptions> = {
  maxChars: 12000,
  maxConvs: 30,
  perConvBytes: 16 * 1024,
  maxMsgsPerConv: 40,
  perMsgChars: 400,
  includeArchived: true,
};

/** 无可用历史时的占位（调用方仍可把它喂给 Agent） */
export const EMPTY_DIGEST = '（本项目暂无可读的历史会话记录。）';

/** 尾部截断标记 */
const TRUNC_MARK = '\n\n…（历史会话过长，其余已省略）…';

interface DigestConvRow {
  id: string;
  label: string | null;
  created_ts: number;
  archived: number;
  agent: string;
}

/** epoch ms → "YYYY-MM-DD HH:MM"（UTC，稳定可测；非法 ts 返回 '未知时间'） */
export function formatConvTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '未知时间';
  try {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '未知时间';
  }
}

/**
 * 一条消息 → 一行摘要（只留关键往来）：
 * user→「👤 用户：…」assistant→「🤖 助手：…」tool_use→「🔧 <标题/工具名>」；
 * thinking / tool_result / 空文本 → null（不进摘要）。
 */
export function formatMessageLine(m: ChatMessage, perMsgChars: number): string | null {
  const clip = (s: string | undefined): string => brief(String(s ?? ''), perMsgChars);
  switch (m.role) {
    case 'user': {
      const t = clip(m.text);
      return t ? `👤 用户：${t}` : null;
    }
    case 'assistant': {
      const t = clip(m.text);
      return t ? `🤖 助手：${t}` : null;
    }
    case 'tool_use': {
      const title = (m.title ?? m.tool ?? '').trim();
      return title ? `🔧 ${brief(title, perMsgChars)}` : null;
    }
    default:
      return null; // thinking / tool_result 等噪声
  }
}

/** 渲染单条会话为文本块；无可读往来时返回 null（整条略过） */
function renderConversation(
  row: DigestConvRow,
  msgs: ChatMessage[],
  opts: Required<HistoryDigestOptions>,
): string | null {
  const lines: string[] = [];
  for (const m of msgs) {
    if (lines.length >= opts.maxMsgsPerConv) break;
    const ln = formatMessageLine(m, opts.perMsgChars);
    if (ln) lines.push(ln);
  }
  if (lines.length === 0) return null;
  const agent: AgentKind = row.agent === 'codex' ? 'codex' : 'claude';
  const label = (row.label ?? '会话').trim() || '会话';
  const flags = row.archived ? '，已归档' : '';
  const header = `## 会话「${label}」（${agent}，${formatConvTime(row.created_ts)}${flags}）`;
  return `${header}\n${lines.join('\n')}`;
}

/**
 * 生成本项目历史会话摘要（纯文本）。遍历 project 全部对话（新→旧、可含归档），
 * 逐条定位 jsonl、读末尾窗口、抽取关键往来，拼成带上限、会截断的摘要。
 * 无任何可读往来 → EMPTY_DIGEST。
 */
export async function buildHistoryDigest(
  deps: HistoryDigestDeps,
  projectId: number,
  options: HistoryDigestOptions = {},
): Promise<string> {
  const opts: Required<HistoryDigestOptions> = { ...DEFAULTS, ...options };
  const { db, reader, locator } = deps;
  const hasDesignTasks = db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'design_tasks'`,
  ).get()!.n > 0;
  const designFilter = hasDesignTasks
    ? ' AND NOT EXISTS (SELECT 1 FROM design_tasks d WHERE d.conversation_id = conversations.id)'
    : '';
  const hasOwners = db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM sqlite_master
     WHERE type = 'table' AND name = 'design_saga_conversation_owners'`,
  ).get()!.n > 0;
  const creationFilter = hasOwners
    ? ` AND NOT EXISTS (
        SELECT 1 FROM design_saga_conversation_owners owner
        WHERE owner.conversation_id = conversations.id
      )`
    : '';

  const rows = db
    .query<DigestConvRow, [number]>(
      `SELECT id, label, created_ts, archived, agent
         FROM conversations
        WHERE project_id = ?${designFilter}${creationFilter}
        ORDER BY created_ts DESC`,
    )
    .all(projectId)
    .filter((r) => opts.includeArchived || r.archived === 0)
    .slice(0, opts.maxConvs);

  const blocks: string[] = [];
  let acc = 0;
  let truncated = false;
  for (const row of rows) {
    const path = await locator.locate(row.id).catch(() => null);
    if (!path) continue;
    const msgs = await readRecentMessages(reader, path, opts.perConvBytes).catch(() => []);
    const block = renderConversation(row, msgs, opts);
    if (!block) continue;
    blocks.push(block);
    acc += block.length + 2; // +2≈块间空行
    if (acc >= opts.maxChars) {
      truncated = true;
      break;
    }
  }

  if (blocks.length === 0) return EMPTY_DIGEST;

  const included = blocks.length;
  const total = rows.length;
  const head =
    `# 项目历史会话摘要\n共 ${total} 条会话，本摘要纳入 ${included} 条（新→旧、只留关键往来）。`;
  let text = `${head}\n\n${blocks.join('\n\n')}`;

  if (truncated || text.length > opts.maxChars) {
    const room = Math.max(0, opts.maxChars - TRUNC_MARK.length);
    text = text.slice(0, room) + TRUNC_MARK;
  }
  return text;
}
