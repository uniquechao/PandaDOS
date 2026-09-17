import { describe, expect, test } from 'bun:test';
import { resolveChatSync, type ChatSyncAction } from './chatsync';

/**
 * 把决策函数放进「渲染 → 应用动作 → 再渲染」的回路里跑到稳定，返回走过的步数与动作序列。
 * 这正是事故的形状：真正要守住的不变量是**它必须收敛**，而不是某一步返回了什么。
 */
function settle(
  start: { cid: string | undefined; selected: string | null },
  conversationIds: readonly string[] | null,
  maxSteps = 20,
): { steps: ChatSyncAction[]; cid: string | undefined; selected: string | null; converged: boolean } {
  let { cid, selected } = start;
  let prevCid = start.cid;
  const steps: ChatSyncAction[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const action = resolveChatSync({ cid, prevCid, selected, conversationIds });
    prevCid = cid;
    if (action.kind === 'none') return { steps, cid, selected, converged: true };
    steps.push(action);
    if (action.kind === 'select') selected = action.convId;
    else cid = action.convId ?? undefined; // nav 后 hashchange 回来 = 下一帧的 cid
  }
  return { steps, cid, selected, converged: false };
}

const CONVS = ['a', 'b', 'c'];

describe('对话页地址栏同步', () => {
  test('新建对话：selected 变了 → 地址栏跟上，一步收敛（不与地址栏对打）', () => {
    // 事故现场：地址栏还是旧对话 a，用户刚新建 b 并选中
    const r = settle({ cid: 'a', selected: 'b' }, CONVS);
    expect(r.converged).toBe(true);
    expect(r.steps).toEqual([{ kind: 'nav', convId: 'b' }]);
    expect(r.cid).toBe('b');
    expect(r.selected).toBe('b'); // 绝不能被地址栏把选中项拽回 a
  });

  test('返回/前进：地址栏这一帧真的变了 → 跟随它，不把用户的后退撤销', () => {
    const first = resolveChatSync({ cid: 'a', prevCid: 'b', selected: 'b', conversationIds: CONVS });
    expect(first).toEqual({ kind: 'select', convId: 'a' });
    const r = settle({ cid: 'a', selected: 'a' }, CONVS);
    expect(r.converged).toBe(true);
    expect(r.steps).toEqual([]);
  });

  test('深链指向不存在的对话：回落到当前选中项并清掉地址栏里的坏 id', () => {
    const r = settle({ cid: 'zzz', selected: 'a' }, CONVS);
    expect(r.converged).toBe(true);
    expect(r.cid).toBe('a');
    expect(r.selected).toBe('a');
  });

  test('窄屏返回列表（selected=null）：地址栏退回不带 id 的对话页', () => {
    const r = settle({ cid: 'a', selected: null }, CONVS);
    expect(r.converged).toBe(true);
    expect(r.steps).toEqual([{ kind: 'nav', convId: null }]);
    expect(r.cid).toBeUndefined();
  });

  test('列表未就绪：一律不动（别抢在初始选中之前抹掉深链）', () => {
    expect(resolveChatSync({ cid: 'a', prevCid: undefined, selected: null, conversationIds: null }))
      .toEqual({ kind: 'none' });
  });

  test('任意起始组合都在两步内收敛（守住「不许来回颠」这条底线）', () => {
    const ids: Array<string | undefined> = [undefined, 'a', 'b', 'zzz'];
    const sels: Array<string | null> = [null, 'a', 'b'];
    for (const cid of ids) {
      for (const selected of sels) {
        const r = settle({ cid, selected }, CONVS);
        expect({ cid, selected, converged: r.converged, steps: r.steps.length })
          .toEqual({ cid, selected, converged: true, steps: r.steps.length });
        expect(r.steps.length).toBeLessThanOrEqual(2);
      }
    }
  });
});
