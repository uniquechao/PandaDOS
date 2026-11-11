import type { AgentKind } from './types';
/** A bounded, tool-free text turn; its identity never references an execution conversation. */
export interface IndependentTextRequest {
  id: string; scopeId: string; projectId: number; agent: AgentKind; model: string; effort: 'low'|'medium'|'high';
  deadlineTs: number; system: string; input: string;
}
export type IndependentTextRunner = (request: IndependentTextRequest, signal: AbortSignal) => Promise<string>;
