import type { RoomHistoryPage, RoomView } from '../../shared/room-views';
import { RoomError, type RoomScope } from './contracts';
import { RoomStore } from './store';

/** Read-only projections keep history bodies out of polling and list responses. */
export class RoomReadModel {
  constructor(private readonly store: RoomStore) {}
  history(scope: RoomScope, beforeSeq?: number, limit = 80): RoomHistoryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) throw new RoomError('invalid_request');
    return this.store.read(() => {
      this.store.room(scope);
      const all = this.store.contributions(scope, undefined, { limit: limit + 1, beforeSeq });
      const hasMore = all.length > limit;
      const contributions = hasMore ? all.slice(1) : all;
      return { contributions, hasMore, beforeSeq: contributions[0]?.seq ?? null };
    });
  }
  view(scope: RoomScope, now = Date.now()): RoomView {
    return this.store.read(() => {
      const snapshot = this.store.snapshot(scope, now, { limit: 81, metadataOnly: true });
      const hasMore = snapshot.contributions.length > 80;
      const contributions = hasMore ? snapshot.contributions.slice(1) : snapshot.contributions;
      return { ...snapshot, contributions, history: { hasMore, beforeSeq: contributions[0]?.seq ?? null } };
    });
  }
  artifact(scope: RoomScope, artifactId: string) {
    return this.store.read(() => {
      this.store.room(scope);
      const artifact = this.store.artifacts(scope, undefined, { artifactId })[0];
      if (!artifact) throw new RoomError('not_found');
      return artifact;
    });
  }
  source(scope: RoomScope, sourceId: string) {
    return this.store.read(() => {
      this.store.room(scope);
      const source = this.store.sources(scope, { sourceId })[0];
      if (!source) throw new RoomError('not_found');
      return source;
    });
  }
}
