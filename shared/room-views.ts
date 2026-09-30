import type { RoomContribution, RoomSnapshot } from './rooms';

export interface RoomHistoryPage { contributions: RoomContribution[]; hasMore: boolean; beforeSeq: number | null }
export interface RoomView extends RoomSnapshot { history: { hasMore: boolean; beforeSeq: number | null } }
