/**
 * ChatPane 历史加载接线源码约束。bun test 无 DOM，按仓库既有惯例锁定关键协议与展示不变式。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');

describe('ChatPane 历史加载契约', () => {
  test('baseline 接收服务端 hasMore，历史请求携带最旧 off 以支持重连续拉', () => {
    expect(source).toContain('setHasMore(historyExhausted.current ? false : f.hasMore)');
    expect(source).toContain("send({ type: 'history', ...(before !== undefined && before > 0 ? { before } : {}) })");
    expect(source).toContain('pendingAnchor.current = el ? el.scrollHeight : null');
  });

  test('当前 issue 自动回溯到起点且只把当前区间交给 RunStream', () => {
    expect(source).toContain('const visibleMsgs = issueScoped');
    expect(source).toContain('const needsIssueBoundary = issueScoped && !reachedIssueStart');
    expect(source).toContain('<RunStream msgs={visibleMsgs}');
    expect(source).not.toContain('<ConversationSegments');
  });
});
