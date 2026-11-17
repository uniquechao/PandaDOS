import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { IssueId } from '../../../shared/issue-id';
import type { MessageKey } from '../../../shared/i18n/messages';
import { useI18n } from '../i18n/provider';
import { tr } from '../i18n/runtime';
import { api, ApiError } from '../lib/api';
import type { AgentKind } from '../lib/types';
import { AgentLogo } from './AgentLogo';
import { Loading } from './Loaders';
import { Modal } from './Modal';
import './issue-worktree.css';

const POLL_MS = 5_000;
const READ_TIMEOUT_MS = 10_000;
const MAX_GUIDANCE_LENGTH = 1_400;

const actionLabels = {
  pause: 'worktree.pause',
  resume: 'worktree.resume',
  takeover: 'worktree.takeover',
  return: 'worktree.return',
  recheck: 'moduleWorkspace.retry',
  'verify-push': 'worktree.verifyPush',
} as const satisfies Record<string, MessageKey>;
type WorktreeAction = keyof typeof actionLabels;

const phaseLabels = new Map<string, MessageKey>([
  ['reserved', 'status.pending'], ['preparing', 'ui.loading'],
  ['prepared', 'moduleWorkspace.ready'], ['ready', 'moduleWorkspace.ready'],
  ['integrating', 'status.merging'], ['integrated', 'status.done'], ['released', 'status.done'],
  ['merging', 'status.merging'], ['conflict', 'worktree.conflict'],
  ['validating', 'status.testing'], ['validated', 'worktree.validationPassed'],
  ['validation_failed', 'worktree.validationFailed'], ['published', 'status.done'], ['superseded', 'status.cancelled'],
]);
const agentLabels = new Map<string, MessageKey>([
  ['starting', 'ui.loading'], ['dispatching', 'ui.loading'], ['running', 'ui.executing'],
  ['stopping', 'worktree.stopping'], ['clarification', 'status.awaitingClarify'],
  ['failed', 'status.paused'], ['uncertain', 'status.unknown'], ['resolved', 'status.done'],
  ['superseded', 'status.cancelled'], ['retry', 'status.pending'],
]);
const evidenceLabels = new Map<string, MessageKey>([
  ['validation_started', 'status.testing'], ['validation_passed', 'worktree.validationPassed'],
  ['validation_failed', 'worktree.validationFailed'], ['validation_error', 'worktree.validationFailed'],
  ['validation_invalidated', 'worktree.validationFailed'], ['validation_diagnostic', 'issue.reportVerification'],
  ['integration_wait', 'moduleWorkspace.integration'],
  ['validation_reused', 'status.validationReuse'], ['environment_preparation_failed', 'worktree.validationFailed'],
  ['workspace_integrated', 'worktree.integratedSha'], ['workspace_retained', 'moduleWorkspace.retained'],
  ['auto_push_failed', 'issue.pushFailedTitle'], ['workspace_push_verified', 'worktree.verifyPush'],
  ['merge_agent_started', 'moduleWorkspace.mergeAgent'], ['merge_agent_resolved', 'status.done'],
  ['merge_agent_failed', 'status.paused'], ['merge_agent_timed_out', 'status.paused'],
  ['worktree_action_failed', 'worktree.operationUnconfirmed'],
]);
const writerLabels = {
  'execution-agent': 'issue.agentField',
  'merge-agent': 'moduleWorkspace.mergeAgent',
  system: 'worktree.engine',
  human: 'worktree.human',
  unknown: 'status.unknown',
  none: 'worktree.noWriter',
} as const satisfies Record<string, MessageKey>;

interface WorktreeSnapshot {
  workspace: null | {
    attemptId: string;
    phase: string;
    cwd: string;
    branch: string;
    resultSha: string | null;
    integratedSha: string | null;
    stopConfirmed: boolean;
    released: boolean;
    diagnostic: string | null;
  };
  integration: null | {
    id: string;
    phase: string;
    cwd: string;
    targetSha: string;
    candidateSha: string | null;
    diagnostic: string | null;
  };
  mergeAgent: null | {
    id: string;
    agent: AgentKind;
    state: string;
    conversationId: string;
    canSend: boolean;
    stopConfirmed: boolean;
    diagnostic: string | null;
    question: string | null;
  };
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; ts: number }>;
  events: Array<{ kind: string; ts: number; data: unknown }>;
  allowedActions: WorktreeAction[];
  writer?: keyof typeof writerLabels;
  targetBranch?: string | null;
  nextCheckTs?: number | null;
}

