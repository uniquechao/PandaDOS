/**
 * copyText 单测（issue #288）：bun 测试环境里没有浏览器，navigator/document 全靠打桩，
 * 覆盖「现代路径成功 / 现代路径抛错回退 / 两条路都不通」三种结局。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { copyText } from './clipboard';

type Globals = { navigator?: unknown; document?: unknown };
const g = globalThis as unknown as Globals;
const origNavigator = g.navigator;
const origDocument = g.document;

afterEach(() => {
  g.navigator = origNavigator;
  g.document = origDocument;
});

/** 最小 document 假件：只够 legacyCopy 跑完，记录 execCommand 拿到的文本 */
function fakeDocument(execOk: boolean): { doc: unknown; copied: () => string | null } {
  let copied: string | null = null;
  const body = {
    appendChild(node: { parentNode?: unknown }) {
      node.parentNode = body;
    },
    removeChild() {
      /* noop */
    },
  };
  const doc = {
    body,
    createElement() {
      return {
        value: '',
        style: {},
        parentNode: null as unknown,
        setAttribute() {},
        select() {
          copied = (this as { value: string }).value;
        },
        setSelectionRange() {},
      };
    },
    execCommand() {
      return execOk;
    },
  };
  return { doc, copied: () => copied };
}

describe('copyText', () => {
  test('有 navigator.clipboard 时直接写入', async () => {
    let got = '';
    g.navigator = { clipboard: { writeText: async (t: string) => { got = t; } } };
    expect(await copyText('要复制的命令')).toBe(true);
    expect(got).toBe('要复制的命令');
  });

  test('clipboard 抛错（非安全上下文/权限被拒）时回退 execCommand', async () => {
    g.navigator = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
    const { doc, copied } = fakeDocument(true);
    g.document = doc;
    expect(await copyText('$ ls -la')).toBe(true);
    expect(copied()).toBe('$ ls -la'); // 兜底路径确实拿到了同一份文本
  });

  test('两条路都不通 / 空文本 → false（调用方提示手动选中复制）', async () => {
    g.navigator = undefined;
    const { doc } = fakeDocument(false);
    g.document = doc;
    expect(await copyText('x')).toBe(false);

    g.document = undefined;
    expect(await copyText('x')).toBe(false);
    expect(await copyText('')).toBe(false);
  });
});
