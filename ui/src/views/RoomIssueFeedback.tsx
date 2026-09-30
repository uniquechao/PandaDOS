import { useEffect, useRef, useState } from 'preact/hooks';
import type { RoomIssueFeedback } from '../../../shared/room-issues';
import { useI18n } from '../i18n/provider';
import { Markdown } from '../components/Markdown';
import { StatusBadge } from '../components/badges';
import { ApiError } from '../lib/api';
import type { IssueStatus } from '../lib/types';
import { readRoomLocal, roomRequestKey, roomsApi, saveRoomLocal } from '../lib/rooms-api';

interface SavedAnswer { answer: string; key?: string; status?: 'uncertain' | 'accepted' }
function IssueAnswer({ pid, rid, userId, feedback, writable, onFailure }: {
  pid: number; rid: string; userId: number; feedback: RoomIssueFeedback; writable: boolean; onFailure: (cause: unknown) => void;
}) {
  const { t } = useI18n();
  const question = feedback.question!;
  const storageKey = `panda.rooms.answer.${userId}.${pid}.${rid}.${feedback.issueId}.${question.id}`;
  const [record, setRecord] = useState<SavedAnswer>(() => readRoomLocal<SavedAnswer>(storageKey) ?? { answer: '' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const retain = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => { if (retain.current) saveRoomLocal(storageKey, record); }, [storageKey, record]);
  const submit = async (): Promise<void> => {
    if (!writable || pending || !record.answer.trim() || record.status === 'accepted') return;
    const submission = { ...record, key: record.key ?? roomRequestKey(), status: 'uncertain' as const };
    saveRoomLocal(storageKey, submission); setRecord(submission); setPending(true); setError('');
    try {
      const result = await roomsApi.answerIssue(pid, rid, feedback.issueId, question.id, submission.answer, submission.key);
      const next = { ...submission, status: result.status }; saveRoomLocal(storageKey, next);
      if (mounted.current) setRecord(next);
    } catch (cause) {
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) retain.current = false;
      onFailure(cause);
      if (mounted.current) {
        setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed'));
        if (cause instanceof ApiError && cause.status > 0 && cause.status < 500 && ![401, 403, 404].includes(cause.status)) setRecord({ answer: submission.answer });
      }
    } finally { if (mounted.current) setPending(false); }
  };
  return <form class="room-form room-issue-answer" onSubmit={event => { event.preventDefault(); void submit(); }}>
    {question.questions.map((text, index) => <p key={index}>{text}</p>)}
    <label class="room-field"><span>{t('rooms.respond')}</span><textarea rows={3} maxLength={4000} required value={record.answer}
      disabled={!writable || pending || !!record.status} onInput={event => setRecord({ answer: event.currentTarget.value })} /></label>
    {record.status && <p class="room-notice" role="status">{t(record.status === 'accepted' ? 'rooms.answerAccepted' : 'rooms.answerUncertain')}</p>}
    {error && <p class="room-error" role="alert">{error}</p>}
    <button class="btn" type="submit" disabled={!writable || pending || !record.answer.trim() || record.status === 'accepted'}>{t(pending ? 'common.loading' : record.status === 'uncertain' ? 'rooms.checkAnswer' : 'rooms.respond')}</button>
  </form>;
}

const eventStatuses: Record<RoomIssueFeedback['events'][number]['kind'], IssueStatus> = {
  started: 'implementing', clarification_needed: 'clarifying', clarification_answered: 'implementing', blocked: 'blocked', paused: 'paused', done: 'done', cancelled: 'cancelled',
};
export function RoomIssueFeedbackPanel({ pid, rid, userId, feedback, writable, onFailure }: {
  pid: number; rid: string; userId: number; feedback: RoomIssueFeedback[]; writable: boolean; onFailure: (cause: unknown) => void;
}) {
  const { t, formatDateTime } = useI18n();
  return <section class="room-side-panel room-issue-feedback"><h2>{t('rooms.issueActivity')}</h2>{feedback.map(item => <details key={item.issueId} open={!!item.question}>
    <summary>{item.title} <StatusBadge status={item.status as IssueStatus} /></summary>
    <a href={`#/p/${pid}/issue/${encodeURIComponent(item.issueId)}`}>{t('rooms.openIssue', { id: item.issueId })}</a>
    <p class="room-muted">{t('rooms.versionLabel', { version: item.artifactVersion })}</p>
    {item.resultSummary && <div><h3>{t('rooms.issueSummary')}</h3><Markdown text={item.resultSummary} /></div>}
    {item.question && <IssueAnswer key={item.question.id} pid={pid} rid={rid} userId={userId} feedback={item} writable={writable} onFailure={onFailure} />}
    {item.events.length > 0 && <ol class="room-issue-events">{item.events.map(event => <li key={event.id}><StatusBadge status={eventStatuses[event.kind]} /><time>{formatDateTime(event.createdAt)}</time></li>)}</ol>}
  </details>)}</section>;
}
