import type { Database } from 'bun:sqlite';
import type { AgentKind } from './types';
import type { SkillInfo } from './skills';

export type SkillMode = 'auto' | 'manual' | 'disabled';
export type SkillPolicy = Record<string, SkillMode>;
export interface SkillPolicyScope { projectId: number; moduleId?: number; issueId?: number }
export function normalizeSkillPolicy(value: unknown): SkillPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid skill policy');
  const entries = Object.entries(value);
  if (entries.length > 256) throw new Error('Too many skill policies');
  const result: SkillPolicy = {};
  for (const [name, mode] of entries) {
    if (!/^[\w][\w.:@/-]{0,199}$/.test(name) || !['auto','manual','disabled'].includes(String(mode))) throw new Error('Invalid skill policy entry');
    result[name] = mode as SkillMode;
  }
  return result;
}
export function readSkillPolicy(db: Database, scope: SkillPolicyScope): SkillPolicy {
  const row = db.query<{ policy_json: string }, [number,number,number]>(
    'SELECT policy_json FROM skill_policies WHERE project_id=? AND module_id=? AND issue_id=?',
  ).get(scope.projectId,scope.moduleId ?? 0,scope.issueId ?? 0);
  return row ? normalizeSkillPolicy(JSON.parse(row.policy_json)) : {};
}
export function saveSkillPolicy(db: Database, scope: SkillPolicyScope, value: unknown): SkillPolicy {
  const policy = normalizeSkillPolicy(value);
  db.run(`INSERT INTO skill_policies(project_id,module_id,issue_id,policy_json) VALUES(?,?,?,?)
    ON CONFLICT(project_id,module_id,issue_id) DO UPDATE SET policy_json=excluded.policy_json`,
    [scope.projectId,scope.moduleId ?? 0,scope.issueId ?? 0,JSON.stringify(policy)]);
  return policy;
}
export function effectiveSkillPolicy(db: Database, scope: SkillPolicyScope): SkillPolicy {
  return { ...readSkillPolicy(db,{projectId:scope.projectId}),
    ...(scope.moduleId ? readSkillPolicy(db,{projectId:scope.projectId,moduleId:scope.moduleId}) : {}),
    ...(scope.issueId ? readSkillPolicy(db,{projectId:scope.projectId,issueId:scope.issueId}) : {}) };
}
export function skillMode(skill: Pick<SkillInfo,'name'|'path'|'source'>, policy: SkillPolicy): SkillMode {
  return policy[skill.name] ?? (skill.source ? policy[skill.source] : undefined)
    ?? (/superpowers/i.test(`${skill.source ?? ''}/${skill.path}`) ? 'manual' : 'auto');
}
export function skillSessionSettings(agent: AgentKind, skills: SkillInfo[], policy: SkillPolicy) {
  const inventory = skills.map(skill => ({...skill, mode:skillMode(skill,policy)}));
  if (agent === 'codex') return { agent, config: { skills: { config: inventory
    .filter(s => s.mode !== 'auto').map(s => ({path:s.path,enabled:false})) } }, inventory,
    limitations: ['Discovery covers local skill folders and installed plugin cache; managed or dynamically loaded skills may remain visible. Manual skills require a task override before launch.'] };
  const skillOverrides: Record<string,string> = {};
  const enabledPlugins: Record<string,boolean> = {};
  for (const skill of inventory) {
    if (!skill.pluginId) {
      if (skill.mode !== 'auto') skillOverrides[skill.name] = skill.mode === 'disabled' ? 'off' : 'user-invocable-only';
    } else if (inventory.filter(s=>s.pluginId===skill.pluginId).every(s=>s.mode!=='auto')) {
      enabledPlugins[skill.pluginId] = false;
    }
  }
  return { agent, config:{skillOverrides,enabledPlugins}, inventory,
    limitations: inventory.some(s=>s.pluginId && s.mode!=='auto' && enabledPlugins[s.pluginId]!==false)
      ? ['Claude plugin visibility is controlled per plugin; mixed policies cannot hide individual plugin skills.'] : [] };
}
