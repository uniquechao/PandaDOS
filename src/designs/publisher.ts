import { createHash, randomBytes } from 'node:crypto';
import type {
  DesignIssueDraft,
  IssuePublicationBatchPort,
  IssuePublicationPostCommitOperation,
  IssuePublicationPostCommitOutboxPort,
  PreparedIssueDependency,
} from '../issues/engine';
import type { Actor } from './engine';
import {
  designGraphDigest,
  topologicalOrder,
  validateDesignGraph,
} from './graph';
import type {
  CommitDesignPublicationInput,
  DesignPublicationLinkInput,
} from './store';
import { DesignStore } from './store';
import type {
  DesignGraphNodeDraft,
  DesignIssueBaselineContract,
  DesignPublication,
  DesignPublicationResult,
  DesignPublishConfirmation,
  DesignPublishedIssue,
  DesignRevision,
  DesignTask,
} from './types';

const CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_ISSUE_BODY = 8_000;
const MAX_IDEMPOTENCY_KEY = 256;
const MAX_CONFIRMATION_TOKEN = 256;
const DEFAULT_POST_COMMIT_TIMEOUT_MS = 5_000;

export type DesignPublisherErrorCode =
  | 'DESIGN_OWNER_REQUIRED'
  | 'DESIGN_NOT_FOUND'
  | 'DESIGN_REVISION_CONFLICT'
  | 'DESIGN_NOT_APPROVED'
  | 'DESIGN_INVALID_GRAPH'
  | 'DESIGN_NOT_READY'
  | 'DESIGN_CONFIRMATION_INVALID'
  | 'DESIGN_CONFIRMATION_EXPIRED'
  | 'DESIGN_CONFIRMATION_CONSUMED'
  | 'DESIGN_CONFIRMATION_MISMATCH'
  | 'DESIGN_IDEMPOTENCY_CONFLICT'
  | 'DESIGN_ALREADY_PUBLISHED';

export class DesignPublisherError extends Error {
  constructor(
    readonly code: DesignPublisherErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'DesignPublisherError';
  }
}

export interface IssuePublishConfirmationInput {
  expectedRevision: number;
}

export interface PublishDesignGraphInput {
  expectedRevision: number;
  confirmationToken: string;
  idempotencyKey: string;
}

export interface DesignPublisherPort {
  issuePublishConfirmation(
    designId: number,
    expectedRevision: number,
    actor: Actor,
  ): DesignPublishConfirmation;
  publishGraph(
    designId: number,
    input: PublishDesignGraphInput,
    actor: Actor,
  ): Promise<DesignPublicationResult>;
  listPublications(designId: number): readonly DesignPublicationResult[];
}

export interface DesignPublisherDeps {
  store: DesignStore;
  issues: IssuePublicationBatchPort;
  now?: () => number;
  tokenFactory?: () => string;
  postCommitTimeoutMs?: number;
  executionRuns?: {
    requirePublishableIntentInTransaction(
      designId: number,
      revision: number,
      graphDigest: string,
    ): unknown;
    bindPublicationInTransaction(input: {
      projectId: number;
      designId: number;
      publicationId: number;
      revision: number;
      graphDigest: string;
      updatedTs: number;
    }): unknown;
  };
}

interface PublicationSnapshot {
  task: DesignTask;
  revision: DesignRevision;
  digest: string;
  contracts: DesignIssueBaselineContract[];
  drafts: DesignIssueDraft[];
  dependencies: PreparedIssueDependency[];
}

function actorKey(actor: Actor): string {
  return `${actor.role}:${actor.id}`;
}

