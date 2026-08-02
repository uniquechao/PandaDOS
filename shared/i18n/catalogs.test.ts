import { describe, expect, test } from 'bun:test';
import { IntlMessageFormat } from 'intl-messageformat';
import { catalogs } from './catalogs';
import { SUPPORTED_LOCALES } from './locales';
import type { MessageKey } from './messages';
import { assertCatalogParity } from './guard';

// These values intentionally match English because they are brands, identifiers,
// pure ICU/symbol formats, or established technical/cognate UI terms. Keeping the
// list exact prevents a newly added product sentence from silently using fallback.
const identicalEnglishAllowlist = {
  'zh-Hans': ['git.pageTitle', 'admin.apiKey', 'notify.statusChange', 'login.token', 'notify.summary.progress'],
  'zh-Hant': ['git.pageTitle', 'admin.apiKey', 'notify.statusChange', 'login.token', 'notify.summary.progress'],
  ja: ['git.pageTitle', 'admin.apiKey', 'admin.feishu', 'notify.statusChange', 'login.token', 'notify.summary.progress'],
  ko: ['git.pageTitle', 'admin.feishu', 'notify.summary.statusTransition', 'notify.summary.issueBlocked', 'login.token', 'notify.summary.progress'],
  es: ['shell.chat', 'ui.no', 'ui.endpoint', 'issue.commitCount', 'git.pageTitle', 'admin.feishu', 'notify.summary.statusTransition', 'notify.summary.issueBlocked', 'login.token', 'notify.summary.progress'],
  fr: ['ui.endpoint', 'issue.commitCount', 'git.pageTitle', 'skills.skillCount', 'skills.pageTitle', 'admin.feishu', 'admin.actions', 'admin.agent', 'notify.summary.progress'],
  de: ['shell.online', 'shell.chat', 'shell.roleAdmin', 'ui.details', 'ui.chat', 'project.executor', 'board.skills', 'board.detailsOptional', 'board.agent', 'issue.team', 'issue.detailsLink', 'issue.detailsTab', 'issue.bodyField', 'issue.planProgress', 'git.committer', 'git.pageTitle', 'skills.pageTitle', 'admin.executors', 'admin.feishu', 'admin.agent', 'admin.name', 'admin.status', 'status.categoryDesign', 'status.online', 'status.offline', 'notify.branch', 'notify.summary.statusTransition', 'notify.summary.issueBlocked', 'login.token', 'notify.summary.progress'],
  'pt-BR': ['shell.online', 'ui.endpoint', 'ui.manual', 'project.executor', 'board.skills', 'issue.commitCount', 'issue.escalated', 'git.pageTitle', 'skills.skillCount', 'skills.pageTitle', 'admin.feishu', 'admin.status', 'status.categoryDesign', 'status.online', 'status.offline', 'notify.statusChange', 'notify.branch', 'notify.summary.statusTransition', 'notify.summary.issueBlocked', 'common.issueCount', 'login.token', 'notify.summary.progress'],
  ru: ['git.pageTitle', 'admin.feishu', 'notify.summary.statusTransition', 'notify.summary.issueBlocked', 'notify.summary.progress'],
} as const;

describe('launch catalogs', () => {
  test('all ten locales have exactly the English key set and valid ICU syntax', () => {
    expect(() => assertCatalogParity(catalogs, SUPPORTED_LOCALES)).not.toThrow();
    expect(Object.keys(catalogs)).toEqual([...SUPPORTED_LOCALES]);
    const englishKeys = Object.keys(catalogs.en).sort();
    expect(englishKeys.length).toBeGreaterThan(5);
    for (const locale of SUPPORTED_LOCALES) {
      const catalog = catalogs[locale];
      expect(Object.keys(catalog).sort()).toEqual(englishKeys);
      for (const message of Object.values(catalog)) {
        expect(() => new IntlMessageFormat(message, locale)).not.toThrow();
      }
    }
  });

  test('non-English catalogs do not silently inherit English product copy', () => {
    const english = catalogs.en;
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === 'en') continue;
      const identical = (Object.keys(english) as MessageKey[])
        .filter((key) => catalogs[locale][key] === english[key])
        .sort();
      expect(identical).toEqual([...identicalEnglishAllowlist[locale]].sort());
    }
  });
});
