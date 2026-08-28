import { createHash } from 'node:crypto';
import {
  DESIGN_GRAPH_COMPLEXITIES,
  DESIGN_GRAPH_RUNTIMES,
} from './types';
import type { DesignGraphDraft, DesignGraphEdgeDraft, DesignGraphNodeDraft } from './types';

export type DesignImplMode = 'direct' | 'team';
export { normalizeDesignGraphGranularity } from './types';
export type { DesignGraphDraft, DesignGraphGranularity, DesignGraphNodeDraft } from './types';

export type DesignGraphNodeRequiredField =
  | 'title'
  | 'goal'
  | 'scope'
  | 'nonGoals'
  | 'implementationNotes'
  | 'runtime'
  | 'complexity'
  | 'complexityRationale'
  | 'acceptanceCriteria'
  | 'testRecommendations'
  | 'evidenceRequirements'
  | 'completionInstructions';

export type GraphValidationError =
  | { code: 'INVALID_GRAPH_FIELD'; field: 'graph' | 'nodes' | 'edges'; value: unknown }
  | { code: 'INVALID_NODE'; index: number; value: unknown }
  | { code: 'INVALID_EDGE'; index: number; value: unknown }
  | { code: 'INVALID_EDGE_FIELD'; index: number; field: 'fromNodeId' | 'toNodeId' | 'kind'; value: unknown }
  | { code: 'DUPLICATE_NODE_ID'; nodeId: string }
  | { code: 'SELF_EDGE'; edge: DesignGraphEdgeDraft }
  | { code: 'DUPLICATE_EDGE'; edge: DesignGraphEdgeDraft }
  | { code: 'MISSING_ENDPOINT'; edge: DesignGraphEdgeDraft; missingNodeId: string }
  | { code: 'CYCLE'; nodeIds: string[] }
  | { code: 'MISSING_NODE_FIELD'; nodeId: string; field: DesignGraphNodeRequiredField }
  | { code: 'INVALID_NODE_FIELD'; nodeId: string; field: keyof DesignGraphNodeDraft; value: unknown }
  | { code: 'UNKNOWN_DEPENDENCY'; nodeId: string; dependencyNodeId: string }
  | { code: 'DUPLICATE_DEPENDENCY'; nodeId: string; dependencyNodeId: string }
  | { code: 'SELF_DEPENDENCY'; nodeId: string }
  | { code: 'MISSING_DEPENDENCY_EDGE'; nodeId: string; dependencyNodeId: string }
  | { code: 'EXTRA_DEPENDENCY_EDGE'; nodeId: string; dependencyNodeId: string }
  | { code: 'INVALID_EDGE_KIND'; edge: DesignGraphEdgeDraft }
  | { code: 'MISSING_ACCEPTANCE_CRITERIA'; nodeId: string }
  | { code: 'MISSING_EVIDENCE_REQUIREMENTS'; nodeId: string }
  | { code: 'INVALID_IMPL_MODE'; nodeId: string; implMode: unknown };

export interface GraphValidation {
  valid: boolean;
  errors: GraphValidationError[];
}

const MAX_GRAPH_NODES = 200;
const MAX_GRAPH_EDGES = MAX_GRAPH_NODES * MAX_GRAPH_NODES;
const MAX_GRAPH_NODE_ID = 120;
const MAX_GRAPH_TITLE = 200;
const MAX_GRAPH_TEXT = 8_000;
const MAX_GRAPH_LIST_ITEMS = 100;
const MAX_GRAPH_LIST_ITEM = 4_000;

