/**
 * web/routes/external-issues —— 项目外部 issue 来源配置、手动获取、忽略与确认导入。
 * 配置写操作限项目属主；获取/忽略/导入属于项目协作操作，成员可用。
 */
import type { Database } from 'bun:sqlite';
import { projectAgentSupport } from '../../core/executors';
import {
  ExternalIssueStore,
  type ExternalIssueIdentityInput,
} from '../../core/external-issues';
import {
  parseAutoApproveLevel,
  type AgentKind,
  type ExternalIssueProvider,
  type ExternalIssueSourceConfig,
  type IssueCategory,
  type Project,
  type ProjectModule,
} from '../../core/types';
import type { ExecutorDriver } from '../../executor/driver';
import {
  externalIssueSourceKey,
  type ExternalIssueFetch,
  ExternalIssueProviderError,
  fetchOpenExternalIssues,
  normalizeInstanceUrl,
  parseGitRemoteUrl,
} from '../../issues/external-provider';
import { getProject, type IssueEngine, type ImplMode } from '../../issues/engine';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';
import { parseIssueGitPatch } from './issues';

type ExternalIssueGitDriver = Pick<ExecutorDriver, 'git'>;

export interface ExternalIssuesRoutesDeps {
  db: Database;
  engine: IssueEngine;
  driverForProject(project: Project): ExternalIssueGitDriver;
  modules?: { listByProject(projectId: number): ProjectModule[] };
  fetchImpl?: ExternalIssueFetch;
}

const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

class DuplicateExternalIssueError extends Error {}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json().catch(() => null);
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function fail(code: string, fallback: string, status: number, details?: unknown): Response {
  return json(apiError(code, fallback, status, {}, details), status);
}

function redactSecret(value: unknown, secret: string | null): unknown {
  if (!secret || typeof value !== 'string') return value;
  return value.replaceAll(secret, '[已隐藏]');
}

function projectOf(db: Database, raw: string | undefined): Project | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? getProject(db, id) ?? null : null;
}

async function remoteUrl(
  deps: ExternalIssuesRoutesDeps,
  project: Project,
  remoteName: string,
): Promise<string> {
  const result = await deps.driverForProject(project).git(project.cwd, ['remote', 'get-url', remoteName]);
  if (result.code !== 0 || !result.out.trim()) {
    throw new Error((result.err || result.out).trim() || `找不到 Git remote：${remoteName}`);
  }
  return result.out.trim().split('\n')[0]!;
}

async function currentSource(
  deps: ExternalIssuesRoutesDeps,
  store: ExternalIssueStore,
  project: Project,
): Promise<ExternalIssueSourceConfig | Response> {
  const source = store.source(project.id);
  if (!source) return fail('external_issue.source_required', '请先配置外部 issue 来源', 409);
  try {
    const current = parseGitRemoteUrl(await remoteUrl(deps, project, source.remoteName));
    if (current.safeUrl !== source.remoteUrl) {
      return fail(
        'external_issue.remote_changed',
        '绑定的 Git remote 已变化，请在项目配置中重新保存外部 issue 来源',
        409,
      );
    }
  } catch (error) {
    return fail(
      'external_issue.remote_unavailable',
      '无法读取绑定的 Git remote',
      409,
      error instanceof Error ? error.message : String(error),
    );
  }
  return source;
}

