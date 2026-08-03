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

  test('localizes import errors while preserving raw technical details', () => {
    const error = new ApiError({
      code: 'history.read_failed',
      params: {},
      fallback: 'Could not read local agent history.',
      details: 'EACCES /history/session.jsonl',
    }, 502);
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(error, fr.t)).toBe(
      'Impossible de lire l’historique local de l’agent. — EACCES /history/session.jsonl',
    );
  });

  test('localizes structured project-import guard errors with raw path params', () => {
    const error = new ApiError({
      code: 'project.import_workspace_forbidden',
      params: { root: '/srv/workspaces/u7' },
      fallback: 'Only sessions in your workspace (/srv/workspaces/u7) can be imported.',
    }, 403);
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(error, fr.t)).toBe(
      'Vous ne pouvez importer que les sessions de votre espace de travail (/srv/workspaces/u7).',
    );
  });

  test('localizes external issue errors while preserving raw technical details', () => {
    const error = new ApiError({
      code: 'external_issue.fetch_failed',
      params: {},
      fallback: 'Open issues could not be fetched from the remote provider.',
      details: 'GitLab HTTP 502',
    }, 502);
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(error, fr.t)).toBe(
      'Impossible de récupérer les issue ouverts depuis le service distant. — GitLab HTTP 502',
    );
  });

  test('localizes subtask edit errors instead of falling back to a generic request failure', () => {
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(new ApiError({
      code: 'issue.subtask_already_dispatched',
      params: {},
      fallback: 'Only subtasks that have not been dispatched can be edited.',
    }, 409), fr.t)).toBe('Seules les sous-tâches qui n’ont pas encore été attribuées peuvent être modifiées.');
    expect(localizeApiError(new ApiError({
      code: 'issue.subtask_text_too_long',
      params: { max: 500 },
      fallback: 'Subtask text must not exceed 500 characters.',
    }, 400), fr.t)).toBe('Le contenu de la sous-tâche ne doit pas dépasser 500 caractères.');
  });

  test('uses stable local codes for invalid responses and network failures', async () => {
    globalThis.fetch = (async () => new Response('not json', { status: 502 })) as unknown as typeof fetch;
    expect((await api('/x').catch((value) => value) as ApiError).code).toBe('http.unexpected_response');
    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await api('/x').catch((value) => value) as ApiError).code).toBe('network.unreachable');
  });
});
