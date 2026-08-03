import { describe, expect, test } from 'bun:test';
import { markPending, maxOffOf, normText, prunePending, type PendingMsg } from './pending';
import type { ChatMessage } from './types';

function pend(over: Partial<PendingMsg> & { id: string }): PendingMsg {
  return { text: '继续修 a.ts', imgCount: 0, sinceOff: 100, state: 'sending', ...over };
}
function userMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { seq: 0, role: 'user', text: '继续修 a.ts', off: 200, ...over };
}

describe('lib/pending（issue #116 本地乐观气泡）', () => {
  test('maxOffOf：取已加载消息的最大 off，无 off 返回 -1', () => {
    expect(maxOffOf([])).toBe(-1);
    expect(maxOffOf([{ seq: 0, role: 'user', text: 'a' }])).toBe(-1);
    expect(maxOffOf([userMsg({ off: 10 }), userMsg({ off: 300 }), userMsg({ off: 20 })])).toBe(300);
  });

  test('normText：空白归一（sendKeys 把换行压成空格）', () => {
    expect(normText(' 第一行\n第二行  末尾 ')).toBe('第一行 第二行 末尾');
    expect(normText(undefined)).toBe('');
  });

  test('markPending：改状态；id 不在表里原样返回（引用不变）', () => {
    const list = [pend({ id: 'p1' }), pend({ id: 'p2' })];
    const marked = markPending(list, 'p2', 'sent');
    expect(marked[1]!.state).toBe('sent');
    expect(marked[0]!.state).toBe('sending');
    expect(markPending(list, 'nope', 'failed')).toBe(list);
  });

  test('真消息回流 → 撤掉气泡（空白差异不影响匹配）', () => {
    const list = [pend({ id: 'p1', text: '继续修\na.ts' })];
    expect(prunePending(list, [userMsg({ text: '继续修 a.ts' })])).toEqual([]);
  });

  test('比 sinceOff 更早的同文历史不误撤', () => {
    const list = [pend({ id: 'p1', sinceOff: 300 })];
    expect(prunePending(list, [userMsg({ off: 200 })])).toBe(list); // 无变化返回原引用
    expect(prunePending(list, [userMsg({ off: 400 })])).toEqual([]);
  });

  test('一条回流只认领一条气泡：连发两句一样的话不会被一次全撤', () => {
    const list = [pend({ id: 'p1' }), pend({ id: 'p2' })];
    const left = prunePending(list, [userMsg({ off: 200 })]);
    expect(left.map((p) => p.id)).toEqual(['p2']);
    expect(prunePending(left, [userMsg({ off: 300 })])).toEqual([]);
  });

  test('纯图消息按张数匹配；张数不符不撤', () => {
    const list = [pend({ id: 'p1', text: '', imgCount: 2 })];
    const img = (n: number): ChatMessage =>
      userMsg({ text: '', images: Array.from({ length: n }, (_, i) => `.panda/uploads/x/${i}.png`) });
    expect(prunePending(list, [img(1)])).toBe(list);
    expect(prunePending(list, [img(2)])).toEqual([]);
  });

  test('失败的气泡也参与回流撤销，assistant 消息永不撤气泡', () => {
    const failed = [pend({ id: 'p1', state: 'failed' })];
    expect(prunePending(failed, [userMsg()])).toEqual([]);
    const list = [pend({ id: 'p1' })];
    expect(prunePending(list, [{ seq: 1, role: 'assistant', text: '继续修 a.ts', off: 200 }])).toBe(list);
  });
});
