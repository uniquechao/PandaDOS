import { describe, expect, test } from 'bun:test';
import {
  canonicalDesignGraph,
  canonicalDesignGraphBytes,
  designGraphDigest,
  mergeNodes,
  normalizeDesignGraphGranularity,
  splitNode,
  topologicalOrder,
  validateDesignGraph,
  type DesignGraphDraft,
  type DesignGraphNodeDraft,
} from './graph';

function node(nodeId: string, ordinal?: number): DesignGraphNodeDraft {
  return {
    nodeId,
    ordinal,
    title: nodeId,
    goal: `Deliver ${nodeId}`,
    background: [`${nodeId} background`],
    sourceSections: [`${nodeId} source`],
    scope: [`${nodeId} scope`],
    nonGoals: [`${nodeId} non-goal`],
    inputs: [`${nodeId} input`],
    outputs: [`${nodeId} output`],
    dependencies: [],
    implementationNotes: [`Implement ${nodeId}`],
    moduleId: null,
    runtime: 'current',
    agent: null,
    complexity: 'medium',
    complexityRationale: [`${nodeId} needs coordination`],
    acceptanceCriteria: [`${nodeId} works`],
    testRecommendations: [`Test ${nodeId}`],
    evidenceRequirements: [`${nodeId} test`],
    completionInstructions: [`Report ${nodeId} outcome`],
    implMode: 'direct',
  };
}

function graph(nodes: DesignGraphNodeDraft[], edges: DesignGraphDraft['edges'] = []): DesignGraphDraft {
  return { nodes, edges };
}

function expectInvalidGraph(input: unknown): void {
  let validation: ReturnType<typeof validateDesignGraph> | undefined;
  expect(() => {
    validation = validateDesignGraph(input as DesignGraphDraft);
  }).not.toThrow();
  expect(validation?.valid).toBe(false);
  expect(() => canonicalDesignGraph(input as DesignGraphDraft)).toThrow(/^invalid design graph:/);
}

