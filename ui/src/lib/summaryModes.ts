/**
 * ui/lib/summaryModes —— 「更新简介」的模型选择与状态文案（纯函数，供 SummaryButton/视图与单测）。
 * - llm：现有同步路径，只读 README、快；
 * - claude/codex：后台 Agent 认知总结（读历史会话+浏览代码库→更新 README→产出认知），慢、异步。
 */
import type { AgentKind, SummaryStatus } from './types';

export type SummaryMode = 'llm' | AgentKind; // 'llm' | 'claude' | 'codex'

export interface SummaryModelOption {
  mode: SummaryMode;
  /** 菜单显示名 */
  label: string;
  /** 简短说明（title/hint） */
  hint: string;
  /** 是否异步（claude/codex 走后台任务） */
  async: boolean;
}

export const SUMMARY_MODELS: SummaryModelOption[] = [
  { mode: 'llm', label: 'README·驱动大模型', hint: '快：只读 README 生成短简介', async: false },
  { mode: 'claude', label: 'Claude', hint: '慢：读历史会话+代码库，产出认知并更新 README', async: true },
  { mode: 'codex', label: 'Codex', hint: '慢：读历史会话+代码库，产出认知并更新 README', async: true },
];

/**
 * 「更新记忆」模型选择（对话模式）：只有 claude/codex（llm 只读 README，不适合项目记忆）。
 * 后端 POST /api/projects/:id/memory 让所选 agent 依对话历史+代码库刷新 CLAUDE.md/AGENTS.md 并产出记忆概要。
 */
export const MEMORY_MODELS: SummaryModelOption[] = [
  { mode: 'claude', label: 'Claude', hint: '读历史对话+代码库，更新 CLAUDE.md 并产出记忆概要', async: true },
  { mode: 'codex', label: 'Codex', hint: '读历史对话+代码库，更新 AGENTS.md 并产出记忆概要', async: true },
];

/** 「更新记忆」按钮文案：本地提交中或后端 running → 更新中…；否则「更新记忆」 */
export function memoryBtnLabel(status: SummaryStatus | undefined, busy: boolean): string {
  return busy || status === 'running' ? '更新中…' : '🧠 更新记忆';
}

/** 该 mode 是否走后台异步任务（claude/codex） */
export function isAsyncMode(mode: SummaryMode): boolean {
  return mode === 'claude' || mode === 'codex';
}

/** 后台任务是否在跑 */
export function isSummaryRunning(status: SummaryStatus | undefined): boolean {
  return status === 'running';
}

/** 「更新简介」按钮文案：本地提交中(busy) 或后端 running → 生成中…；否则「更新简介」 */
export function summaryBtnLabel(status: SummaryStatus | undefined, busy: boolean): string {
  return busy || status === 'running' ? '生成中…' : '更新简介';
}
