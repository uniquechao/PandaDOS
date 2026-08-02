/**
 * ChatPane 菜单解读接线（issue #112）—— 源码级断言。
 * ChatPane 依赖 WS/DOM，这里只钉住「按需生成、换菜单作废、失败提示」这三条容易被改坏的接线，
 * 帧语义本身由 src/web/ws/chat.test.ts 覆盖。
 */
import { describe, expect, test } from 'bun:test';

const paneUrl = new URL('./ChatPane.tsx', import.meta.url);
const mockUrl = new URL('../lib/mockChat.ts', import.meta.url);
const typesUrl = new URL('../lib/types.ts', import.meta.url);
const cssUrl = new URL('../style.css', import.meta.url);

describe('ChatPane「解释一下」（issue #112）', () => {
  test('点了才发 explain 帧，请求期间钮置灰显示解读中', async () => {
    const src = await Bun.file(paneUrl).text();
    expect(src).toContain("send({ type: 'explain', sig: sel.sig })");
    expect(src).toContain('onClick={askExplain}');
    expect(src).toContain('disabled={explaining}');
    expect(src).toContain("{explaining ? t('ui.explaining') : `🤔 ${t('ui.explain')}`}");
    // 连点守卫：在途不重复发
    expect(src).toContain('if (!sel || explaining) return');
  });

  test('解读按菜单本体签名认领：迟到/错位的解读不显示，换菜单即作废', async () => {
    const src = await Bun.file(paneUrl).text();
    expect(src).toContain('if (f.optionsSig === selOptSig.current)');
    expect(src).toContain("explain.optionsSig === sel.options.join('|')");
    expect(src).toContain('const applySelection = (next: ChatSelection | null): void =>');
    // baseline / selection / stale 三个入口都走 applySelection，避免漏清
    expect(src).toContain('applySelection(f.selection ?? null)');
    expect(src).toContain('applySelection(f.sel ?? null)');
    expect(src).toContain('applySelection(null)');
  });

  test('explain_failed 只在菜单卡里提示，不污染连接状态行', async () => {
    const src = await Bun.file(paneUrl).text();
    expect(src).toContain("f.code === 'explain_failed'");
    expect(src).toContain('setExplainErr(true)');
    expect(src).toContain("t('ui.explainFailed')");
  });

  test('帧类型、mock 与样式都补齐了', async () => {
    const types = await Bun.file(typesUrl).text();
    expect(types).toContain("{ type: 'explanation'; sig: string; optionsSig: string; text: string }");
    expect(types).toContain("{ type: 'explain'; sig: string }");

    const mock = await Bun.file(mockUrl).text();
    expect(mock).toContain("f.type === 'explain'");
    expect(mock).toContain('（mock 解读）');

    const css = await Bun.file(cssUrl).text();
    expect(css).toContain('.copt-why-btn {');
    expect(css).toContain('.copt-why {');
    expect(css).toContain('.copt-why.bad {');
  });
});
