import { expect, test } from 'bun:test';
import { loadLlmConfig, loadPmLlmConfig } from './llm';

test('PM credentials use only the explicitly configured DeepSeek endpoint and model', () => {
  const shared = { ...loadLlmConfig(), baseUrl: 'https://shared.invalid/v1', model: 'shared', apiKey: 'shared-token' };
  expect(loadPmLlmConfig(shared, {})).toBe(shared);
  const pm = loadPmLlmConfig(shared, {
    PANDA_PM_LLM_BASE_URL: 'https://pm.invalid/v1',
    PANDA_PM_LLM_MODEL: 'deepseek-custom',
    PANDA_PM_LLM_API_KEY: 'pm-token',
  });
  expect(pm).toMatchObject({ baseUrl: 'https://pm.invalid/v1', model: 'deepseek-custom', apiKey: 'pm-token' });
  expect(loadPmLlmConfig(shared, { PANDA_PM_LLM_MODEL: 'deepseek-custom' }).apiKey).toBe('');
});
