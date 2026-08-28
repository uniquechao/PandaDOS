import type { ExecutorDriver } from '../executor/driver';
import {
  runAgentArtifacts,
  type AgentArtifactDriver,
  type RunAgentArtifactsOptions,
} from '../core/agent-artifact-runner';
import { readDriverText } from '../core/skills';
import type { AgentKind } from '../core/types';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { validateDesignGraph } from './graph';
import {
  DESIGN_TASK_STAGES,
  type DesignGraphDraft,
  type DesignPersonaProvenance,
  type DesignRunIntent,
  type DesignRevision,
  type DesignTaskStage,
} from './types';
import type {
  Actor,
  DesignFinding,
  DesignReviewRun,
  StewardRevisionInput,
} from './engine';
import { isResolvedPersona, type ResolvedPersona } from './personas';

export const DESIGN_SCRATCH_BASE = '.panda/tmp/design';
export const MAX_DESIGN_CONTEXT_BYTES = 2 * 1024 * 1024;
export const MAX_DESIGN_PERSONAS = 12;
const MAX_FINDINGS_BYTES = 128 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_GRAPH_BYTES = 512 * 1024;
const MAX_RUN_BYTES = 32 * 1024;
const MAX_PERSONA_ID_CHARS = 120;
const MAX_PERSONA_PROMPT_BYTES = 64 * 1024;
const MAX_PRIOR_FINDINGS_BYTES = 512 * 1024;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const OPERATION_GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const DESIGN_CLAUDE_ARGS = '--permission-mode acceptEdits --disallowedTools Bash NotebookEdit';
const DESIGN_CODEX_ARGS = '-c check_for_update_on_startup=false -c model_reasoning_effort=medium --sandbox workspace-write --ask-for-approval never';

export type DesignRunnerDriver = AgentArtifactDriver & Pick<ExecutorDriver, 'listDir'>;

export interface DesignRunnerEngine {
  requestReview(
    designId: number,
    input: {
      operationId: string;
      sourceRevision: number;
      persona: string;
      findings: DesignFinding[];
      personaProvenance: DesignPersonaProvenance;
    },
    actor: Actor,
  ): Promise<DesignReviewRun | unknown>;
  applyStewardRevision(
    designId: number,
    input: StewardRevisionInput & { operationId: string; personaProvenance: DesignPersonaProvenance },
    actor: Actor,
  ): Promise<DesignRevision | unknown>;
  replaceGraph(
    designId: number,
    input: {
      expectedRevision: number;
      graph: DesignGraphDraft;
      readiness: StewardRevisionInput['readiness'];
      reason?: string;
    },
    actor: Actor,
  ): Promise<unknown>;
}

/** Only registry-resolved, approval-checked personas may enter the runner. */
export type DesignPersonaRunInput = ResolvedPersona;

export interface RunDesignInput {
  projectId: number;
  designId: number;
  cwd: string;
  agent: AgentKind;
  sourceRevision: number;
  operationGroupId: string;
  contextMarkdown: string;
  personas: DesignPersonaRunInput[];
  locale?: SupportedLocale;
}

export type DesignRunOptions = Pick<
  RunAgentArtifactsOptions,
  'pollIntervalMs' | 'timeoutMs' | 'readyDelayMs' | 'signal'
>;

export interface DesignDocumentPatchArtifact {
  documentJson: unknown;
  documentMarkdown: string;
  readiness: StewardRevisionInput['readiness'];
  nextStage?: DesignTaskStage;
  reason?: string;
}

export interface DesignRunManifest {
  schemaVersion: 1;
  projectId: number;
  designId: number;
  runId: string;
  persona: string;
  role: ResolvedPersona['manifest']['role'];
  personaContentHash?: string;
  personaOrigin?: ResolvedPersona['origin'];
  personaGitCommit?: string | null;
  resolvedAgent: AgentKind;
  sourceRevision: number;
  operationGroupId: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedTs: number;
  finishedTs?: number;
  interruptedTs?: number;
  error?: string;
}

export interface DesignPersonaRunResult {
  runId: string;
  persona: string;
  role: ResolvedPersona['manifest']['role'];
  findings: DesignFinding[];
  documentPatch: DesignDocumentPatchArtifact | null;
  graph: DesignGraphDraft | null;
}

interface RetainedDesignArtifacts {
  findings: DesignFinding[];
  documentPatch: DesignDocumentPatchArtifact | null;
  graph: DesignGraphDraft | null;
  raw: { findings: string; documentPatch: string; graph: string };
}

export type RunDesignResult =
  | { ok: true; runs: DesignPersonaRunResult[] }
  | {
      ok: false;
      reason: 'invalid-context' | 'invalid-operation-group' | 'invalid-personas' | 'invalid-run-id' | 'invalid-run-scope' | 'run-id-conflict' | 'forbidden-artifact' | 'runner-error';
      runId?: string;
      error?: string;
    };

