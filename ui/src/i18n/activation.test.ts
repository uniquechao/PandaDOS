import { describe, expect, test } from 'bun:test';
import { LatestActivation } from './activation';

describe('LatestActivation', () => {
  test('only the newest catalog request may update locale state', () => {
    const gate = new LatestActivation();
    const deviceRequest = gate.begin();
    const accountRequest = gate.begin();
    expect(gate.isCurrent(deviceRequest)).toBe(false);
    expect(gate.isCurrent(accountRequest)).toBe(true);
  });
});
