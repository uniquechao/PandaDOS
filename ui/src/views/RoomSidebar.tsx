import { useI18n } from '../i18n/provider';
import { StatusBadge } from '../components/badges';
import { RoomIcon } from '../components/RoomIcon';
import { latestRoomAssessment, roomVersionPassed } from '../lib/rooms-api';
import { RoomMembersManager } from './RoomMembers';
import { RoomSourcesPanel } from './RoomResources';
import { RoomIssueFeedbackPanel } from './RoomIssueFeedback';
import { RoomAvatar, memberLabel, memberActivityKey } from './room-presenters';
import type { RoomControl } from './RoomPanels';
import type { IssueStatus } from '../lib/types';
import type { RoomSnapshot } from '../../../shared/rooms';

export type RoomSidebarTab = 'goal' | 'artifacts' | 'sources' | 'budget' | 'team';
export const ROOM_SIDEBAR_TABS = ['goal', 'artifacts', 'sources', 'budget'] as const;
export function RoomSidebar({ tab, pid, userId, snapshot, disabled, onControl, onArtifact, onMember, onSnapshot, onFailure, focusMemberId }: {
  focusMemberId?: string; tab: RoomSidebarTab; pid: number; userId: number; snapshot: RoomSnapshot; disabled: boolean;
  onControl: (kind: RoomControl) => void; onArtifact: (id: string, version: number) => void; onMember: (id: string) => void;
  onSnapshot: (snapshot: RoomSnapshot) => void; onFailure: (cause: unknown) => void;
}) {
  const { t, formatNumber, formatDateTime, formatList } = useI18n();
  const { mission, goal, artifacts, capabilities } = snapshot;
  const latest = artifacts.filter(item => item.missionId === mission?.id).at(-1);
  if (tab === 'goal') return <>
    <section class="room-side-panel"><header><h3>{t('rooms.goal')}</h3>{capabilities.canEditGoal && <button class="linkbtn" disabled={disabled} onClick={() => onControl('goal')}>{t('rooms.changeGoal')}</button>}</header>
      <p class="room-goal-text">{goal?.request}</p>
      <ul class="room-checks">{goal?.criteria.filter(criterion => criterion.origin !== 'request' && criterion.id !== 'original-request').map(criterion => {
        const passed = latest && latestRoomAssessment(snapshot, latest.id, latest.currentVersion, criterion.id)?.verdict === 'passed';
        return <li key={criterion.id}><span class={passed ? 'room-check passed' : 'room-check'} aria-label={t(passed ? 'rooms.passed' : 'rooms.pending')}>{passed ? '✓' : '○'}</span><span>{criterion.description}</span></li>;
      })}</ul>
    </section>
    {snapshot.goals && snapshot.goals.length > 1 && <details class="room-side-panel room-history"><summary>{t('rooms.goalHistory')}</summary>{snapshot.goals.map(item => <section key={item.id}><b>{t('rooms.goalRevision', { revision: item.revision })}</b><p>{item.request}</p><ul>{item.criteria.filter(c => c.id !== 'original-request' && c.origin !== 'request').map(c => <li key={c.id}>{c.description}</li>)}</ul><small>{formatDateTime(item.createdAt)}</small></section>)}</details>}
  </>;
  if (tab === 'sources') return <RoomSourcesPanel pid={pid} userId={userId} snapshot={snapshot} writable={!disabled && capabilities.canContribute} onSnapshot={onSnapshot} onFailure={onFailure} />;
  if (tab === 'budget') return mission && <section class="room-side-panel"><header><h3>{t('rooms.budget')}</h3>{capabilities.canAddBudget && <button class="linkbtn" disabled={disabled} onClick={() => onControl('budget')}>{t('rooms.addBudget')}</button>}</header>
    <p>{t('rooms.roundUsage', { used: formatNumber(mission.round), limit: formatNumber(mission.budget.limits.rounds) })}</p>
    <p>{t('rooms.requestUsage', { used: formatNumber(mission.budget.modelRequests), limit: formatNumber(mission.budget.limits.modelRequests) })}</p>
    <progress aria-label={t('rooms.requests')} value={mission.budget.modelRequests} max={mission.budget.limits.modelRequests} />
    <p>{t('rooms.minuteUsage', { used: formatNumber(Math.ceil(mission.budget.activeMs / 60000)), limit: formatNumber(mission.budget.limits.activeMs / 60000) })}</p><p class="room-muted">{t('rooms.budgetHint')}</p>{snapshot.members.some(member => member.status === 'active' && member.model && member.model.provider !== 'deepseek') && <p class="room-muted">{t('rooms.localMetering')}</p>}
  </section>;
  if (tab === 'team') return <>
    <RoomMembersManager pid={pid} userId={userId} snapshot={snapshot} writable={!disabled} focusMemberId={focusMemberId} onSnapshot={onSnapshot} onFailure={onFailure} />
    <section class="room-side-panel room-plans"><h3>{t('rooms.teamPlan')}</h3>{snapshot.plans?.filter(plan => plan.missionId === mission?.id && plan.goalRevision === mission.goalRevision).map(plan => <details key={plan.id} open={plan.state === 'running'}><summary>{t('rooms.planRound', { round: plan.round })}</summary>{plan.tasks.map(task => <article key={task.id}><b>{t(`rooms.${task.role}`)}</b><span class="room-status">{t(task.state === 'skipped' ? 'rooms.taskSkipped' : task.state === 'succeeded' ? 'rooms.completed' : task.state === 'running' ? 'rooms.memberWorking' : ['cancelled', 'superseded'].includes(task.state) ? 'rooms.stopped' : task.state === 'failed' ? 'rooms.interrupted' : 'rooms.queued')}</span><p>{task.instruction}</p>{task.condition === 'has_failed_review' && <p class="room-muted">{t('rooms.conditionalTask')}</p>}{task.independent && <p class="room-muted">{t('rooms.independentTask')}</p>}{task.dependsOn.length > 0 && <p class="room-muted">{t('rooms.taskDependencies', { tasks: formatList(task.dependsOn.map(id => { const dependency = plan.tasks.find(item => item.id === id); return dependency ? t(`rooms.${dependency.role}`) : id; })) })}</p>}</article>)}</details>)}</section>
  </>;
  return <>
    {!artifacts.length && <p class="room-muted">{t('rooms.noArtifact')}</p>}
    {artifacts.map(artifact => <button class="room-artifact-card" onClick={() => onArtifact(artifact.id, artifact.currentVersion)} key={artifact.id}><RoomIcon name="artifacts" /><b>{artifact.title}</b><small>{t('rooms.versionLabel', { version: artifact.currentVersion })} · {t(roomVersionPassed(snapshot, artifact.id, artifact.currentVersion) ? 'rooms.passed' : 'rooms.pending')}</small>{artifact.adoptedVersion !== null && <span class="room-adopted">{t('rooms.adopted')} · {t('rooms.versionLabel', { version: artifact.adoptedVersion })}</span>}</button>)}
    {!!snapshot.issueFeedback?.length && <RoomIssueFeedbackPanel pid={pid} rid={snapshot.room.id} userId={userId} feedback={snapshot.issueFeedback} writable={!disabled && capabilities.canPublish} onFailure={onFailure} />}
    {!snapshot.issueFeedback?.length && snapshot.issueLinks.map(link => <a class="room-issue-link" key={link.id} href={`#/p/${pid}/issue/${encodeURIComponent(link.issueId)}`}><b>{t('rooms.openIssue', { id: link.issueId })}</b><span>{link.title}</span>{link.status && <StatusBadge status={link.status as IssueStatus} />}</a>)}
  </>;
}
