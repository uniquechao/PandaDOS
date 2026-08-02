/**
 * ChatPane 发送回执接线（issue #116）—— 源码级断言。
 * 纯逻辑（状态机/去重）在 lib/pending.test.ts，帧语义在 src/web/ws/chat.test.ts；
 * 这里只钉住三条容易被改坏的接线：发送即插气泡、ack/err 更新状态、回流即撤。
 */
import { describe, expect, test } from 'bun:test';

const paneUrl = new URL('./ChatPane.tsx', import.meta.url);
const mockUrl = new URL('../lib/mockChat.ts', import.meta.url);
const typesUrl = new URL('../lib/types.ts', import.meta.url);
const cssUrl = new URL('../style.css', import.meta.url);

describe('ChatPane 发送回执（issue #116）', () => {
  test('点发送即插一条乐观气泡，id 随帧发出', async () => {
    const src = await Bun.file(paneUrl).text();
    expect(src).toContain("send({ type: 'text', text: t, ...(rels.length ? { images: rels } : {}), id })");
    expect(src).toContain("sinceOff: maxOffOf(msgs), state: 'sending'");
    expect(src).toContain('{pendingHint(p.state)}');
  });

  test('ack → 已送达；带 id 的 err → 失败（不带 id 的重启补发帧保持发送中）', async () => {
    const src = await Bun.file(paneUrl).text();
    expect(src).toContain("f.type === 'ack'");
    expect(src).toContain("markPending(p, f.id, 'sent')");
    expect(src).toContain('const failedId = f.id;');
    expect(src).toContain("markPending(p, failedId, 'failed')");
  });

  test('真消息回流即撤气泡；切对话清空', async () => {
    const src = await Bun.file(paneUrl).text();
    expect(src).toContain('setPending((p) => prunePending(p, msgs));');
    expect(src).toContain('setPending([]); // 乐观气泡属于上一条对话，跟着清');
  });

  test('帧类型、mock 与样式都补齐了', async () => {
    const types = await Bun.file(typesUrl).text();
    expect(types).toContain("{ type: 'ack'; id: string }");
    expect(types).toContain("{ type: 'err'; code: string; msg?: string; id?: string }");
    expect(types).toContain("{ type: 'text'; text: string; images?: string[]; id?: string }");

    const mock = await Bun.file(mockUrl).text();
    expect(mock).toContain("if (f.id) emit({ type: 'ack', id: f.id }, 120);");

    const css = await Bun.file(cssUrl).text();
    expect(css).toContain('.rs-msg.pending {');
    expect(css).toContain('.rs-msg.pending.failed {');
    expect(css).toContain('.rs-msg-ack {');
  });
});
