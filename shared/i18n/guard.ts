import { readFileSync } from 'node:fs';
import { IntlMessageFormat } from 'intl-messageformat';
import * as ts from 'typescript';
import type { SupportedLocale } from './locales';
import type { MessageCatalog } from './messages';

export interface LiteralFinding {
  file: string;
  line: number;
  text: string;
  kind: 'jsx-text' | 'attribute' | 'dialog' | 'summary';
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
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}
