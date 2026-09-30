import { useI18n } from '../i18n/provider';
import type { RoomMember, RoomPhase, RoomState } from '../../../shared/rooms';
import type { MessageKey } from '../../../shared/i18n/messages';

export const ROOM_STATE_KEYS: Record<RoomState, MessageKey> = {
  draft: 'rooms.draft', queued: 'rooms.queued', running: 'rooms.running', quiescing: 'rooms.quiescing',
  waiting_user: 'rooms.waiting', paused: 'rooms.paused', exhausted: 'rooms.exhausted', interrupted: 'rooms.interrupted',
  completed: 'rooms.completed', stopped: 'rooms.stopped',
};
export const ROOM_PHASE_KEYS: Record<RoomPhase, MessageKey> = {
  aligning: 'rooms.phaseAlign', producing: 'rooms.phaseCreate', reviewing: 'rooms.phaseReview', finalizing: 'rooms.phaseDeliver',
};
export function RoomStatus({ state }: { state: RoomState }) {
  const { t } = useI18n();
  return <span class={`room-status room-state-${state}`}>{t(ROOM_STATE_KEYS[state])}</span>;
}
export function memberLabel(member: Pick<RoomMember, 'role' | 'displayName'>, t: (key: MessageKey) => string): string {
  return !member.displayName || member.displayName === member.role ? t(`rooms.${member.role}`) : member.displayName;
}
export function memberActivityKey(member: RoomMember): MessageKey {
  if (member.activity?.state !== 'working') return 'rooms.chatMemberWaiting';
  return ({ coach: 'rooms.chatCoaching', planner: 'rooms.chatPlanning', writer: 'rooms.chatWriting', reviewer: 'rooms.chatReviewing' } as const)[member.role];
}
export function RoomAvatar({ member }: { member: Pick<RoomMember, 'role' | 'displayName'> }) {
  const { t } = useI18n();
  return <span class={`room-avatar room-role-${member.role}`} aria-hidden="true">{memberLabel(member, t).slice(0, 1)}</span>;
}
