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
  });

  test('模块时间线只做历史索引：正文仍只有当前 issue 的消息（#277 / I-01）', () => {
    // 时间线列的是**当前 issue 之前**的段（groupModuleSegments 按 currentIssueId 排除自己），
    // 所以必须把 currentIssueId 传下去；正文那条 RunStream 依旧只吃 visibleMsgs，不能改成全量。
    expect(source).toContain('<ConversationSegments');
    expect(source).toContain('segments={moduleSegments ?? []}');
    expect(source).toContain('currentIssueId={currentIssueId}');
    expect(source).not.toContain('<RunStream msgs={msgs}');
  });
});
