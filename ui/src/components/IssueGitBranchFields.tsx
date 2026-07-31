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
          setError(result.error ?? '无法读取 Git 分支');
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
        Git 目标分支
        <input
          value={value.targetBranch}
          spellcheck={false}
          placeholder={loading ? '正在读取当前分支…' : '输入目标分支名称'}
          onInput={(event) => {
            targetTouched.current = true;
            emit(changeIssueTargetBranch(valueRef.current, event.currentTarget.value, branches));
          }}
        />
        <span class="mut small">
          {loading
            ? '正在读取 Git 分支…'
            : branches
              ? `当前分支：${branches.current || '(detached HEAD)'}`
              : error || '未读取到 Git 分支'}
        </span>
      </label>

      {showSource && branches && (
        <label class="field">
          源分支（可选）
          <select
            value={value.sourceRef}
            disabled={sourceCount === 0 && !value.sourceRef}
            onChange={(event) => emit({
              ...valueRef.current,
              sourceRef: event.currentTarget.value,
            })}
          >
            <option value="">不指定（仅切换已有目标分支）</option>
            {!knownSource && value.sourceRef && (
              <option value={value.sourceRef}>
                {formatIssueSourceRef(value.sourceRef)}（已保存，当前清单不存在）
              </option>
            )}
            {branches.local.length > 0 && (
              <optgroup label="本地分支">
                {branches.local.map((branch) => (
                  <option key={branch.ref} value={branch.ref}>{branch.name}</option>
                ))}
              </optgroup>
            )}
            {branches.remote.length > 0 && (
              <optgroup label="远程分支">
                {branches.remote.map((branch) => (
                  <option key={branch.ref} value={branch.ref}>{branch.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {sourceCount === 0 && (
            <span class="mut small">没有可用的本地或远程跟踪分支</span>
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
  return (
    <div class="issue-git-summary">
      <span>
        <b>目标分支</b>
        <span class="mono">{issue.targetBranch || '当前分支（沿用）'}</span>
      </span>
      <span>
        <b>源分支</b>
        <span class="mono" title={issue.sourceRef ?? undefined}>
          {formatIssueSourceRef(issue.sourceRef)}
        </span>
      </span>
    </div>
  );
}
