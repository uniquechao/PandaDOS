import type { IssueCategory, IssueStatus } from './types';
import { tr } from '../i18n/runtime';

const statusKeys = {
  pending: 'status.pending', clarifying: 'status.clarifying', planning: 'status.planning',
  plan_review: 'status.planReview', implementing: 'status.implementing', testing: 'status.testing',
  merge_review: 'status.mergeReview', merging: 'status.merging', done: 'status.done',
  blocked: 'status.blocked', cancelled: 'status.cancelled',
} as const;

const categoryKeys = {
  task: 'status.categoryTask', design: 'status.categoryDesign', debug: 'status.categoryDebug',
} as const;

export const issueStatusLabel = (status: IssueStatus): string => tr(statusKeys[status]);
export const issueCategoryLabel = (category: IssueCategory): string => tr(categoryKeys[category]);