const NODE_LIST_FIELDS = [
  'background',
  'sourceSections',
  'scope',
  'nonGoals',
  'inputs',
  'outputs',
  'dependencies',
  'implementationNotes',
  'complexityRationale',
  'acceptanceCriteria',
  'testRecommendations',
  'evidenceRequirements',
  'completionInstructions',
] as const satisfies readonly (keyof DesignGraphNodeDraft)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function graphShapeErrors(value: unknown): GraphValidationError[] {
  if (!isRecord(value)) return [{ code: 'INVALID_GRAPH_FIELD', field: 'graph', value }];
  const errors: GraphValidationError[] = [];
  const nodes = value.nodes;
  const edges = value.edges;
  if (!Array.isArray(nodes) || nodes.length > MAX_GRAPH_NODES) {
    errors.push({ code: 'INVALID_GRAPH_FIELD', field: 'nodes', value: nodes });
  }
  if (!Array.isArray(edges) || edges.length > MAX_GRAPH_EDGES) {
    errors.push({ code: 'INVALID_GRAPH_FIELD', field: 'edges', value: edges });
  }
  if (errors.length > 0) return errors;
  const graphNodes = nodes as unknown[];
  const graphEdges = edges as unknown[];

  for (const [index, rawNode] of graphNodes.entries()) {
    if (!isRecord(rawNode)) {
      errors.push({ code: 'INVALID_NODE', index, value: rawNode });
      continue;
    }
    const nodeId = typeof rawNode.nodeId === 'string' ? rawNode.nodeId : `@${index}`;
    if (typeof rawNode.nodeId !== 'string'
      || rawNode.nodeId.trim().length === 0
      || rawNode.nodeId !== rawNode.nodeId.trim()
      || rawNode.nodeId.length > MAX_GRAPH_NODE_ID) {
      errors.push({ code: 'INVALID_NODE_FIELD', nodeId, field: 'nodeId', value: rawNode.nodeId });
    }
    for (const [field, limit] of [['title', MAX_GRAPH_TITLE], ['goal', MAX_GRAPH_TEXT]] as const) {
      const fieldValue = rawNode[field];
      if (fieldValue !== undefined && (typeof fieldValue !== 'string' || fieldValue.length > limit)) {
        errors.push({ code: 'INVALID_NODE_FIELD', nodeId, field, value: fieldValue });
      }
    }
    for (const field of NODE_LIST_FIELDS) {
      const list = rawNode[field];
      if (list === undefined) continue;
      if (!Array.isArray(list)
        || list.length > MAX_GRAPH_LIST_ITEMS
        || list.some((item) => typeof item !== 'string'
          || item.length > MAX_GRAPH_LIST_ITEM
          || (field === 'dependencies' && item !== item.trim()))) {
        errors.push({ code: 'INVALID_NODE_FIELD', nodeId, field, value: list });
      }
    }
  }

  for (const [index, rawEdge] of graphEdges.entries()) {
    if (!isRecord(rawEdge)) {
      errors.push({ code: 'INVALID_EDGE', index, value: rawEdge });
      continue;
    }
    for (const field of ['fromNodeId', 'toNodeId'] as const) {
      const endpoint = rawEdge[field];
      if (typeof endpoint !== 'string'
        || endpoint.trim().length === 0
        || endpoint !== endpoint.trim()
        || endpoint.length > MAX_GRAPH_NODE_ID) {
        errors.push({ code: 'INVALID_EDGE_FIELD', index, field, value: endpoint });
      }
    }
    if (rawEdge.kind !== undefined
      && (typeof rawEdge.kind !== 'string' || rawEdge.kind.trim().length === 0 || rawEdge.kind.length > 40)) {
      errors.push({ code: 'INVALID_EDGE_FIELD', index, field: 'kind', value: rawEdge.kind });
    }
  }
  return errors;
}

function isNonEmptyTextList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function isNonBlankText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Stable raw UTF-16 code-unit order; intentionally performs no locale collation or NFC folding. */
function compareCanonicalText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNodes(left: DesignGraphNodeDraft, right: DesignGraphNodeDraft): number {
  const leftOrdinal = left.ordinal ?? Number.MAX_SAFE_INTEGER;
  const rightOrdinal = right.ordinal ?? Number.MAX_SAFE_INTEGER;
  return leftOrdinal - rightOrdinal || compareCanonicalText(left.nodeId, right.nodeId);
}

function edgeKey(edge: DesignGraphEdgeDraft): string {
  return `${edge.fromNodeId}\u0000${edge.toNodeId}`;
}

function compareEdges(left: DesignGraphEdgeDraft, right: DesignGraphEdgeDraft): number {
  return compareCanonicalText(left.fromNodeId, right.fromNodeId)
    || compareCanonicalText(left.toNodeId, right.toNodeId)
    || compareCanonicalText(left.kind ?? '', right.kind ?? '');
}

function deduplicatedSortedEdges(edges: DesignGraphEdgeDraft[]): DesignGraphEdgeDraft[] {
  const unique = new Map<string, DesignGraphEdgeDraft>();
  for (const edge of edges) {
    if (!unique.has(edgeKey(edge))) unique.set(edgeKey(edge), { ...edge });
  }
  return [...unique.values()].sort(compareEdges);
}

