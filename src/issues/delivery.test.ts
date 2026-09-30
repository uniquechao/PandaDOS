import { expect, test } from 'bun:test';
import type { IssueEvent } from '../core/types';
import { issueDelivery } from './delivery';

function event(id: number, kind: string, data: Record<string, unknown> = {}): IssueEvent {
  return { id, issueId: '20260923-0000000', kind, dataJson: JSON.stringify(data), ts: id };
}

test('local completion and remote delivery are independent, and reopening resets old evidence', () => {
  const events = [
    event(1, 'auto_commit'),
    event(2, 'impl_tip', { sha: 'a'.repeat(40) }),
    event(3, 'auto_push_failed'),
  ];
  expect(issueDelivery('done', events)).toEqual({
    implementation: 'complete', commit: 'recorded', commitSha: 'a'.repeat(40),
    push: 'failed', merge: 'not_managed', deploy: 'not_managed',
  });
  expect(issueDelivery('implementing', [...events, event(4, 'reopened')])).toEqual({
    implementation: 'incomplete', commit: 'unrecorded', commitSha: null,
    push: 'not_attempted', merge: 'not_managed', deploy: 'not_managed',
  });
  expect(issueDelivery('done', [...events, event(4, 'auto_push')]).push).toBe('pushed');
});
