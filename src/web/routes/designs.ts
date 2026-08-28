import type { Database } from 'bun:sqlite';
import { projectAgentSupport } from '../../core/executors';
import type { AgentKind, User } from '../../core/types';
import { validateDesignGraph } from '../../designs/graph';
import {
  DesignEngine,
  DesignEngineError,
  type Actor,
} from '../../designs/engine';
import { DesignPublisherError } from '../../designs/publisher';
import { DesignSyncCoordinator, DesignSyncError } from '../../designs/sync';
import { evaluateReadiness, type ReadinessInput, type ReadinessReport, type RiskOverride } from '../../designs/readiness';
import type { PersonaSummary } from '../../designs/personas';
import type { DesignRunView } from '../../designs/run-coordinator';
import {
  DESIGN_GRAPH_GRANULARITIES,
  normalizeDesignGraphGranularity,
  type DesignGraphDraft,
  type DesignPublicationResult,
  type DesignTask,
} from '../../designs/types';
import type { DesignStore } from '../../designs/store';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

export interface DesignsRoutesDeps {
  db: Database;
  engine: DesignEngine;
  store: DesignStore;
  sync: DesignSyncCoordinator;
  personas?: { listAvailable(projectId: number): PersonaSummary[] };
  runs?: { listScoped(projectId: number, designId: number, limit?: number): DesignRunView[] };
  assetCapability?: () => unknown;
}

