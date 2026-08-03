import { readFileSync } from 'node:fs';
import { IntlMessageFormat } from 'intl-messageformat';
import * as ts from 'typescript';
import type { SupportedLocale } from './locales';
import type { MessageCatalog } from './messages';

export interface LiteralFinding {
  file: string;
  line: number;
  text: string;
  kind: 'jsx-text' | 'attribute' | 'dialog' | 'summary' | 'helper-return' | 'default-label' | 'api-error';
}

export interface LiteralAllowlist {
  values?: readonly string[];
  patterns?: readonly RegExp[];
}

function argumentsOf(message: string): string[] {
  const result = new Set<string>();
  for (const match of message.matchAll(/\{\s*([A-Za-z_][\w]*)\s*(?:[,}])/g)) result.add(match[1]!);
  return [...result].sort();
}

type IcuElement = ReturnType<IntlMessageFormat['getAst']>[number];

interface IcuControl {
  identity: string;
  argument: string;
  kind: 'plural' | 'select';
  categories: string[];
  pluralType?: Intl.PluralRulesOptions['type'];
}

// These messages predate the ICU guard. Keep the debt explicit so any newly
// introduced `{count}` message must use plural rules instead of extending a
// broad pattern allowlist.
const LEGACY_NON_PLURAL_COUNT_KEYS = new Set([
  'shell.expandAll',
  'ui.expandCount',
  'project.archivedCount',
  'project.closedSessions',
  'project.reviewAttention',
  'project.tasksRunning',
  'issue.commitHistory',
  'issue.approvalLog',
  'skills.translateCount',
  'skills.matchLimit',
  'notify.planMore',
  'notify.planHeading',
]);

function controlsOf(message: string, locale: SupportedLocale): IcuControl[] {
  const controls: IcuControl[] = [];
  const visit = (elements: readonly IcuElement[], parents: readonly string[]): void => {
    for (const element of elements) {
      if (element.type === 5 || element.type === 6) {
        const kind = element.type === 5 ? 'select' : 'plural';
        const segment = `${kind}:${element.value}`;
        controls.push({
          identity: [...parents, segment].join('>'),
          argument: element.value,
          kind,
          categories: Object.keys(element.options).sort(),
          ...(element.type === 6 ? { pluralType: element.pluralType } : {}),
        });
        for (const option of Object.values(element.options)) visit(option.value, [...parents, segment]);
      } else if (element.type === 8) {
        visit(element.children, parents);
      }
    }
  };
  visit(new IntlMessageFormat(message, locale).getAst(), []);
  return controls;
}

function controlShape(controls: readonly IcuControl[]): string {
  return controls
    .map((control) => `${control.identity}:${control.pluralType ?? ''}`)
    .sort()
    .join('|');
}

function categoriesFor(controls: readonly IcuControl[], identity: string): string[] {
  return [...new Set(controls
    .filter((control) => control.identity === identity)
    .flatMap((control) => control.categories))].sort();
}

