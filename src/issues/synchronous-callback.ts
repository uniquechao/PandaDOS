export type SynchronousCallbackResult<Result> = Result extends PromiseLike<unknown> ? never : Result;

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  ) && typeof (value as { then?: unknown }).then === 'function';
}

export function isDeclaredAsyncFunction(value: Function): boolean {
  return Object.prototype.toString.call(value) === '[object AsyncFunction]';
}