function ownerUserId(actor: Actor): number | null {
  const match = actor.id.match(/(?:^|:)([1-9][0-9]*)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '- None' : items.map((item) => `- ${item}`).join('\n');
}

/** Stable, lossless human projection of the machine-readable publication baseline. */
export function renderDesignIssueBody(contract: Omit<DesignIssueBaselineContract, 'body'>): string {
  return [
    '## Goal',
    contract.goal,
    '',
    '## Background/source',
    '### Background',
    list(contract.background),
    '',
    '### Source sections',
    list(contract.sourceSections),
    '',
    '## Scope',
    list(contract.scope),
    '',
    '## Non-goals',
    list(contract.nonGoals),
    '',
    '## Implementation',
    list(contract.implementationNotes),
    '',
    '## Inputs/outputs',
    '### Inputs',
    list(contract.inputs),
    '',
    '### Outputs',
    list(contract.outputs),
    '',
    '## Dependencies',
    list(contract.dependencies),
    '',
    '## Acceptance criteria',
    list(contract.acceptanceCriteria),
    '',
    '## Tests',
    list(contract.testRecommendations),
    '',
    '## Required evidence',
    list(contract.evidenceRequirements),
    '',
    '## Completion report',
    list(contract.completionInstructions),
  ].join('\n');
}

function trimList(value: string[] | undefined): string[] {
  return (value ?? []).map((item) => item.trim());
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function baselineContract(
  task: DesignTask,
  revision: DesignRevision,
  node: DesignGraphNodeDraft,
): DesignIssueBaselineContract {
  const base: Omit<DesignIssueBaselineContract, 'body'> = {
    schemaVersion: 1,
    designId: task.id,
    revision: revision.revision,
    nodeId: node.nodeId,
    title: node.title.trim(),
    goal: node.goal!.trim(),
    background: trimList(node.background),
    sourceSections: trimList(node.sourceSections),
    scope: trimList(node.scope),
    nonGoals: trimList(node.nonGoals),
    inputs: trimList(node.inputs),
    outputs: trimList(node.outputs),
    dependencies: trimList(node.dependencies).sort(compareText),
    implementationNotes: trimList(node.implementationNotes),
    moduleId: node.moduleId ?? task.moduleId,
    runtime: node.runtime!,
    agent: node.agent ?? task.agent,
    complexity: node.complexity!,
    complexityRationale: trimList(node.complexityRationale),
    acceptanceCriteria: trimList(node.acceptanceCriteria),
    testRecommendations: trimList(node.testRecommendations),
    evidenceRequirements: trimList(node.evidenceRequirements),
    completionInstructions: trimList(node.completionInstructions),
    implMode: node.implMode!,
  };
  return { ...base, body: renderDesignIssueBody(base) };
}

export class DesignPublisher implements DesignPublisherPort {
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly postCommitTimeoutMs: number;

  constructor(private readonly deps: DesignPublisherDeps) {
    this.now = deps.now ?? Date.now;
    this.tokenFactory = deps.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
    this.postCommitTimeoutMs = Math.max(
      1,
      Math.trunc(deps.postCommitTimeoutMs ?? DEFAULT_POST_COMMIT_TIMEOUT_MS),
    );
  }

  issuePublishConfirmation(
    designId: number,
    expectedRevision: number,
    actor: Actor,
  ): DesignPublishConfirmation {
    this.requireOwner(actor);
    const snapshot = this.approvedSnapshot(designId, expectedRevision, actor);
    const rawToken = this.tokenFactory();
    if (!rawToken || rawToken.length > MAX_CONFIRMATION_TOKEN || rawToken !== rawToken.trim()) {
      throw new DesignPublisherError('DESIGN_CONFIRMATION_INVALID', 'invalid confirmation token material');
    }
    const now = this.now();
    const expiresTs = now + CONFIRMATION_TTL_MS;
    this.deps.store.createPublishConfirmation({
      tokenHash: sha256(rawToken),
      designTaskId: designId,
      revision: expectedRevision,
      graphDigest: snapshot.digest,
      actorKey: actorKey(actor),
      expiresTs,
      createdTs: now,
    });
    return {
      designId,
      projectId: snapshot.task.projectId,
      revision: expectedRevision,
      graphDigest: snapshot.digest,
      token: rawToken,
      expiresTs,
      orderedNodes: snapshot.contracts.map((contract) => ({
        nodeId: contract.nodeId,
        title: contract.title,
        goal: contract.goal,
        scope: [...contract.scope],
        nonGoals: [...contract.nonGoals],
        inputs: [...contract.inputs],
        outputs: [...contract.outputs],
        dependencies: [...contract.dependencies],
        implementationNotes: [...contract.implementationNotes],
        resolvedModuleId: contract.moduleId,
        resolvedAgent: contract.agent,
        runtime: contract.runtime,
        complexity: contract.complexity,
        complexityRationale: [...contract.complexityRationale],
        implMode: contract.implMode,
        acceptanceCriteria: [...contract.acceptanceCriteria],
        testRecommendations: [...contract.testRecommendations],
        evidenceRequirements: [...contract.evidenceRequirements],
        completionInstructions: [...contract.completionInstructions],
        bodyDigest: sha256(contract.body),
      })),
      topologicalOrder: snapshot.contracts.map((contract) => contract.nodeId),
      dependencies: snapshot.dependencies.map(({ fromNodeId, toNodeId }) => ({ fromNodeId, toNodeId })),
      blockers: snapshot.revision.readiness < snapshot.task.readinessThreshold
        ? ['readiness_below_threshold']
        : [],
      readiness: {
        score: snapshot.revision.readiness,
        threshold: snapshot.task.readinessThreshold,
        override: snapshot.task.readinessOverride,
      },
    };
  }

  async publishGraph(
    designId: number,
    input: PublishDesignGraphInput,
    actor: Actor,
  ): Promise<DesignPublicationResult> {
    this.requireOwner(actor);
    this.requireIdempotencyKey(input.idempotencyKey);
    const task = this.deps.store.getTask(designId);
    if (!task) throw new DesignPublisherError('DESIGN_NOT_FOUND', `design task not found: ${designId}`);
    const keyActor = actorKey(actor);

    // Replay is intentionally first: a committed request does not need its already-consumed token.
    const replay = this.deps.store.getPublicationByIdempotency(task.projectId, input.idempotencyKey);
    if (replay) {
      const replayRevision = this.deps.store.getRevision(designId, input.expectedRevision);
      let replayDigest: string | null = null;
      if (replayRevision && validateDesignGraph(replayRevision.graph).valid) {
        replayDigest = designGraphDigest(designId, input.expectedRevision, replayRevision.graph);
      }
      if (replay.designTaskId !== designId
        || replay.revision !== input.expectedRevision
        || replay.actorKey !== keyActor
        || replayDigest !== replay.graphDigest) {
        throw new DesignPublisherError(
          'DESIGN_IDEMPOTENCY_CONFLICT',
          'idempotency key was already used for a different publication request',
        );
      }
      await this.drainPublication(replay.id);
      return this.result(replay.id);
    }

    const snapshot = this.approvedSnapshot(designId, input.expectedRevision, actor);
    const alreadyPublished = this.deps.store.getPublicationByRevision(
      designId,
      input.expectedRevision,
      snapshot.digest,
    );
    if (alreadyPublished) {
      throw new DesignPublisherError('DESIGN_ALREADY_PUBLISHED', 'approved design revision was already published');
    }
    const tokenHash = this.validateConfirmation(input.confirmationToken, snapshot, keyActor);
    const prepared = await this.deps.issues.prepareDesignBatch(task.projectId, snapshot.drafts);
    let committed: DesignPublication | null = null;
    try {
      this.deps.issues.commitPreparedDesignBatch(prepared, snapshot.dependencies, (issuesByNodeId) => {
        try {
          this.deps.executionRuns?.requirePublishableIntentInTransaction(
            designId,
            input.expectedRevision,
            snapshot.digest,
          );
        } catch {
          throw new DesignPublisherError(
            'DESIGN_NOT_READY',
            'The approved execution workspace is not ready for publication.',
          );
        }
        const links: DesignPublicationLinkInput[] = snapshot.contracts.map((contract) => {
          const issue = issuesByNodeId.get(contract.nodeId);
          if (!issue) throw new Error(`publication Issue missing for node ${contract.nodeId}`);
          const baselineJson = JSON.stringify(contract);
          return {
            nodeId: contract.nodeId,
            issueId: issue.id,
            implMode: contract.implMode,
            baselineContract: contract,
            baselineContractDigest: sha256(baselineJson),
          };
        });
        const commitInput: CommitDesignPublicationInput = {
          designTaskId: designId,
          projectId: task.projectId,
          revision: input.expectedRevision,
          graphDigest: snapshot.digest,
          actorKey: keyActor,
          actorUserId: ownerUserId(actor)!,
          idempotencyKey: input.idempotencyKey,
          tokenHash,
          links,
          now: this.now(),
        };
        committed = this.deps.store.commitPublicationInTransaction(commitInput);
        try {
          this.deps.executionRuns?.bindPublicationInTransaction({
            projectId: task.projectId,
            designId,
            publicationId: committed.id,
            revision: input.expectedRevision,
            graphDigest: snapshot.digest,
            updatedTs: commitInput.now,
          });
        } catch {
          throw new DesignPublisherError(
            'DESIGN_NOT_READY',
            'The approved execution workspace could not be bound to the publication.',
          );
        }
      });
    } catch (error) {
      const raced = this.deps.store.getPublicationByIdempotency(task.projectId, input.idempotencyKey);
      if (raced
        && raced.designTaskId === designId
        && raced.revision === input.expectedRevision
        && raced.graphDigest === snapshot.digest
        && raced.actorKey === keyActor) {
        await this.drainPublication(raced.id);
        return this.result(raced.id);
      }
      const sameRevision = this.deps.store.getPublicationByRevision(designId, input.expectedRevision, snapshot.digest);
      if (sameRevision) {
        throw new DesignPublisherError('DESIGN_ALREADY_PUBLISHED', 'approved design revision was already published');
      }
      throw error;
    }
    if (!committed) throw new Error('publication transaction did not return a durable publication');
    await this.drainPublication((committed as DesignPublication).id);
    return this.result((committed as DesignPublication).id);
  }

  listPublications(designId: number): readonly DesignPublicationResult[] {
    return this.deps.store.listPublications(designId).map((publication) => this.result(publication.id));
  }

  async drainPublication(publicationId: number): Promise<DesignPublicationResult> {
    const publication = this.deps.store.getPublication(publicationId);
    if (!publication) throw new DesignPublisherError('DESIGN_NOT_FOUND', 'design publication not found');
    if (publication.status === 'complete') return this.result(publicationId);
    const links = this.deps.store.listPublicationLinks(publicationId);
    const issueIds = links.map((link) => link.issueId);
    const controller = new AbortController();
    let active = true;
    const requireActive = (): void => {
      if (!active) throw new Error('publication post-commit drain is no longer active');
    };
    const outbox: IssuePublicationPostCommitOutboxPort = {
      listOperations: () => {
        requireActive();
        return this.deps.store.listPublicationOutbox(publicationId).map((item) => {
          const payload = item.payload as {
            projectId?: unknown;
            issueId?: unknown;
            issueIds?: unknown;
            moduleId?: unknown;
            agent?: unknown;
          };
          if (payload.projectId !== publication.projectId || !Array.isArray(payload.issueIds)
            || !payload.issueIds.every((id) => Number.isSafeInteger(id))) {
            throw new Error(`publication outbox payload invalid: ${item.targetKey}`);
          }
          return {
            key: item.targetKey,
            kind: item.kind === 'module_index' ? 'module-doc' as const : 'scheduler' as const,
            projectId: publication.projectId,
            issueId: Number.isSafeInteger(payload.issueId) ? payload.issueId as number : null,
            issueIds: payload.issueIds as number[],
            ...(item.kind === 'module_index'
              ? {
                moduleId: Number.isSafeInteger(payload.moduleId) ? payload.moduleId as number : null,
                agent: payload.agent === 'codex' ? 'codex' as const : 'claude' as const,
              }
              : {}),
          };
        });
      },
      isComplete: (operation) => {
        requireActive();
        return this.outboxItem(publicationId, operation).completedTs !== null;
      },
      markComplete: (operation) => {
        requireActive();
        if (!this.deps.store.markPublicationOutboxComplete(publicationId, operation.key, this.now())) {
          throw new Error(`publication outbox item missing: ${operation.key}`);
        }
      },
      markRetry: (operation, error) => {
        requireActive();
        if (!this.deps.store.markPublicationOutboxRetry(publicationId, operation.key, error, this.now())) {
          throw new Error(`publication outbox item cannot retry: ${operation.key}`);
        }
      },
    };
    const completion = this.deps.issues.completeDesignBatch(
      publication.projectId,
      issueIds,
      outbox,
      controller.signal,
    ).then(
      () => ({ kind: 'complete' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), this.postCommitTimeoutMs);
    });
    const outcome = await Promise.race([completion, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.kind === 'timeout') {
      active = false;
      controller.abort();
      this.deps.store.refreshPublicationStatus(
        publicationId,
        `publication post-commit drain timed out after ${this.postCommitTimeoutMs}ms`,
        this.now(),
      );
      return this.result(publicationId);
    }
    active = false;
    this.deps.store.refreshPublicationStatus(
      publicationId,
      outcome.kind === 'complete' ? null : String(outcome.error).slice(0, 4000),
      this.now(),
    );
    return this.result(publicationId);
  }

  async recoverPostCommit(limit = 100): Promise<{ examined: number; completed: number }> {
    const recoverable = this.deps.store.listRecoverablePublications(this.now(), limit);
    let completed = 0;
    for (const publication of recoverable) {
      const result = await this.drainPublication(publication.id);
      if (result.status === 'complete') completed++;
    }
    return { examined: recoverable.length, completed };
  }

  private approvedSnapshot(designId: number, expectedRevision: number, actor: Actor): PublicationSnapshot {
    const task = this.deps.store.getTask(designId);
    if (!task) throw new DesignPublisherError('DESIGN_NOT_FOUND', `design task not found: ${designId}`);
    const createdBy = ownerUserId(actor);
    if (createdBy === null || this.deps.store.getProjectOwnerUserId(task.projectId) !== createdBy) {
      throw new DesignPublisherError('DESIGN_OWNER_REQUIRED', 'design publication requires the project owner');
    }
    if (task.currentRevision !== expectedRevision) {
      throw new DesignPublisherError(
        'DESIGN_REVISION_CONFLICT',
        `revision conflict; current revision is ${task.currentRevision}`,
        task.currentRevision,
      );
    }
    if (task.stage !== 'approved' || task.status !== 'active') {
      throw new DesignPublisherError('DESIGN_NOT_APPROVED', 'design must be active and approved before publication');
    }
    const revision = this.deps.store.getRevision(designId, expectedRevision);
    if (!revision) {
      throw new DesignPublisherError(
        'DESIGN_REVISION_CONFLICT',
        'approved revision snapshot is missing',
        task.currentRevision,
      );
    }
    const validation = validateDesignGraph(revision.graph);
    if (!validation.valid) {
      throw new DesignPublisherError(
        'DESIGN_INVALID_GRAPH',
        `approved revision graph is invalid: ${validation.errors.map((error) => error.code).join(', ')}`,
      );
    }
    if (revision.readiness < task.readinessThreshold && !task.readinessOverride) {
      throw new DesignPublisherError('DESIGN_NOT_READY', 'approved revision readiness is below its threshold');
    }
    const digest = designGraphDigest(designId, expectedRevision, revision.graph);
    const order = topologicalOrder(revision.graph);
    const byNode = new Map(revision.graph.nodes.map((node) => [node.nodeId, node]));
    const contracts = order.map((nodeId) => baselineContract(task, revision, byNode.get(nodeId)!));
    for (const contract of contracts) {
      if (contract.body.length > MAX_ISSUE_BODY) {
        throw new DesignPublisherError(
          'DESIGN_INVALID_GRAPH',
          `published Issue body exceeds ${MAX_ISSUE_BODY} characters for node ${contract.nodeId}`,
        );
      }
    }
    const drafts: DesignIssueDraft[] = contracts.map((contract) => ({
      nodeId: contract.nodeId,
      title: contract.title,
      body: contract.body,
      moduleId: contract.moduleId,
      implMode: contract.implMode,
      agent: contract.agent,
      createdBy,
    }));
    const dependencies: PreparedIssueDependency[] = revision.graph.edges
      .map((edge) => ({
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        kind: 'blocks' as const,
      }))
      .sort((left, right) => compareText(left.fromNodeId, right.fromNodeId)
        || compareText(left.toNodeId, right.toNodeId));
    return { task, revision, digest, contracts, drafts, dependencies };
  }

  private validateConfirmation(
    rawToken: string,
    snapshot: PublicationSnapshot,
    keyActor: string,
  ): string {
    if (typeof rawToken !== 'string'
      || rawToken.length === 0
      || rawToken.length > MAX_CONFIRMATION_TOKEN
      || rawToken !== rawToken.trim()) {
      throw new DesignPublisherError('DESIGN_CONFIRMATION_INVALID', 'invalid design publish confirmation');
    }
    const tokenHash = sha256(rawToken);
    const confirmation = this.deps.store.getPublishConfirmation(tokenHash);
    if (!confirmation) {
      throw new DesignPublisherError('DESIGN_CONFIRMATION_INVALID', 'design publish confirmation not found');
    }
    if (confirmation.designTaskId !== snapshot.task.id
      || confirmation.revision !== snapshot.revision.revision
      || confirmation.graphDigest !== snapshot.digest
      || confirmation.actorKey !== keyActor) {
      throw new DesignPublisherError('DESIGN_CONFIRMATION_MISMATCH', 'design publish confirmation does not match');
    }
    if (confirmation.consumedPublicationId !== null) {
      throw new DesignPublisherError('DESIGN_CONFIRMATION_CONSUMED', 'design publish confirmation was consumed');
    }
    if (confirmation.expiresTs <= this.now()) {
      throw new DesignPublisherError('DESIGN_CONFIRMATION_EXPIRED', 'design publish confirmation expired');
    }
    return tokenHash;
  }

  private requireOwner(actor: Actor): void {
    if (actor.role !== 'owner') {
      throw new DesignPublisherError('DESIGN_OWNER_REQUIRED', 'design publication requires the project owner');
    }
  }

  private requireIdempotencyKey(value: string): void {
    if (typeof value !== 'string'
      || value.length === 0
      || value.length > MAX_IDEMPOTENCY_KEY
      || value !== value.trim()
      || !/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw new DesignPublisherError('DESIGN_IDEMPOTENCY_CONFLICT', 'invalid design publication idempotency key');
    }
  }

  private outboxItem(publicationId: number, operation: IssuePublicationPostCommitOperation) {
    const item = this.deps.store.getPublicationOutboxByTarget(publicationId, operation.key);
    if (!item) throw new Error(`publication outbox item missing: ${operation.key}`);
    return item;
  }

  private result(publicationId: number): DesignPublicationResult {
    const publication = this.deps.store.getPublication(publicationId);
    if (!publication) throw new DesignPublisherError('DESIGN_NOT_FOUND', 'design publication not found');
    const links = this.deps.store.listPublicationLinks(publicationId);
    const issues: DesignPublishedIssue[] = links.map((link) => ({
      nodeId: link.nodeId,
      issueId: link.issueId,
      title: link.baselineContract.title,
      implMode: link.originalImplMode,
      moduleId: link.baselineContract.moduleId,
      agent: link.baselineContract.agent,
    }));
    return {
      publicationId: publication.id,
      designId: publication.designTaskId,
      projectId: publication.projectId,
      revision: publication.revision,
      graphDigest: publication.graphDigest,
      status: publication.status,
      error: publication.error,
      issues,
    };
  }
}
