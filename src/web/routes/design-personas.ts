import type { Database } from 'bun:sqlite';
import {
  addMarket,
  listMarkets,
  removeMarket,
  syncMarkets,
  updateMarket,
} from '../../core/skill-market';
import {
  DesignPersonaRegistry,
  PersonaRegistryError,
  type PersonaProjectDriver,
} from '../../designs/personas';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

interface ProjectPersonaScope {
  id: number;
  cwd: string;
}

export interface DesignPersonaRoutesDeps {
  db: Database;
  registry: DesignPersonaRegistry;
  driverForProject(project: ProjectPersonaScope): PersonaProjectDriver;
  marketBaseDir?: string;
}

function projectId(params: Record<string, string>): number {
  return Number(params.projectId);
}

function project(db: Database, id: number): ProjectPersonaScope | null {
  return db.query<ProjectPersonaScope, [number]>(
    'SELECT id, cwd FROM projects WHERE id = ?',
  ).get(id) ?? null;
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const parsed = await req.json().catch(() => null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function personaError(error: unknown): Response {
  if (!(error instanceof PersonaRegistryError)) {
    return json(apiError(
      'design.persona_operation_failed',
      'The persona operation could not be completed.',
      500,
    ), 500);
  }
  const mapping: Record<string, { status: number; code: string; fallback: string }> = {
    DESIGN_PERSONA_NOT_FOUND: { status: 404, code: 'design.persona_not_found', fallback: 'The persona does not exist in this project.' },
    DESIGN_PERSONA_SOURCE_NOT_FOUND: { status: 404, code: 'design.persona_source_not_found', fallback: 'The persona source does not exist.' },
    DESIGN_PERSONA_AGENT_INCOMPATIBLE: { status: 409, code: 'design.persona_incompatible', fallback: 'The persona is incompatible with the selected agent.' },
    DESIGN_PERSONA_NOT_APPROVED: { status: 409, code: 'design.persona_approval_required', fallback: 'Approve the current persona content before enabling it.' },
    DESIGN_PERSONA_NOT_ENABLED: { status: 409, code: 'design.persona_approval_required', fallback: 'Approve and enable the current persona before using it.' },
    DESIGN_PERSONA_HASH_MISMATCH: { status: 409, code: 'design.persona_hash_stale', fallback: 'The persona content changed. Review the current version and try again.' },
    DESIGN_PERSONA_COLLISION: { status: 409, code: 'design.persona_collision', fallback: 'Choose a specific persona source because this slug is ambiguous.' },
    DESIGN_PERSONA_SECURE_READ_UNSUPPORTED: { status: 409, code: 'design.persona_discovery_failed', fallback: 'This executor cannot securely discover project personas.' },
    DESIGN_PERSONA_SECURE_WRITE_UNSUPPORTED: { status: 409, code: 'design.persona_discovery_failed', fallback: 'This executor cannot securely publish project personas.' },
    DESIGN_PERSONA_PUBLISH_CONFLICT: { status: 409, code: 'design.persona_publish_conflict', fallback: 'A project persona with different content already exists.' },
  };
  const mapped = mapping[error.code] ?? {
    status: 400,
    code: error.code.includes('SOURCE') ? 'design.persona_source_invalid' : 'design.persona_invalid',
    fallback: error.code.includes('SOURCE') ? 'The persona source is invalid.' : 'The persona bundle is invalid.',
  };
  return json(apiError(mapped.code, mapped.fallback, mapped.status), mapped.status);
}

function sourceError(status = 400, notFound = false): Response {
  return json(apiError(
    notFound ? 'design.persona_source_not_found' : 'design.persona_source_invalid',
    notFound ? 'The persona source does not exist.' : 'The persona source is invalid.',
    status,
  ), status);
}

export function designPersonaRoutes(deps: DesignPersonaRoutesDeps): RouteDef[] {
  const { db, registry } = deps;
  return [
    {
      method: 'GET', path: '/api/projects/:projectId/personas', auth: 'project-access',
      handler: ({ params }) => json({ personas: registry.listAvailable(projectId(params)) }),
    },
    {
      method: 'GET', path: '/api/projects/:projectId/personas/market', auth: 'project-access',
      handler: async () => {
        try {
          return json({ personas: await registry.browseMarket(deps.marketBaseDir) });
        } catch (error) {
          return personaError(error);
        }
      },
    },
    {
      method: 'POST', path: '/api/projects/:projectId/personas/discover', auth: 'project-owner',
      handler: async ({ params }) => {
        const current = project(db, projectId(params));
        if (!current) return personaError(new PersonaRegistryError('DESIGN_PERSONA_NOT_FOUND', 'project missing'));
        try {
          const personas = await registry.discoverProject(current, deps.driverForProject(current));
          return json({ personas });
        } catch (error) {
          return personaError(error);
        }
      },
    },
    {
      method: 'POST', path: '/api/projects/:projectId/personas/publish', auth: 'project-owner',
      handler: async ({ req, params }) => {
        const value = await body(req);
        if (!value || typeof value.key !== 'string'
          || !onlyKeys(value, ['key', 'contentHash'])
          || (value.contentHash !== undefined && typeof value.contentHash !== 'string')) {
          return personaError(new PersonaRegistryError('DESIGN_PERSONA_INVALID_MANIFEST', 'bad request'));
        }
        try {
          const current = project(db, projectId(params));
          if (!current) return personaError(new PersonaRegistryError('DESIGN_PERSONA_NOT_FOUND', 'project missing'));
          return json({ persona: await registry.publishMarketToProject(
            current,
            value.key,
            value.contentHash as string | undefined,
            deps.driverForProject(current),
            deps.marketBaseDir,
          ) }, 201);
        } catch (error) {
          return personaError(error);
        }
      },
    },
    {
      method: 'PATCH', path: '/api/projects/:projectId/personas/:selector', auth: 'project-owner',
      handler: async ({ req, params, user }) => {
        const value = await body(req);
        if (!value
          || !onlyKeys(value, ['approveHash', 'enabled'])
          || (value.approveHash === undefined && value.enabled === undefined)
          || (value.approveHash !== undefined && typeof value.approveHash !== 'string')
          || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) {
          return personaError(new PersonaRegistryError('DESIGN_PERSONA_INVALID_MANIFEST', 'bad request'));
        }
        try {
          let persona = registry.findAvailable(projectId(params), params.selector!);
          if (typeof value.approveHash === 'string') {
            registry.approveHash(projectId(params), persona.id, value.approveHash, user!.id);
            persona = registry.findAvailable(projectId(params), params.selector!);
          }
          if (typeof value.enabled === 'boolean') {
            registry.setEnabled(projectId(params), persona.id, value.enabled);
          }
          return json({ persona: registry.findAvailable(projectId(params), params.selector!) });
        } catch (error) {
          return personaError(error);
        }
      },
    },
    {
      method: 'GET', path: '/api/admin/design-persona-markets', auth: 'admin',
      handler: () => json({ markets: listMarkets(db) }),
    },
    {
      method: 'POST', path: '/api/admin/design-persona-markets', auth: 'admin',
      handler: async ({ req }) => {
        const value = await body(req);
        if (!value || !onlyKeys(value, ['name', 'repo', 'subdir', 'note'])
          || typeof value.name !== 'string' || typeof value.repo !== 'string'
          || (value.subdir !== undefined && typeof value.subdir !== 'string')
          || (value.note !== undefined && typeof value.note !== 'string')) return sourceError();
        const result = addMarket(db, {
          name: value.name,
          repo: value.repo,
          ...(typeof value.subdir === 'string' ? { subdir: value.subdir } : {}),
          ...(typeof value.note === 'string' ? { note: value.note } : {}),
        });
        return result.ok ? json({ ok: true }, 201) : sourceError();
      },
    },
    {
      method: 'PATCH', path: '/api/admin/design-persona-markets/:name', auth: 'admin',
      handler: async ({ req, params }) => {
        const value = await body(req);
        if (!value || !onlyKeys(value, ['repo', 'subdir', 'note', 'enabled'])
          || Object.keys(value).length === 0
          || (value.repo !== undefined && typeof value.repo !== 'string')
          || (value.subdir !== undefined && typeof value.subdir !== 'string')
          || (value.note !== undefined && typeof value.note !== 'string')
          || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) return sourceError();
        const result = updateMarket(db, params.name!, {
          ...(typeof value.repo === 'string' ? { repo: value.repo } : {}),
          ...(typeof value.subdir === 'string' ? { subdir: value.subdir } : {}),
          ...(typeof value.note === 'string' ? { note: value.note } : {}),
          ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
        });
        return result.ok ? json({ ok: true }) : sourceError(result.error === '市场不存在' ? 404 : 400, result.error === '市场不存在');
      },
    },
    {
      method: 'DELETE', path: '/api/admin/design-persona-markets/:name', auth: 'admin',
      handler: ({ params }) => {
        const result = removeMarket(db, params.name!, deps.marketBaseDir);
        if (!result.ok) return sourceError(404, true);
        registry.removeMarketPersonas(params.name!);
        return json({ ok: true });
      },
    },
    {
      method: 'POST', path: '/api/admin/design-persona-markets/:name/sync', auth: 'admin',
      handler: async ({ params }) => {
        if (!listMarkets(db).some((market) => market.name === params.name)) return sourceError(404, true);
        const synced = await syncMarkets(db, { only: params.name, baseDir: deps.marketBaseDir });
        if (!synced.results[0]?.ok) {
          return json(apiError(
            'design.persona_market_sync_failed',
            'The persona market could not be synchronized.',
            502,
          ), 502);
        }
        try {
          await registry.approveMarketSnapshot(params.name!, deps.marketBaseDir);
          const personas = await registry.browseMarket(deps.marketBaseDir, params.name);
          return json({ ok: true, result: synced.results[0], personas });
        } catch (error) {
          return personaError(error);
        }
      },
    },
  ];
}
