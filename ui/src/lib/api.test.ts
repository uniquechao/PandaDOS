import { afterEach, describe, expect, test } from 'bun:test';
import { createI18n } from '../../../shared/i18n/formatter';
import { frCatalog } from '../../../shared/i18n/catalogs/fr';
import { zhHansCatalog } from '../../../shared/i18n/catalogs/zh-Hans';
import {
  api,
  ApiError,
  localizeApiError,
  setOnUnauthorized,
  uploadChatFile,
  uploadImage,
  uploadWithProgress,
  type UploadProgress,
} from './api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('localized API errors', () => {
  test('sends the caller-owned idempotency key on retried mutation requests', async () => {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { input, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await api('/api/projects/1/designs', 'POST', { title: 'Safe rollout' }, {
      idempotencyKey: 'design-create-1',
    });
    expect(new Headers(request?.init?.headers).get('Idempotency-Key')).toBe('design-create-1');
  });

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

  test('localizes all Feishu configuration validation errors without exposing an English fallback', () => {
    const zh = createI18n({ locale: 'zh-Hans', timeZone: 'UTC', catalog: zhHansCatalog });
    const codes = ['config_invalid', 'app_id_invalid', 'public_url_invalid', 'secret_invalid', 'secret_conflict', 'credentials_required'] as const;
    for (const code of codes) {
      const error = new ApiError({ code: `feishu.${code}`, params: {}, fallback: 'English fallback must not appear.' }, 400);
      expect(localizeApiError(error, zh.t)).toBe(zhHansCatalog[`errors.feishu.${code}`]);
      expect(error.details).toBeUndefined();
    }
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

  test('localizes workflow validation errors while retaining structured issue details', () => {
    const error = new ApiError({
      code: 'workflow.graph_invalid',
      params: { count: 1 },
      fallback: 'The workflow graph is invalid.',
      details: { issues: [{ code: 'workflow.node_unreachable', nodeKey: 'review' }] },
    }, 400);
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(error, fr.t)).toBe('Corrigez les problèmes signalés dans la structure du workflow.');
    expect(error.details).toEqual({ issues: [{ code: 'workflow.node_unreachable', nodeKey: 'review' }] });
  });

  test('localizes issue workflow selection and executor capability errors', () => {
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    expect(localizeApiError(new ApiError({
      code: 'workflow.inactive', params: {}, fallback: 'Workflow inactive.',
    }, 409), fr.t)).toBe('Le modèle sélectionné est archivé.');
    expect(localizeApiError(new ApiError({
      code: 'workflow.agent_unavailable', params: {}, fallback: 'Agent unavailable.',
    }, 409), fr.t)).toBe('Le workflow nécessite un Agent indisponible sur cet exécuteur.');
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

  test('localizes design revision conflicts while preserving the current revision parameter', () => {
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    const error = new ApiError({
      code: 'design.revision_conflict',
      params: { currentRevision: 7 },
      fallback: 'The design changed. Refresh it and try again.',
    }, 409);
    expect(localizeApiError(error, fr.t)).toBe(
      'La conception a changé (révision actuelle : 7). Actualisez-la, puis réessayez.',
    );
  });

  test('localizes reserved design conversations without exposing a fixed-language legacy detail', () => {
    const fr = createI18n({ locale: 'fr', timeZone: 'UTC', catalog: frCatalog });
    const error = new ApiError({
      code: 'design.conversation_reserved',
      params: { conversationId: 'design-1' },
      fallback: 'This conversation is managed by the design workspace.',
    }, 409);
    expect(localizeApiError(error, fr.t)).toBe(
      'Cette conversation est gérée par l’espace de conception.',
    );
  });

  test('uses stable local codes for invalid responses and network failures', async () => {
    globalThis.fetch = (async () => new Response('not json', { status: 502 })) as unknown as typeof fetch;
    expect((await api('/x').catch((value) => value) as ApiError).code).toBe('http.unexpected_response');
    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await api('/x').catch((value) => value) as ApiError).code).toBe('network.unreachable');
  });
});

// ---------- XHR 上传（进度条底座） ----------

/** 最小 XMLHttpRequest 替身：只实现 uploadWithProgress 用到的面 */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 200;
  responseText = '{"ok":true,"path":"p","abs":"/a/p","name":"p","size":1}';
  url = '';
  body: FormData | null = null;
  aborted = false;

  open(_method: string, url: string): void {
    this.url = url;
  }
  send(body: FormData): void {
    this.body = body;
    FakeXhr.last = this;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  /** 造一次上传进度事件 */
  progress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }
}

const originalXhr = globalThis.XMLHttpRequest;
function installFakeXhr(): void {
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  FakeXhr.last = null;
}

