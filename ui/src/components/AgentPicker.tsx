import type { AgentKind } from '../lib/types';
import { AgentLogo } from './AgentLogo';

export function toggleAgent(
  value: AgentKind[],
  agent: AgentKind,
  checked: boolean,
): AgentKind[] {
  const next = checked ? [...new Set([...value, agent])] : value.filter((x) => x !== agent);
  return (['claude', 'codex'] as AgentKind[]).filter((x) => next.includes(x));
}

export function reconcileAgent(
  current: AgentKind | null,
  supported: AgentKind[],
): AgentKind | null {
  if (supported.length === 0) return null;
  if (supported.length === 1) return supported[0]!;
  return current && supported.includes(current) ? current : null;
}

export function AgentPicker({
  value,
  onChange,
  available = ['claude', 'codex'],
  disabled = false,
}: {
  value: AgentKind[];
  onChange(value: AgentKind[]): void;
  available?: AgentKind[];
  disabled?: boolean;
}) {
  return (
    <div class="agent-picker">
      {(['claude', 'codex'] as AgentKind[]).map((agent) => {
        const allowed = available.includes(agent);
        return (
          <label key={agent} class={`chkrow agent-choice${allowed ? '' : ' disabled'}`}>
            <input
              type="checkbox"
              checked={value.includes(agent)}
              disabled={disabled || !allowed}
              onChange={(e) => onChange(toggleAgent(value, agent, e.currentTarget.checked))}
            />
            <span class="agent-choice-name">
              <AgentLogo agent={agent} decorative size="sm" />
              <span class="mut small">{agent === 'claude' ? 'Claude Code' : 'OpenAI Codex'}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
