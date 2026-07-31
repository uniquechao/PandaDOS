/**
 * Git 页面异步请求的纯状态协调器。
 *
 * 组件只负责发请求；这里决定同项目刷新是否保留已有数据、以及迟到的成功/失败是否仍可落地。
 * 纯函数让连续刷新和跨项目切换无需 DOM 也能做真实状态转换测试。
 */
export interface GitLoadState<T> {
  pid: number;
  request: number;
  value: T | null;
  error: string;
}

export function createGitLoadState<T>(pid: number): GitLoadState<T> {
  return { pid, request: 0, value: null, error: '' };
}

export function beginGitLoad<T>(
  state: GitLoadState<T>,
  pid: number,
  request: number,
  preserve: boolean,
): GitLoadState<T> {
  return {
    pid,
    request,
    value: preserve && state.pid === pid ? state.value : null,
    error: '',
  };
}

export function completeGitLoad<T>(
  state: GitLoadState<T>,
  pid: number,
  request: number,
  value: T,
): GitLoadState<T> {
  if (state.pid !== pid || state.request !== request) return state;
  return { ...state, value, error: '' };
}

export function failGitLoad<T>(
  state: GitLoadState<T>,
  pid: number,
  request: number,
  error: string,
): GitLoadState<T> {
  if (state.pid !== pid || state.request !== request) return state;
  return { ...state, error };
}

export interface KeyedResult<T> {
  key: string;
  value: T | null;
  error: string;
}

export function requestKey(pid: number, refreshToken: number, url: string | null): string {
  return `${pid}:${refreshToken}:${url ?? 'none'}`;
}

export function keyedResult<T>(
  result: KeyedResult<T> | null,
  key: string,
): { value: T | null; error: string } {
  return result?.key === key
    ? { value: result.value, error: result.error }
    : { value: null, error: '' };
}

export function commitPanelLayout(
  mobile: boolean,
  hasSelectedFile: boolean,
): 'detail' | 'mobile-diff' {
  return mobile && hasSelectedFile ? 'mobile-diff' : 'detail';
}