function nodesWithDependenciesFromEdges(
  nodes: DesignGraphNodeDraft[],
  edges: DesignGraphEdgeDraft[],
): DesignGraphNodeDraft[] {
  const incoming = new Map(nodes.map((node) => [node.nodeId, [] as string[]]));
  for (const edge of edges) incoming.get(edge.toNodeId)?.push(edge.fromNodeId);
  return nodes.map((node) => ({
    ...node,
    dependencies: [...new Set(incoming.get(node.nodeId) ?? [])]
      .sort(compareCanonicalText),
  }));
}

function cycleNodeIds(graph: DesignGraphDraft, nodeIds: Set<string>): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, []);
  for (const edge of graph.edges) {
    if (edge.fromNodeId !== edge.toNodeId && nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)) {
      adjacency.get(edge.fromNodeId)?.push(edge.toNodeId);
    }
  }
  for (const successors of adjacency.values()) successors.sort(compareCanonicalText);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (nodeId: string): string[] | null => {
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const successor of adjacency.get(nodeId) ?? []) {
      if (visiting.has(successor)) {
        const cycleStart = stack.indexOf(successor);
        return stack.slice(cycleStart).sort(compareCanonicalText);
      }
      if (!visited.has(successor)) {
        const cycle = visit(successor);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
    return null;
  };

  for (const node of [...graph.nodes].sort(compareNodes)) {
    if (!visited.has(node.nodeId)) {
      const cycle = visit(node.nodeId);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function validateDesignGraph(graph: DesignGraphDraft): GraphValidation {
  const shapeErrors = graphShapeErrors(graph);
  if (shapeErrors.length > 0) return { valid: false, errors: shapeErrors };
  const errors: GraphValidationError[] = [];
  const nodeIds = new Set<string>();
  const duplicateNodeIds = new Set<string>();

  for (const node of graph.nodes) {
    if (nodeIds.has(node.nodeId)) {
      duplicateNodeIds.add(node.nodeId);
      errors.push({ code: 'DUPLICATE_NODE_ID', nodeId: node.nodeId });
    }
    else nodeIds.add(node.nodeId);
    if (!isNonBlankText(node.title)) errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'title' });
    if (!isNonBlankText(node.goal)) errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'goal' });
    if (!isNonEmptyTextList(node.scope)) errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'scope' });
    if (!isNonEmptyTextList(node.nonGoals)) errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'nonGoals' });
    if (!isNonEmptyTextList(node.implementationNotes)) {
      errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'implementationNotes' });
    }
    if (!isNonEmptyTextList(node.testRecommendations)) {
      errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'testRecommendations' });
    }
    if (!isNonEmptyTextList(node.completionInstructions)) {
      errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'completionInstructions' });
    }
    if (node.ordinal !== undefined && (!Number.isSafeInteger(node.ordinal) || node.ordinal < 0)) {
      errors.push({ code: 'INVALID_NODE_FIELD', nodeId: node.nodeId, field: 'ordinal', value: node.ordinal });
    }
    for (const field of ['background', 'sourceSections', 'inputs', 'outputs'] as const) {
      if (node[field] !== undefined && !isTextList(node[field])) {
        errors.push({ code: 'INVALID_NODE_FIELD', nodeId: node.nodeId, field, value: node[field] });
      }
    }
    if (node.moduleId !== undefined && node.moduleId !== null
      && (!Number.isSafeInteger(node.moduleId) || node.moduleId <= 0)) {
      errors.push({ code: 'INVALID_NODE_FIELD', nodeId: node.nodeId, field: 'moduleId', value: node.moduleId });
    }
    const issueId = node.issueId;
    if (issueId !== undefined && issueId !== null && (!Number.isSafeInteger(issueId) || issueId <= 0)) {
      errors.push({ code: 'INVALID_NODE_FIELD', nodeId: node.nodeId, field: 'issueId', value: issueId });
    }
    const lastSyncedRevision = node.lastSyncedRevision;
    if (lastSyncedRevision !== undefined && lastSyncedRevision !== null
      && (!Number.isSafeInteger(lastSyncedRevision) || lastSyncedRevision < 0)) {
      errors.push({
        code: 'INVALID_NODE_FIELD',
        nodeId: node.nodeId,
        field: 'lastSyncedRevision',
        value: lastSyncedRevision,
      });
    }
    if (node.runtime === undefined) {
      errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'runtime' });
    } else if (!(DESIGN_GRAPH_RUNTIMES as readonly unknown[]).includes(node.runtime)) {
      errors.push({ code: 'INVALID_NODE_FIELD', nodeId: node.nodeId, field: 'runtime', value: node.runtime });
    }
    if (node.agent !== undefined && node.agent !== null && node.agent !== 'claude' && node.agent !== 'codex') {
      errors.push({ code: 'INVALID_NODE_FIELD', nodeId: node.nodeId, field: 'agent', value: node.agent });
    }
    if (node.complexity === undefined) {
      errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'complexity' });
    } else if (!(DESIGN_GRAPH_COMPLEXITIES as readonly unknown[]).includes(node.complexity)) {
      errors.push({ code: 'INVALID_NODE_FIELD', nodeId: node.nodeId, field: 'complexity', value: node.complexity });
    }
    if (!isNonEmptyTextList(node.complexityRationale)) {
      errors.push({ code: 'MISSING_NODE_FIELD', nodeId: node.nodeId, field: 'complexityRationale' });
    }
    if (!isNonEmptyTextList(node.acceptanceCriteria)) {
      errors.push({ code: 'MISSING_ACCEPTANCE_CRITERIA', nodeId: node.nodeId });
    }
    if (!isNonEmptyTextList(node.evidenceRequirements)) {
      errors.push({ code: 'MISSING_EVIDENCE_REQUIREMENTS', nodeId: node.nodeId });
    }
    if (node.implMode !== 'direct' && node.implMode !== 'team') {
      errors.push({ code: 'INVALID_IMPL_MODE', nodeId: node.nodeId, implMode: node.implMode });
    }
  }

  for (const node of graph.nodes) {
    const dependencies = new Set<string>();
    for (const dependencyNodeId of node.dependencies ?? []) {
      if (dependencyNodeId === node.nodeId) {
        errors.push({ code: 'SELF_DEPENDENCY', nodeId: node.nodeId });
      } else if (dependencies.has(dependencyNodeId)) {
        errors.push({ code: 'DUPLICATE_DEPENDENCY', nodeId: node.nodeId, dependencyNodeId });
      } else if (!nodeIds.has(dependencyNodeId)) {
        errors.push({ code: 'UNKNOWN_DEPENDENCY', nodeId: node.nodeId, dependencyNodeId });
      }
      dependencies.add(dependencyNodeId);
    }
  }

  const edgeKeys = new Set<string>();
  const incomingDependencies = new Map([...nodeIds].map((nodeId) => [nodeId, new Set<string>()]));
  for (const edge of graph.edges) {
    const key = edgeKey(edge);
    if (edgeKeys.has(key)) errors.push({ code: 'DUPLICATE_EDGE', edge: { ...edge } });
    else edgeKeys.add(key);
    if (edge.fromNodeId === edge.toNodeId) {
      errors.push({ code: 'SELF_EDGE', edge: { ...edge } });
      continue;
    }
    if (edge.kind !== undefined && edge.kind !== 'depends_on') {
      errors.push({ code: 'INVALID_EDGE_KIND', edge: { ...edge } });
      continue;
    }
    if (!nodeIds.has(edge.fromNodeId)) {
      errors.push({ code: 'MISSING_ENDPOINT', edge: { ...edge }, missingNodeId: edge.fromNodeId });
    }
    if (!nodeIds.has(edge.toNodeId)) {
      errors.push({ code: 'MISSING_ENDPOINT', edge: { ...edge }, missingNodeId: edge.toNodeId });
    }
    if (nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)) {
      incomingDependencies.get(edge.toNodeId)?.add(edge.fromNodeId);
    }
  }

  for (const node of graph.nodes) {
    if (duplicateNodeIds.has(node.nodeId)) continue;
    const declared = new Set(node.dependencies ?? []);
    const incoming = incomingDependencies.get(node.nodeId) ?? new Set<string>();
    for (const dependencyNodeId of declared) {
      if (nodeIds.has(dependencyNodeId) && dependencyNodeId !== node.nodeId && !incoming.has(dependencyNodeId)) {
        errors.push({ code: 'MISSING_DEPENDENCY_EDGE', nodeId: node.nodeId, dependencyNodeId });
      }
    }
    for (const dependencyNodeId of incoming) {
      if (!declared.has(dependencyNodeId)) {
        errors.push({ code: 'EXTRA_DEPENDENCY_EDGE', nodeId: node.nodeId, dependencyNodeId });
      }
    }
  }

  const cycle = cycleNodeIds(graph, nodeIds);
  if (cycle) errors.push({ code: 'CYCLE', nodeIds: cycle });
  return { valid: errors.length === 0, errors };
}

