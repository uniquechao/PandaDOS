import type { RoomCapabilities, RoomState } from '../../shared/rooms';

export const isRoomClosed = (state: RoomState): boolean => state === 'completed' || state === 'stopped';
export const isRoomActive = (state: RoomState): boolean => state === 'queued' || state === 'running' || state === 'quiescing';
export const isRoomRunnable = (state: RoomState): boolean => state === 'queued' || state === 'running';

/** Control intent is persisted before any asynchronous cancellation. */
export function roomTransition(state: RoomState, event: 'start' | 'pause' | 'resume' | 'stop' | 'answer' | 'budget' | 'complete'): RoomState | null {
  switch (event) {
    case 'start': return state === 'draft' ? 'queued' : null;
    case 'pause': return isRoomRunnable(state) ? 'quiescing' : null;
    case 'resume': return state === 'paused' || state === 'interrupted' ? 'queued' : null;
    case 'stop': return isRoomClosed(state) || state === 'quiescing' ? null : isRoomRunnable(state) ? 'quiescing' : 'stopped';
    case 'answer': return state === 'waiting_user' ? 'queued' : null;
    case 'budget': return state === 'exhausted' ? 'queued' : null;
    case 'complete': return state === 'running' ? 'completed' : null;
  }
}

export function roomCapabilities(state: RoomState | null, archived: boolean): RoomCapabilities {
  const open = state !== null && !isRoomClosed(state) && !archived;
  return {
    canStart: open && state === 'draft', canPause: open && isRoomRunnable(state!),
    canResume: open && (state === 'paused' || state === 'interrupted'),
    canStop: open && state !== 'quiescing', canEditGoal: open && state !== 'quiescing',
    canAddBudget: open && state !== 'quiescing', canPublish: !archived,
    canContribute: open && state !== 'quiescing', canArchive: !archived && !open,
  };
}
