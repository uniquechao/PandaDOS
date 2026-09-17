/**
 * ChatPane 的「查看完整内容」接线约束（issue #288）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');

describe('ChatPane detail 缓存与下发', () => {
  test('detail 帧按 off 落缓存，error 帧落失败态', () => {
    expect(source).toContain("} else if (f.type === 'detail') {");
    expect(source).toContain("'error' in f");
    expect(source).toContain("{ phase: 'ready', content: f.content, truncated: f.truncated, total: f.total }");
  });

  test('切对话必须清缓存：off 是这条对话 jsonl 的字节位置，换对话就全指错地方', () => {
    expect(source).toContain('setDetails({});');
  });

  test('请求带 off 与 role/tool 提示，且在途不重发', () => {
    expect(source).toContain("if (details[off]?.phase === 'loading') return;");
    expect(source).toContain("send({\n          type: 'detail',\n          off,");
    expect(source).toContain("...(hint.role ? { role: hint.role } : {})");
    expect(source).toContain("...(hint.tool ? { tool: hint.tool } : {})");
  });

  test('context 包住整条消息流：模块历史时间线里的 RunStream 也要能展开看全', () => {
    expect(source).toContain('<DetailCtx.Provider value={detailApi}>');
    const provider = source.slice(
      source.indexOf('<DetailCtx.Provider'),
      source.indexOf('</DetailCtx.Provider>'),
    );
    expect(provider).toContain('<ConversationSegments');
    expect(provider).toContain('<RunStream msgs={visibleMsgs}');
  });
});
