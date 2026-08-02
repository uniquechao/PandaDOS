import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api';
import {
  changeIssueTargetBranch,
  formatIssueSourceRef,
  initializeIssueGitBranchValue,
  targetNeedsSourceRef,
  type IssueGitBranchValue,
} from '../lib/issuegitbranch';
import type { GitBranches, Issue } from '../lib/types';
import { useI18n } from '../i18n/provider';

export function IssueGitBranchFields({
  pid,
  value,
  onChange,
  onLoadingChange,
}: {
  pid: number;
  value: IssueGitBranchValue;
  onChange: (value: IssueGitBranchValue) => void;
  onLoadingChange?: (loading: boolean) => void;
}) {
  const { t } = useI18n();
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onLoadingChangeRef = useRef(onLoadingChange);
  const targetTouched = useRef(false);
  valueRef.current = value;
  onChangeRef.current = onChange;
  onLoadingChangeRef.current = onLoadingChange;

  const emit = (next: IssueGitBranchValue): void => {
    valueRef.current = next;
    onChangeRef.current(next);
  };

  useEffect(() => {
    let alive = true;
    targetTouched.current = false;
    setBranches(null);
    setLoading(true);
    setError('');
    onLoadingChangeRef.current?.(true);
    void api<GitBranches>(`/api/projects/${pid}/git/branches`)
      .then((result) => {
        if (!alive) return;
        setLoading(false);
        onLoadingChangeRef.current?.(false);
        if (!result.ok) {
          setError(result.error ?? t('ui.readGitBranchFailed'));
          return;
        }
        setBranches(result);
        const initialized = initializeIssueGitBranchValue(
          valueRef.current,
          result,
          targetTouched.current,
        );
        if (
          initialized.targetBranch !== valueRef.current.targetBranch
          || initialized.sourceRef !== valueRef.current.sourceRef
        ) {
          emit(initialized);
        }
      })
      .catch((reason: Error) => {
        if (!alive) return;
        setLoading(false);
        onLoadingChangeRef.current?.(false);
        setError(reason.message);
      });
    return () => { alive = false; };
  }, [pid]);

  const showSource = branches !== null
    && targetNeedsSourceRef(value.targetBranch, branches.current);
  const knownSource = branches !== null && [
    ...branches.local,
    ...branches.remote,
  ].some((branch) => branch.ref === value.sourceRef);
  const sourceCount = branches
    ? branches.local.length + branches.remote.length
    : 0;

  return (
    <div class="issue-git-fields">
      <label class="field">
        {t('ui.gitTargetBranch')}
        <input
          value={value.targetBranch}
          spellcheck={false}
          placeholder={loading ? t('ui.readingCurrentBranch') : t('ui.targetBranchPlaceholder')}
          onInput={(event) => {
            targetTouched.current = true;
            emit(changeIssueTargetBranch(valueRef.current, event.currentTarget.value, branches));
          }}
        />
        <span class="mut small">
          {loading
            ? t('ui.readingGitBranches')
            : branches
              ? t('ui.currentBranch', { branch: branches.current || '(detached HEAD)' })
              : error || t('ui.noGitBranches')}
        </span>
      </label>

      {showSource && branches && (
        <label class="field">
          {t('ui.sourceBranchOptional')}
          <select
            value={value.sourceRef}
            disabled={sourceCount === 0 && !value.sourceRef}
            onChange={(event) => emit({
              ...valueRef.current,
              sourceRef: event.currentTarget.value,
            })}
          >
            <option value="">{t('ui.noSourceBranch')}</option>
            {!knownSource && value.sourceRef && (
              <option value={value.sourceRef}>
                {t('ui.savedBranchMissing', { branch: formatIssueSourceRef(value.sourceRef) })}
              </option>
            )}
            {branches.local.length > 0 && (
              <optgroup label={t('ui.localBranches')}>
                {branches.local.map((branch) => (
                  <option key={branch.ref} value={branch.ref}>{branch.name}</option>
                ))}
              </optgroup>
            )}
            {branches.remote.length > 0 && (
              <optgroup label={t('ui.remoteBranches')}>
                {branches.remote.map((branch) => (
                  <option key={branch.ref} value={branch.ref}>{branch.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {sourceCount === 0 && (
            <span class="mut small">{t('ui.noTrackingBranches')}</span>
          )}
        </label>
      )}
    </div>
  );
}

export function IssueGitBranchSummary({
  issue,
}: {
  issue: Pick<Issue, 'targetBranch' | 'sourceRef'>;
}) {
  const { t } = useI18n();
  return (
    <div class="issue-git-summary">
      <span>
        <b>{t('ui.targetBranch')}</b>
        <span class="mono">{issue.targetBranch || t('ui.currentBranchInherited')}</span>
      </span>
      <span>
        <b>{t('ui.sourceBranch')}</b>
        <span class="mono" title={issue.sourceRef ?? undefined}>
          {formatIssueSourceRef(issue.sourceRef)}
        </span>
      </span>
    </div>
  );
}
