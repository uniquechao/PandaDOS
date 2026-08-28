import { describe, expect, test } from 'bun:test';
import {
  canPublishGraph,
  evaluateReadiness,
  type ReadinessDimension,
  type ReadinessDimensionReport,
  type ReadinessBlocker,
  type ReadinessInput,
  type RiskOverride,
} from './readiness';

const dimensions: ReadinessDimension[] = [
  'goal_clarity',
  'scope_boundaries',
  'solution_completeness',
  'dependencies_constraints',
  'acceptance_testability',
  'risks_unknowns',
];

interface ReadinessCase {
  name: string;
  input: ReadinessInput;
  aggregate: number;
  publishable: boolean;
  first: ReadinessDimensionReport;
}

interface OverrideAuditCase {
  name: string;
  blockers: ReadinessBlocker[];
  acceptedBlockerIds: string[];
}

function scoredInput(score: number, threshold = 80): ReadinessInput {
  return {
    threshold,
    dimensions: Object.fromEntries(dimensions.map((dimension) => [dimension, {
      score,
      evidencePaths: [`document.${dimension}`],
      missingItems: [],
      nextQuestions: [],
    }])) as ReadinessInput['dimensions'],
  };
}

describe('evaluateReadiness', () => {
  test.each<ReadinessCase>([
    {
      name: 'scores sparse input as not publishable and supplies all explanatory dimensions',
      input: {},
      aggregate: 0,
      publishable: false,
      first: {
        dimension: 'goal_clarity',
        score: 0,
        weight: 20,
        evidencePaths: [],
        missingItems: ['goal_clarity'],
        nextQuestions: ['What is the intended outcome and who benefits from it?'],
      },
    },
    {
      name: 'uses all supplied dimension evidence in a fully specified report',
      input: scoredInput(100),
      aggregate: 100,
      publishable: true,
      first: {
        dimension: 'goal_clarity',
        score: 100,
        weight: 20,
        evidencePaths: ['document.goal_clarity'],
        missingItems: [],
        nextQuestions: [],
      },
    },
  ])('$name', ({ input, aggregate, publishable, first }) => {
    const report = evaluateReadiness(input);

    expect(report.aggregate).toBe(aggregate);
    expect(report.dimensions).toHaveLength(6);
    expect(report.dimensions[0]).toEqual(first);
    expect(canPublishGraph(report)).toBe(publishable);
  });

  test('keeps explicit hard blockers from being replaced by a passing score', () => {
    const report = evaluateReadiness({
      ...scoredInput(100),
      hardBlockers: [{
        id: 'dependency-owner',
        dimension: 'dependencies_constraints',
        code: 'OWNER_MISSING',
        message: 'The upstream owner is not assigned.',
      }],
    });

    expect(report.aggregate).toBe(100);
    expect(report.hardBlockers).toEqual([{
      id: 'dependency-owner',
      dimension: 'dependencies_constraints',
      code: 'OWNER_MISSING',
      message: 'The upstream owner is not assigned.',
    }]);
    expect(canPublishGraph(report)).toBe(false);
  });

  test.each([
    { score: 79, publishable: false },
    { score: 80, publishable: true },
  ])('honors the threshold boundary at $score', ({ score, publishable }) => {
    const report = evaluateReadiness(scoredInput(score));
    expect(report.aggregate).toBe(score);
    expect(canPublishGraph(report)).toBe(publishable);
  });

  test('requires a complete owner audit before accepting every hard blocker', () => {
    const report = evaluateReadiness({
      ...scoredInput(100),
      hardBlockers: [{
        id: 'risk-unknown',
        dimension: 'risks_unknowns',
        code: 'ROLLBACK_UNKNOWN',
        message: 'The rollback procedure is unknown.',
      }],
    });
    const valid: RiskOverride = {
      ownerActor: 'owner:alice',
      reason: 'Risk accepted for the time-boxed prototype.',
      timestamp: 1_722_842_400_000,
      acceptedBlockerIds: ['risk-unknown'],
    };

    expect(canPublishGraph(report, valid)).toBe(true);
    expect(canPublishGraph(report, { ...valid, reason: ' ' })).toBe(false);
    expect(canPublishGraph(report, { ...valid, acceptedBlockerIds: [] })).toBe(false);
    expect(canPublishGraph(report, { ...valid, ownerActor: '' })).toBe(false);
    expect(canPublishGraph(report, { ...valid, timestamp: 0 })).toBe(false);
  });

  test.each<OverrideAuditCase>([
    {
      name: 'a blank blocker ID',
      blockers: [{
        id: ' ',
        dimension: 'risks_unknowns' as const,
        code: 'ROLLBACK_UNKNOWN',
        message: 'The rollback procedure is unknown.',
      }],
      acceptedBlockerIds: [' '],
    },
    {
      name: 'duplicate blocker IDs',
      blockers: [
        {
          id: 'shared-risk',
          dimension: 'risks_unknowns' as const,
          code: 'ROLLBACK_UNKNOWN',
          message: 'The rollback procedure is unknown.',
        },
        {
          id: 'shared-risk',
          dimension: 'dependencies_constraints' as const,
          code: 'OWNER_MISSING',
          message: 'The upstream owner is not assigned.',
        },
      ],
      acceptedBlockerIds: ['shared-risk'],
    },
  ])('rejects an override when hard blockers have $name', ({ blockers, acceptedBlockerIds }) => {
    const report = evaluateReadiness({ ...scoredInput(100), hardBlockers: blockers });

    expect(canPublishGraph(report, {
      ownerActor: 'owner:alice',
      reason: 'Risk accepted for the time-boxed prototype.',
      timestamp: 1_722_842_400_000,
      acceptedBlockerIds,
    })).toBe(false);
  });
});