function identity(
  body: Record<string, unknown>,
  source: ExternalIssueSourceConfig,
  userId: number,
): ExternalIssueIdentityInput | string {
  const externalId = typeof body.externalId === 'string' ? body.externalId.trim() : '';
  const externalNumber = typeof body.externalNumber === 'string' ? body.externalNumber.trim() : '';
  const externalUrl = typeof body.externalUrl === 'string' ? body.externalUrl.trim() : '';
  if (!externalId || externalId.length > 200) return 'externalId 必须是 1-200 字符的字符串';
  if (!externalNumber || externalNumber.length > 100) return 'externalNumber 必须是 1-100 字符的字符串';
  if (!externalUrl || externalUrl.length > 2_000) return 'externalUrl 必须是有效的远端 issue URL';
  try {
    const url = new URL(externalUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
    if (url.hostname.toLowerCase() !== new URL(source.instanceUrl).hostname.toLowerCase()) {
      return 'externalUrl 与当前绑定的远端实例不一致';
    }
  } catch {
    return 'externalUrl 必须是有效的远端 issue URL';
  }
  return {
    projectId: source.projectId,
    provider: source.provider,
    sourceKey: externalIssueSourceKey(source),
    externalId,
    externalNumber,
    externalUrl,
    createdBy: userId,
  };
}

export function externalIssuesRoutes(deps: ExternalIssuesRoutesDeps): RouteDef[] {
  const store = new ExternalIssueStore(deps.db);
  return [
    {
      method: 'GET',
      path: '/api/projects/:projectId/external-issues/remotes',
      auth: 'project-access',
      handler: async ({ params }) => {
        const project = projectOf(deps.db, params.projectId);
        if (!project) return fail('project.not_found', '项目不存在', 404);
        const driver = deps.driverForProject(project);
        const listed = await driver.git(project.cwd, ['remote']);
        if (listed.code !== 0) {
          return fail(
            'external_issue.remote_list_failed',
            '读取 Git remote 列表失败',
            409,
            (listed.err || listed.out).trim(),
          );
        }
        const remotes = [];
        for (const name of listed.out.split('\n').map((value) => value.trim()).filter(Boolean)) {
          try {
            const parsed = parseGitRemoteUrl(await remoteUrl(deps, project, name));
            const suggestedProvider: ExternalIssueProvider = parsed.host === 'github.com' ? 'github' : 'gitlab';
            remotes.push({
              name,
              url: parsed.safeUrl,
              host: parsed.host,
              suggestedProvider,
              suggestedInstanceUrl: normalizeInstanceUrl(suggestedProvider, parsed),
            });
          } catch {
            // 单条 remote 损坏不拖垮其余候选；它不会出现在可绑定列表里。
          }
        }
        return json({ ok: true, remotes });
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/external-issues/source',
      auth: 'project-access',
      handler: ({ params }) => {
        const project = projectOf(deps.db, params.projectId);
        if (!project) return fail('project.not_found', '项目不存在', 404);
        return json({ ok: true, source: store.sourceSummary(project.id) });
      },
    },
    {
      method: 'PUT',
      path: '/api/projects/:projectId/external-issues/source',
      auth: 'project-owner',
      handler: async ({ req, params }) => {
        const project = projectOf(deps.db, params.projectId);
        if (!project) return fail('project.not_found', '项目不存在', 404);
        const body = await readBody(req);
        const remoteName = typeof body.remoteName === 'string' ? body.remoteName.trim() : '';
        const provider: ExternalIssueProvider | null =
          body.provider === 'github' ? 'github' : body.provider === 'gitlab' ? 'gitlab' : null;
        if (!REMOTE_NAME_RE.test(remoteName)) {
          return fail('external_issue.remote_name_invalid', '请选择有效的 Git remote', 400);
        }
        if (!provider) return fail('external_issue.provider_invalid', 'provider 必须是 github 或 gitlab', 400);
        const suppliedToken = typeof body.apiToken === 'string' ? body.apiToken.trim() : '';
        if (suppliedToken.length > 2_000) {
          return fail('external_issue.token_too_long', 'API token 最多 2000 字符', 400);
        }
        if (body.clearApiToken === true && suppliedToken) {
          return fail('external_issue.token_action_conflict', '不能同时清除并设置 API token', 400);
        }
        try {
          const parsed = parseGitRemoteUrl(await remoteUrl(deps, project, remoteName));
          const instanceUrl = normalizeInstanceUrl(
            provider,
            parsed,
            typeof body.instanceUrl === 'string' ? body.instanceUrl : undefined,
          );
          store.saveSource({
            projectId: project.id,
            provider,
            remoteName,
            remoteUrl: parsed.safeUrl,
            instanceUrl,
            ...(body.clearApiToken === true
              ? { apiToken: null }
              : suppliedToken
                ? { apiToken: suppliedToken }
                : {}),
          });
          return json({ ok: true, source: store.sourceSummary(project.id) });
        } catch (error) {
          return fail(
            'external_issue.source_invalid',
            '无法保存外部 issue 来源',
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      method: 'DELETE',
      path: '/api/projects/:projectId/external-issues/source',
      auth: 'project-owner',
      handler: ({ params }) => {
        const project = projectOf(deps.db, params.projectId);
        if (!project) return fail('project.not_found', '项目不存在', 404);
        return json({ ok: true, removed: store.clearSource(project.id) });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/external-issues/fetch',
      auth: 'project-access',
      handler: async ({ params }) => {
        const project = projectOf(deps.db, params.projectId);
        if (!project) return fail('project.not_found', '项目不存在', 404);
        const source = await currentSource(deps, store, project);
        if (source instanceof Response) return source;
        try {
          const issues = await fetchOpenExternalIssues(source, deps.fetchImpl ?? fetch);
          const handled = new Set(
            store.listRecords(project.id, source.provider, externalIssueSourceKey(source))
              .map((record) => record.externalId),
          );
          return json({
            ok: true,
            source: store.sourceSummary(project.id),
            issues: issues.filter((issue) => !handled.has(issue.externalId)),
          });
        } catch (error) {
          const remote = error instanceof ExternalIssueProviderError ? error : null;
          return fail(
            'external_issue.fetch_failed',
            remote?.message ?? '获取远端 issue 失败',
            502,
            redactSecret(
              remote?.details ?? (error instanceof Error ? error.message : String(error)),
              source.apiToken,
            ),
          );
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/external-issues/ignore',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const project = projectOf(deps.db, params.projectId);
        if (!project) return fail('project.not_found', '项目不存在', 404);
        const source = await currentSource(deps, store, project);
        if (source instanceof Response) return source;
        const parsed = identity(await readBody(req), source, user!.id);
        if (typeof parsed === 'string') return fail('external_issue.identity_invalid', parsed, 400);
        const record = store.recordIgnored(parsed);
        if (!record) {
          return fail('external_issue.already_imported', '该远端 issue 已经导入', 409);
        }
        return json({ ok: true, record });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/external-issues/import',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const project = projectOf(deps.db, params.projectId);
        if (!project) return fail('project.not_found', '项目不存在', 404);
        const source = await currentSource(deps, store, project);
        if (source instanceof Response) return source;
        const body = await readBody(req);
        const external = identity(body, source, user!.id);
        if (typeof external === 'string') {
          return fail('external_issue.identity_invalid', external, 400);
        }
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) return fail('external_issue.title_required', '请填写导入后的 issue 标题', 400);
        const category: IssueCategory =
          body.category === 'debug' ? 'debug' : body.category === 'design' ? 'design' : 'task';
        const implMode: ImplMode = body.implMode === 'team' ? 'team' : 'seq';
        const agent: AgentKind = body.agent === 'codex' ? 'codex' : 'claude';
        const moduleRequested = body.moduleId !== undefined && body.moduleId !== null && body.moduleId !== '';
        const moduleId = Number(body.moduleId);
        const selectedModule = Number.isInteger(moduleId) && moduleId > 0
          ? deps.modules?.listByProject(project.id).find((module) => module.id === moduleId)
          : undefined;
        if (moduleRequested && !selectedModule) {
          return fail('external_issue.module_invalid', '所选模块不存在或不属于当前项目', 400);
        }
        const effectiveAgent = selectedModule?.agent ?? agent;
        const support = projectAgentSupport(deps.db, project.id, effectiveAgent);
        if (!support.ok) return fail('external_issue.agent_unavailable', support.error, 409);
        const git = parseIssueGitPatch(body, null, null);
        if (git.error) return fail('external_issue.git_invalid', git.error, 400);
        try {
          const issue = await deps.engine.createIssue(
            project.id,
            {
              title,
              body: typeof body.body === 'string' ? body.body : null,
              category,
              ...(selectedModule
                ? { moduleId: selectedModule.id }
                : typeof body.moduleName === 'string' && body.moduleName.trim()
                  ? { moduleName: body.moduleName.trim() }
                  : {}),
              implMode,
              agent,
              autoApprove: parseAutoApproveLevel(body.autoApprove) ?? 'medium',
              ...git.patch,
              createdBy: user!.id,
            },
            true,
            (created) => {
              if (!store.recordImportedOnce(external, created.id)) {
                throw new DuplicateExternalIssueError('该远端 issue 已经导入');
              }
            },
          );
          return json({ ok: true, issue });
        } catch (error) {
          if (error instanceof DuplicateExternalIssueError) {
            return fail('external_issue.already_imported', error.message, 409);
          }
          return fail(
            'external_issue.import_failed',
            '导入远端 issue 失败',
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
  ];
}