function positiveInt(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function revision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function strictPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function canonicalPathId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function idempotencyKey(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : null;
}

function publicationIdempotencyKey(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && /^[A-Za-z0-9._:-]+$/.test(value)
    ? value
    : null;
}

function confirmationToken(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    ? value
    : null;
}

function hasExactKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(body).every((key) => allowed.has(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function publicationRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function ownerActor(db: Database, projectId: number, user: User | null): Actor | null {
  if (!user) return null;
  const owner = db.query<{ ownerUserId: number }, [number]>(
    'SELECT owner_user_id AS ownerUserId FROM projects WHERE id = ?',
  ).get(projectId);
  if (!owner || (user.role !== 'admin' && owner.ownerUserId !== user.id)) return null;
  return { id: `user:${user.id}`, role: 'owner' };
}

function invalidRequest(): Response {
  return json(apiError(
    'design.invalid_request',
    'The design request is invalid.',
    400,
  ), 400);
}

function designNotFound(): Response {
  return json(apiError('design.not_found', 'The design does not exist in this project.', 404), 404);
}

function designForbidden(): Response {
  return json(apiError(
    'design.forbidden',
    'This design action is not available to the current actor.',
    403,
  ), 403);
}

function engineError(error: unknown, extraParams: Record<string, unknown> = {}): Response {
  if (!(error instanceof DesignEngineError)) {
    return json(apiError(
      'design.operation_failed',
      'The design operation could not be completed.',
      500,
      extraParams,
      error instanceof Error ? error.message : String(error),
    ), 500);
  }
  const currentRevision = error.currentRevision;
  const mapped: Partial<Record<DesignEngineError['code'], { status: number; code: string; fallback: string }>> = {
    DESIGN_NOT_FOUND: { status: 404, code: 'design.not_found', fallback: 'The design does not exist in this project.' },
    DESIGN_PROJECT_NOT_FOUND: { status: 404, code: 'project.not_found', fallback: 'The project does not exist.' },
    DESIGN_MODULE_NOT_FOUND: { status: 400, code: 'design.module_invalid', fallback: 'The selected module does not exist in this project.' },
    DESIGN_MODULE_PROJECT_MISMATCH: { status: 400, code: 'design.module_invalid', fallback: 'The selected module does not exist in this project.' },
    DESIGN_MODULE_AGENT_MISMATCH: { status: 409, code: 'design.module_agent_mismatch', fallback: 'The selected module requires a different agent.' },
    DESIGN_AGENT_UNAVAILABLE: { status: 409, code: 'design.agent_unavailable', fallback: 'The selected agent is unavailable for this project.' },
    DESIGN_REVISION_CONFLICT: { status: 409, code: 'design.revision_conflict', fallback: 'The design changed. Refresh it and try again.' },
    DESIGN_ARCHIVED: { status: 409, code: 'design.archived', fallback: 'This design is archived and cannot be changed.' },
    DESIGN_STEWARD_REQUIRED: { status: 403, code: 'design.forbidden', fallback: 'This design action is not available to the current actor.' },
    DESIGN_OWNER_REQUIRED: { status: 403, code: 'design.forbidden', fallback: 'This design action is not available to the current actor.' },
    DESIGN_INVALID_STAGE_TRANSITION: { status: 409, code: 'design.stage_conflict', fallback: 'This action is not available in the current design stage.' },
    DESIGN_INVALID_FINDING: { status: 400, code: 'design.invalid_request', fallback: 'The design request is invalid.' },
    DESIGN_INVALID_GRAPH: { status: 400, code: 'design.graph_invalid', fallback: 'The proposed design graph is invalid.' },
    DESIGN_NOT_READY: { status: 409, code: 'design.not_ready', fallback: 'The design is not ready for this action.' },
    DESIGN_CONVERSATION_FAILED: { status: 502, code: 'design.conversation_failed', fallback: 'The design conversation could not be started.' },
    DESIGN_CONVERSATION_CLEANUP_FAILED: { status: 503, code: 'design.conversation_cleanup_failed', fallback: 'The design conversation could not be cleaned up. Retry the action.' },
    DESIGN_IDEMPOTENCY_CONFLICT: { status: 409, code: 'design.idempotency_conflict', fallback: 'This idempotency key already identifies a different design request.' },
    DESIGN_FORBIDDEN: { status: 403, code: 'design.forbidden', fallback: 'This design action is not available to the current actor.' },
  };
  const value = mapped[error.code] ?? {
    status: 500,
    code: 'design.operation_failed',
    fallback: 'The design operation could not be completed.',
  };
  const details = value.status >= 500 ? error.message : undefined;
  return json(apiError(
    value.code,
    value.fallback,
    value.status,
    { ...extraParams, ...(currentRevision === undefined ? {} : { currentRevision }) },
    details,
  ), value.status);
}

function publisherError(error: unknown): Response {
  if (!(error instanceof DesignPublisherError)) {
    return json(apiError(
      'design.operation_failed',
      'The design operation could not be completed.',
      500,
    ), 500);
  }
  const mapped: Record<DesignPublisherError['code'], { status: number; code: string; fallback: string }> = {
    DESIGN_OWNER_REQUIRED: { status: 403, code: 'design.forbidden', fallback: 'This design action is not available to the current actor.' },
    DESIGN_NOT_FOUND: { status: 404, code: 'design.not_found', fallback: 'The design does not exist in this project.' },
    DESIGN_REVISION_CONFLICT: { status: 409, code: 'design.revision_conflict', fallback: 'The design changed. Refresh it and try again.' },
    DESIGN_NOT_APPROVED: { status: 409, code: 'design.not_approved', fallback: 'Approve the current design graph before publishing it.' },
    DESIGN_INVALID_GRAPH: { status: 400, code: 'design.graph_invalid', fallback: 'The proposed design graph is invalid.' },
    DESIGN_NOT_READY: { status: 409, code: 'design.not_ready', fallback: 'The design is not ready for this action.' },
    DESIGN_CONFIRMATION_INVALID: { status: 400, code: 'design.confirmation_invalid', fallback: 'The publication confirmation is invalid.' },
    DESIGN_CONFIRMATION_EXPIRED: { status: 409, code: 'design.confirmation_expired', fallback: 'The publication confirmation expired. Request a new confirmation.' },
    DESIGN_CONFIRMATION_CONSUMED: { status: 409, code: 'design.confirmation_consumed', fallback: 'The publication confirmation has already been used.' },
    DESIGN_CONFIRMATION_MISMATCH: { status: 409, code: 'design.confirmation_mismatch', fallback: 'The publication confirmation no longer matches this design.' },
    DESIGN_IDEMPOTENCY_CONFLICT: { status: 409, code: 'design.idempotency_conflict', fallback: 'This idempotency key already identifies a different design request.' },
    DESIGN_ALREADY_PUBLISHED: { status: 409, code: 'design.already_published', fallback: 'This design revision has already been published.' },
  };
  const value = mapped[error.code];
  return json(apiError(
    value.code,
    value.fallback,
    value.status,
    error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision },
  ), value.status);
}

function syncError(error: unknown, fallbackCurrentRevision?: number): Response {
  if (!(error instanceof DesignSyncError)) {
    return json(apiError('design.operation_failed', 'The design operation could not be completed.', 500), 500);
  }
  const mapped: Record<DesignSyncError['code'], { status: number; code: string; fallback: string }> = {
    DESIGN_SYNC_NOT_FOUND: { status: 404, code: 'design.sync_not_found', fallback: 'The design sync does not exist.' },
    DESIGN_SYNC_STALE: { status: 409, code: 'design.sync_stale', fallback: 'The design sync is stale. Refresh the design and try again.' },
    DESIGN_SYNC_CONFLICT: { status: 409, code: 'design.sync_conflict', fallback: 'The design sync conflicts with the current Issue.' },
    DESIGN_SYNC_NOT_ACTIONABLE: { status: 409, code: 'design.sync_not_actionable', fallback: 'The design sync cannot perform this action.' },
    DESIGN_SYNC_INVALID: { status: 400, code: 'design.sync_invalid', fallback: 'The design sync data is invalid.' },
  };
  const value = mapped[error.code];
  const currentRevision = error.currentRevision ?? fallbackCurrentRevision;
  return json(apiError(
    value.code,
    value.fallback,
    value.status,
    error.code === 'DESIGN_SYNC_STALE' && currentRevision !== undefined ? { currentRevision } : {},
  ), value.status);
}

function publicationView(result: DesignPublicationResult) {
  return {
    publicationId: result.publicationId,
    designId: result.designId,
    projectId: result.projectId,
    revision: result.revision,
    graphDigest: result.graphDigest,
    status: result.status,
    issues: result.issues,
  };
}

function withIdempotencyKey(response: Response, key: string): Response {
  response.headers.set('Idempotency-Key', key);
  return response;
}

function designOf(store: DesignStore, params: Record<string, string>): DesignTask | null {
  const projectId = positiveInt(params.projectId);
  const designId = positiveInt(params.designId);
  if (!projectId || !designId) return null;
  const design = store.getTask(designId);
  return design?.projectId === projectId && !store.isTaskProvisional(design.id) ? design : null;
}

function strictAgent(value: unknown): AgentKind | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const SAFE_READINESS_EVENTS = new Set(['task_created', 'document_revised', 'graph_replaced', 'graph_approved']);
const SAFE_FINDING_EVENTS = new Set(['finding_appended']);
const FINDING_SEVERITIES = new Set(['info', 'warning', 'blocker']);

function boundedStrings(value: unknown, limit = 100): string[] | null {
  if (!Array.isArray(value) || value.length > limit
    || value.some((item) => typeof item !== 'string' || item.length > 8_000)) return null;
  return value.slice() as string[];
}

function safeReadinessReport(store: DesignStore, design: DesignTask): ReadinessReport {
  for (const event of store.listEvents(design.id).reverse()) {
    if (!SAFE_READINESS_EVENTS.has(event.kind) || !isRecord(event.data)) continue;
    const raw = event.data.readinessReport;
    if (!isRecord(raw) || !Array.isArray(raw.dimensions)) continue;
    const inputs: NonNullable<ReadinessInput['dimensions']> = {};
    let valid = raw.dimensions.length === 6;
    for (const item of raw.dimensions) {
      if (!isRecord(item) || typeof item.dimension !== 'string' || !READINESS_DIMENSIONS.has(item.dimension)
        || typeof item.score !== 'number' || !Number.isFinite(item.score)) {
        valid = false;
        break;
      }
      const evidencePaths = boundedStrings(item.evidencePaths);
      const missingItems = boundedStrings(item.missingItems);
      const nextQuestions = boundedStrings(item.nextQuestions);
      if (!evidencePaths || !missingItems || !nextQuestions) { valid = false; break; }
      inputs[item.dimension as keyof typeof inputs] = {
        score: item.score,
        evidencePaths,
        missingItems,
        nextQuestions,
      };
    }
    const hardBlockers = Array.isArray(raw.hardBlockers)
      ? raw.hardBlockers.filter((blocker): blocker is { id: string; dimension: keyof typeof inputs; code: string; message: string } => (
        isRecord(blocker)
        && typeof blocker.id === 'string'
        && typeof blocker.dimension === 'string'
        && READINESS_DIMENSIONS.has(blocker.dimension)
        && typeof blocker.code === 'string'
        && typeof blocker.message === 'string'
      )).map((blocker) => ({ ...blocker }))
      : [];
    if (valid) return evaluateReadiness({ dimensions: inputs, hardBlockers, threshold: design.readinessThreshold });
  }
  const snapshotScore = store.getRevision(design.id, design.currentRevision)?.readiness ?? 0;
  return evaluateReadiness({
    threshold: design.readinessThreshold,
    dimensions: Object.fromEntries([...READINESS_DIMENSIONS].map((dimension) => [dimension, {
      score: snapshotScore,
      evidencePaths: [],
      missingItems: [],
      nextQuestions: [],
    }])),
  });
}

function safeStructuredValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeStructuredValue(item, depth + 1));
  if (!isRecord(value)) return null;
  const blocked = /^(prompt|promptPath|lastError|syncError|error|stderr|cwd|worktreeCwd)$/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.test(key))
    .slice(0, 100)
    .map(([key, item]) => [key, safeStructuredValue(item, depth + 1)]));
}