export function assertCatalogParity(
  catalogs: Readonly<Record<SupportedLocale, MessageCatalog>>,
  locales: readonly SupportedLocale[],
): void {
  const english = catalogs.en;
  const englishMessages = english as Readonly<Record<string, string>>;
  const englishKeys = Object.keys(english).sort();
  const problems: string[] = [];
  for (const key of englishKeys) {
    const message = englishMessages[key]!;
    if (
      argumentsOf(message).includes('count') &&
      !controlsOf(message, 'en').some((control) => control.kind === 'plural' && control.argument === 'count') &&
      !LEGACY_NON_PLURAL_COUNT_KEYS.has(key)
    ) {
      problems.push(`en:${key}: count must use ICU plural`);
    }
  }
  for (const locale of locales) {
    const catalog = catalogs[locale];
    const keys = Object.keys(catalog).sort();
    const missing = englishKeys.filter((key) => !(key in catalog));
    const extra = keys.filter((key) => !(key in english));
    if (missing.length) problems.push(`${locale}: missing ${missing.join(', ')}`);
    if (extra.length) problems.push(`${locale}: extra ${extra.join(', ')}`);
    for (const key of englishKeys) {
      if (!(key in catalog)) continue;
      const englishMessage = englishMessages[key]!;
      const localeMessage = (catalog as Readonly<Record<string, string>>)[key]!;
      const expected = argumentsOf(englishMessages[key]!);
      const actual = argumentsOf(localeMessage);
      if (expected.join('|') !== actual.join('|')) {
        problems.push(`${locale}:${key}: ICU arguments ${actual.join(', ') || 'none'}; expected ${expected.join(', ') || 'none'}`);
      }
      const expectedControls = controlsOf(englishMessage, 'en');
      const actualControls = controlsOf(localeMessage, locale);
      const localePluralCategories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      // Languages whose cardinal system only has `other` (for example Korean)
      // may naturally render a count without retaining an English plural block.
      const requiredControls = expectedControls.filter((control) => (
        control.kind === 'select' || localePluralCategories.length > 1
      ));
      const requiredShape = new Set(requiredControls.map((control) => `${control.identity}:${control.pluralType ?? ''}`));
      const expectedShape = new Set(expectedControls.map((control) => `${control.identity}:${control.pluralType ?? ''}`));
      const actualShape = new Set(actualControls.map((control) => `${control.identity}:${control.pluralType ?? ''}`));
      const missingControls = [...requiredShape].filter((identity) => !actualShape.has(identity));
      const unexpectedControls = [...actualShape].filter((identity) => !expectedShape.has(identity));
      if (missingControls.length || unexpectedControls.length) {
        problems.push(`${locale}:${key}: ICU structure ${controlShape(actualControls) || 'none'}; expected ${controlShape(requiredControls) || 'none'}`);
        continue;
      }
      for (const control of actualControls) {
        const expectedCategories = categoriesFor(expectedControls, control.identity);
        if (control.kind === 'select') {
          if (control.categories.join('|') !== expectedCategories.join('|')) {
            problems.push(`${locale}:${key}: ICU select ${control.argument} categories ${control.categories.join(', ')}; expected ${expectedCategories.join(', ')}`);
          }
          continue;
        }
        const localeCategories = new Intl.PluralRules(locale, { type: control.pluralType }).resolvedOptions().pluralCategories;
        const localeCategorySet = new Set<string>(localeCategories);
        const requiredCategories = locale === 'ru'
          ? localeCategories
          : expectedCategories.filter((category) => category.startsWith('=') || localeCategorySet.has(category));
        const missingCategories = requiredCategories.filter((category) => !control.categories.includes(category));
        if (missingCategories.length) {
          problems.push(`${locale}:${key}: ICU plural ${control.argument} categories ${control.categories.join(', ')}; expected ${requiredCategories.join(', ')}`);
        }
      }
    }
  }
  if (problems.length) throw new Error(`Invalid i18n catalogs:\n${problems.join('\n')}`);
}

function allowed(text: string, allowlist: LiteralAllowlist): boolean {
  const normalized = text.trim();
  if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) return true;
  if (allowlist.values?.includes(normalized)) return true;
  return allowlist.patterns?.some((pattern) => pattern.test(normalized)) ?? false;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function propertyName(name: ts.PropertyName, source: ts.SourceFile): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(source);
}

function literalExpressionText(expression: ts.Expression, source: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) return expression.getText(source).slice(1, -1);
  return undefined;
}

function literalLeaves(
  expression: ts.Expression,
  source: ts.SourceFile,
): Array<{ node: ts.Expression; text: string }> {
  const direct = literalExpressionText(expression, source);
  if (direct !== undefined) return [{ node: expression, text: direct }];
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
    return literalLeaves(expression.expression, source);
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...literalLeaves(expression.whenTrue, source),
      ...literalLeaves(expression.whenFalse, source),
    ];
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [
      ...literalLeaves(expression.left, source),
      ...literalLeaves(expression.right, source),
    ];
  }
  return [];
}

