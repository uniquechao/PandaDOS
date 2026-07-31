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

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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
  } catch {
    throw new ApiError('网络错误', 0);
  }
  if (r.status === 401 && !opts.silent401) onUnauthorized?.();
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new ApiError(j?.error ?? `HTTP ${r.status}`, r.status);
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
  } catch {
    throw new ApiError('网络错误', 0);
  }
  if (r.status === 401) onUnauthorized?.();
  const j = (await r.json().catch(() => null)) as (UploadResult & { error?: string }) | null;
  if (!r.ok || !j?.ok) throw new ApiError(j?.error ?? `上传失败(HTTP ${r.status})`, r.status);
  return j;
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
