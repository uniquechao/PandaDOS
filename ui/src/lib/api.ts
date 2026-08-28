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
  'user.not_found': 'errors.user.not_found',
  'executor.not_found': 'errors.executor.not_found',
  'executor.id_required': 'errors.executor.id_required',
  'executor.driver_unavailable': 'errors.executor.driver_unavailable',
  'executor.connection_unavailable': 'errors.executor.connection_unavailable',
  'executor.agent_invalid': 'errors.executor.agent_invalid',
  'executor.agent_unavailable': 'errors.executor.agent_unavailable',
  'history.read_failed': 'errors.history.read_failed',
  'history.selection_required': 'errors.history.selection_required',
  'history.selection_invalid': 'errors.history.selection_invalid',
  'history.not_found': 'errors.history.not_found',
  'history.assigned': 'errors.history.assigned',
  'history.import_failed': 'errors.history.import_failed',
  'project.import_source_invalid': 'errors.project.import_source_invalid',
  'project.import_session_invalid': 'errors.project.import_session_invalid',
  'project.import_managed_session': 'errors.project.import_managed_session',
  'project.import_tmux_read_failed': 'errors.project.import_tmux_read_failed',
  'project.import_tmux_not_found': 'errors.project.import_tmux_not_found',
  'project.import_tmux_cwd_unavailable': 'errors.project.import_tmux_cwd_unavailable',
  'project.import_session_assigned': 'errors.project.import_session_assigned',
  'project.import_cwd_invalid': 'errors.project.import_cwd_invalid',
  'project.import_project_not_found': 'errors.project.import_project_not_found',
  'project.import_history_assigned': 'errors.project.import_history_assigned',
  'project.import_history_failed': 'errors.project.import_history_failed',
  'project.import_workspace_forbidden': 'errors.project.import_workspace_forbidden',
  'project.import_directory_owned': 'errors.project.import_directory_owned',
  'project.import_create_failed': 'errors.project.import_create_failed',
  'external_issue.source_required': 'errors.external_issue.source_required',
  'external_issue.remote_changed': 'errors.external_issue.remote_changed',
  'external_issue.remote_unavailable': 'errors.external_issue.remote_unavailable',
  'external_issue.remote_list_failed': 'errors.external_issue.remote_list_failed',
  'external_issue.remote_name_invalid': 'errors.external_issue.remote_name_invalid',
  'external_issue.provider_invalid': 'errors.external_issue.provider_invalid',
  'external_issue.token_too_long': 'errors.external_issue.token_too_long',
  'external_issue.token_action_conflict': 'errors.external_issue.token_action_conflict',
  'external_issue.source_invalid': 'errors.external_issue.source_invalid',
  'external_issue.fetch_failed': 'errors.external_issue.fetch_failed',
  'external_issue.identity_invalid': 'errors.external_issue.identity_invalid',
  'external_issue.already_imported': 'errors.external_issue.already_imported',
  'external_issue.title_required': 'errors.external_issue.title_required',
  'external_issue.module_invalid': 'errors.external_issue.module_invalid',
  'external_issue.agent_unavailable': 'errors.external_issue.agent_unavailable',
  'external_issue.git_invalid': 'errors.external_issue.git_invalid',
  'external_issue.import_failed': 'errors.external_issue.import_failed',
  'workflow.graph_invalid': 'errors.workflow.graph_invalid',
  'workflow.save_failed': 'errors.workflow.save_failed',
  'workflow.name_invalid': 'errors.workflow.name_invalid',
  'workflow.description_invalid': 'errors.workflow.description_invalid',
  'workflow.name_conflict': 'errors.workflow.name_conflict',
  'workflow.not_found': 'errors.workflow.not_found',
  'workflow.selection_invalid': 'errors.workflow.selection_invalid',
  'workflow.inactive': 'errors.workflow.inactive',
  'workflow.agent_unavailable': 'errors.workflow.agent_unavailable',
  'workflow.status_invalid': 'errors.workflow.status_invalid',
  'workflow.patch_required': 'errors.workflow.patch_required',
  'issue.not_found': 'errors.issue.not_found',
  'issue.subtask_text_required': 'errors.issue.subtask_text_required',
  'issue.subtask_text_too_long': 'errors.issue.subtask_text_too_long',
  'issue.subtask_not_found': 'errors.issue.subtask_not_found',
  'issue.subtask_already_dispatched': 'errors.issue.subtask_already_dispatched',
  'design.invalid_request': 'errors.design.invalid_request',
  'design.not_found': 'errors.design.not_found',
  'design.agent_invalid': 'errors.design.agent_invalid',
  'design.agent_unavailable': 'errors.design.agent_unavailable',
  'design.module_invalid': 'errors.design.module_invalid',
  'design.module_agent_mismatch': 'errors.design.module_agent_mismatch',
  'design.revision_conflict': 'errors.design.revision_conflict',
  'design.archived': 'errors.design.archived',
  'design.forbidden': 'errors.design.forbidden',
  'design.stage_conflict': 'errors.design.stage_conflict',
  'design.graph_invalid': 'errors.design.graph_invalid',
  'design.not_ready': 'errors.design.not_ready',
  'design.operation_failed': 'errors.design.operation_failed',
  'design.conversation_reserved': 'errors.design.conversation_reserved',
  'design.conversation_failed': 'errors.design.conversation_failed',
  'design.conversation_cleanup_failed': 'errors.design.conversation_cleanup_failed',
  'design.idempotency_conflict': 'errors.design.idempotency_conflict',
  'design.not_approved': 'errors.design.not_approved',
  'design.confirmation_invalid': 'errors.design.confirmation_invalid',
  'design.confirmation_expired': 'errors.design.confirmation_expired',
  'design.confirmation_consumed': 'errors.design.confirmation_consumed',
  'design.confirmation_mismatch': 'errors.design.confirmation_mismatch',
  'design.already_published': 'errors.design.already_published',
  'design.sync_not_found': 'errors.design.sync_not_found',
  'design.sync_stale': 'errors.design.sync_stale',
  'design.sync_conflict': 'errors.design.sync_conflict',
  'design.sync_not_actionable': 'errors.design.sync_not_actionable',
  'design.sync_invalid': 'errors.design.sync_invalid',
  'design.persona_invalid': 'errors.design.persona_invalid',
  'design.persona_not_found': 'errors.design.persona_not_found',
  'design.persona_incompatible': 'errors.design.persona_incompatible',
  'design.persona_approval_required': 'errors.design.persona_approval_required',
  'design.persona_hash_stale': 'errors.design.persona_hash_stale',
  'design.persona_source_invalid': 'errors.design.persona_source_invalid',
  'design.persona_source_not_found': 'errors.design.persona_source_not_found',
  'design.persona_discovery_failed': 'errors.design.persona_discovery_failed',
  'design.persona_market_sync_failed': 'errors.design.persona_market_sync_failed',
  'design.persona_operation_failed': 'errors.design.persona_operation_failed',
  'design.persona_collision': 'errors.design.persona_collision',
  'design.persona_publish_conflict': 'errors.design.persona_publish_conflict',
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
  const detail = typeof error.details === 'string' ? error.details.trim() : '';
  return detail && key ? `${summary} — ${detail}` : summary;
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
  /** Stable caller-owned key reused when retrying an idempotent mutation. */
  idempotencyKey?: string;
  /** Cancels requests superseded by a newer route, poll, or mutation refresh. */
  signal?: AbortSignal;
}

export async function api<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
  opts: ApiOpts = {},
): Promise<T> {
  const init: RequestInit = { method };
  if (opts.signal !== undefined) init.signal = opts.signal;
  const headers = new Headers();
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }
  if (opts.idempotencyKey !== undefined) headers.set('Idempotency-Key', opts.idempotencyKey);
  if ([...headers].length > 0) init.headers = headers;
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
export async function getProjectExecutorAgents(projectId: number, signal?: AbortSignal): Promise<AgentKind[]> {
  const [project, executors] = await Promise.all([
    api<Project>(`/api/projects/${projectId}`, 'GET', undefined, { signal }),
    api<ExecutorLite[]>('/api/executors', 'GET', undefined, { signal }),
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
