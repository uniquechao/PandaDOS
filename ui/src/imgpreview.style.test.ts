/**
 * 截图缩略图 + 全屏灯箱的样式约束（对齐 runstream/style.test.ts 的字符串校验法）。
 * 守住：缩略图有固定尺寸、灯箱 fixed 全屏且盖在编辑弹窗(.modal-bg)之上、舞台支持原生双指缩放、关闭键触控区够大。
 * 另守住全屏覆盖层的 portal 挂载（issue #79）：裸 z-index 数值比大小挡不住「祖先层叠上下文困住 fixed」
 * ——工作台容器的入场动画 fill-mode:both 让 .fullcol/.wb-split 永久成为层叠上下文，覆盖层不 portal 到
 * body 就会被 .bhead/.id-head(z-index:5) 反压，所以这里做源码级断言。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const readSrc = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

function zIndexOf(selector: string): number {
  return Number(declarations(selector).match(/z-index\s*:\s*(\d+)/)?.[1] ?? '0');
}

describe('截图缩略图 + 灯箱布局约束', () => {
  test('缩略图有固定尺寸（不塌陷）', () => {
    const d = declarations('.imgthumb');
    expect(d).toMatch(/width\s*:\s*\d+px/);
    expect(d).toMatch(/height\s*:\s*\d+px/);
  });

  test('灯箱遮罩 fixed 全屏，且 z-index 高于编辑弹窗 .modal-bg', () => {
    expect(declarations('.lightbox-bg')).toMatch(/position\s*:\s*fixed/);
    expect(zIndexOf('.lightbox-bg')).toBeGreaterThan(zIndexOf('.modal-bg'));
  });

  test('灯箱舞台放开原生双指缩放（touch-action 含 pinch-zoom）', () => {
    expect(declarations('.lightbox-stage')).toMatch(/touch-action\s*:[^;]*pinch-zoom/);
  });

  test('灯箱关闭/下载键触控区够大（≥40px）', () => {
    expect(declarations('.lightbox-dl, .lightbox-x')).toMatch(/height\s*:\s*40px/);
  });

  test('消息内附图行 .rs-msg-imgs 为可换行的 flex 行（复用 .imgthumb 固定尺寸）', () => {
    const d = declarations('.rs-msg-imgs');
    expect(d).toMatch(/display\s*:\s*flex/);
    expect(d).toMatch(/flex-wrap\s*:\s*wrap/);
  });

  test('纯图消息 .rs-msg.imgonly 去掉气泡底色/内边距（不显示空文本气泡）', () => {
    const d = declarations('.rs-msg.imgonly');
    expect(d).toMatch(/background\s*:\s*none/);
    expect(d).toMatch(/padding\s*:\s*0/);
  });
});

describe('全屏覆盖层 portal 到 body（issue #79：防层叠上下文困住 fixed）', () => {
  const overlays = [
    { file: './components/ImageLightbox.tsx', cls: 'lightbox-bg' },
    { file: './components/Modal.tsx', cls: 'modal-bg' },
    { file: './views/Git.tsx', cls: 'gsheet-bg' },
  ];

  for (const { file, cls } of overlays) {
    test(`${file} 的 .${cls} 经 createPortal 挂到 document.body`, () => {
      const src = readSrc(file);
      expect(src).toContain("import { createPortal } from 'preact/compat'");
      expect(src).toContain(`class="${cls}"`);
      // createPortal(<div class="…-bg">…</div>, document.body)：挂载点必须是 body
      expect(src).toMatch(/createPortal\(/);
      expect(src).toMatch(/,\s*document\.body,?\s*\)/);
    });
  }

  test('容器入场动画确实带 fill-mode:both（portal 断言的前提还成立；若动画改掉可重估）', () => {
    expect(declarations('.fullcol')).toMatch(/animation\s*:[^;]*\bboth\b/);
  });
});
