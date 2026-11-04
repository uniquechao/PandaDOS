/** 诊断出口统一脱敏；保留技术原文的结构和截断标记。 */
export function redactDiagnostic(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[凭据已隐藏]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, '$1 [凭据已隐藏]')
    .replace(/((?:["']?[\w-]*(?:token|password|passwd|secret|api[_-]?key|authorization|cookie)["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)(?:[^\n]*$)?/gim, '$1[凭据已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭据已隐藏]@')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[凭据已隐藏]');
}

export function redactDiagnosticValue(value: unknown, key = ''): unknown {
  if (/(?:token|password|passwd|secret|api[_-]?key|authorization|cookie)/i.test(key)) return '[凭据已隐藏]';
  if (typeof value === 'string') return redactDiagnostic(value);
  if (Array.isArray(value)) return value.map((item, i) =>
    typeof value[i - 1] === 'string' && /^--?[\w-]*(?:token|password|secret|api[_-]?key)$/i.test(value[i - 1] as string)
      ? '[凭据已隐藏]' : redactDiagnosticValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDiagnosticValue(v, k)]));
  return value;
}

export interface DiagnosticEvent { id: number; kind: string; dataJson: string | null; ts: number }
export function diagnosticData(event: DiagnosticEvent): Record<string, any> {
  try {
    const value = JSON.parse(event.dataJson ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** 仅从当前停止轮次的结构化事实派生，不凭权限/账号等日志关键词猜状态。 */
export function issueStopState(status: string, awaitingClarify: boolean, events: DiagnosticEvent[]) {
  if (['done', 'cancelled'].includes(status)) return null;
  if (awaitingClarify || status === 'clarifying') return { kind: 'clarify' as const, stage: status === 'clarifying' ? null : status, failures: 0, label: '', tail: '', stopLoss: false, summaryTruncated: false };
  if (['done', 'cancelled', 'pending'].includes(status)) return null;
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const reset = ordered.filter(e => e.kind === 'transition' && ['unblock', 'reopen'].includes(diagnosticData(e).event)).at(-1)?.id ?? 0;
  const current = ordered.filter(e => e.id > reset);
  const entry = current.filter(e => e.kind === 'transition' && diagnosticData(e).to === status).at(-1);
  const d = entry ? diagnosticData(entry) : {};
  const validation = current.filter(e => ['validation_failed', 'validation_passed', 'validation_error'].includes(e.kind)).at(-1);
  const environment = current.filter(e => ['environment_preparation_failed', 'environment_recovery_failed', 'environment_ready'].includes(e.kind)).at(-1);
  const failed = current.filter(e => e.kind === 'tests_failed').at(-1);
  const failures = failed ? Number(diagnosticData(failed).failCount) || 0 : 0;
  const base = { stage: d.from ?? d.resumeState ?? null, failures, label: '', tail: '', summaryTruncated: false, stopLoss: d.stopLoss === true || d.event === 'tests_failed' && status === 'paused' };
  if (status === 'blocked') return { ...base, kind: 'blocked' as const };
  if (status === 'paused' && environment && environment.kind !== 'environment_ready' && environment.id > (validation?.id ?? 0)) return { ...base, kind: 'environment' as const };
  if (validation?.kind === 'validation_failed' && (d.event === 'tests_failed' || status === 'paused' && d.stopLoss === true)) {
    const v = diagnosticData(validation);
    return { ...base, kind: 'validation' as const, label: String(v.label ?? ''), tail: redactDiagnostic(String(v.tail ?? '')), summaryTruncated: v.summaryTruncated === true || String(v.tail ?? '').length >= 1200 };
  }
  if (status === 'paused') return { ...base, kind: d.stopLoss || d.event === 'tests_failed' ? 'budget' as const : 'paused' as const };
  return null;
}
