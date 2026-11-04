import { useState } from 'preact/hooks';
import { api } from '../lib/api';
import type { Issue } from '../lib/types';
import { useI18n } from '../i18n/provider';

const reasonKeys = {
  'module-held': 'moduleWorkspace.moduleHeld', capacity: 'moduleWorkspace.capacity', dependency: 'moduleWorkspace.dependency',
  legacy: 'moduleWorkspace.legacy', ready: 'moduleWorkspace.ready', retained: 'moduleWorkspace.retained', integration: 'moduleWorkspace.integration',
} as const;

export function IssueWorkspace({ issue, compact = false }: { issue: Issue; compact?: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const w = issue.workspace;
  if (!w) return null;

  const retry = async (confirmInput = false) => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/projects/${issue.projectId}/issues/${issue.id}/workspace/retry`, 'POST', { confirmInput });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const completed = !!w.integratedSha && !w.retained;
  const running = !completed && w.computeHeld && issue.status !== 'pending';
  const label = completed ? t('issue.deliveryLocalComplete') : running ? t('ui.executing') : t(reasonKeys[w.reason]);
  if (compact) return <span class="badge b-gray" title={w.cwd ?? undefined}>{label}{w.branch && <> · <span class="mono">{w.branch}</span></>}</span>;

  const tone = completed ? 'complete' : running ? 'running' : w.retained || w.reason === 'integration' ? 'attention' : 'waiting';
  return (
    <section class={`issue-workspace ${tone}`} aria-label={t('moduleWorkspace.title')}>
      <header class="issue-workspace-head">
        <strong class="issue-workspace-title">
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M2.5 6V4.5h5l2 2h8V16h-15V6Z" /></svg>
          {t('moduleWorkspace.title')}
        </strong>
        <span class="issue-workspace-status">{label}</span>
      </header>
      {w.cwd && <div class="issue-workspace-path mono">{w.cwd}</div>}
      <dl class="issue-workspace-branches">
        <div><dt>{t('ui.sourceBranch')}</dt><dd class="mono">{w.branch ?? '—'}</dd></div>
        <div><dt>{t('moduleWorkspace.target')}</dt><dd class="mono">{w.targetBranch ?? '—'}</dd></div>
      </dl>
      {w.integrationCwd && <div class="issue-workspace-candidate"><b>{t('moduleWorkspace.candidate')}</b><div class="mono">{w.integrationCwd}</div></div>}
      {w.diagnostic && <p class="issue-workspace-diagnostic" role="status">{w.diagnostic}</p>}
      {(w.retained || w.reason === 'integration') && (
        <div class="issue-workspace-actions">
          <button class="btn" disabled={busy} onClick={() => void retry()}>{t('moduleWorkspace.retry')}</button>
          {issue.status === 'paused' && <button class="btn" disabled={busy} onClick={() => void retry(true)}>{t('moduleWorkspace.confirmInput')}</button>}
        </div>
      )}
      {error && <p class="issue-workspace-error" role="alert">{error}</p>}
      {w.integratedSha && <div class="issue-workspace-sha mono">{w.integratedSha}</div>}
    </section>
  );
}