function safeFindings(store: DesignStore, design: DesignTask) {
  const output: Array<Record<string, unknown>> = [];
  for (const event of store.listEvents(design.id)) {
    if (!SAFE_FINDING_EVENTS.has(event.kind) || !isRecord(event.data)
      || typeof event.data.persona !== 'string'
      || typeof event.data.sourceRevision !== 'number'
      || !Array.isArray(event.data.findings)) continue;
    for (const finding of event.data.findings.slice(0, 200)) {
      if (!isRecord(finding)
        || typeof finding.dimension !== 'string'
        || typeof finding.severity !== 'string'
        || !FINDING_SEVERITIES.has(finding.severity)
        || typeof finding.finding !== 'string') continue;
      const evidence = boundedStrings(finding.evidence);
      if (!evidence) continue;
      output.push({
        eventId: event.id,
        createdTs: event.ts,
        persona: event.data.persona,
        sourceRevision: event.data.sourceRevision,
        dimension: finding.dimension,
        severity: finding.severity,
        finding: finding.finding,
        evidence,
        proposedPatch: safeStructuredValue(finding.proposedPatch),
      });
    }
  }
  return output;
}

function safeDesign(design: DesignTask) {
  return {
    id: design.id,
    projectId: design.projectId,
    moduleId: design.moduleId,
    title: design.title,
    originalRequest: design.originalRequest,
    agent: design.agent,
    stage: design.stage,
    status: design.status,
    currentRevision: design.currentRevision,
    readinessThreshold: design.readinessThreshold,
    readinessOverride: design.readinessOverride,
    graphGranularity: design.graphGranularity,
    conversationId: design.conversationId,
    createdTs: design.createdTs,
    updatedTs: design.updatedTs,
  };
}