type Mutation = { runId: string; text: string } | { attemptId: string; action: WorktreeAction };

export function IssueWorktree({ pid, iid, onChanged }: { pid: number; iid: IssueId; onChanged: () => void }) {
  const { t, formatDateTime } = useI18n();
  const path = `/api/projects/${pid}/issues/${encodeURIComponent(iid)}/worktree`;
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot | null>(null);
  const [readError, setReadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState({ runId: '', text: '' });
  const [writeError, setWriteError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<{ attemptId: string; action: WorktreeAction } | null>(null);
  const active = useRef(false);
  const inFlight = useRef(false);
  const retryIds = useRef(new Map<string, string>());
  const transcript = useRef<HTMLDivElement>(null);
  const confirmationTrigger = useRef<HTMLButtonElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  // Each mounted tab polls one issue, with no overlapping reads. An explicit refresh
  // replaces the in-flight read so a pre-mutation snapshot cannot overwrite newer data.
  useEffect(() => {
    let activeRead: AbortController | null = null;
    let stopped = false;
    let next: number | undefined;
    const read = async (): Promise<void> => {
      const controller = new AbortController();
      activeRead = controller;
      const timeout = window.setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      let pollAgain = true;
      try {
        const result = await api<WorktreeSnapshot>(path, 'GET', undefined, { signal: controller.signal });
        if (stopped) return;
        setSnapshot(result);
        setReadError('');
      } catch (error) {
        if (stopped) return;
        if(controller.signal.aborted) {
          setReadError(tr('worktree.readTimeout'));
          return;
        }
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setSnapshot(null);
          pollAgain = false;
        }
        setReadError(error instanceof Error ? error.message : t('ui.loadFailed'));
      } finally {
        window.clearTimeout(timeout);
        activeRead = null;
        if (!stopped) {
          setRefreshing(false);
          if (pollAgain) next = window.setTimeout(() => void read(), POLL_MS);
        }
      }
    };
    void read();
    return () => {
      stopped = true;
      activeRead?.abort();
      window.clearTimeout(next);
    };
  }, [path, revision]);

  const agent = snapshot?.mergeAgent;
  const workspace = snapshot?.workspace;
  const integration = snapshot?.integration;
  const canSend = Boolean(workspace && !workspace.released && agent?.canSend);
  const controlsDisabled = saving || refreshing || Boolean(readError);
  const input = draft.runId === agent?.id ? draft.text : '';
  const lastMessage = snapshot?.messages.at(-1);

  useLayoutEffect(() => {
    if (stickToBottom.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [agent?.id, lastMessage?.id, lastMessage?.text]);

  const refresh = () => {
    setRefreshing(true);
    setRevision((value) => value + 1);
  };

  const mutate = async (request: Mutation): Promise<void> => {
    if (inFlight.current || controlsDisabled) return;
    inFlight.current = true;
    setSaving(true);
    setWriteError('');
    const key = JSON.stringify(request);
    const requestId = retryIds.current.get(key) ?? crypto.randomUUID();
    retryIds.current.set(key, requestId);
    const sending = 'runId' in request;
    try {
      await api(`${path}/${sending ? 'merge-chat' : 'action'}`, 'POST', { ...request, requestId });
      retryIds.current.delete(key);
      if (active.current) {
        if (sending) setDraft((current) => current.runId === request.runId && current.text.trim() === request.text
          ? { ...current, text: '' } : current);
        onChanged();
      }
    } catch (error) {
      if (active.current) setWriteError(error instanceof Error ? error.message : t('worktree.operationUnconfirmed'));
    } finally {
      inFlight.current = false;
      if (active.current) {
        setSaving(false);
        refresh();
      }
    }
  };

  function send() {
    const text = input.trim();
    if (canSend && agent && text && text.length <= MAX_GUIDANCE_LENGTH) void mutate({ runId: agent.id, text });
  }

  const runAction = (action: WorktreeAction, trigger: HTMLButtonElement) => {
    if (!workspace || !snapshot?.allowedActions.includes(action)) return;
    const request = { attemptId: workspace.attemptId, action };
    if (action === 'takeover' || action === 'return') {
      confirmationTrigger.current = trigger;
      setConfirmation(request);
    }
    else void mutate(request);
  };

  const closeConfirmation = () => {
    setConfirmation(null);
    confirmationTrigger.current?.focus();
  };

  const confirmAction = () => {
    if (!confirmation) return;
    closeConfirmation();
    if (workspace?.attemptId === confirmation.attemptId && snapshot?.allowedActions.includes(confirmation.action)) {
      void mutate(confirmation);
    }
  };

  if (!snapshot && !readError) return <Loading />;
  if (!snapshot) return <div class="issue-worktree-empty">
    <p class="err" role="alert">{readError}</p>
    <button class="btn" type="button" onClick={refresh}>{t('action.retry')}</button>
  </div>;
  if (!workspace) return <div class="empty">{t('worktree.noWorkspace')}</div>;

  const actionKeys = Object.keys(actionLabels) as WorktreeAction[];
  const actions = actionKeys.filter((action) => snapshot.allowedActions.includes(action));
  const modelName = agent?.agent === 'codex' ? 'Codex' : 'Claude';
  const phase = integration?.phase ?? workspace.phase;
  const writer = snapshot.writer ?? 'unknown';
  const diagnostic = integration?.diagnostic ?? workspace.diagnostic ?? agent?.diagnostic;
  const evidence = snapshot.events.flatMap((event) => {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const action = typeof data.action === 'string' && Object.hasOwn(actionLabels, data.action) ? data.action as WorktreeAction : null;
    const label = event.kind === 'worktree_action' && action ? actionLabels[action] : evidenceLabels.get(event.kind);
    return label ? [{ ...event, label, data }] : [];
  });
  const commits = [
    ['worktree.resultSha', workspace.resultSha], ['worktree.baseSha', integration?.targetSha],
    ['worktree.candidateSha', integration?.candidateSha], ['worktree.integratedSha', workspace.integratedSha],
  ] as const;

  return (
    <div class="issue-worktree-tab">
      <div class="issue-worktree-layout">
        <section class="issue-worktree-chat" aria-label={t('moduleWorkspace.mergeAgent')}>
          <header class="issue-worktree-chat-head">
            <div class="issue-worktree-chat-title">
              <h3>{t('moduleWorkspace.mergeAgent')}</h3>
              {agent && <>
                <span class="badge b-gray"><AgentLogo agent={agent.agent} size="xs" decorative /> {modelName}</span>
                <span class={`badge ${agent.state === 'running' ? 'b-amber' : 'b-gray'}`}>{t(agentLabels.get(agent.state) ?? 'status.unknown')}</span>
              </>}
            </div>
            {actions.length > 0 && <div class="issue-worktree-controls">
              {actions.map((action) => <button key={action} type="button" class="btn" disabled={controlsDisabled} onClick={(event) => runAction(action, event.currentTarget)}>
                {t(actionLabels[action])}
              </button>)}
            </div>}
          </header>

          <div
            class="chat-msgs issue-worktree-transcript"
            ref={transcript}
            role="log"
            aria-label={t('moduleWorkspace.mergeAgentRecord')}
            onScroll={(event) => {
              const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
              stickToBottom.current = scrollHeight - scrollTop - clientHeight < 32;
            }}
          >
            {!agent && <p class="empty">{t('worktree.noRun')}</p>}
            {agent && snapshot.messages.length === 0 && !agent.question && <p class="empty">{t('worktree.noTranscript')}</p>}
            {snapshot.messages.map((message) => (
              <article class={`issue-worktree-message ${message.role}`} key={message.id}>
                <div class="small mut">{message.role === 'user' ? t('worktree.human') : modelName}{message.ts > 0 && <> · <time>{formatDateTime(message.ts)}</time></>}</div>
                <div class="issue-worktree-bubble">{message.text}</div>
              </article>
            ))}
            {agent?.question && <p class="issue-worktree-question">{agent.question}</p>}
          </div>

          {(readError || writeError) && <p class="err issue-worktree-error" role="alert">{writeError || readError}</p>}
          {canSend && agent ? (
            <form class="issue-worktree-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
              <textarea
                rows={2}
                aria-label={t('worktree.input')}
                placeholder={t('worktree.input')}
                value={input}
                maxLength={MAX_GUIDANCE_LENGTH}
                disabled={controlsDisabled}
                onInput={(event) => setDraft({ runId: agent.id, text: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <button type="submit" class="btn primary" disabled={controlsDisabled || !input.trim()}>
                {t(saving ? 'rooms.sending' : 'ui.send')}
              </button>
            </form>
          ) : agent && <p class="mut small issue-worktree-readonly">{t('worktree.readOnly')}</p>}
        </section>

        <aside class="issue-worktree-scene" aria-label={t('worktree.scene')}>
          <h3>{t('worktree.scene')}</h3>
          <dl class="issue-worktree-facts">
            <div><dt>{t('worktree.phase')}</dt><dd>{t(phaseLabels.get(phase) ?? 'status.unknown')}</dd></div>
            <div><dt>{t('worktree.writer')}</dt><dd>{t(writerLabels[writer] ?? 'status.unknown')}</dd></div>
            <div><dt>{t('ui.sourceBranch')}</dt><dd class="mono">{workspace.branch}</dd></div>
            {snapshot.targetBranch && <div><dt>{t('moduleWorkspace.target')}</dt><dd class="mono">{snapshot.targetBranch}</dd></div>}
            {commits.map(([label, sha]) => sha && <div key={label}><dt>{t(label)}</dt><dd class="mono">{sha}</dd></div>)}
            {snapshot.nextCheckTs && <div><dt>{t('worktree.nextCheck')}</dt><dd>{formatDateTime(snapshot.nextCheckTs)}</dd></div>}
          </dl>
          {diagnostic && <p class="issue-worktree-diagnostic">{diagnostic}</p>}
          {(workspace.cwd || integration?.cwd || evidence.length > 0) && (
            <details class="issue-worktree-evidence">
              <summary>{t('worktree.evidence')}</summary>
              {workspace.cwd && <p><strong>{t('moduleWorkspace.title')}</strong><code>{workspace.cwd}</code></p>}
              {integration?.cwd && <p><strong>{t('moduleWorkspace.candidate')}</strong><code>{integration.cwd}</code></p>}
              {evidence.length > 0 && <ol>
                {evidence.map((event, index) => <li key={`${event.kind}:${event.ts}:${index}`}>
                  <strong>{t(event.label)}</strong>
                  <time>{formatDateTime(event.ts)}</time>
                  <EvidenceDetails value={event.data} />
                </li>)}
              </ol>}
            </details>
          )}
        </aside>
      </div>

      {confirmation && (
        <Modal title={t(actionLabels[confirmation.action])} onClose={closeConfirmation}>
          {confirmation.action === 'takeover' && <p>{t('worktree.takeoverHelp')}</p>}
          {confirmation.action === 'return' && <p class="mono">{integration?.cwd ?? workspace.cwd}</p>}
          <div class="issue-worktree-confirm">
            <button type="button" class="btn" onClick={closeConfirmation}>{t('ui.cancel')}</button>
            <button type="button" class="btn primary" disabled={controlsDisabled} onClick={confirmAction}>{t('ui.confirm')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EvidenceDetails({ value: data }: { value: Record<string, unknown> }): JSX.Element | null {
  const command = Array.isArray(data.argv) ? JSON.stringify(data.argv) : undefined;
  const changedPaths = Array.isArray(data.changedPaths) ? data.changedPaths.filter((path): path is string => typeof path === 'string') : [];
  const note = [command, data.label, data.note, data.reason, data.detail, data.tail, data.out, data.err, ...changedPaths]
    .filter((item): item is string => typeof item === 'string' && item.length > 0).join('\n');
  return note ? <pre>{note}</pre> : null;
}