function canonicalTextList(value: string[] | undefined): string[] {
  return (value ?? []).map((item) => item.trim());
}

function canonicalIdList(value: string[] | undefined): string[] {
  return canonicalTextList(value).sort(compareCanonicalText);
}

function requireValidDesignGraph(graph: DesignGraphDraft): DesignGraphDraft {
  const validation = validateDesignGraph(graph);
  if (!validation.valid) {
    throw new Error(`invalid design graph: ${validation.errors.map((error) => error.code).join(', ')}`);
  }
  return {
    nodes: graph.nodes.map((node) => {
      const copy: DesignGraphNodeDraft = { ...node };
      for (const field of NODE_LIST_FIELDS) {
        const list = node[field];
        if (Array.isArray(list)) Object.assign(copy, { [field]: [...list] });
      }
      return copy;
    }),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

/**
 * Serializes only the approved, author-authored graph contract. Live Issue linkage fields and the
 * legacy opaque detail payload are deliberately excluded from publication identity.
 */
export function canonicalDesignGraph(graph: DesignGraphDraft): string {
  const normalized = requireValidDesignGraph(graph);
  const nodesById = new Map(normalized.nodes.map((node) => [node.nodeId, node]));
  const nodes = topologicalOrder(normalized).map((nodeId) => {
    const node = nodesById.get(nodeId)!;
    return {
      nodeId: node.nodeId,
      title: node.title.trim(),
      goal: node.goal!.trim(),
      background: canonicalTextList(node.background),
      sourceSections: canonicalTextList(node.sourceSections),
      scope: canonicalTextList(node.scope),
      nonGoals: canonicalTextList(node.nonGoals),
      inputs: canonicalTextList(node.inputs),
      outputs: canonicalTextList(node.outputs),
      dependencies: canonicalIdList(node.dependencies),
      implementationNotes: canonicalTextList(node.implementationNotes),
      moduleId: node.moduleId ?? null,
      runtime: node.runtime!,
      agent: node.agent ?? null,
      complexity: node.complexity!,
      complexityRationale: canonicalTextList(node.complexityRationale),
      acceptanceCriteria: canonicalTextList(node.acceptanceCriteria),
      testRecommendations: canonicalTextList(node.testRecommendations),
      evidenceRequirements: canonicalTextList(node.evidenceRequirements),
      completionInstructions: canonicalTextList(node.completionInstructions),
      implMode: node.implMode!,
    };
  });
  const edges = normalized.edges.map((edge) => ({
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    kind: edge.kind ?? 'depends_on',
  })).sort(compareEdges);
  return JSON.stringify({ schemaVersion: 1, nodes, edges });
}

export function canonicalDesignGraphBytes(graph: DesignGraphDraft): Uint8Array {
  return new TextEncoder().encode(canonicalDesignGraph(graph));
}

/** SHA-256 over a domain-separated design/revision envelope plus canonical graph bytes. */
export function designGraphDigest(designId: number, revision: number, graph: DesignGraphDraft): string {
  if (!Number.isSafeInteger(designId) || designId <= 0) throw new Error('designId must be a positive integer');
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error('revision must be a positive integer');
  const hash = createHash('sha256');
  hash.update(`panda.design-graph.v1\u0000${designId}\u0000${revision}\u0000`, 'utf8');
  hash.update(canonicalDesignGraphBytes(graph));
  return hash.digest('hex');
}

export function topologicalOrder(graph: DesignGraphDraft): string[] {
  const normalized = requireValidDesignGraph(graph);

  const nodesById = new Map(normalized.nodes.map((node) => [node.nodeId, node]));
  const incoming = new Map<string, number>(normalized.nodes.map((node) => [node.nodeId, 0]));
  const successors = new Map<string, string[]>(normalized.nodes.map((node) => [node.nodeId, []]));
  for (const edge of deduplicatedSortedEdges(normalized.edges)) {
    incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1);
    successors.get(edge.fromNodeId)?.push(edge.toNodeId);
  }
  for (const list of successors.values()) list.sort((left, right) => compareNodes(nodesById.get(left)!, nodesById.get(right)!));

  const ready = normalized.nodes.filter((node) => incoming.get(node.nodeId) === 0).sort(compareNodes);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    ordered.push(next.nodeId);
    for (const successor of successors.get(next.nodeId) ?? []) {
      const nextIncoming = (incoming.get(successor) ?? 0) - 1;
      incoming.set(successor, nextIncoming);
      if (nextIncoming === 0) {
        ready.push(nodesById.get(successor)!);
        ready.sort(compareNodes);
      }
    }
  }
  return ordered;
}

