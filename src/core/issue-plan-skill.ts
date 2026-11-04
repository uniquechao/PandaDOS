import { readFileSync } from 'node:fs';
import type { CompatDriver, CompatHomes } from './agent-compat';

export const ISSUE_PLAN_SKILL = `---
name: panda-issue-plan
description: Turn agreed requirements from a local agent conversation into a PandaDOS issue plan for preview and batch execution. Use for preparing a series of issues or a local issue plan, not reading the existing issue inbox.
---

# PandaDOS local issue plans (panda 自动生成)

Write a draft at \`.panda/plans/<plan-id>.md\` in the current project. PandaDOS discovers it; the user selects Execute plan to create and queue issues. No token or running service is needed to generate the file. Generating a draft does not authorize execution.

Read project instructions and, when available, \`.panda/modules/INDEX.md\` and relevant module documents. Check existing issue records to avoid duplicate work. Split only by independent acceptance goals or necessary phase decisions; keep implementation, tests and documentation for the same deliverable together. A simple request can be one issue.

Use a readable Markdown introduction and exactly one fenced \`pandados-plan\` JSON block:

~~~json
{
  "schemaVersion": 1,
  "planId": "login-improvements-20261010-a7c2",
  "title": "Improve login",
  "issues": [
    {
      "title": "Improve failure messages and retry",
      "category": "task",
      "body": "Distinguish invalid credentials from network errors and support retry.",
      "acceptance": ["Network errors can be retried without losing input"],
      "dependsOn": []
    },
    {
      "title": "Measure login failure reasons",
      "body": "Record the error categories introduced by the preceding task.",
      "acceptance": ["Metrics distinguish failure reasons without recording secrets"],
      "dependsOn": [1]
    }
  ]
}
~~~

- Tasks have no issue key, id or status. Array positions are task numbers starting at 1; \`dependsOn\` references those numbers. PandaDOS allocates official issue keys only during import and stores the mapping.
- \`planId\` identifies the plan, not an issue. Keep it stable while editing or renaming the draft; use a new planId for follow-up work after execution. Identifiers use letters, digits, dots, underscores and hyphens, start with a letter or digit, and have at most 120 characters. File names use these characters and end in .md.
- Required: title (at most 200 characters), body, and a nonempty acceptance array for every task. Body plus criteria must fit 8000 characters. At most 200 tasks, 50 criteria per task, 2 MiB per file.
- category defaults to task; task/debug/design are accepted. module optionally references an existing active module slug; do not create modules as a planning side effect. agent optionally selects claude/codex and must match the module agent; omit it to use the module or an available executor agent.
- Add only genuine prerequisites. No cycles, self-dependencies or references outside the plan. A dependency chain expresses strict sequential execution.
- Preserve user wording and technical content; write the introduction, requirements and acceptance criteria in the user's language. Do not include credentials or runtime state.

Validate offline with \`node <this-skill-directory>/validate.mjs <draft-file>\` (or bun). The validator uses the exact parser used by PandaDOS. Write a temporary file whose name does not end in .md, validate, then atomically rename into \`.panda/plans/\`. Return the final relative path, task count and dependency summary. Do not submit via issue APIs or write \`.panda/modules/*/issues/\`; those paths can import and execute immediately.
`;

export const ISSUE_PLAN_VALIDATOR = `// panda 自动生成 — offline, no credentials or HTTP.
import { readFileSync } from 'node:fs';
import { parseLocalPlan } from './local-plan-format.mjs';
try {
  if (process.argv.length !== 3) throw new Error('Usage: node validate.mjs <plan-file>');
  const plan = parseLocalPlan(readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify({ valid: true, planId: plan.planId, tasks: plan.issues.length }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

export async function ensurePandaIssuePlanSkill(driver: CompatDriver, homes: CompatHomes): Promise<string[]> {
  const parser = readFileSync(new URL('../../shared/local-plan-format.mjs', import.meta.url), 'utf8');
  const files = [['SKILL.md', ISSUE_PLAN_SKILL], ['validate.mjs', ISSUE_PLAN_VALIDATOR],
    ['local-plan-format.mjs', `// panda 自动生成\n${parser}`]];
  const wrote: string[] = [];
  for (const home of [homes.claudeHome, homes.codexHome]) {
    if (!home) continue;
    for (const [name, content] of files) {
      const path = `${home.replace(/\/+$/, '')}/skills/panda-issue-plan/${name}`;
      const stat = await driver.statPath(path);
      const existing = stat ? new TextDecoder().decode((await driver.readFileRange(path, 0, 128 * 1024)).data) : null;
      if (existing === content || (existing !== null && !existing.includes('panda 自动生成'))) continue;
      await driver.writeFile(path, content);
      wrote.push(path);
    }
  }
  return wrote;
}