function safePersona(persona: PersonaSummary) {
  return {
    id: persona.id,
    key: persona.key,
    origin: persona.origin,
    displayName: persona.manifest.displayName,
    reviewSpecialty: persona.manifest.reviewSpecialty,
    compatibleAgents: [...persona.manifest.compatibleAgents],
    role: persona.manifest.role,
    contentHash: persona.contentHash,
    gitCommit: persona.gitCommit,
    approval: persona.approval,
  };
}

const READINESS_DIMENSIONS = new Set([
  'goal_clarity',
  'scope_boundaries',
  'solution_completeness',
  'dependencies_constraints',
  'acceptance_testability',
  'risks_unknowns',
]);

function readinessInput(value: unknown): ReadinessInput | null {
  if (!isRecord(value)) return null;
  if (value.threshold !== undefined && (typeof value.threshold !== 'number' || !Number.isFinite(value.threshold))) {
    return null;
  }
  if (value.dimensions !== undefined) {
    if (!isRecord(value.dimensions)) return null;
    for (const [key, dimension] of Object.entries(value.dimensions)) {
      if (!READINESS_DIMENSIONS.has(key)) return null;
      if (!isRecord(dimension)) return null;
      if (dimension.score !== undefined && (typeof dimension.score !== 'number' || !Number.isFinite(dimension.score))) {
        return null;
      }
      for (const key of ['evidencePaths', 'missingItems', 'nextQuestions'] as const) {
        if (dimension[key] !== undefined && !isStringArray(dimension[key])) return null;
      }
    }
  }
  if (value.hardBlockers !== undefined) {
    if (!Array.isArray(value.hardBlockers)) return null;
    for (const blocker of value.hardBlockers) {
      if (
        !isRecord(blocker)
        || typeof blocker.id !== 'string'
        || typeof blocker.dimension !== 'string'
        || !READINESS_DIMENSIONS.has(blocker.dimension)
        || typeof blocker.code !== 'string'
        || typeof blocker.message !== 'string'
      ) return null;
    }
  }
  return value as ReadinessInput;
}

function graphInput(value: unknown): DesignGraphDraft | null {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  for (const node of value.nodes) {
    if (
      !isRecord(node)
      || typeof node.nodeId !== 'string'
      || !node.nodeId.trim()
      || typeof node.title !== 'string'
      || !node.title.trim()
      || (node.ordinal !== undefined && (!Number.isSafeInteger(node.ordinal) || (node.ordinal as number) < 0))
      || (node.issueId !== undefined && node.issueId !== null && strictPositiveInt(node.issueId) === null)
      || (
        node.lastSyncedRevision !== undefined
        && node.lastSyncedRevision !== null
        && (typeof node.lastSyncedRevision !== 'number'
          || !Number.isSafeInteger(node.lastSyncedRevision)
          || node.lastSyncedRevision < 0)
      )
    ) return null;
    for (const key of [
      'scope',
      'nonGoals',
      'dependencies',
      'implementationNotes',
      'acceptanceCriteria',
      'testRecommendations',
      'evidenceRequirements',
    ] as const) {
      if (node[key] !== undefined && !isStringArray(node[key])) return null;
    }
    if (node.goal !== undefined && typeof node.goal !== 'string') return null;
    if (node.implMode !== undefined && typeof node.implMode !== 'string') return null;
  }
  for (const edge of value.edges) {
    if (
      !isRecord(edge)
      || typeof edge.fromNodeId !== 'string'
      || typeof edge.toNodeId !== 'string'
      || (edge.kind !== undefined && typeof edge.kind !== 'string')
    ) return null;
  }
  return value as unknown as DesignGraphDraft;
}