export interface DesignRunnerDeps {
  driver: DesignRunnerDriver;
  engine: DesignRunnerEngine;
  intents: DesignRunIntentStore;
  idFactory?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DesignRunIntentStore {
  createRunIntent(intent: DesignRunIntent): boolean;
  getRunIntent(designId: number, runId: string): DesignRunIntent | null;
  updateRunIntentState(
    designId: number,
    runId: string,
    from: DesignRunIntent['state'],
    to: DesignRunIntent['state'],
    updatedTs?: number,
  ): boolean;
}

export interface DesignRunPaths {
  scratch: string;
  context: string;
  persona: string;
  findings: string;
  documentPatch: string;
  graph: string;
  priorFindings: string;
  contract: string;
  run: string;
  done: string;
}

function validRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId) && runId !== '.' && runId !== '..';
}

export function designRunPaths(cwd: string, designId: number, runId: string): DesignRunPaths {
  if (!Number.isSafeInteger(designId) || designId <= 0) throw new Error('invalid design ID');
  if (!validRunId(runId)) throw new Error('invalid design run ID');
  const scratch = `${cwd.replace(/\/+$/, '')}/${DESIGN_SCRATCH_BASE}/${designId}/${runId}`;
  return {
    scratch,
    context: `${scratch}/context.md`,
    persona: `${scratch}/persona.md`,
    findings: `${scratch}/findings.json`,
    documentPatch: `${scratch}/document.patch.json`,
    graph: `${scratch}/graph.json`,
    priorFindings: `${scratch}/prior-findings.json`,
    contract: `${scratch}/artifact-contract.md`,
    run: `${scratch}/run.json`,
    done: `${scratch}/done`,
  };
}

export function designSessionName(designId: number, runId: string): string {
  if (!validRunId(runId)) throw new Error('invalid design run ID');
  return `design-${designId}-${runId}`;
}

export function designPersonaOperationId(
  operationGroupId: string,
  sourceRevision: number,
  personaId: string,
): string {
  return `group-${operationGroupId.length}:${operationGroupId}|revision-${sourceRevision}|persona-${personaId.length}:${personaId}`;
}

const DESIGN_ARTIFACT_CONTRACT = `# Design run artifact contract

Read and write only files in this run directory. All files must contain strict JSON except done.

- findings.json: an array of objects with exactly these value shapes: {"dimension":"non-empty string","severity":"info|warning|blocker","finding":"non-empty string","evidence":["one or more non-empty strings"],"proposedPatch":<any JSON value>}.
- document.patch.json: null for every non-steward. A steward may write null or {"documentJson":<any JSON value>,"documentMarkdown":"string","readiness":{"dimensions":{"goal_clarity":<dimension>,"scope_boundaries":<dimension>,"solution_completeness":<dimension>,"dependencies_constraints":<dimension>,"acceptance_testability":<dimension>,"risks_unknowns":<dimension>},"hardBlockers":[]},"nextStage":"goal_setting|solution_draft|review|graph_draft","reason":"string"}. Each <dimension> is {"score":0..100,"evidencePaths":["string"],"missingItems":["string"],"nextQuestions":["string"]}.
- graph.json: null unless this role proposes the Issue graph. Otherwise write {"nodes":[<node>],"edges":[<edge>]}. The exact node value shape is {"nodeId":"id","title":"title","goal":"goal","background":["..."],"sourceSections":["..."],"scope":["..."],"nonGoals":["..."],"inputs":["..."],"outputs":["..."],"dependencies":["dependency-node-id"],"implementationNotes":["..."],"moduleId":null,"runtime":"current|worktree","agent":null,"complexity":"low|medium|high","complexityRationale":["..."],"acceptanceCriteria":["..."],"testRecommendations":["..."],"evidenceRequirements":["..."],"completionInstructions":["..."],"implMode":"direct|team"}. agent may also be claude or codex; moduleId may be a positive integer. Each edge is {"fromNodeId":"dependency node","toNodeId":"dependent node","kind":"depends_on"}. A node's dependencies must exactly match its incoming depends_on edges. Node IDs must be unique; no self edge, duplicate edge, missing endpoint, or cycle.
- Never modify run.json. Create done containing ok only after the three output files are valid.
`;