function assertValid(graph: DesignGraphDraft): void {
  const validation = validateDesignGraph(graph);
  if (!validation.valid) {
    throw new Error(`invalid design graph: ${validation.errors.map((error) => error.code).join(', ')}`);
  }
}

export function splitNode(
  graph: DesignGraphDraft,
  nodeId: string,
  children: DesignGraphNodeDraft[],
): DesignGraphDraft {
  assertValid(graph);
  if (children.length === 0) throw new Error('split requires at least one child');
  if (!graph.nodes.some((node) => node.nodeId === nodeId)) throw new Error(`unknown graph node: ${nodeId}`);

  const childIds = new Set(children.map((child) => child.nodeId));
  if (childIds.size !== children.length || childIds.has(nodeId)) throw new Error('invalid split child IDs');
  if (graph.nodes.some((node) => node.nodeId !== nodeId && childIds.has(node.nodeId))) {
    throw new Error('split child ID already exists');
  }

  const predecessors = graph.edges.filter((edge) => edge.toNodeId === nodeId);
  const successors = graph.edges.filter((edge) => edge.fromNodeId === nodeId);
  const retainedEdges = graph.edges.filter((edge) => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId);
  const rewiredEdges = [
    ...retainedEdges,
    ...predecessors.flatMap((edge) => children.map((child) => ({ ...edge, toNodeId: child.nodeId }))),
    ...successors.flatMap((edge) => children.map((child) => ({ ...edge, fromNodeId: child.nodeId }))),
  ];
  const resultEdges = deduplicatedSortedEdges(rewiredEdges);
  const result: DesignGraphDraft = {
    nodes: nodesWithDependenciesFromEdges(
      graph.nodes.flatMap((node) => node.nodeId === nodeId ? children.map((child) => ({ ...child })) : [{ ...node }]),
      resultEdges,
    ),
    edges: resultEdges,
  };
  assertValid(result);
  return result;
}

