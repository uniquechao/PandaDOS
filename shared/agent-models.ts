/** 模型与档位只接受当前执行机 CLI 实时返回的能力。 */
export interface AgentModelOption {
  id: string;
  name: string;
  resolvedModel?: string;
  efforts: string[];
  defaultEffort?: string;
}
export interface AgentModelCatalog {
  agent: 'claude' | 'codex';
  models: AgentModelOption[];
  fetchedAt: number;
}
export interface AgentModelSelection { model: string; effort: string | null }
export interface AgentModelApplyRequest extends AgentModelSelection {
  agent: 'claude' | 'codex';
  cwd: string;
  session: string;
  nativeSessionId: string | null;
  modelName?: string;
  resolvedModel?: string;
  env?: Record<string, string>;
}
export type AgentModelApplyResult =
  | { state: 'applied'; model: string; effort: string | null }
  | { state: 'pending' }
  | { state: 'failed'; error: string };
export interface AgentModelState {
  selection: AgentModelSelection | null;
  revision: number;
  state: 'pending' | 'applying' | 'applied' | 'failed' | 'unset';
  actual: AgentModelSelection | null;
  error: string | null;
}
export function validModelToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(value);
}