describe('uploadWithProgress', () => {
  afterEach(() => {
    globalThis.XMLHttpRequest = originalXhr;
    setOnUnauthorized(() => {});
  });

  const file = (): File => new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' });

  test('回调进度并解析响应体；total 未知时 ratio 为 0，收尾补满格', async () => {
    installFakeXhr();
    const seen: UploadProgress[] = [];
    const p = uploadWithProgress<{ ok: boolean; name: string }>('/api/x', file(), 'fallback.png', {
      onProgress: (x) => seen.push(x),
    });
    const xhr = FakeXhr.last!;
    xhr.progress(3, 0, false); // lengthComputable=false → total 0
    xhr.progress(5, 10);
    xhr.onload!();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(seen[0]).toEqual({ loaded: 3, total: 0, ratio: 0 });
    expect(seen[1]).toEqual({ loaded: 5, total: 10, ratio: 0.5 });
    expect(seen.at(-1)!.ratio).toBe(1); // onload 收尾补 100%
    expect(xhr.url).toBe('/api/x');
    expect((xhr.body!.get('file') as File).name).toBe('shot.png');
  });

  test('401 触发全局登出回调并抛 ApiError', async () => {
    installFakeXhr();
    let kicked = 0;
    setOnUnauthorized(() => { kicked++; });
    const p = uploadWithProgress('/api/x', file(), 'f', {});
    const xhr = FakeXhr.last!;
    xhr.status = 401;
    xhr.responseText = JSON.stringify({ ok: false, error: { code: 'auth.invalid_credentials', params: {}, fallback: 'nope' } });
    xhr.onload!();
    const err = (await p.catch((e: unknown) => e)) as ApiError;
    expect(kicked).toBe(1);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('auth.invalid_credentials');
  });

  test('非 2xx / ok:false / 非 JSON 响应体都走 descriptorFromBody', async () => {
    installFakeXhr();
    const p1 = uploadWithProgress('/api/x', file(), 'f', {});
    const x1 = FakeXhr.last!;
    x1.status = 413;
    x1.responseText = JSON.stringify({ ok: false, error: '文件过大(>20MB)' });
    x1.onload!();
    const e1 = (await p1.catch((e: unknown) => e)) as ApiError;
    expect(e1.status).toBe(413);
    expect(e1.code).toBe('legacy.error'); // 后端裸 error 字符串 → legacy 通道

    const p2 = uploadWithProgress('/api/x', file(), 'f', {});
    const x2 = FakeXhr.last!;
    x2.status = 200;
    x2.responseText = JSON.stringify({ ok: false });
    x2.onload!();
    expect((await p2.catch((e: unknown) => e))).toBeInstanceOf(ApiError);

    const p3 = uploadWithProgress('/api/x', file(), 'f', {});
    const x3 = FakeXhr.last!;
    x3.status = 502;
    x3.responseText = '<html>bad gateway</html>';
    x3.onload!();
    const e3 = (await p3.catch((e: unknown) => e)) as ApiError;
    expect(e3.status).toBe(502);
  });

  test('网络失败 → network.unreachable(status 0)', async () => {
    installFakeXhr();
    const p = uploadWithProgress('/api/x', file(), 'f', {});
    FakeXhr.last!.onerror!();
    const err = (await p.catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('network.unreachable');
    expect(err.status).toBe(0);
  });

  test('abort：已取消的 signal 立即拒绝；上传中取消调 xhr.abort()', async () => {
    installFakeXhr();
    const dead = new AbortController();
    dead.abort();
    const e0 = (await uploadWithProgress('/api/x', file(), 'f', { signal: dead.signal }).catch((e: unknown) => e)) as Error;
    expect(e0.name).toBe('AbortError');
    expect(FakeXhr.last).toBeNull(); // 根本没发出去

    const ctl = new AbortController();
    const p = uploadWithProgress('/api/x', file(), 'f', { signal: ctl.signal });
    ctl.abort();
    expect(FakeXhr.last!.aborted).toBe(true);
    const err = (await p.catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('AbortError');
  });

  test('uploadImage / uploadChatFile 打到各自端点', async () => {
    installFakeXhr();
    const p1 = uploadImage(7, file());
    expect(FakeXhr.last!.url).toBe('/api/projects/7/upload');
    FakeXhr.last!.onload!();
    await p1;

    const p2 = uploadChatFile(7, new File([new Uint8Array(3)], 'notes.txt'));
    expect(FakeXhr.last!.url).toBe('/api/projects/7/upload/file');
    FakeXhr.last!.onload!();
    await p2;
  });
});
