export const COMPLETION_REPORT_VERSION = 1 as const;

export type CompletionOutcome = 'complete' | 'partial' | 'blocked';

export interface CompletionReport {
  version: typeof COMPLETION_REPORT_VERSION;
  outcome: CompletionOutcome;
  objective: string;
  implementation: string[];
  advantages: string[];
  disadvantages: string[];
  verification: string[];
  completion: string;
  unmetGoals: string[];
  remainingWork: string[];
  optionalFollowUps?: string[];
}

const MAX_TEXT_CHARS = 4000;
const MAX_LIST_ITEMS = 50;
const MAX_ITEM_CHARS = 1000;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_TEXT_CHARS ? normalized : null;
}

function list(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null;
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const entry = item.trim();
    if (!entry || entry.length > MAX_ITEM_CHARS) return null;
    normalized.push(entry);
  }
  return normalized;
}

export function parseCompletionReport(value: unknown): CompletionReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (report.version !== COMPLETION_REPORT_VERSION) return null;
  if (!['complete', 'partial', 'blocked'].includes(String(report.outcome))) return null;

  const objective = text(report.objective);
  const implementation = list(report.implementation);
  const advantages = list(report.advantages);
  const disadvantages = list(report.disadvantages);
  const verification = list(report.verification);
  const completion = text(report.completion);
  const unmetGoals = list(report.unmetGoals);
  const remainingWork = list(report.remainingWork);
  const optionalFollowUps = list(report.optionalFollowUps ?? []);
  if (
    !objective || !implementation || !advantages || !disadvantages || !verification ||
    !completion || !unmetGoals || !remainingWork || !optionalFollowUps
  ) return null;

  return {
    version: COMPLETION_REPORT_VERSION,
    outcome: report.outcome as CompletionOutcome,
    objective,
    implementation,
    advantages,
    disadvantages,
    verification,
    completion,
    unmetGoals,
    remainingWork,
    optionalFollowUps,
  };
}

export function parseCompletionReportJson(raw: string | null | undefined): CompletionReport | null {
  if (!raw) return null;
  try {
    return parseCompletionReport(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeCompletionReport(report: CompletionReport): string {
  const normalized = parseCompletionReport(report);
  if (!normalized) throw new Error('无效的结构化完成报告');
  return JSON.stringify(normalized);
}
