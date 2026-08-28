export type ReadinessDimension =
  | 'goal_clarity'
  | 'scope_boundaries'
  | 'solution_completeness'
  | 'dependencies_constraints'
  | 'acceptance_testability'
  | 'risks_unknowns';

export interface ReadinessDimensionInput {
  score?: number;
  evidencePaths?: string[];
  missingItems?: string[];
  nextQuestions?: string[];
}

export interface ReadinessBlocker {
  id: string;
  dimension: ReadinessDimension;
  code: string;
  message: string;
}

export interface ReadinessInput {
  dimensions?: Partial<Record<ReadinessDimension, ReadinessDimensionInput>>;
  hardBlockers?: ReadinessBlocker[];
  threshold?: number;
}

export interface ReadinessDimensionReport {
  dimension: ReadinessDimension;
  score: number;
  weight: number;
  evidencePaths: string[];
  missingItems: string[];
  nextQuestions: string[];
}

export interface ReadinessReport {
  aggregate: number;
  threshold: number;
  dimensions: ReadinessDimensionReport[];
  hardBlockers: ReadinessBlocker[];
}

/** Records the accountable owner and every blocker accepted for an exception. */
export interface RiskOverride {
  ownerActor: string;
  reason: string;
  timestamp: number;
  acceptedBlockerIds: string[];
}

const DIMENSIONS: readonly ReadinessDimension[] = [
  'goal_clarity',
  'scope_boundaries',
  'solution_completeness',
  'dependencies_constraints',
  'acceptance_testability',
  'risks_unknowns',
];

const DIMENSION_DETAILS: Record<ReadinessDimension, { weight: number; question: string }> = {
  goal_clarity: {
    weight: 20,
    question: 'What is the intended outcome and who benefits from it?',
  },
  scope_boundaries: {
    weight: 15,
    question: 'What is explicitly in scope and out of scope?',
  },
  solution_completeness: {
    weight: 20,
    question: 'What implementation approach covers the requested behavior?',
  },
  dependencies_constraints: {
    weight: 15,
    question: 'Which dependencies and constraints need an owner or decision?',
  },
  acceptance_testability: {
    weight: 20,
    question: 'How will each acceptance criterion be verified?',
  },
  risks_unknowns: {
    weight: 10,
    question: 'Which risks or unknowns remain and how will they be handled?',
  },
};

function normalizedInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function dimensionReport(
  dimension: ReadinessDimension,
  input: ReadinessDimensionInput | undefined,
): ReadinessDimensionReport {
  const score = normalizedInteger(input?.score, 0);
  const details = DIMENSION_DETAILS[dimension];
  const missingItems = input?.missingItems?.slice()
    ?? (score === 100 ? [] : [dimension]);
  const nextQuestions = input?.nextQuestions?.slice()
    ?? (score === 100 ? [] : [details.question]);

  return {
    dimension,
    score,
    weight: details.weight,
    evidencePaths: input?.evidencePaths?.slice() ?? [],
    missingItems,
    nextQuestions,
  };
}

export function evaluateReadiness(input: ReadinessInput): ReadinessReport {
  const dimensions = DIMENSIONS.map((dimension) => dimensionReport(dimension, input.dimensions?.[dimension]));
  const aggregate = Math.round(
    dimensions.reduce((total, dimension) => total + dimension.score * dimension.weight, 0) / 100,
  );

  return {
    aggregate,
    threshold: normalizedInteger(input.threshold, 80),
    dimensions,
    hardBlockers: input.hardBlockers?.map((blocker) => ({ ...blocker })) ?? [],
  };
}

function hasCompleteOverride(report: ReadinessReport, override: RiskOverride): boolean {
  if (!override.ownerActor.trim() || !override.reason.trim() || !Number.isFinite(override.timestamp) || override.timestamp <= 0) {
    return false;
  }

  const blockerIds = report.hardBlockers.map((blocker) => blocker.id);
  const requiredIds = new Set(blockerIds);
  if (blockerIds.some((id) => !id.trim()) || requiredIds.size !== blockerIds.length) return false;
  const acceptedIds = new Set(override.acceptedBlockerIds);
  return acceptedIds.size === requiredIds.size
    && override.acceptedBlockerIds.length === acceptedIds.size
    && [...requiredIds].every((id) => acceptedIds.has(id));
}

export function canPublishGraph(report: ReadinessReport, override?: RiskOverride): boolean {
  if (report.aggregate < report.threshold) return false;
  if (report.hardBlockers.length === 0) return true;
  return override !== undefined && hasCompleteOverride(report, override);
}