export function mergeNodes(
  graph: DesignGraphDraft,
  nodeIds: string[],
  merged: DesignGraphNodeDraft,
): DesignGraphDraft {
  assertValid(graph);
  const mergedIds = new Set(nodeIds);
  if (mergedIds.size === 0 || mergedIds.size !== nodeIds.length) throw new Error('merge requires unique node IDs');
  if ([...mergedIds].some((nodeId) => !graph.nodes.some((node) => node.nodeId === nodeId))) {
    throw new Error('merge references an unknown graph node');
  }
  if (graph.nodes.some((node) => !mergedIds.has(node.nodeId) && node.nodeId === merged.nodeId)) {
    throw new Error('merged node ID already exists');
  }

  const rewiredEdges = graph.edges.flatMap((edge) => {
    const fromMerged = mergedIds.has(edge.fromNodeId);
    const toMerged = mergedIds.has(edge.toNodeId);
    if (fromMerged && toMerged) return [];
    return [{
      ...edge,
      fromNodeId: fromMerged ? merged.nodeId : edge.fromNodeId,
      toNodeId: toMerged ? merged.nodeId : edge.toNodeId,
    }];
  });
  const firstMergedIndex = graph.nodes.findIndex((node) => mergedIds.has(node.nodeId));
  const resultEdges = deduplicatedSortedEdges(rewiredEdges);
  const result: DesignGraphDraft = {
    nodes: nodesWithDependenciesFromEdges(graph.nodes.flatMap((node, index) => {
      if (!mergedIds.has(node.nodeId)) return [{ ...node }];
      return index === firstMergedIndex ? [{ ...merged }] : [];
    }), resultEdges),
    edges: resultEdges,
  };
  assertValid(result);
  return result;
}
