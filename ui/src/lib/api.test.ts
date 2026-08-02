import { afterEach, describe, expect, test } from 'bun:test';
import { createI18n } from '../../../shared/i18n/formatter';
import { frCatalog } from '../../../shared/i18n/catalogs/fr';
import { api, ApiError, localizeApiError } from './api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('localized API errors', () => {
  test('parses the structured wire contract and localizes known codes', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'auth.invalid_credentials', params: {}, fallback: 'The username or token is incorrect.' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const error = await api('/api/login', 'POST', {}, { silent401: true }).catch((value) => value) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('auth.invalid_credentials');
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(error, fr.t)).toBe('Le nom d’utilisateur ou le jeton est incorrect.');
  });

  test('keeps unknown-code fallback and technical details', () => {
    const error = new ApiError({ code: 'custom.failure', params: {}, fallback: 'Safe fallback.', details: 'stderr' }, 500);
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(error, fr.t)).toBe('Safe fallback.');
    expect(error.details).toBe('stderr');
  });

  test('keeps legacy validation details visible after the localized summary', () => {
    const error = new ApiError({
      code: 'legacy.error', params: {}, fallback: 'The request could not be completed.', details: 'timezone must be an IANA name',
    }, 400);
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(error, fr.t)).toBe(
      'La requête n’a pas pu être effectuée. — timezone must be an IANA name',
    );
  });

  test('uses stable local codes for invalid responses and network failures', async () => {
    globalThis.fetch = (async () => new Response('not json', { status: 502 })) as unknown as typeof fetch;
    expect((await api('/x').catch((value) => value) as ApiError).code).toBe('http.unexpected_response');
    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await api('/x').catch((value) => value) as ApiError).code).toBe('network.unreachable');
  });
});