function riskOverride(value: unknown, actor: Actor): RiskOverride | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const override = value as Partial<RiskOverride>;
  if (
    typeof override.reason !== 'string'
    || !override.reason.trim()
    || !Array.isArray(override.acceptedBlockerIds)
    || override.acceptedBlockerIds.some((id) => typeof id !== 'string')
  ) return null;
  return {
    ownerActor: actor.id,
    reason: override.reason,
    timestamp: Date.now(),
    acceptedBlockerIds: override.acceptedBlockerIds.slice(),
  };
}

export function designsRoutes(deps: DesignsRoutesDeps): RouteDef[] {
  const { db, engine, store, sync } = deps;
  const withDesign = async (
    params: Record<string, string>,
    operation: (design: DesignTask) => Response | Promise<Response>,
  ): Promise<Response> => {
    const design = designOf(store, params);
    return design ? operation(design) : designNotFound();
  };

  const workbench = (design: DesignTask, user: User | null) => db.transaction(() => {
    const task = store.getTask(design.id);
    if (!task || task.projectId !== design.projectId || task.currentRevision !== design.currentRevision) {
      throw new Error('design aggregate changed during read');
    }
    const snapshot = store.getRevision(task.id, task.currentRevision);
    if (!snapshot) throw new Error('current design revision is missing');
    const graphValidation = validateDesignGraph(snapshot.graph);
    const readinessReport = safeReadinessReport(store, task);
    const syncs = sync.listSyncs(task.id);
    const syncByLink = new Map(syncs.map((item) => [item.linkId, item]));
    const linkedIssues = store.listPrimaryIssueLinks(task.id).map((link) => {
      const issue = db.query<{ title: string; status: string }, [number, number]>(
        'SELECT title, status FROM issues WHERE id = ? AND project_id = ?',
      ).get(link.issueId, task.projectId);
      const latestSync = syncByLink.get(link.id);
      return {
        linkId: link.id,
        nodeId: link.nodeId,
        issueId: link.issueId,
        title: issue?.title ?? link.baselineContract.title,
        status: issue?.status ?? 'unavailable',
        sourceRevision: link.sourceRevision,
        lastSyncedRevision: link.lastSyncedRevision,
        syncState: link.syncState,
        latestSync: latestSync ? {
          targetRevision: latestSync.targetRevision,
          state: latestSync.state,
          executionSyncId: latestSync.executionSyncId,
          decisionState: latestSync.decisionState,
          fields: latestSync.fields,
          recovery: latestSync.recovery,
        } : null,
      };
    });
    const owner = ownerActor(db, task.projectId, user) !== null;
    const publications = store.listPublications(task.id).map((publication) => ({
      publicationId: publication.id,
      designId: publication.designTaskId,
      projectId: publication.projectId,
      revision: publication.revision,
      graphDigest: publication.graphDigest,
      status: publication.status,
      createdTs: publication.createdTs,
      updatedTs: publication.updatedTs,
    }));
    const recentRuns = deps.runs?.listScoped(task.projectId, task.id, 20)
      ?? store.listAgentRunGroups(task.id, 20).map((group) => ({
        id: group.id,
        designId: group.designTaskId,
        projectId: group.projectId,
        mode: group.mode,
        sourceRevision: group.sourceRevision,
        status: group.status,
        personas: [...group.personaKeys],
        cancelRequested: group.cancelRequested,
        failureCode: group.failureCode,
        createdTs: group.createdTs,
        startedTs: group.startedTs,
        finishedTs: group.finishedTs,
        updatedTs: group.updatedTs,
      }));
    const claude = projectAgentSupport(db, task.projectId, 'claude');
    const codex = projectAgentSupport(db, task.projectId, 'codex');
    return {
      design: safeDesign(task),
      revision: {
        revision: snapshot.revision,
        documentJson: safeStructuredValue(snapshot.documentJson),
        documentMarkdown: snapshot.documentMarkdown,
        readiness: snapshot.readiness,
        createdTs: snapshot.createdTs,
      },
      readinessReport,
      graph: snapshot.graph,
      graphValidation: {
        valid: graphValidation.valid,
        errors: graphValidation.errors.map((error) => safeStructuredValue(error)),
      },
      findings: safeFindings(store, task),
      linkedIssues,
      enabledPersonas: (deps.personas?.listAvailable(task.projectId) ?? [])
        .filter((persona) => persona.enabled)
        .map(safePersona),
      latestRun: recentRuns[0] ?? null,
      recentRuns,
      publications,
      permissions: {
        owner,
        canEdit: owner && task.status === 'active',
        canRun: owner && task.status === 'active',
        canApproveGraph: owner
          && task.status === 'active'
          && task.stage === 'graph_draft'
          && graphValidation.valid
          && readinessReport.aggregate >= readinessReport.threshold
          && (readinessReport.hardBlockers.length === 0 || task.readinessOverride),
        canPublish: owner && task.status === 'active' && task.stage === 'approved',
        canResolveSync: owner && task.status === 'active',
        canManagePersonas: owner,
      },
      capabilities: {
        agents: { claude: claude.ok, codex: codex.ok },
        graphGranularities: [...DESIGN_GRAPH_GRANULARITIES],
        runModes: task.stage === 'goal_setting'
          ? ['goal']
          : task.stage === 'solution_draft'
            ? ['solution', 'review']
            : task.stage === 'review'
              ? ['review', 'graph']
              : task.stage === 'graph_draft' ? ['graph'] : [],
        visualAssets: safeStructuredValue(deps.assetCapability?.() ?? { available: false }),
      },
    };
  })();

  return [
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs',
      auth: 'project-access',
      handler: ({ params }) => {
        const projectId = positiveInt(params.projectId);
        return projectId ? json({ ok: true, designs: store.listTasks(projectId) }) : invalidRequest();
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const projectId = positiveInt(params.projectId);
        const body = await readBody(req);
        if (!projectId || !body) return invalidRequest();
        const actor = ownerActor(db, projectId, user);
        if (!actor) return designForbidden();
        const headerKey = req.headers.get('idempotency-key');
        let requestKey: string;
        if (headerKey !== null) {
          const parsed = idempotencyKey(headerKey);
          if (!parsed) return invalidRequest();
          requestKey = parsed;
        } else if (body.requestKey !== undefined) {
          const parsed = idempotencyKey(body.requestKey);
          if (!parsed) return invalidRequest();
          requestKey = parsed;
        } else {
          requestKey = crypto.randomUUID();
        }
        const agent = strictAgent(body.agent);
        if (!agent) {
          return json(apiError('design.agent_invalid', 'Choose Claude or Codex as the design agent.', 400), 400);
        }
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const originalRequest = typeof body.originalRequest === 'string' ? body.originalRequest : '';
        if (!title || !originalRequest.trim()) return invalidRequest();
        let moduleId: number | null | undefined;
        if (body.moduleId === null || body.moduleId === undefined) {
          moduleId = body.moduleId as null | undefined;
        } else {
          moduleId = strictPositiveInt(body.moduleId);
          if (!moduleId) return invalidRequest();
        }
        if (
          body.readinessThreshold !== undefined
          && (typeof body.readinessThreshold !== 'number'
            || !Number.isFinite(body.readinessThreshold)
            || body.readinessThreshold < 0
            || body.readinessThreshold > 100)
        ) return invalidRequest();
        if (
          body.graphGranularity !== undefined
          && (typeof body.graphGranularity !== 'string' || !body.graphGranularity.trim())
        ) return invalidRequest();
        const support = projectAgentSupport(db, projectId, agent);
        if (!support.ok) {
          return json(apiError(
            'design.agent_unavailable',
            'The selected agent is unavailable for this project.',
            409,
            { agent, executor: support.executorName },
          ), 409);
        }
        try {
          const design = await engine.create(projectId, {
            idempotencyKey: requestKey,
            ...(moduleId === undefined ? {} : { moduleId }),
            title,
            originalRequest,
            agent,
            ...(typeof body.readinessThreshold === 'number'
              ? { readinessThreshold: body.readinessThreshold }
              : {}),
            ...(typeof body.graphGranularity === 'string'
              ? { graphGranularity: body.graphGranularity }
              : {}),
          }, actor);
          return withIdempotencyKey(json({ ok: true, design, idempotencyKey: requestKey }), requestKey);
        } catch (error) {
          return withIdempotencyKey(engineError(error, { idempotencyKey: requestKey }), requestKey);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs/:designId',
      auth: 'project-access',
      handler: ({ params }) => withDesign(params, (design) => json({ ok: true, design })),
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs/:designId/workbench',
      auth: 'project-access',
      handler: ({ params, user }) => withDesign(params, (design) => {
        try {
          return json({ ok: true, workbench: workbench(design, user) });
        } catch {
          return json(apiError(
            'design.operation_failed',
            'The design operation could not be completed.',
            500,
          ), 500);
        }
      }),
    },
    {
      method: 'PATCH',
      path: '/api/projects/:projectId/designs/:designId/granularity',
      auth: 'project-access',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const body = await readBody(req);
        if (!body || !hasExactKeys(body, ['expectedRevision', 'granularity'])) return invalidRequest();
        const expectedRevision = publicationRevision(body.expectedRevision);
        const granularity = normalizeDesignGraphGranularity(body.granularity);
        if (expectedRevision === null || granularity === null || body.granularity === 'issue') return invalidRequest();
        try {
          return json({
            ok: true,
            design: engine.updateGranularity(design.id, { expectedRevision, granularity }, actor),
          });
        } catch (error) {
          return engineError(error);
        }
      }),
    },
    {
      method: 'PATCH',
      path: '/api/projects/:projectId/designs/:designId',
      auth: 'project-access',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const body = await readBody(req);
        const expectedRevision = revision(body?.expectedRevision);
        if (!body || expectedRevision === null) return invalidRequest();
        const title = body.title;
        const originalRequest = body.originalRequest;
        if (
          (title === undefined && originalRequest === undefined)
          || (title !== undefined && (typeof title !== 'string' || !title.trim()))
          || (originalRequest !== undefined && (typeof originalRequest !== 'string' || !originalRequest.trim()))
        ) return invalidRequest();
        try {
          const updated = await engine.updateBrief(design.id, {
            expectedRevision,
            ...(typeof title === 'string' ? { title: title.trim() } : {}),
            ...(typeof originalRequest === 'string' ? { originalRequest } : {}),
          }, actor);
          return json({ ok: true, design: updated });
        } catch (error) {
          return engineError(error);
        }
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs/:designId/confirm-goal',
      auth: 'project-access',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const body = await readBody(req);
        const expectedRevision = revision(body?.expectedRevision);
        if (expectedRevision === null) return invalidRequest();
        try {
          return json({
            ok: true,
            design: await engine.confirmGoal(design.id, { expectedRevision }, actor),
          });
        } catch (error) {
          return engineError(error);
        }
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs/:designId/reviews',
      auth: 'project-access',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const body = await readBody(req);
        const expectedRevision = revision(body?.expectedRevision);
        if (expectedRevision === null) return invalidRequest();
        const personas = body?.personas;
        if (
          personas !== undefined
          && (!Array.isArray(personas) || personas.length === 0
            || personas.some((persona) => typeof persona !== 'string' || !persona.trim()))
        ) return invalidRequest();
        try {
          const updated = await engine.queueReview(design.id, {
            expectedRevision,
            ...(Array.isArray(personas) ? { personas: personas.map((persona) => (persona as string).trim()) } : {}),
          }, actor);
          return json({ ok: true, queued: true, design: updated });
        } catch (error) {
          return engineError(error);
        }
      }),
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs/:designId/readiness',
      auth: 'project-access',
      handler: ({ params }) => withDesign(params, (design) => {
        const snapshot = store.getRevision(design.id, design.currentRevision);
        return json({
          ok: true,
          readiness: {
            score: snapshot?.readiness ?? 0,
            threshold: design.readinessThreshold,
            override: design.readinessOverride,
            revision: design.currentRevision,
          },
        });
      }),
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs/:designId/graph',
      auth: 'project-access',
      handler: ({ params }) => withDesign(params, (design) => json({ ok: true, graph: store.getGraph(design.id) })),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs/:designId/graph/publish-confirmation',
      auth: 'project-owner',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const body = await readBody(req);
        if (!body || !hasExactKeys(body, ['expectedRevision'])) return invalidRequest();
        const expectedRevision = publicationRevision(body.expectedRevision);
        if (expectedRevision === null) return invalidRequest();
        try {
          return json({
            ok: true,
            confirmation: engine.issuePublishConfirmation(design.id, { expectedRevision }, actor),
          });
        } catch (error) {
          return publisherError(error);
        }
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs/:designId/graph/publish',
      auth: 'project-owner',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const key = publicationIdempotencyKey(req.headers.get('idempotency-key'));
        const body = await readBody(req);
        if (!key || !body || !hasExactKeys(body, ['expectedRevision', 'confirmationToken'])) {
          return invalidRequest();
        }
        const expectedRevision = publicationRevision(body.expectedRevision);
        const token = confirmationToken(body.confirmationToken);
        if (expectedRevision === null || token === null) return invalidRequest();
        try {
          const publication = await engine.publishGraph(design.id, {
            expectedRevision,
            confirmationToken: token,
            idempotencyKey: key,
          }, actor);
          return withIdempotencyKey(json({ ok: true, publication: publicationView(publication) }), key);
        } catch (error) {
          return withIdempotencyKey(publisherError(error), key);
        }
      }),
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs/:designId/publications',
      auth: 'project-access',
      handler: ({ params }) => withDesign(params, (design) => {
        try {
          return json({
            ok: true,
            publications: engine.listPublications(design.id).map(publicationView),
          });
        } catch (error) {
          return publisherError(error);
        }
      }),
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs/:designId/syncs',
      auth: 'project-access',
      handler: ({ params }) => withDesign(params, (design) => {
        try {
          return json({ ok: true, syncs: sync.listSyncs(design.id) });
        } catch (error) {
          return syncError(error);
        }
      }),
    },
    ...(['apply', 'ignore', 'supplement'] as const).map((decision): RouteDef => ({
      method: 'POST',
      path: `/api/projects/:projectId/designs/:designId/syncs/:syncId/${decision}`,
      auth: 'project-owner',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const syncId = canonicalPathId(params.syncId);
        if (syncId === null) return syncError(new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'sync not found'));
        const body = await readBody(req);
        if (!body || !hasExactKeys(body, ['expectedRevision'])) return invalidRequest();
        const expectedRevision = publicationRevision(body.expectedRevision);
        if (expectedRevision === null) return invalidRequest();
        const key = decision === 'supplement'
          ? publicationIdempotencyKey(req.headers.get('idempotency-key'))
          : null;
        if (decision === 'supplement' && !key) return invalidRequest();
        if (expectedRevision !== design.currentRevision) {
          return syncError(new DesignSyncError(
            'DESIGN_SYNC_STALE',
            'design revision changed',
            design.currentRevision,
          ));
        }
        try {
          const result = await sync.decideScoped(
            design.id,
            syncId,
            expectedRevision,
            decision,
            user!.id,
          );
          const response = json({ ok: true, sync: result });
          return key ? withIdempotencyKey(response, key) : response;
        } catch (error) {
          const response = syncError(error, design.currentRevision);
          return key ? withIdempotencyKey(response, key) : response;
        }
      }),
    })),
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs/:designId/syncs/:syncId/recovery',
      auth: 'project-owner',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const syncId = canonicalPathId(params.syncId);
        if (syncId === null) return syncError(new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'sync not found'));
        const body = await readBody(req);
        if (!body || !hasExactKeys(body, ['expectedRevision', 'resolution'])) return invalidRequest();
        const expectedRevision = publicationRevision(body.expectedRevision);
        const resolution = body.resolution;
        if (expectedRevision === null || (resolution !== 'confirm_delivered' && resolution !== 'retry')) {
          return invalidRequest();
        }
        if (expectedRevision !== design.currentRevision) {
          return syncError(new DesignSyncError(
            'DESIGN_SYNC_STALE',
            'design revision changed',
            design.currentRevision,
          ));
        }
        try {
          return json({
            ok: true,
            sync: await sync.resolveScopedRecovery(design.id, syncId, expectedRevision, resolution),
          });
        } catch (error) {
          return syncError(error, design.currentRevision);
        }
      }),
    },
    {
      method: 'PUT',
      path: '/api/projects/:projectId/designs/:designId/graph',
      auth: 'project-access',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const body = await readBody(req);
        const expectedRevision = revision(body?.expectedRevision);
        const graph = graphInput(body?.graph);
        if (expectedRevision === null || !graph) return invalidRequest();
        try {
          const updated = await engine.proposeGraph(design.id, { expectedRevision, graph }, actor);
          return json({ ok: true, queued: true, design: updated, graph: store.getGraph(design.id) });
        } catch (error) {
          return engineError(error);
        }
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs/:designId/approve-graph',
      auth: 'project-access',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const body = await readBody(req);
        const expectedRevision = revision(body?.expectedRevision);
        const readiness = readinessInput(body?.readiness);
        if (expectedRevision === null || !readiness) return invalidRequest();
        const override = body?.override === undefined ? undefined : riskOverride(body.override, actor);
        if (body?.override !== undefined && !override) return invalidRequest();
        try {
          const approved = await engine.approveGraph(design.id, {
            expectedRevision,
            readiness,
            ...(override ? { override } : {}),
          }, actor);
          return json({ ok: true, design: approved });
        } catch (error) {
          return engineError(error);
        }
      }),
    },
    ...(['start-execution', 'complete-execution'] as const).map((action): RouteDef => ({
      method: 'POST',
      path: `/api/projects/:projectId/designs/:designId/${action}`,
      auth: 'project-access',
      handler: async ({ req, params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        const body = await readBody(req);
        const expectedRevision = revision(body?.expectedRevision);
        if (expectedRevision === null) return invalidRequest();
        try {
          const updated = action === 'start-execution'
            ? await engine.startExecution(design.id, { expectedRevision }, actor)
            : await engine.completeExecution(design.id, { expectedRevision }, actor);
          return json({ ok: true, design: updated });
        } catch (error) {
          return engineError(error);
        }
      }),
    })),
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs/:designId/events',
      auth: 'project-access',
      handler: ({ params, url }) => withDesign(params, (design) => {
        const rawAfter = url.searchParams.get('after');
        const after = rawAfter === null ? 0 : Number(rawAfter);
        if (!Number.isInteger(after) || after < 0) return invalidRequest();
        return json({ ok: true, events: store.listEvents(design.id, after) });
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs/:designId/archive',
      auth: 'project-access',
      handler: ({ params, user }) => withDesign(params, async (design) => {
        const actor = ownerActor(db, design.projectId, user);
        if (!actor) return designForbidden();
        try {
          return json({ ok: true, design: await engine.archive(design.id, actor) });
        } catch (error) {
          return engineError(error);
        }
      }),
    },
  ];
}
