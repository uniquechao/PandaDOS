import { describe, expect, test } from 'bun:test';
import { apiError, normalizeErrorPayload } from './errors';

describe('structured API error contract', () => {
  test('keeps stable codes, English fallbacks, parameters, and optional details', () => {
    expect(apiError('auth.invalid_credentials', 'The username or token is incorrect.', 401)).toEqual({
      ok: false,
      error: {
        code: 'auth.invalid_credentials',
        params: {},
        fallback: 'The username or token is incorrect.',
      },
    });
    expect(apiError('git.failed', 'Git operation failed.', 500, { action: 'push' }, 'stderr'))
      .toMatchObject({ error: { params: { action: 'push' }, details: 'stderr' } });
  });

  test('wraps legacy string failures without exposing them as display copy', () => {
    expect(normalizeErrorPayload({ ok: false, error: '内部细节' }, 400)).toEqual({
      ok: false,
      error: {
        code: 'legacy.error',
        params: {},
        fallback: 'The request could not be completed.',
        details: '内部细节',
      },
    });
  });
});
