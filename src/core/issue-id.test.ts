import { describe, expect, test } from 'bun:test';
import {
  compareIssueIds,
  isIssueId,
  machineSuffix,
  newIssueId,
  parseIssueId,
  withNewIssueId,
} from './issue-id';

describe('#307 issue 编号', () => {
  test('新编号 = 本地日期 + 4 位随机 + 3 位机器段', () => {
    const id = newIssueId({ now: new Date(2026, 8, 17, 23, 59), random: 'a3f9', machine: 'e4f' });
    expect(id).toBe('20260917-a3f9e4f');
    expect(isIssueId(id)).toBe(true);
  });

  test('默认生成的编号格式合法，机器段取自本机且稳定', () => {
    const suffix = machineSuffix();
    expect(suffix).toMatch(/^[0-9a-f]{3}$/);
    const id = newIssueId();
    expect(id).toMatch(/^\d{8}-[0-9a-f]{7}$/);
    expect(id.endsWith(suffix)).toBe(true);
  });

  test('parseIssueId 兼容存量数字编号，拒绝非法输入', () => {
    expect(parseIssueId('307')).toBe('307');
    expect(parseIssueId(307)).toBe('307');
    expect(parseIssueId('#20260917-A3F9E4F')).toBe('20260917-a3f9e4f');
    for (const bad of ['', '0', '007', '-1', '1.5', '20260917-a3f9', '20260917-a3f9e4fz', 'abc', null, 0, 1.5]) {
      expect(parseIssueId(bad)).toBeNull();
    }
  });

  test('排序：存量数字按数值在前，新编号按日期字典序', () => {
    const ids = ['20260918-0000abc', '99', '20260917-ffffabc', '307'];
    expect([...ids].sort(compareIssueIds)).toEqual(['99', '307', '20260917-ffffabc', '20260918-0000abc']);
  });

  test('本机撞号（主键冲突）时重新生成，其它错误直接抛出', () => {
    const seen = new Set(['20260917-aaaa000']);
    const candidates = ['20260917-aaaa000', '20260917-bbbb000'];
    const id = withNewIssueId((next) => {
      if (seen.has(next)) throw new Error('UNIQUE constraint failed: issues.id');
      return next;
    }, () => candidates.shift()!);
    expect(id).toBe('20260917-bbbb000');
    expect(() => withNewIssueId(() => { throw new Error('boom'); })).toThrow('boom');
  });
});