describe('Design graph validation', () => {
  test('normalizes the five granularity wire values and the legacy issue value', () => {
    expect([
      'milestone',
      'module',
      'balanced',
      'small',
      'atomic',
    ].map(normalizeDesignGraphGranularity)).toEqual([
      'milestone',
      'module',
      'balanced',
      'small',
      'atomic',
    ]);
    expect(normalizeDesignGraphGranularity('issue')).toBe('balanced');
    expect(normalizeDesignGraphGranularity('small_issue')).toBeNull();
    expect(normalizeDesignGraphGranularity('free-form')).toBeNull();
  });

  test('validates a diamond DAG and returns a stable deterministic order', () => {
    const implement = { ...node('implement'), dependencies: ['research'] };
    const deploy = { ...node('deploy'), dependencies: ['implement'] };
    const verify = { ...node('test'), dependencies: ['implement'] };
    const draft = graph(
      [deploy, verify, implement, node('research')],
      [
        { fromNodeId: 'research', toNodeId: 'implement' },
        { fromNodeId: 'implement', toNodeId: 'test' },
        { fromNodeId: 'implement', toNodeId: 'deploy' },
      ],
    );

    expect(validateDesignGraph(draft)).toEqual({ valid: true, errors: [] });
    expect(topologicalOrder(draft)).toEqual(['research', 'implement', 'deploy', 'test']);
  });

  test('rejects cycles, duplicate IDs, self edges, and missing endpoints', () => {
    const draft = graph(
      [node('a'), node('a'), node('b')],
      [
        { fromNodeId: 'a', toNodeId: 'a' },
        { fromNodeId: 'a', toNodeId: 'missing' },
        { fromNodeId: 'a', toNodeId: 'b' },
        { fromNodeId: 'b', toNodeId: 'a' },
      ],
    );
    draft.nodes[2]!.dependencies = ['a'];
    draft.nodes[0]!.dependencies = ['b'];

    expect(validateDesignGraph(draft)).toEqual({
      valid: false,
      errors: [
        { code: 'DUPLICATE_NODE_ID', nodeId: 'a' },
        { code: 'SELF_EDGE', edge: { fromNodeId: 'a', toNodeId: 'a' } },
        { code: 'MISSING_ENDPOINT', edge: { fromNodeId: 'a', toNodeId: 'missing' }, missingNodeId: 'missing' },
        { code: 'CYCLE', nodeIds: ['a', 'b'] },
      ],
    });
  });

  test('rejects nodes without acceptance, evidence, or a supported implementation mode', () => {
    const draft = graph([
      { ...node('acceptance'), acceptanceCriteria: [] },
      { ...node('evidence'), evidenceRequirements: ['  '] },
      { ...node('mode'), implMode: 'sequential' as never },
    ]);

    expect(validateDesignGraph(draft)).toEqual({
      valid: false,
      errors: [
        { code: 'MISSING_ACCEPTANCE_CRITERIA', nodeId: 'acceptance' },
        { code: 'MISSING_EVIDENCE_REQUIREMENTS', nodeId: 'evidence' },
        { code: 'INVALID_IMPL_MODE', nodeId: 'mode', implMode: 'sequential' },
      ],
    });
  });

  test('returns field-specific errors for an incomplete publication contract', () => {
    const incomplete = {
      ...node('incomplete'),
      goal: ' ',
      scope: [],
      nonGoals: [' '],
      implementationNotes: [],
      testRecommendations: [],
      completionInstructions: [],
      moduleId: -1,
      runtime: 'remote' as never,
      agent: 'other' as never,
      complexity: 'huge' as never,
      complexityRationale: [],
    };

    expect(validateDesignGraph(graph([incomplete])).errors).toEqual(expect.arrayContaining([
      { code: 'MISSING_NODE_FIELD', nodeId: 'incomplete', field: 'goal' },
      { code: 'MISSING_NODE_FIELD', nodeId: 'incomplete', field: 'scope' },
      { code: 'MISSING_NODE_FIELD', nodeId: 'incomplete', field: 'nonGoals' },
      { code: 'MISSING_NODE_FIELD', nodeId: 'incomplete', field: 'implementationNotes' },
      { code: 'MISSING_NODE_FIELD', nodeId: 'incomplete', field: 'testRecommendations' },
      { code: 'MISSING_NODE_FIELD', nodeId: 'incomplete', field: 'completionInstructions' },
      { code: 'INVALID_NODE_FIELD', nodeId: 'incomplete', field: 'moduleId', value: -1 },
      { code: 'INVALID_NODE_FIELD', nodeId: 'incomplete', field: 'runtime', value: 'remote' },
      { code: 'INVALID_NODE_FIELD', nodeId: 'incomplete', field: 'agent', value: 'other' },
      { code: 'INVALID_NODE_FIELD', nodeId: 'incomplete', field: 'complexity', value: 'huge' },
      { code: 'MISSING_NODE_FIELD', nodeId: 'incomplete', field: 'complexityRationale' },
    ]));
  });

  test('purely rejects malformed graph/node/edge containers before semantic validation', () => {
    for (const malformed of [
      null,
      {},
      { nodes: {}, edges: [] },
      { nodes: [], edges: {} },
      { nodes: [null], edges: [] },
      { nodes: [node('valid')], edges: [null] },
    ]) expectInvalidGraph(malformed);
  });

  test('validates every scalar, ID, ordinal, and nullable enum field at runtime', () => {
    const scalarCases: Array<[keyof DesignGraphNodeDraft, unknown]> = [
      ['nodeId', 7],
      ['nodeId', ' '],
      ['nodeId', ' subject '],
      ['nodeId', 'x'.repeat(121)],
      ['ordinal', -1],
      ['ordinal', 1.5],
      ['title', 7],
      ['title', ' '],
      ['title', 'x'.repeat(201)],
      ['goal', 7],
      ['goal', ' '],
      ['goal', 'x'.repeat(8_001)],
      ['moduleId', 0],
      ['moduleId', 1.5],
      ['runtime', null],
      ['runtime', 'remote'],
      ['agent', 7],
      ['agent', 'other'],
      ['complexity', null],
      ['complexity', 'huge'],
      ['implMode', null],
      ['implMode', 'parallel'],
      ['issueId', 0],
      ['issueId', 1.5],
      ['lastSyncedRevision', -1],
      ['lastSyncedRevision', 1.5],
    ];
    for (const [field, value] of scalarCases) {
      expectInvalidGraph(graph([{ ...node('subject'), [field]: value } as DesignGraphNodeDraft]));
    }

    for (const malformed of [
      graph([node('valid')], [{ fromNodeId: 7 as never, toNodeId: 'valid' }]),
      graph([node('valid')], [{ fromNodeId: ' ', toNodeId: 'valid' }]),
      graph([node('valid')], [{ fromNodeId: 'x'.repeat(121), toNodeId: 'valid' }]),
      graph([node('valid')], [{ fromNodeId: 'valid', toNodeId: 7 as never }]),
      graph([node('valid')], [{ fromNodeId: 'valid', toNodeId: ' ' }]),
      graph([node('valid')], [{ fromNodeId: 'valid', toNodeId: 'x'.repeat(121) }]),
      graph([node('valid')], [{ fromNodeId: 'valid', toNodeId: 'other', kind: 7 as never }]),
    ]) expectInvalidGraph(malformed);
  });

  test('validates type, element whitespace, item count, and item length for every contract list', () => {
    const listFields: Array<keyof DesignGraphNodeDraft> = [
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
    ];
    for (const field of listFields) {
      for (const value of [7, [7], [' '], Array(101).fill('item'), ['x'.repeat(4_001)]]) {
        expectInvalidGraph(graph([{ ...node('subject'), [field]: value } as DesignGraphNodeDraft]));
      }
    }
  });

  test('rejects unknown node dependencies and duplicate graph edges', () => {
    const dependent = { ...node('dependent'), dependencies: ['root', 'missing'] };
    const draft = graph([node('root'), dependent], [
      { fromNodeId: 'root', toNodeId: 'dependent' },
      { fromNodeId: 'root', toNodeId: 'dependent' },
    ]);

    expect(validateDesignGraph(draft).errors).toEqual(expect.arrayContaining([
      { code: 'UNKNOWN_DEPENDENCY', nodeId: 'dependent', dependencyNodeId: 'missing' },
      { code: 'DUPLICATE_EDGE', edge: { fromNodeId: 'root', toNodeId: 'dependent' } },
    ]));
  });

  test('requires dependencies to exactly match prerequisite-to-dependent depends_on edges', () => {
    const cases = [
      graph([node('root'), { ...node('dependent'), dependencies: ['root'] }]),
      graph([node('root'), { ...node('dependent'), dependencies: ['root'] }], [
        { fromNodeId: 'dependent', toNodeId: 'root' },
      ]),
      graph([node('root'), node('dependent')], [
        { fromNodeId: 'root', toNodeId: 'dependent' },
      ]),
      graph([node('root'), { ...node('dependent'), dependencies: ['root'] }], [
        { fromNodeId: 'root', toNodeId: 'dependent', kind: 'related_to' },
      ]),
    ];

    expect(cases.map((draft) => validateDesignGraph(draft).valid)).toEqual([false, false, false, false]);
    expect(validateDesignGraph(cases[0]!).errors).toContainEqual({
      code: 'MISSING_DEPENDENCY_EDGE',
      nodeId: 'dependent',
      dependencyNodeId: 'root',
    });
    expect(validateDesignGraph(cases[2]!).errors).toContainEqual({
      code: 'EXTRA_DEPENDENCY_EDGE',
      nodeId: 'dependent',
      dependencyNodeId: 'root',
    });
    expect(validateDesignGraph(cases[3]!).errors).toContainEqual({
      code: 'INVALID_EDGE_KIND',
      edge: { fromNodeId: 'root', toNodeId: 'dependent', kind: 'related_to' },
    });
  });

  test('uses prerequisite-to-dependent direction and keeps impl mode independent of granularity', () => {
    const dependent = { ...node('dependent'), dependencies: ['prerequisite'], implMode: 'team' as const };
    const draft = graph([dependent, node('prerequisite')], [
      { fromNodeId: 'prerequisite', toNodeId: 'dependent' },
    ]);

    expect(topologicalOrder(draft)).toEqual(['prerequisite', 'dependent']);
    for (const granularity of ['milestone', 'module', 'balanced', 'small', 'atomic'] as const) {
      expect(normalizeDesignGraphGranularity(granularity)).toBe(granularity);
      expect(canonicalDesignGraph(draft)).toContain('"implMode":"team"');
    }
  });

  test('serializes and digests equivalent reordered input identically', () => {
    const root = node('root');
    const second = { ...node('second'), dependencies: ['root'], scope: ['zeta', 'alpha'] };
    const third = { ...node('third'), dependencies: ['root'], scope: ['alpha', 'zeta'] };
    const firstGraph = graph([third, root, second], [
      { fromNodeId: 'root', toNodeId: 'third', kind: 'depends_on' },
      { fromNodeId: 'root', toNodeId: 'second' },
    ]);
    const reorderedGraph = graph([second, third, root], [
      { toNodeId: 'second', fromNodeId: 'root', kind: 'depends_on' },
      { toNodeId: 'third', kind: 'depends_on', fromNodeId: 'root' },
    ]);

    expect(new TextDecoder().decode(canonicalDesignGraphBytes(firstGraph)))
      .toBe(canonicalDesignGraph(reorderedGraph));
    expect(designGraphDigest(42, 7, firstGraph)).toBe(designGraphDigest(42, 7, reorderedGraph));
    expect(designGraphDigest(42, 7, firstGraph)).not.toBe(designGraphDigest(42, 8, firstGraph));
    expect(designGraphDigest(42, 7, firstGraph)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('canonicalizes dependency sets but preserves authored instruction order', () => {
    const dependent = {
      ...node('dependent'),
      dependencies: ['root-b', 'root-a'],
      implementationNotes: ['First change the schema.', 'Then update the mapper.'],
    };
    const draft = graph([dependent, node('root-b'), node('root-a')], [
      { fromNodeId: 'root-b', toNodeId: 'dependent' },
      { fromNodeId: 'root-a', toNodeId: 'dependent' },
    ]);
    const reorderedDependencies = graph([
      { ...dependent, dependencies: ['root-a', 'root-b'] },
      node('root-a'),
      node('root-b'),
    ], [...draft.edges].reverse());
    const reorderedInstructions = graph([
      { ...dependent, implementationNotes: [...dependent.implementationNotes].reverse() },
      node('root-a'),
      node('root-b'),
    ], [...draft.edges].reverse());

    expect(designGraphDigest(42, 7, draft)).toBe(designGraphDigest(42, 7, reorderedDependencies));
    expect(designGraphDigest(42, 7, draft)).not.toBe(designGraphDigest(42, 7, reorderedInstructions));
  });

  test('uses raw Unicode code-unit ordering without localeCompare for every canonical set', () => {
    const dependent = { ...node('dependent'), dependencies: ['ä', 'z'] };
    const draft = graph([dependent, node('ä'), node('z')], [
      { fromNodeId: 'ä', toNodeId: 'dependent' },
      { fromNodeId: 'z', toNodeId: 'dependent' },
    ]);
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('canonical ordering must not use the process locale');
    };
    try {
      const canonical = JSON.parse(canonicalDesignGraph(draft)) as {
        nodes: Array<{ nodeId: string; dependencies: string[] }>;
        edges: Array<{ fromNodeId: string }>;
      };
      expect(canonical.nodes.map((item) => item.nodeId)).toEqual(['z', 'ä', 'dependent']);
      expect(canonical.nodes[2]?.dependencies).toEqual(['z', 'ä']);
      expect(canonical.edges.map((edge) => edge.fromNodeId)).toEqual(['z', 'ä']);
      expect(designGraphDigest(42, 7, draft)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  test('replaces a node with children while connecting every predecessor and successor', () => {
    const result = splitNode(
      graph(
        [
          node('research'),
          { ...node('implement'), dependencies: ['research'] },
          { ...node('verify'), dependencies: ['implement'] },
        ],
        [
          { fromNodeId: 'research', toNodeId: 'implement' },
          { fromNodeId: 'implement', toNodeId: 'verify' },
        ],
      ),
      'implement',
      [
        { ...node('api'), dependencies: ['research'] },
        { ...node('ui'), dependencies: ['research'] },
      ],
    );

    expect(result.nodes.map((item) => item.nodeId)).toEqual(['research', 'api', 'ui', 'verify']);
    expect(result.edges).toEqual([
      { fromNodeId: 'api', toNodeId: 'verify' },
      { fromNodeId: 'research', toNodeId: 'api' },
      { fromNodeId: 'research', toNodeId: 'ui' },
      { fromNodeId: 'ui', toNodeId: 'verify' },
    ]);
    expect(result.nodes.map((item) => [item.nodeId, item.dependencies])).toEqual([
      ['research', []],
      ['api', ['research']],
      ['ui', ['research']],
      ['verify', ['api', 'ui']],
    ]);
  });

  test('merges nodes, preserves external dependencies, and deduplicates rewired edges', () => {
    const result = mergeNodes(
      graph(
        [
          node('research'),
          { ...node('api'), dependencies: ['research'] },
          { ...node('ui'), dependencies: ['research', 'api'] },
          { ...node('verify'), dependencies: ['api', 'ui'] },
        ],
        [
          { fromNodeId: 'research', toNodeId: 'api' },
          { fromNodeId: 'research', toNodeId: 'ui' },
          { fromNodeId: 'api', toNodeId: 'verify' },
          { fromNodeId: 'ui', toNodeId: 'verify' },
          { fromNodeId: 'api', toNodeId: 'ui' },
        ],
      ),
      ['api', 'ui'],
      { ...node('implementation'), dependencies: ['research'] },
    );

    expect(result.nodes.map((item) => item.nodeId)).toEqual(['research', 'implementation', 'verify']);
    expect(result.edges).toEqual([
      { fromNodeId: 'implementation', toNodeId: 'verify' },
      { fromNodeId: 'research', toNodeId: 'implementation' },
    ]);
    expect(result.nodes.map((item) => [item.nodeId, item.dependencies])).toEqual([
      ['research', []],
      ['implementation', ['research']],
      ['verify', ['implementation']],
    ]);
  });
});
