import { describe, expect, test } from 'bun:test';
import { IntlMessageFormat } from 'intl-messageformat';
import { unlinkSync } from 'node:fs';
import { catalogs } from './catalogs';
import { assertCatalogParity, scanUserVisibleLiterals } from './guard';
import { shellMessages } from './domains/shell';
import { SUPPORTED_LOCALES } from './locales';
import { pseudoCatalog, pseudoMessage } from './pseudo';

describe('i18n guardrails', () => {
  test('catalogs preserve keys and ICU arguments', () => {
    expect(() => assertCatalogParity(catalogs, SUPPORTED_LOCALES)).not.toThrow();
  });

  test('catalog parity rejects lost ICU controls and required selector categories', () => {
    const catalogsWith = (en: string, ru: string) => Object.fromEntries(
      SUPPORTED_LOCALES.map((locale) => [locale, { message: locale === 'ru' ? ru : en }]),
    ) as unknown as Parameters<typeof assertCatalogParity>[0];

    expect(() => assertCatalogParity(catalogsWith(
      '{state, select, running {Running} other {Idle}}',
      '{state}',
    ), SUPPORTED_LOCALES)).toThrow(/ru:message: ICU structure/);
    expect(() => assertCatalogParity(catalogsWith(
      '{state, select, running {Running} other {Idle}}',
      '{state, select, other {Idle}}',
    ), SUPPORTED_LOCALES)).toThrow(/ru:message: ICU select state categories/);
    expect(() => assertCatalogParity(catalogsWith(
      '{count, plural, one {# task} other {# tasks}}',
      '{count, plural, one {# задача} other {# задач}}',
    ), SUPPORTED_LOCALES)).toThrow(/ru:message: ICU plural count categories/);
  });

  test('Russian shell counts use one, few, many, and other forms', () => {
    const format = (key: 'shell.runningCount' | 'shell.reviewCount' | 'shell.waitingCount', count: number) => (
      new IntlMessageFormat(shellMessages.ru[key], 'ru').format({ count })
    );
    expect([1, 2, 5, 1.5].map((count) => format('shell.runningCount', count))).toEqual([
      '1 выполняется', '2 выполняются', '5 выполняются', '1,5 выполняются',
    ]);
    expect([1, 2, 5, 1.5].map((count) => format('shell.reviewCount', count))).toEqual([
      '1 ждёт подтверждения', '2 ждут подтверждения', '5 ждут подтверждения', '1,5 ждут подтверждения',
    ]);
    expect([1, 2, 5, 1.5].map((count) => format('shell.waitingCount', count))).toEqual([
      '1 ожидает', '2 ожидают', '5 ожидают', '1,5 ожидают',
    ]);
  });

  test('pseudo-localization expands text without corrupting ICU syntax', () => {
    const message = pseudoMessage('Hello {name}, {count, plural, one {# task} other {# tasks}}');
    expect(message).toContain('{name}');
    expect(message.length).toBeGreaterThan(60);
    expect(() => new IntlMessageFormat(message, 'en')).not.toThrow();
    expect(Object.keys(pseudoCatalog(catalogs.en))).toEqual(Object.keys(catalogs.en));
  });

  test('literal scanner catches visible copy and ignores allowlisted technical labels', () => {
    const file = new URL('./__guard_fixture.tsx', import.meta.url).pathname;
    Bun.write(file, '<button title="CLI">Save now</button>');
    try {
      expect(scanUserVisibleLiterals([file], { values: ['CLI'] })).toEqual([
        expect.objectContaining({ kind: 'jsx-text', text: 'Save now' }),
      ]);
    } finally {
      unlinkSync(file);
    }
  });

  test('literal scanner catches summary copy but ignores structured summary metadata', () => {
    const file = new URL('./__guard_summary_fixture.ts', import.meta.url).pathname;
    Bun.write(file, `
      const stringCopy = { summary: '等待人工确认' };
      const templateCopy = { summary: \`issue #\${id} 已完成\` };
      const structured = {
        summaryCode: 'status_transition',
        summaryParams: { title: '修复 OAuth 登录' },
      };
    `);
    try {
      expect(scanUserVisibleLiterals([file])).toEqual([
        expect.objectContaining({ kind: 'summary', text: '等待人工确认' }),
        expect.objectContaining({ kind: 'summary', text: 'issue #${id} 已完成' }),
      ]);
    } finally {
      unlinkSync(file);
    }
  });

  test('application UI contains no direct user-visible copy', async () => {
    const files: string[] = [];
    for await (const file of new Bun.Glob('ui/src/**/*.{ts,tsx}').scan('.')) {
      if (!file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) files.push(file);
    }
    expect(scanUserVisibleLiterals(files, { values: [
      'Mando', 'MandoAI', 'MandoAI ·', 'AI', 'Git', 'codex', 'issue', 'Issue #', 'DEBUG', 'admin', 'user',
      'persona', 'memory', 'ws:', '· claude:', '±0', '&lt;', '&gt;',
      '{"quiet":"23:00-08:00"}', 'https://example.com/v1', 'model-name',
    ] })).toEqual([]);
  });

  test('backend notifications and cards contain no direct summary copy', async () => {
    const files = [
      'src/issues/engine.ts',
      'src/web/ws/progress.ts',
      'src/web/ws/approvals.ts',
    ];
    for await (const file of new Bun.Glob('src/notify/*.ts').scan('.')) {
      if (!file.endsWith('.test.ts')) files.push(file);
    }
    expect(scanUserVisibleLiterals(files, {
      patterns: [/^\$\{base\}\/summary\.md$/],
    })).toEqual([]);
  });
});
