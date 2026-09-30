import type { Database } from 'bun:sqlite';
import { ProjectMemberStore } from '../core/members';
import { RoomError, type RoomAttempt, type RoomRunPort } from '../rooms/contracts';
import type { RoomIssueFeedback } from '../../shared/room-issues';

/** Model work rechecks the initiating human's authority after every asynchronous boundary. */
export function roomRuntimeAccess(db: Database, service: RoomRunPort, feedback?: (attempt: RoomAttempt) => RoomIssueFeedback[]): RoomRunPort {
  const members = new ProjectMemberStore(db);
  const allowed = (attempt: RoomAttempt): boolean => {
    const scope = db.query<{ actor_user_id: number; owner_user_id: number; role: string; status: string }, [string, number, string]>(
      `SELECT m.actor_user_id,p.owner_user_id,u.role,p.status FROM room_missions m
       JOIN projects p ON p.id=m.project_id JOIN users u ON u.id=m.actor_user_id
       WHERE m.id=? AND m.project_id=? AND m.room_id=?`,
    ).get(attempt.missionId, attempt.projectId, attempt.roomId);
    return !!scope && scope.status === 'active' && (scope.role === 'admin' || scope.actor_user_id === scope.owner_user_id || members.isMember(attempt.projectId,scope.actor_user_id));
  };
  const current = (attempt: RoomAttempt, now?: number): boolean => {
    if (!allowed(attempt)) { service.fail(attempt,'access_revoked',now); return false; }
    return service.isCurrent(attempt,now);
  };
  return {
    claimNext(workerId,now) {
      // A denied mission is interrupted by fail; move on to another ready room fairly.
      for (let i=0;i<100;i++) { const attempt=service.claimNext(workerId,now);if(!attempt)return null;if(allowed(attempt))return attempt;service.fail(attempt,'access_revoked',now); }
      return null;
    },
    context(attempt) { if(!current(attempt))throw new RoomError('forbidden');return { ...service.context(attempt), ...(feedback ? { issueFeedback: feedback(attempt) } : {}) }; },
    dispatched(attempt,now,requestId) { return current(attempt,now) && service.dispatched(attempt,now,requestId); },
    setCancellationMode(attempt,mode) { return current(attempt) && !!service.setCancellationMode?.(attempt,mode); },
    pendingStops: () => service.pendingStops?.() ?? [],
    confirmStopped: (attempt,now) => service.confirmStopped?.(attempt,now) ?? false,
    tool(attempt,call) { if(!current(attempt))throw new RoomError('forbidden');if(!service.tool)throw new RoomError('unavailable');return service.tool(attempt,call); },
    renew(attempt,now) { return current(attempt,now) && service.renew(attempt,now); },
    accept(attempt,result,now) { return current(attempt,now) && service.accept(attempt,result,now); },
    fail: (attempt,code,now) => service.fail(attempt,code,now),
    recover: now => service.recover(now),
    isCurrent: current,
  };
}
