import { expect, test } from 'bun:test';
import { RoomDiagnostics, type RoomObservation } from './observability';

test('operator observations project fixed fields and never retain caller error objects or content', () => {
  const metrics = new RoomDiagnostics(() => { throw new Error('PRIVATE_SINK_ERROR'); });
  const input = { phase: 'request', outcome: 'failed', code: 'PRIVATE_API_KEY_IN_ERROR', raw: 'PRIVATE_THOUGHT', url: 'https://PRIVATE_PROVIDER', durationMs: 12.8, attempt: { id: 'PRIVATE_SESSION', projectId: 7, roomId: '87654321-1234-1234-1234-123456789012', missionId: 'PRIVATE_MISSION', role: 'writer' } } as unknown as RoomObservation;
  metrics.record(input);
  const state = metrics.snapshot();
  expect(JSON.stringify(state)).not.toContain('PRIVATE');
  expect(state.recent[0]).toMatchObject({ phase: 'request', outcome: 'failed', code: 'internal_error', durationMs: 12, projectId: 7, role: 'writer' });
  expect(state.counters['request.failed.internal_error']).toBe(1);
  for (let i = 0; i < 100; i++) metrics.record({ phase: 'attempt', outcome: 'succeeded' });
  expect(metrics.snapshot().recent).toHaveLength(64);
  expect(metrics.snapshot().counters['attempt.succeeded.ok']).toBe(100);
});
