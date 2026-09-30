import { useI18n } from '../i18n/provider';
import { Markdown } from '../components/Markdown';
import { RoomIcon } from '../components/RoomIcon';
import { toast } from '../lib/toast';
import type { useRoomAnswer } from '../lib/room-answer';
import { RoomAvatar, memberLabel } from './room-presenters';
import type { RoomContribution, RoomSnapshot } from '../../../shared/rooms';

export function RoomMessages({ snapshot, userId, answer, disabled, onArtifact, onReply }: {
  snapshot: RoomSnapshot; userId: number; answer: ReturnType<typeof useRoomAnswer>; disabled: boolean;
  onArtifact: (id: string, version: number) => void; onReply: () => void;
}) {
  const { t, formatDateTime, formatTime, formatList } = useI18n();
  const { members, mission, artifacts, contributions } = snapshot;
  const coach = members.find(member => member.role === 'coach');
  const questionCard = (question: NonNullable<RoomContribution['question']>) => {
    const active = mission?.state === 'waiting_user' && mission.question?.id === question.id;
    const answered = contributions.some(item => item.answersQuestionId === question.id);
    return <section class={`room-question-record${active ? ' room-question-active' : ''}`} aria-label={question.text}>
      <b>{question.text}</b>
      {active ? <>
        <div class="room-question-options" role="radiogroup" aria-label={question.text}>{question.options.map(option => <button key={option} type="button" role="radio" aria-checked={answer.questionId === question.id && answer.option === option}
          tabIndex={(answer.questionId === question.id && answer.option ? answer.option === option : question.options[0] === option) ? 0 : -1}
          disabled={disabled || answer.pending || answer.uncertain} onKeyDown={event => {
            const index = question.options.indexOf(option);
            const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % question.options.length : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index + question.options.length - 1) % question.options.length : event.key === 'Home' ? 0 : event.key === 'End' ? question.options.length - 1 : -1;
            if (next >= 0) { event.preventDefault(); answer.selectOption(question.id, question.options[next]); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus(); }
          }} onClick={() => { answer.selectOption(question.id, option); onReply(); }}>{option}</button>)}</div>
        <p class="room-muted">{t('rooms.chatAnswerHint')}</p>
        {(!answer.mode || answer.questionId !== question.id || !question.options.length) && <button class="linkbtn" disabled={disabled || answer.pending || answer.uncertain} onClick={() => { answer.begin(question.id); onReply(); }}>{t('rooms.chatAnswerQuestion')}</button>}
      </> : <><div class="room-question-closed-options">{question.options.map(option => <span key={option}>{option}</span>)}</div><small class={answered ? 'room-success' : 'room-muted'}>{t(answered ? 'rooms.chatAnswered' : 'rooms.chatQuestionClosed')}</small></>}
    </section>;
  };
  return <>
    {!contributions.length && <div class="room-empty room-empty-small"><p>{t('rooms.noHistory')}</p></div>}
    {contributions.map((contribution, index) => {
      const author = members.find(member => member.id === contribution.authorId);
      const label = author ? memberLabel(author, t) : contribution.authorType === 'user' ? contribution.authorId === String(userId) ? t('rooms.you') : contribution.authorId : t('rooms.system');
      const previous = contributions[index - 1];
      const boundary = !!previous && (previous.missionId !== contribution.missionId || previous.goalRevision !== contribution.goalRevision);
      const grouped = previous && !boundary && previous.authorType === contribution.authorType && previous.authorId === contribution.authorId && JSON.stringify(previous.audience) === JSON.stringify(contribution.audience) && contribution.createdAt - previous.createdAt < 300000;
      const own = contribution.authorType === 'user' && contribution.authorId === String(userId);
      const contributionGoal = snapshot.goals?.find(item => item.missionId === contribution.missionId && item.revision === contribution.goalRevision);
      return <div key={contribution.id}>
        {boundary && <div class="room-history-boundary"><b>{t('rooms.goalRevision', { revision: contribution.goalRevision })}</b><p>{contributionGoal?.request ?? t('rooms.historicalGoal')}</p></div>}
        <article id={`room-message-${contribution.id}`} data-message-id={contribution.id} class={`room-message room-message-${contribution.authorType}${own ? ' room-message-own' : ''}${grouped ? ' room-message-grouped' : ''}`} aria-label={label}>
          <div class="room-message-avatar">{author ? <RoomAvatar member={author} /> : <span class="room-avatar" aria-hidden="true">{label.slice(0, 1)}</span>}</div>
          <div class="room-message-body"><header><b>{label}</b>{author?.role === 'coach' && <span class="room-moderator-badge">{t('rooms.chatModerator')}</span>}<time dateTime={new Date(contribution.createdAt).toISOString()} title={formatDateTime(contribution.createdAt)}>{formatTime(contribution.createdAt)}</time></header>
            {contribution.audience.kind !== 'room' && <span class="room-message-audience">{t('rooms.to', { recipient: formatList(contribution.audience.memberIds.map(id => { const member = members.find(item => item.id === id); return member ? memberLabel(member, t) : id; })) })}</span>}
            {contribution.replyTo && <button class="room-reply-link" onClick={() => { const target = document.getElementById(`room-message-${contribution.replyTo}`); if (target) target.scrollIntoView({ block: 'center' }); else toast.info(t('rooms.notAvailable')); }}>{t('rooms.source')}</button>}
            {contribution.text !== contribution.question?.text && <div class="room-message-text"><Markdown text={contribution.text} /></div>}
            {contribution.evidence?.map((item, position) => <blockquote class="room-evidence" key={position}><b>{snapshot.sources?.find(source => source.id === item.sourceId)?.title ?? t('rooms.source')}</b><p>{item.quote}</p></blockquote>)}
            {contribution.question && questionCard(contribution.question)}
            {contribution.answersQuestionId && <small class="room-answer-receipt">{t('rooms.chatAnswered')}</small>}
            {contribution.artifactId && contribution.artifactVersion && <button class="room-file-link" onClick={() => onArtifact(contribution.artifactId!, contribution.artifactVersion!)}><RoomIcon name="artifacts" /><span>{artifacts.find(artifact => artifact.id === contribution.artifactId)?.title ?? t('rooms.artifacts')}</span><small>{t('rooms.versionLabel', { version: contribution.artifactVersion })}</small></button>}
          </div>
        </article>
      </div>;
    })}
    {mission?.state === 'waiting_user' && mission.question && !contributions.some(item => item.question?.id === mission.question!.id) && <article class="room-message room-message-agent"><div class="room-message-avatar">{coach && <RoomAvatar member={coach} />}</div><div class="room-message-body"><header><b>{coach ? memberLabel(coach, t) : t('rooms.chatModerator')}</b><span class="room-moderator-badge">{t('rooms.chatModerator')}</span></header>{questionCard(mission.question)}</div></article>}
  </>;
}
