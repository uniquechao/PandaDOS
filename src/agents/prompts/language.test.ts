import { describe, expect, test } from 'bun:test';
import { SUPPORTED_LOCALES } from '../../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from './language';
import { buildPlanningPrompt, buildTestingPrompt } from '../../issues/prompts';
import { buildSummaryPrompt as buildReadmeSummaryPrompt } from '../../core/readme-summary';

describe('agent prompt language routing', () => {
  test('Chinese locales use Chinese instructions and every other locale uses English', () => {
    expect(promptLanguage('zh-Hans')).toBe('zh');
    expect(promptLanguage('zh-Hant')).toBe('zh');
    for (const locale of SUPPORTED_LOCALES.filter((item) => !item.startsWith('zh-'))) {
      expect(promptLanguage(locale)).toBe('en');
    }
  });

  test('output instruction names the selected locale and protects technical/user content', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const instruction = outputLanguageInstruction(locale);
      expect(instruction).toContain(locale);
      expect(instruction).toContain('code');
      expect(instruction).toContain('Git');
      expect(instruction).toMatch(/terminal|终端/);
      expect(instruction).toMatch(/user-provided|用户提供/);
    }
  });

  test('non-Chinese prompts use English instructions while preserving raw input and protocols', () => {
    const raw = '修复 `git push` 后的错误';
    for (const locale of ['en', 'ja', 'fr'] as const) {
      const planning = buildPlanningPrompt({ issue: { id: 42, title: raw, body: null }, locale });
      const testing = buildTestingPrompt({ issue: { id: 42, title: raw, body: null }, branch: 'feat/x', locale });
      expect(planning).toContain('[Task planning]');
      expect(planning).toContain(raw);
      expect(planning).toContain('SUBTASKS_BEGIN');
      expect(planning).toContain('SUBTASKS_END');
      expect(testing).toContain('STAGE_DONE:42:testing');
      expect(testing).toContain(locale);
    }
  });

  test('Chinese internal prompts stay Chinese and selected output locale is explicit', () => {
    const zh = buildPlanningPrompt({ issue: { id: 7, title: '导出', body: null }, locale: 'zh-Hant' });
    expect(zh).toContain('【任务规划】');
    expect(zh).toContain('Traditional Chinese (zh-Hant)');
    const ja = buildReadmeSummaryPrompt('demo', '# Raw README 日本語', 'ja');
    expect(ja[0].content).toContain('You write concise');
    expect(ja[0].content).toContain('Japanese (ja)');
    expect(ja[1].content).toContain('# Raw README 日本語');
  });
});