export function buildDesignRunPrompt(input: {
  designId: number;
  runId: string;
  persona: string;
  role: ResolvedPersona['manifest']['role'];
  locale?: SupportedLocale;
}): string {
  const locale = input.locale ?? DEFAULT_LOCALE;
  if (promptLanguage(locale) === 'en') {
    const roleContract = input.role === 'design_steward'
      ? 'Only the design steward may propose a live-document change: write a validated patch object to document.patch.json, or null when no change is warranted.'
      : 'You are a specialist, not the design steward: document.patch.json must contain null. Put all advice in findings.json.';
    return [
      `Act as persona ${JSON.stringify(input.persona)} with role ${input.role}. The current run directory is your only writable directory.`,
      `Read context.md, persona.md, prior-findings.json, and artifact-contract.md; follow the artifact contract exactly. Do not inspect files outside the current run directory.`,
      `Write findings.json as a JSON array of {dimension,severity,finding,evidence,proposedPatch}; severity is info, warning, or blocker, and evidence must be an array of non-empty strings.`,
      roleContract,
      `Write graph.json as a valid design graph object only when this role proposes a graph; otherwise write null.`,
      `Do not modify run.json. As the final step create done containing ok.`,
      outputLanguageInstruction(locale),
    ].join(' ');
  }
  const roleContract = input.role === 'design_steward'
    ? '只有设计主理人可以提出实时文档变更：需要变更时把合法补丁对象写入 document.patch.json，否则写 null。'
    : '你是专业审查人格，不是设计主理人：document.patch.json 必须写 null，所有建议只能写入 findings.json。';
  return [
    `你以人格 ${JSON.stringify(input.persona)}、角色 ${input.role} 执行设计审查；当前运行目录是唯一可写目录。`,
    `读取 context.md、persona.md、prior-findings.json 和 artifact-contract.md，并严格遵循产物合同；不要读取当前运行目录以外的文件。`,
    `把结构化发现写入 findings.json，格式为 {dimension,severity,finding,evidence,proposedPatch} 数组；severity 只能是 info、warning 或 blocker，evidence 必须是非空字符串数组。`,
    roleContract,
    `仅当角色需要提议 Issue Graph 时把合法图对象写入 graph.json，否则写 null。`,
    `不要修改 run.json；最后一步创建 done，内容写 ok。`,
    outputLanguageInstruction(locale),
  ].join(' ');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validPersonaRole(value: unknown): value is ResolvedPersona['manifest']['role'] {
  return value === 'reviewer'
    || value === 'goal_coach'
    || value === 'issue_planner'
    || value === 'independent_verifier'
    || value === 'design_steward';
}

function parseFindings(text: string): DesignFinding[] {
  const value = JSON.parse(text) as unknown;
  if (!Array.isArray(value)) throw new Error('findings must be an array');
  return value.map((item) => {
    if (
      !object(item)
      || typeof item.dimension !== 'string' || !item.dimension.trim()
      || (item.severity !== 'info' && item.severity !== 'warning' && item.severity !== 'blocker')
      || typeof item.finding !== 'string' || !item.finding.trim()
      || !Array.isArray(item.evidence)
      || item.evidence.some((entry) => typeof entry !== 'string' || !entry.trim())
      || !('proposedPatch' in item)
    ) throw new Error('invalid design finding');
    return {
      dimension: item.dimension,
      severity: item.severity,
      finding: item.finding,
      evidence: item.evidence as string[],
      proposedPatch: item.proposedPatch,
    };
  });
}

function parseDocumentPatch(text: string): DesignDocumentPatchArtifact | null {
  const value = JSON.parse(text) as unknown;
  if (value === null) return null;
  if (
    !object(value)
    || !('documentJson' in value)
    || typeof value.documentMarkdown !== 'string'
    || !object(value.readiness)
    || (value.reason !== undefined && typeof value.reason !== 'string')
    || (value.nextStage !== undefined
      && !(DESIGN_TASK_STAGES as readonly unknown[]).includes(value.nextStage))
  ) throw new Error('invalid design document patch');
  return value as unknown as DesignDocumentPatchArtifact;
}

function parseGraph(text: string): DesignGraphDraft | null {
  const value = JSON.parse(text) as unknown;
  if (value === null) return null;
  if (!object(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error('invalid design graph shape');
  }
  const graph = value as unknown as DesignGraphDraft;
  const validation = validateDesignGraph(graph);
  if (!validation.valid) {
    throw new Error(`invalid design graph: ${validation.errors.map((error) => error.code).join(',')}`);
  }
  return graph;
}

function parseManifest(text: string): DesignRunManifest {
  const value = JSON.parse(text) as unknown;
  if (
    !object(value)
    || value.schemaVersion !== 1
    || typeof value.projectId !== 'number'
    || typeof value.designId !== 'number'
    || typeof value.runId !== 'string' || !validRunId(value.runId)
    || typeof value.persona !== 'string' || !value.persona.trim()
    || !validPersonaRole(value.role)
    || typeof value.sourceRevision !== 'number'
    || typeof value.operationGroupId !== 'string'
    || !OPERATION_GROUP_ID_RE.test(value.operationGroupId)
    || (value.personaContentHash !== undefined
      && (typeof value.personaContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.personaContentHash)))
    || (value.personaOrigin !== undefined
      && value.personaOrigin !== 'builtin' && value.personaOrigin !== 'market' && value.personaOrigin !== 'project')
    || (value.personaGitCommit !== undefined && value.personaGitCommit !== null
      && (typeof value.personaGitCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.personaGitCommit)))
    || (value.resolvedAgent !== 'claude' && value.resolvedAgent !== 'codex')
    || !['running', 'completed', 'failed', 'interrupted'].includes(String(value.status))
    || typeof value.startedTs !== 'number'
  ) throw new Error('invalid design run manifest');
  return value as unknown as DesignRunManifest;
}

