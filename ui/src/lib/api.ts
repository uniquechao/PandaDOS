/**
 * ui/lib/api —— fetch 封装。
 * - cookie 鉴权（登录后 HttpOnly cookie，浏览器自动带）；
 * - 401 统一回登录页（setOnUnauthorized 注入回调）；login 请求自己处理 401（silent401）；
 * - 非 2xx 抛 ApiError（message = 服务端 {error} 或 HTTP 状态）。
 */
import type {
  AutoApproveLevel,
  Conversation,
  AgentKind,
  ExecutorLite,
  Issue,
  MemberCandidate,
  Project,
  ProjectMember,
  UploadResult,
} from './types';
import type { MessageKey, MessageValues } from '../../../shared/i18n/messages';
import { tr } from '../i18n/runtime';

export interface ApiErrorDescriptor {
  code: string;
  params: Record<string, unknown>;
  fallback: string;
  details?: unknown;
}

const ERROR_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  'auth.invalid_credentials': 'errors.auth.invalid_credentials',
  'auth.required': 'errors.auth.required',
  'auth.admin_required': 'errors.auth.admin_required',
  'auth.forbidden': 'errors.auth.forbidden',
  'auth.route_undeclared': 'errors.auth.route_undeclared',
  'project.required': 'errors.project.required',
  'project.not_found': 'errors.project.not_found',
  'legacy.error': 'errors.legacy.error',
  'network.unreachable': 'errors.network.unreachable',
  'http.unexpected_response': 'errors.http.unexpected_response',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly params: Record<string, unknown>;
  readonly fallback: string;
  readonly details?: unknown;

  constructor(error: ApiErrorDescriptor, status: number, message = error.fallback) {
    super(message);
    this.status = status;
    this.code = error.code;
    this.params = error.params;
    this.fallback = error.fallback;
    this.details = error.details;
  }
}

type Translator = (key: MessageKey, values?: MessageValues) => string;

export function localizeApiError(error: ApiError, t: Translator): string {
  const key = ERROR_MESSAGE_KEYS[error.code];
  const summary = key ? t(key, error.params) : error.fallback;
  if (error.code !== 'legacy.error') return summary;
  const detail = typeof error.details === 'string' ? error.details.trim() : '';
  return detail ? `${summary} — ${detail}` : summary;
}

function descriptorFromBody(body: unknown, status: number): ApiErrorDescriptor {
  if (typeof body === 'object' && body !== null) {
    const raw = (body as { error?: unknown }).error;
    if (typeof raw === 'object' && raw !== null) {
      const value = raw as Partial<ApiErrorDescriptor>;
      if (typeof value.code === 'string' && typeof value.fallback === 'string') {
        return {
          code: value.code,
          params: typeof value.params === 'object' && value.params !== null ? value.params : {},
          fallback: value.fallback,
          ...(value.details === undefined ? {} : { details: value.details }),
        };
      }
    }
    if (typeof raw === 'string') {
      return { code: 'legacy.error', params: {}, fallback: raw };
    }
  }
  return {
    code: 'http.unexpected_response',
    params: { status },
    fallback: `The server returned an unexpected response (HTTP ${status}).`,
  };
}

function localizedError(error: ApiErrorDescriptor, status: number): ApiError {
  const value = new ApiError(error, status);
  value.message = localizeApiError(value, tr);
  return value;
}

let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(fn: () => void): void {
  onUnauthorized = fn;
}

export interface ApiOpts {
  /** true = 401 不触发全局登出回调（登录页自己展示错误） */
  silent401?: boolean;
}

export async function api<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
  opts: ApiOpts = {},
): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let r: Response;
  try {
    r = await fetch(path, init);
  } catch (cause) {
    throw localizedError({
      code: 'network.unreachable',
      params: {},
      fallback: 'Could not reach the server. Check your connection and try again.',
      details: cause instanceof Error ? cause.message : undefined,
    }, 0);
  }
  if (r.status === 401 && !opts.silent401) onUnauthorized?.();
  const j = await r.json().catch(() => null) as unknown;
  if (!r.ok) throw localizedError(descriptorFromBody(j, r.status), r.status);
  return j as T;
}