function functionName(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) {
    return node.name ? propertyName(node.name, source) : undefined;
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)) {
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
  }
  return undefined;
}

function enclosingFunctionName(node: ts.Node, source: ts.SourceFile): string | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return functionName(current, source);
    current = current.parent;
  }
  return undefined;
}

function routePathOf(node: ts.ObjectLiteralExpression, source: ts.SourceFile): string | undefined {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name, source) !== 'path') continue;
    return ts.isStringLiteral(property.initializer) ? property.initializer.text : undefined;
  }
  return undefined;
}

function objectProperty(
  node: ts.ObjectLiteralExpression,
  name: string,
  source: ts.SourceFile,
): ts.PropertyAssignment | undefined {
  return node.properties.find((property): property is ts.PropertyAssignment => (
    ts.isPropertyAssignment(property) && propertyName(property.name, source) === name
  ));
}

/** Scan source files for new, directly embedded user-visible literals. */
export function scanUserVisibleLiterals(
  paths: readonly string[],
  allowlist: LiteralAllowlist = {},
): LiteralFinding[] {
  const findings: LiteralFinding[] = [];
  for (const file of paths) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const add = (node: ts.Node, text: string, kind: LiteralFinding['kind']): void => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (allowed(normalized, allowlist)) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push({ file, line: line + 1, text: normalized, kind });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node)) add(node, node.text, 'jsx-text');
      if (ts.isJsxAttribute(node) && ['title', 'placeholder', 'aria-label', 'alt'].includes(node.name.getText(source))) {
        if (node.initializer && ts.isStringLiteral(node.initializer)) add(node, node.initializer.text, 'attribute');
      }
      if (ts.isCallExpression(node) && ['confirm', 'alert', 'prompt'].includes(calleeName(node.expression) ?? '')) {
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) add(node, first.text, 'dialog');
      }
      if (ts.isPropertyAssignment(node) && propertyName(node.name, source) === 'summary') {
        const text = literalExpressionText(node.initializer, source);
        if (text !== undefined) add(node, text, 'summary');
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const name = enclosingFunctionName(node, source);
        if (name && /(?:Label|Text|Message|Description|Title)$/i.test(name)) {
          for (const literal of literalLeaves(node.expression, source)) {
            add(literal.node, literal.text, 'helper-return');
          }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (/^(?:default|fallback).*Label$/i.test(node.name.text)) {
          for (const literal of literalLeaves(node.initializer, source)) {
            add(literal.node, literal.text, 'default-label');
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}

/** Scan selected API routes for legacy error bodies and fixed-language fallbacks. */
export function scanApiErrorExits(
  paths: readonly string[],
  routePaths: readonly string[],
  allowlist: LiteralAllowlist = {},
): LiteralFinding[] {
  const findings: LiteralFinding[] = [];
  const protectedPaths = new Set(routePaths);
  for (const file of paths) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const add = (node: ts.Node, text: string): void => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (allowed(normalized, allowlist)) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.push({ file, line: line + 1, text: normalized, kind: 'api-error' });
    };
    const scanRoute = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node.expression) === 'json') {
        const body = node.arguments[0];
        if (body && ts.isObjectLiteralExpression(body)) {
          const ok = objectProperty(body, 'ok', source);
          const error = objectProperty(body, 'error', source);
          if (ok && ok.initializer.kind === ts.SyntaxKind.FalseKeyword && error) {
            add(error.initializer, literalExpressionText(error.initializer, source) ?? error.initializer.getText(source));
          }
        }
      }
      if (ts.isCallExpression(node) && calleeName(node.expression) === 'apiError') {
        const fallback = node.arguments[1];
        if (fallback) {
          const text = literalExpressionText(fallback, source);
          if (text === undefined || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/u.test(text)) {
            add(fallback, text ?? fallback.getText(source));
          }
        }
      }
      ts.forEachChild(node, scanRoute);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && protectedPaths.has(routePathOf(node, source) ?? '')) {
        scanRoute(node);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