function manifestJson(manifest: DesignRunManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function validPersonaBatch(personas: DesignPersonaRunInput[], projectId: number, agent: AgentKind): boolean {
  if (personas.length === 0 || personas.length > MAX_DESIGN_PERSONAS) return false;
  const ids = new Set<string>();
  let stewardIndex = -1;
  for (let index = 0; index < personas.length; index++) {
    const persona = personas[index];
    if (
      !isResolvedPersona(persona)
      || persona.projectId !== projectId
      || persona.resolvedAgent !== agent
      || !persona.manifest.compatibleAgents.includes(agent)
      || typeof persona.key !== 'string'
      || persona.key !== persona.key.trim()
      || persona.key.length === 0
      || persona.key.length > MAX_PERSONA_ID_CHARS
      || ids.has(persona.key)
      || !validPersonaRole(persona.manifest.role)
      || typeof persona.prompt !== 'string'
      || !persona.prompt.trim()
      || byteLength(persona.prompt) > MAX_PERSONA_PROMPT_BYTES
    ) return false;
    ids.add(persona.key);
    if (persona.manifest.role === 'design_steward') {
      if (stewardIndex >= 0) return false;
      stewardIndex = index;
    }
  }
  return stewardIndex < 0 || stewardIndex === personas.length - 1;
}

function runIntent(
  input: RunDesignInput,
  runId: string,
  persona: ResolvedPersona,
  now: number,
): DesignRunIntent {
  return {
    designId: input.designId,
    runId,
    projectId: input.projectId,
    operationGroupId: input.operationGroupId,
    key: persona.key,
    contentHash: persona.contentHash,
    origin: persona.origin,
    gitCommit: persona.gitCommit,
    role: persona.manifest.role,
    resolvedAgent: persona.resolvedAgent,
    sourceRevision: input.sourceRevision,
    state: 'launching',
    createdTs: now,
    updatedTs: now,
  };
}

function personaProvenance(intent: DesignRunIntent) {
  return {
    key: intent.key,
    contentHash: intent.contentHash,
    origin: intent.origin,
    gitCommit: intent.gitCommit,
    role: intent.role,
    projectId: intent.projectId,
    resolvedAgent: intent.resolvedAgent,
  };
}

function manifestMatchesIntent(manifest: DesignRunManifest, intent: DesignRunIntent): boolean {
  return manifest.designId === intent.designId
    && manifest.projectId === intent.projectId
    && manifest.runId === intent.runId
    && manifest.persona === intent.key
    && manifest.role === intent.role
    && manifest.personaContentHash === intent.contentHash
    && manifest.personaOrigin === intent.origin
    && manifest.personaGitCommit === intent.gitCommit
    && manifest.resolvedAgent === intent.resolvedAgent
    && manifest.sourceRevision === intent.sourceRevision
    && manifest.operationGroupId === intent.operationGroupId;
}

export class DesignRunner {
  private readonly driver: DesignRunnerDriver;
  private readonly engine: DesignRunnerEngine;
  private readonly intents: DesignRunIntentStore;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: DesignRunnerDeps) {
    this.driver = deps.driver;
    this.engine = deps.engine;
    this.intents = deps.intents;
    this.idFactory = deps.idFactory ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async nextRun(input: RunDesignInput): Promise<
    | { ok: true; runId: string; paths: DesignRunPaths }
    | { ok: false; reason: 'invalid-run-id' | 'run-id-conflict' }
  > {
    for (let attempt = 0; attempt < 10; attempt++) {
      const runId = this.idFactory();
      if (!validRunId(runId)) return { ok: false, reason: 'invalid-run-id' };
      const paths = designRunPaths(input.cwd, input.designId, runId);
      if (!await this.driver.statPath(paths.scratch)) return { ok: true, runId, paths };
    }
    return { ok: false, reason: 'run-id-conflict' };
  }

  private async writeManifest(path: string, manifest: DesignRunManifest): Promise<void> {
    await this.driver.writeFile(path, manifestJson(manifest));
  }

  private async strictText(path: string, maxBytes: number): Promise<string | null> {
    const stat = await this.driver.statPath(path);
    if (!stat?.isFile || stat.size > maxBytes) return null;
    return readDriverText(this.driver, path, maxBytes);
  }

  private async artifactsAt(paths: DesignRunPaths): Promise<RetainedDesignArtifacts | null> {
    const done = await this.driver.statPath(paths.done).catch(() => null);
    if (!done?.isFile) return null;
    const [findingsText, patchText, graphText] = await Promise.all([
      this.strictText(paths.findings, MAX_FINDINGS_BYTES).catch(() => null),
      this.strictText(paths.documentPatch, MAX_PATCH_BYTES).catch(() => null),
      this.strictText(paths.graph, MAX_GRAPH_BYTES).catch(() => null),
    ]);
    if (findingsText === null || patchText === null || graphText === null) return null;
    try {
      return {
        findings: parseFindings(findingsText),
        documentPatch: parseDocumentPatch(patchText),
        graph: parseGraph(graphText),
        raw: { findings: findingsText, documentPatch: patchText, graph: graphText },
      };
    } catch {
      return null;
    }
  }

  private async retainedRetry(
    input: RunDesignInput,
    persona: DesignPersonaRunInput,
  ): Promise<RetainedDesignArtifacts | null> {
    const root = `${input.cwd.replace(/\/+$/, '')}/${DESIGN_SCRATCH_BASE}/${input.designId}`;
    const entries = await this.driver.listDir(root).catch(() => []);
    const candidates: Array<{ paths: DesignRunPaths; manifest: DesignRunManifest }> = [];
    for (const entry of entries) {
      if (entry.type !== 'dir' || !validRunId(entry.name)) continue;
      const paths = designRunPaths(input.cwd, input.designId, entry.name);
      const manifestText = await this.strictText(paths.run, MAX_RUN_BYTES).catch(() => null);
      if (!manifestText) continue;
      try {
        const manifest = parseManifest(manifestText);
        const intent = this.intents.getRunIntent(input.designId, entry.name);
        if (
          intent?.state === 'interrupted'
          && manifestMatchesIntent(manifest, intent)
          && intent.projectId === input.projectId
          && intent.resolvedAgent === input.agent
          && manifest.designId === input.designId
          && manifest.runId === entry.name
          && manifest.persona === persona.key
          && manifest.role === persona.manifest.role
          && manifest.personaContentHash === persona.contentHash
          && manifest.sourceRevision === input.sourceRevision
          && manifest.operationGroupId === input.operationGroupId
          && manifest.status === 'interrupted'
        ) candidates.push({ paths, manifest });
      } catch {
        // Malformed retained attempts are audit evidence, never retry input.
      }
    }
    candidates.sort((left, right) =>
      (right.manifest.interruptedTs ?? right.manifest.startedTs)
      - (left.manifest.interruptedTs ?? left.manifest.startedTs));
    for (const candidate of candidates) {
      const artifacts = await this.artifactsAt(candidate.paths);
      if (artifacts) return artifacts;
    }
    return null;
  }

  async run(
    input: RunDesignInput,
    options: DesignRunOptions = {},
  ): Promise<RunDesignResult> {
    try {
      return await this.runInternal(input, options);
    } catch (error) {
      return { ok: false, reason: 'runner-error', error: String(error).slice(0, 300) };
    }
  }

  private async runInternal(
    input: RunDesignInput,
    options: DesignRunOptions,
  ): Promise<RunDesignResult> {
    if (!OPERATION_GROUP_ID_RE.test(input.operationGroupId)) {
      return { ok: false, reason: 'invalid-operation-group' };
    }
    if (byteLength(input.contextMarkdown) > MAX_DESIGN_CONTEXT_BYTES) {
      return { ok: false, reason: 'invalid-context' };
    }
    if (!validPersonaBatch(input.personas, input.projectId, input.agent)) {
      return { ok: false, reason: 'invalid-personas' };
    }
    const runs: DesignPersonaRunResult[] = [];
    for (const persona of input.personas) {
      if (options.signal?.aborted) return { ok: false, reason: 'runner-error', error: 'design run cancelled' };
      const operationId = designPersonaOperationId(
        input.operationGroupId,
        input.sourceRevision,
        persona.key,
      );
      const priorFindingsJson = JSON.stringify(
        runs.map((run) => ({
          persona: run.persona,
          findings: run.findings,
          graph: run.graph,
        })),
      );
      if (byteLength(priorFindingsJson) > MAX_PRIOR_FINDINGS_BYTES) {
        return { ok: false, reason: 'runner-error', error: 'prior findings exceed size limit' };
      }
      const allocation = await this.nextRun(input);
      if (!allocation.ok) return { ok: false, reason: allocation.reason };
      const { runId, paths } = allocation;
      const startedTs = this.now();
      const manifest: DesignRunManifest = {
        schemaVersion: 1,
        projectId: input.projectId,
        designId: input.designId,
        runId,
        persona: persona.key,
        role: persona.manifest.role,
        personaContentHash: persona.contentHash,
        personaOrigin: persona.origin,
        personaGitCommit: persona.gitCommit,
        resolvedAgent: persona.resolvedAgent,
        sourceRevision: input.sourceRevision,
        operationGroupId: input.operationGroupId,
        status: 'running',
        startedTs,
      };
      const intent = runIntent(input, runId, persona, startedTs);
      if (!this.intents.createRunIntent(intent)) {
        return {
          ok: false,
          reason: this.intents.getRunIntent(input.designId, runId)
            ? 'run-id-conflict'
            : 'invalid-run-scope',
        };
      }
      const retained = await this.retainedRetry(input, persona);
      let artifacts: Record<string, unknown>;
      if (retained) {
        await Promise.all([
          this.driver.writeFile(paths.context, input.contextMarkdown),
          this.driver.writeFile(paths.persona, persona.prompt),
          this.driver.writeFile(paths.priorFindings, priorFindingsJson),
          this.driver.writeFile(paths.contract, DESIGN_ARTIFACT_CONTRACT),
          this.driver.writeFile(paths.run, manifestJson(manifest)),
          this.driver.writeFile(paths.findings, retained.raw.findings),
          this.driver.writeFile(paths.documentPatch, retained.raw.documentPatch),
          this.driver.writeFile(paths.graph, retained.raw.graph),
          this.driver.writeFile(paths.done, 'ok'),
        ]);
        artifacts = { ...retained, run: manifest };
      } else {
        const result = await runAgentArtifacts(
          { driver: this.driver, now: this.now, sleep: this.sleep },
          {
            agent: input.agent,
            cwd: paths.scratch,
            session: designSessionName(input.designId, runId),
            scratch: paths.scratch,
            prompt: buildDesignRunPrompt({
              designId: input.designId,
              runId,
              persona: persona.key,
              role: persona.manifest.role,
              locale: input.locale,
            }),
            inputFiles: [
              { path: paths.context, data: input.contextMarkdown },
              { path: paths.persona, data: persona.prompt },
              { path: paths.priorFindings, data: priorFindingsJson },
              { path: paths.contract, data: DESIGN_ARTIFACT_CONTRACT },
              { path: paths.run, data: manifestJson(manifest) },
            ],
            donePath: paths.done,
            artifacts: [
              { key: 'findings', path: paths.findings, maxBytes: MAX_FINDINGS_BYTES, rejectOversize: true, parse: parseFindings },
              { key: 'documentPatch', path: paths.documentPatch, maxBytes: MAX_PATCH_BYTES, rejectOversize: true, parse: parseDocumentPatch },
              { key: 'graph', path: paths.graph, maxBytes: MAX_GRAPH_BYTES, rejectOversize: true, parse: parseGraph },
              { key: 'run', path: paths.run, maxBytes: MAX_RUN_BYTES, rejectOversize: true, parse: parseManifest },
            ],
          },
          {
            pollIntervalMs: options.pollIntervalMs,
            timeoutMs: options.timeoutMs,
            readyDelayMs: options.readyDelayMs,
            signal: options.signal,
            claudeArgs: DESIGN_CLAUDE_ARGS,
            codexArgs: DESIGN_CODEX_ARGS,
            autoApproveMenus: false,
            preserveScratch: true,
          },
        );
        if (options.signal?.aborted && options.signal.reason === 'shutdown') {
          return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
        }
        if (!result.ok) {
          this.intents.updateRunIntentState(
            input.designId,
            runId,
            'launching',
            result.reason === 'cancelled' ? 'interrupted' : 'failed',
            this.now(),
          );
          await this.writeManifest(paths.run, {
            ...manifest,
            status: result.reason === 'cancelled' ? 'interrupted' : 'failed',
            finishedTs: this.now(),
            error: result.error ?? result.reason,
          });
          return { ok: false, reason: 'runner-error', runId, error: result.error ?? result.reason };
        }
        if (options.signal?.aborted) {
          this.intents.updateRunIntentState(input.designId, runId, 'launching', 'interrupted', this.now());
          await this.writeManifest(paths.run, {
            ...manifest, status: 'interrupted', interruptedTs: this.now(), error: 'design run cancelled',
          });
          return { ok: false, reason: 'runner-error', runId, error: 'design run cancelled' };
        }
        artifacts = result.artifacts;
      }

      const observedManifest = artifacts.run as DesignRunManifest;
      if (
        observedManifest.designId !== input.designId
        || observedManifest.projectId !== input.projectId
        || observedManifest.runId !== runId
        || observedManifest.persona !== persona.key
        || observedManifest.role !== persona.manifest.role
        || observedManifest.personaContentHash !== persona.contentHash
        || observedManifest.personaOrigin !== persona.origin
        || observedManifest.personaGitCommit !== persona.gitCommit
        || observedManifest.resolvedAgent !== input.agent
        || observedManifest.sourceRevision !== input.sourceRevision
        || observedManifest.operationGroupId !== input.operationGroupId
        || observedManifest.status !== 'running'
      ) {
        this.intents.updateRunIntentState(input.designId, runId, 'launching', 'failed', this.now());
        await this.writeManifest(paths.run, {
          ...manifest,
          status: 'failed',
          finishedTs: this.now(),
          error: 'run manifest was modified by the agent',
        });
        return { ok: false, reason: 'runner-error', runId, error: 'run manifest was modified' };
      }

      const findings = artifacts.findings as DesignFinding[];
      const documentPatch = artifacts.documentPatch as DesignDocumentPatchArtifact | null;
      const graph = artifacts.graph as DesignGraphDraft | null;
      const actor: Actor = { id: persona.key, role: persona.manifest.role };
      const shuttingDown = () => options.signal?.aborted && options.signal.reason === 'shutdown';
      try {
        if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
        if (persona.manifest.role !== 'design_steward') {
          if (documentPatch !== null) {
            this.intents.updateRunIntentState(input.designId, runId, 'launching', 'failed', this.now());
            await this.writeManifest(paths.run, {
              ...manifest,
              status: 'failed',
              finishedTs: this.now(),
              error: 'specialist attempted a document patch',
            });
            return { ok: false, reason: 'forbidden-artifact', runId };
          }
          if (findings.length > 0) {
            if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
            await this.engine.requestReview(input.designId, {
              operationId,
              sourceRevision: input.sourceRevision,
              persona: persona.key,
              findings,
              personaProvenance: personaProvenance(intent),
            }, actor);
            if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
          }
        } else {
          let graphRevision = input.sourceRevision;
          if (documentPatch !== null) {
            if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
            const revision = await this.engine.applyStewardRevision(input.designId, {
              operationId,
              expectedRevision: input.sourceRevision,
              documentJson: documentPatch.documentJson,
              documentMarkdown: documentPatch.documentMarkdown,
              readiness: documentPatch.readiness,
              nextStage: documentPatch.nextStage,
              reason: documentPatch.reason,
              personaProvenance: personaProvenance(intent),
            }, actor);
            if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
            const revisionNumber = (revision as Partial<DesignRevision> | null)?.revision;
            if (!Number.isSafeInteger(revisionNumber) || revisionNumber! <= input.sourceRevision) {
              throw new Error('steward revision did not return a safe next revision');
            }
            graphRevision = revisionNumber!;
          }
          if (graph !== null) {
            if (documentPatch === null) throw new Error('steward graph requires a document/readiness patch');
            if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
            await this.engine.replaceGraph(input.designId, {
              expectedRevision: graphRevision,
              graph,
              readiness: documentPatch.readiness,
              reason: documentPatch.reason,
            }, actor);
            if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
          }
        }
      } catch (error) {
        if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
        const message = String(error).slice(0, 300);
        this.intents.updateRunIntentState(input.designId, runId, 'launching', 'failed', this.now());
        await this.writeManifest(paths.run, {
          ...manifest,
          status: 'failed',
          finishedTs: this.now(),
          error: message,
        });
        return { ok: false, reason: 'runner-error', runId, error: message };
      }

      if (shuttingDown()) return { ok: false, reason: 'runner-error', runId, error: 'design runner stopped' };
      if (!this.intents.updateRunIntentState(input.designId, runId, 'launching', 'ingested', this.now())) {
        return { ok: false, reason: 'runner-error', runId, error: 'run intent state conflict' };
      }
      await this.writeManifest(paths.run, { ...manifest, status: 'completed', finishedTs: this.now() });
      runs.push({
        runId,
        persona: persona.key,
        role: persona.manifest.role,
        findings,
        documentPatch,
        graph,
      });
    }
    return { ok: true, runs };
  }

  async recoverInterrupted(cwd: string, designId: number): Promise<string[]> {
    const root = `${cwd.replace(/\/+$/, '')}/${DESIGN_SCRATCH_BASE}/${designId}`;
    const entries = await this.driver.listDir(root).catch(() => []);
    const interrupted: string[] = [];
    for (const entry of entries) {
      if (entry.type !== 'dir' || !validRunId(entry.name)) continue;
      const paths = designRunPaths(cwd, designId, entry.name);
      await this.driver.killSession(designSessionName(designId, entry.name)).catch(() => {});
      const text = await readDriverText(this.driver, paths.run, MAX_RUN_BYTES).catch(() => null);
      if (!text) {
        this.intents.updateRunIntentState(designId, entry.name, 'launching', 'failed', this.now());
        continue;
      }
      let manifest: DesignRunManifest;
      try {
        manifest = parseManifest(text);
      } catch {
        this.intents.updateRunIntentState(designId, entry.name, 'launching', 'failed', this.now());
        continue;
      }
      if (
        manifest.designId !== designId
        || manifest.runId !== entry.name
        || manifest.status !== 'running'
      ) {
        this.intents.updateRunIntentState(designId, entry.name, 'launching', 'failed', this.now());
        continue;
      }
      const intent = this.intents.getRunIntent(designId, entry.name);
      if (!intent || !manifestMatchesIntent(manifest, intent)) {
        if (intent?.state === 'launching') {
          this.intents.updateRunIntentState(designId, entry.name, 'launching', 'failed', this.now());
        }
        await this.writeManifest(paths.run, {
          ...manifest,
          status: 'failed',
          finishedTs: this.now(),
          error: 'run manifest has no matching control-plane intent',
        });
        continue;
      }
      if (intent.state === 'ingested') {
        await this.writeManifest(paths.run, {
          ...manifest,
          status: 'completed',
          finishedTs: this.now(),
        });
        continue;
      }
      if (intent.state !== 'launching') {
        await this.writeManifest(paths.run, {
          ...manifest,
          status: intent.state === 'interrupted' ? 'interrupted' : 'failed',
          ...(intent.state === 'interrupted' ? { interruptedTs: this.now() } : { finishedTs: this.now() }),
          error: `run intent is ${intent.state}`,
        });
        if (intent.state === 'interrupted') interrupted.push(entry.name);
        continue;
      }
      const done = await this.driver.statPath(paths.done).catch(() => null);
      const artifacts = await this.artifactsAt(paths);
      if (artifacts) {
        const actor: Actor = { id: manifest.persona, role: manifest.role };
        const operationId = designPersonaOperationId(
          manifest.operationGroupId,
          manifest.sourceRevision,
          manifest.persona,
        );
        try {
          if (manifest.role !== 'design_steward') {
            if (artifacts.documentPatch !== null) throw new Error('specialist attempted a document patch');
            if (artifacts.findings.length > 0) {
              await this.engine.requestReview(designId, {
                operationId,
                sourceRevision: manifest.sourceRevision,
                persona: manifest.persona,
                findings: artifacts.findings,
                personaProvenance: personaProvenance(intent),
              }, actor);
            }
          } else if (artifacts.documentPatch !== null) {
            const revision = await this.engine.applyStewardRevision(designId, {
              operationId,
              expectedRevision: manifest.sourceRevision,
              documentJson: artifacts.documentPatch.documentJson,
              documentMarkdown: artifacts.documentPatch.documentMarkdown,
              readiness: artifacts.documentPatch.readiness,
              nextStage: artifacts.documentPatch.nextStage,
              reason: artifacts.documentPatch.reason,
              personaProvenance: personaProvenance(intent),
            }, actor);
            const revisionNumber = (revision as Partial<DesignRevision> | null)?.revision;
            if (!Number.isSafeInteger(revisionNumber) || revisionNumber! <= manifest.sourceRevision) {
              throw new Error('steward revision did not return a safe next revision');
            }
            if (artifacts.graph !== null) {
              await this.engine.replaceGraph(designId, {
                expectedRevision: revisionNumber!,
                graph: artifacts.graph,
                readiness: artifacts.documentPatch.readiness,
                reason: artifacts.documentPatch.reason,
              }, actor);
            }
          } else if (artifacts.graph !== null) {
            throw new Error('steward graph requires a document/readiness patch');
          }
          if (!this.intents.updateRunIntentState(designId, entry.name, 'launching', 'ingested', this.now())) {
            throw new Error('run intent state conflict');
          }
          await this.writeManifest(paths.run, {
            ...manifest,
            status: 'completed',
            finishedTs: this.now(),
          });
          continue;
        } catch (error) {
          this.intents.updateRunIntentState(designId, entry.name, 'launching', 'failed', this.now());
          await this.writeManifest(paths.run, {
            ...manifest,
            status: 'failed',
            finishedTs: this.now(),
            error: String(error).slice(0, 300),
          });
          continue;
        }
      }
      if (done?.isFile) {
        this.intents.updateRunIntentState(designId, entry.name, 'launching', 'failed', this.now());
        await this.writeManifest(paths.run, {
          ...manifest,
          status: 'failed',
          finishedTs: this.now(),
          error: 'completed run has invalid retained artifacts',
        });
        continue;
      }
      this.intents.updateRunIntentState(designId, entry.name, 'launching', 'interrupted', this.now());
      await this.writeManifest(paths.run, {
        ...manifest,
        status: 'interrupted',
        interruptedTs: this.now(),
      });
      interrupted.push(entry.name);
    }
    return interrupted.sort();
  }
}
