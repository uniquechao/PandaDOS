import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const extracted = [
  'transition-coordinator.ts',
  'transition-repository.ts',
  'scheduling-policy.ts',
  'completion-policy.ts',
  'clarify-recovery-coordinator.ts',
  'issue-state-event-repository.ts',
  'issue-gate-repository.ts',
  'issue-scheduler.ts',
  'git-delivery-service.ts',
];

describe('extracted issue boundary imports', () => {
  for (const file of extracted) {
    test(`${file} has no runtime dependency on IssueEngine or outer layers`, () => {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
      const runtimeImports = source.statements
        .filter(ts.isImportDeclaration)
        .filter((declaration) => {
          const clause = declaration.importClause;
          if (!clause || clause.isTypeOnly) return false;
          const bindings = clause.namedBindings;
          return !bindings || !ts.isNamedImports(bindings) || bindings.elements.some((item) => !item.isTypeOnly);
        })
        .map((declaration) => (declaration.moduleSpecifier as ts.StringLiteral).text);
      expect(runtimeImports.filter((path) =>
        path === './engine' || path.startsWith('../agents/') || path.startsWith('../web/') || path.startsWith('../notify/'),
      )).toEqual([]);
    });
  }
});
