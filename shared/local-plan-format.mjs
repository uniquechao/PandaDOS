// This dependency-free module is also installed beside the offline skill validator.
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;
export const MAX_PLAN_ISSUES = 200;
const identity = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function fail(field, reason) { throw new Error(`${field}: ${reason}`); }
function object(value, field, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'expected an object');
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${field}.${key}`, 'unknown field');
  return value;
}
function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(field, `expected 1-${max} characters`);
  return value;
}
function id(value, field) {
  if (typeof value !== 'string' || !identity.test(value)) fail(field, 'invalid identifier');
  return value;
}

/** Preserve user text exactly; normalize only optional machine fields. */
export function parseLocalPlan(markdown) {
  if (typeof markdown !== 'string' || new TextEncoder().encode(markdown).length > MAX_PLAN_BYTES) fail('file', 'too large');
  const blocks = [...markdown.matchAll(/^```pandados-plan[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (blocks.length !== 1) fail('file', 'expected exactly one pandados-plan JSON block');
  let raw;
  try { raw = JSON.parse(blocks[0][1]); } catch { fail('file', 'invalid JSON'); }
  object(raw, 'plan', ['schemaVersion', 'planId', 'title', 'issues']);
  if (raw.schemaVersion !== 1) fail('schemaVersion', 'unsupported version');
  id(raw.planId, 'planId');
  text(raw.title, 'title', 200);
  if (!Array.isArray(raw.issues) || !raw.issues.length || raw.issues.length > MAX_PLAN_ISSUES) fail('issues', `expected 1-${MAX_PLAN_ISSUES} issues`);
  const issues = raw.issues.map((value, index) => {
    const field = `issues[${index}]`;
    const item = object(value, field, ['title', 'category', 'module', 'agent', 'body', 'acceptance', 'dependsOn']);
    const position = index + 1;
    const title = text(item.title, `${field}.title`, 200);
    const body = text(item.body, `${field}.body`, 8000);
    const category = item.category ?? 'task';
    if (!['task', 'debug', 'design'].includes(category)) fail(`${field}.category`, 'invalid category');
    const module = item.module == null ? null : id(item.module, `${field}.module`);
    const agent = item.agent ?? null;
    if (agent !== null && agent !== 'claude' && agent !== 'codex') fail(`${field}.agent`, 'invalid agent');
    if (!Array.isArray(item.acceptance) || !item.acceptance.length || item.acceptance.length > 50) fail(`${field}.acceptance`, 'expected 1-50 criteria');
    const acceptance = item.acceptance.map((entry, n) => text(entry, `${field}.acceptance[${n}]`, 2000));
    const issueBody = `${body}\n\n<!-- pandados:acceptance -->\n${acceptance.map(entry => `- [ ] ${entry}`).join('\n')}`;
    if (issueBody.length > 8000) fail(`${field}.body`, 'body and acceptance exceed 8000 characters');
    const dependsOn = item.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.length > MAX_PLAN_ISSUES) fail(`${field}.dependsOn`, 'invalid dependency list');
    const dependencies = dependsOn.map(entry => {
      if (!Number.isSafeInteger(entry) || entry < 1 || entry > raw.issues.length) fail(`${field}.dependsOn`, 'expected an existing task number (1-based)');
      return entry;
    });
    if (new Set(dependencies).size !== dependencies.length) fail(`${field}.dependsOn`, 'duplicate dependency');
    return { position, title, body, acceptance, issueBody, category, module, agent, dependsOn: dependencies };
  });
  const byKey = new Map(issues.map(item => [item.position, item]));
  const visiting = new Set();
  const visited = new Set();
  function visit(key) {
    if (visiting.has(key)) fail('dependsOn', `cycle at ${key}`);
    if (visited.has(key)) return;
    const issue = byKey.get(key);
    if (!issue) fail('dependsOn', `unknown issue ${key}`);
    visiting.add(key);
    issue.dependsOn.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  }
  issues.forEach(item => visit(item.position));
  return { schemaVersion: 1, planId: raw.planId, title: raw.title, issues };
}
