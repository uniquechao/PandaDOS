export interface ErrorDescriptor {
  code: string;
  params: Record<string, unknown>;
  fallback: string;
  details?: unknown;
}

export interface ErrorPayload {
  ok: false;
  error: ErrorDescriptor;
}

export function apiError(
  code: string,
  fallback: string,
  _status: number,
  params: Record<string, unknown> = {},
  details?: unknown,
): ErrorPayload {
  return {
    ok: false,
    error: {
      code,
      params,
      fallback,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function normalizeErrorPayload(body: unknown, status: number): unknown {
  if (status < 400 || typeof body !== 'object' || body === null) return body;
  const value = body as Record<string, unknown>;
  if (typeof value.error === 'object' && value.error !== null) return body;
  if (typeof value.error !== 'string') return body;
  return {
    ...value,
    ...apiError(
      'legacy.error',
      'The request could not be completed.',
      status,
      {},
      value.error,
    ),
  };
}