/** 只用公开项目与执行机视图解析项目可用 Agent，不接触 SSH/目录等 admin 字段。 */
export async function getProjectExecutorAgents(projectId: number): Promise<AgentKind[]> {
  const [project, executors] = await Promise.all([
    api<Project>(`/api/projects/${projectId}`),
    api<ExecutorLite[]>('/api/executors'),
  ]);
  return executors.find((x) => x.id === project.executorId)?.supportedAgents ?? [];
}

/** 截图上传：multipart file → { path(rel), abs, name, size }；rel 随建 issue images 提交 */
export async function uploadImage(projectId: number, file: File): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('file', file, file.name || 'image.png');
  let r: Response;
  try {
    r = await fetch(`/api/projects/${projectId}/upload`, { method: 'POST', body: fd });
  } catch (cause) {
    throw localizedError({
      code: 'network.unreachable', params: {},
      fallback: 'Could not reach the server. Check your connection and try again.',
      details: cause instanceof Error ? cause.message : undefined,
    }, 0);
  }
  if (r.status === 401) onUnauthorized?.();
  const j = await r.json().catch(() => null) as unknown;
  if (!r.ok || typeof j !== 'object' || j === null || !(j as UploadResult).ok) {
    throw localizedError(descriptorFromBody(j, r.status), r.status);
  }
  return j as UploadResult;
}

// ---------- 项目成员（关联多用户） ----------

/** 项目成员列表（属主置顶 role='owner' + project_members 成员 role='member'）。
 *  project-access：属主/成员/admin 皆可拉取。 */
export function listMembers(projectId: number): Promise<{ ok: boolean; members: ProjectMember[] }> {
  return api(`/api/projects/${projectId}/members`);
}

/** 加成员（属主/admin）：按用户名精确添加。added=false 表示本已是成员（幂等）。 */
export function addMember(
  projectId: number,
  username: string,
): Promise<{ ok: boolean; added: boolean; member: ProjectMember; warnings?: string[] }> {
  return api(`/api/projects/${projectId}/members`, 'POST', { username });
}

/** 移除成员（属主/admin），幂等：removed=false 表示本就不是成员。 */
export function removeMember(
  projectId: number,
  userId: number,
): Promise<{ ok: boolean; removed: boolean }> {
  return api(`/api/projects/${projectId}/members/${userId}`, 'DELETE');
}

/** 候选用户（加成员下拉；属主/admin 才可调，排除属主与已有成员） */
export function listMemberCandidates(
  projectId: number,
): Promise<{ ok: boolean; candidates: MemberCandidate[] }> {
  return api(`/api/projects/${projectId}/member-candidates`);
}

/** 转让属主（属主/admin）：目标须为现有成员；原属主自动降为成员 */
export function transferOwner(
  projectId: number,
  userId: number,
): Promise<{ ok: boolean; project: Project }> {
  return api(`/api/projects/${projectId}/transfer-owner`, 'POST', { userId });
}

// ---------- 自动批准档位（issue #108） ----------

/** 改这条 issue 的弹窗自动批准档位；任何状态都能改，下一次弹窗即按新档位分级 */
export function setIssueAutoApprove(
  projectId: number,
  issueId: number,
  level: AutoApproveLevel,
): Promise<{ ok: boolean; issue: Issue }> {
  return api(`/api/projects/${projectId}/issues/${issueId}/auto-approve`, 'POST', { level });
}

/** 改这条对话的弹窗自动批准档位；非谨慎档由服务端巡检兜底（没开网页也自动批） */
export function setConvAutoApprove(
  projectId: number,
  convId: string,
  level: AutoApproveLevel,
): Promise<{ ok: boolean; conversation: Conversation }> {
  return api(
    `/api/projects/${projectId}/conversations/${encodeURIComponent(convId)}/auto-approve`,
    'POST',
    { level },
  );
}
