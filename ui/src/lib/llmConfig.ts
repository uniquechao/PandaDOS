import type { Role } from './types';
import { tr } from '../i18n/runtime';

export interface LlmConfigFormState {
  baseUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
}

export function llmConfigGuidance(
  role: Role,
  configured: boolean,
): { message: string; actionPath: string | null } | null {
  if (configured) return null;
  return {
    message: tr('action.llmNotConfigured'),
    actionPath: role === 'admin' ? '/admin/llm' : null,
  };
}

export function buildLlmConfigUpdate(state: LlmConfigFormState): {
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: true;
} {
  const base = {
    baseUrl: state.baseUrl.trim().replace(/\/+$/, ''),
    model: state.model.trim(),
  };
  if (state.clearApiKey) return { ...base, clearApiKey: true };
  const apiKey = state.apiKey.trim();
  return apiKey ? { ...base, apiKey } : base;
}
