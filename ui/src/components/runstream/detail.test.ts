/**
 * 展开区「看全 + 复制」的接线约束（issue #288）。bun test 无 DOM，按仓库既有惯例锁源码不变式：
 * 这些点一旦被改掉，界面上的表现是「按钮永远不出现」「点了没反应」「复制把卡片折叠了」，
 * 全都不会被类型系统或构建挡住。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const detail = read('detail.tsx');
const command = read('CommandEvent.tsx');
const tool = read('ToolEvent.tsx');
const message = read('MessageEvent.tsx');
const thinking = read('ThinkingEvent.tsx');
const index = read('index.tsx');

describe('DetailBody / CopyButton', () => {
  test('只有「服务端确实截过」且还没拿到全文时才出「查看完整内容」', () => {
    expect(detail).toContain(
      "const canLoad = api !== null && off !== undefined && full === undefined && isClipped(text);",
    );
    expect(detail).toContain("tr('ui.showFull')");
  });

  test('拿到全文后显示的就是全文；仍被上限截尾时标注截断', () => {
    expect(detail).toContain("const full = state?.phase === 'ready' ? state.content : undefined;");
    expect(detail).toContain('const shown = full ?? text;');
    expect(detail).toContain("tr('ui.fullTruncated', { shown: state.content.length, total: state.total })");
    expect(detail).toContain("tr('ui.loadFullFailed')");
  });

  test('在途时按钮禁用、不重复请求', () => {
    expect(detail).toContain("const loading = state?.phase === 'loading';");
    expect(detail).toContain('disabled={loading}');
  });

  test('复制/展开按钮都不得把外层可折叠卡片顺手折叠掉', () => {
    expect(detail.match(/e\.stopPropagation\(\);/g)?.length).toBe(2);
  });

  test('复制结果就地反馈成功与失败（失败要告诉用户可以手动选中）', () => {
    expect(detail).toContain("void copyText(text).then((ok) => setState(ok ? 'ok' : 'fail'));");
    expect(detail).toContain("tr('ui.copied')");
    expect(detail).toContain("tr('ui.copyFailed')");
  });
});

describe('复制钮浮层（issue #299）', () => {
  test('复制钮浮在正文右上角的槽里，不再占底部操作条的一行', () => {
    expect(detail).toContain('<div class="rs-copy-slot">');
    expect(detail).toContain('<CopyButton text={shown} />');
  });

  test('操作条只剩「查看完整内容」与说明文案，两者都没有时整条不渲染', () => {
    expect(detail).toContain("const note = state?.phase === 'error' || (state?.phase === 'ready' && state.truncated);");
    expect(detail).toContain('const showBar = canLoad || note;');
    expect(detail).toContain('{showBar && (');
  });

  test('图标钮没有文字：可读名称靠 title/aria-label，失败时才把提示铺开', () => {
    expect(detail).toContain('title={label}');
    expect(detail).toContain('aria-label={label}');
    expect(detail).toContain('{state === \'fail\' && <span class="rs-copy-tx">{label}</span>}');
  });
});

describe('四类事件都接上展开区', () => {
  test('命令：展开先给完整命令块（换行显示），再给输出块；两块各回各的 off', () => {
    expect(command).toContain('class="rs-cmd-full"');
    expect(command).toContain('off={ev.off}');
    expect(command).toContain('off={ev.resultOff}');
    // 命令卡一律可展开：没有输出时「看全这条命令」本身就是展开的理由
    expect(command).not.toContain('nobody');
  });

  test('工具：入参用 ev.off、结果用 ev.resultOff', () => {
    expect(tool).toContain('off={ev.off}');
    expect(tool).toContain('off={ev.resultOff}');
  });

  test('AI/用户消息与思考内容也走 DetailBody（复制按钮 + 必要时回源）', () => {
    expect(message).toContain('<DetailBody');
    expect(message).toContain('role={role}');
    expect(thinking).toContain('<DetailBody');
    expect(thinking).toContain('role="thinking"');
  });

  test('off 从事件流一路透传下去，否则回源无从定位', () => {
    expect(index).toContain('<ThinkingEvent key={k} text={ev.text} off={ev.off} />');
    expect(index).toContain('off={ev.off}');
  });
});
