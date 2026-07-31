import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDriver } from '../executor/local';
import type { JsonlReader } from './jsonl';
import { ModelProbe, parseModelFromEntry, scanModelInText } from './model-probe';

let dir: string;
const driver = new LocalDriver();

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-model-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/** claude 一行 assistant（带模型） */
function claudeLine(model: string, text = '好的'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-28T10:00:00.000Z',
    message: { model, content: [{ type: 'text', text }] },
  });
}
/** codex 一行 turn_context（带模型） */
function codexTurn(model: string): string {
  return JSON.stringify({ type: 'turn_context', payload: { cwd: '/tmp', model, approval_policy: 'never' } });
}

/** 记账 reader：数 readFileRange 次数，验缓存真的挡住了重复读 */
function counting(r: JsonlReader): JsonlReader & { reads: number } {
  const o = {
    reads: 0,
    statPath: (p: string) => r.statPath(p),
    readFileRange: (p: string, off: number, lim: number) => {
      o.reads++;
      return r.readFileRange(p, off, lim);
    },
    listDir: (p: string) => r.listDir(p),
  };
  return o;
}

/** 固定路径 locator（对话 id → 文件；null = 定位不到） */
function locatorOf(map: Record<string, string | null>): { locate(id: string): Promise<string | null> } {
  return { locate: (id: string) => Promise.resolve(map[id] ?? null) };
}

async function write(name: string, lines: string[]): Promise<string> {
  const p = path.join(dir, name);
  await fsp.writeFile(p, lines.join('\n') + '\n');
  return p;
}

describe('parseModelFromEntry（单行 → 模型原始名）', () => {
  test('claude assistant 取 message.model', () => {
    expect(parseModelFromEntry(JSON.parse(claudeLine('claude-opus-5')))).toBe('claude-opus-5');
  });

  test('claude 合成消息 <synthetic> 不算模型', () => {
    expect(parseModelFromEntry(JSON.parse(claudeLine('<synthetic>')))).toBeNull();
  });

  test('codex turn_context / session_meta 取 payload.model', () => {
    expect(parseModelFromEntry(JSON.parse(codexTurn('gpt-5.6-sol')))).toBe('gpt-5.6-sol');
    expect(parseModelFromEntry({ type: 'session_meta', payload: { model: 'gpt-5.5' } })).toBe('gpt-5.5');
  });

  test('无模型的行/非对象 → null', () => {
    expect(parseModelFromEntry({ type: 'user', message: { content: '喂' } })).toBeNull();
    expect(parseModelFromEntry({ type: 'session_meta', payload: { model_provider: 'openai' } })).toBeNull();
    expect(parseModelFromEntry(null)).toBeNull();
    expect(parseModelFromEntry('assistant')).toBeNull();
  });
});

describe('scanModelInText（倒序扫最新一条）', () => {
  test('取最新一条带模型的行（换过模型就是新的那个）', () => {
    const text = [claudeLine('claude-sonnet-5'), '{坏行', claudeLine('claude-opus-5'), ''].join('\n');
    expect(scanModelInText(text)).toBe('claude-opus-5');
  });

  test('窗口首行是半截行也不影响（parse 失败即丢）', () => {
    const text = ['ent":{"model":"claude-opus-5"}}', codexTurn('gpt-5.6-sol')].join('\n');
    expect(scanModelInText(text)).toBe('gpt-5.6-sol');
  });

  test('全是无模型的行 → null', () => {
    const text = [JSON.stringify({ type: 'user', message: { content: '你好' } }), ''].join('\n');
    expect(scanModelInText(text)).toBeNull();
  });
});

describe('ModelProbe.modelOf', () => {
  test('claude 会话：取最后一次用的模型', async () => {
    const p = await write('claude.jsonl', [
      claudeLine('claude-sonnet-5'),
      JSON.stringify({ type: 'user', message: { content: '换个模型' } }),
      claudeLine('claude-opus-5'),
      claudeLine('<synthetic>', 'API Error'),
    ]);
    const probe = new ModelProbe(driver, locatorOf({ c1: p }));
    expect(await probe.modelOf('c1')).toBe('claude-opus-5');
  });

  test('codex 会话：turn_context 的 model；只有 session_meta 时兜底', async () => {
    const p = await write('codex.jsonl', [
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai' } }),
      codexTurn('gpt-5.6-sol'),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }),
    ]);
    const meta = await write('codex-meta.jsonl', [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5.5', model_provider: 'openai' } }),
    ]);
    const probe = new ModelProbe(driver, locatorOf({ x1: p, x2: meta }));
    expect(await probe.modelOf('x1')).toBe('gpt-5.6-sol');
    expect(await probe.modelOf('x2')).toBe('gpt-5.5');
  });

  test('扫不到 / 定位不到 / 空文件 → null（不猜默认模型）', async () => {
    const p = await write('nomodel.jsonl', [JSON.stringify({ type: 'user', message: { content: '你好' } })]);
    const empty = await write('empty.jsonl', []);
    await fsp.writeFile(empty, '');
    const probe = new ModelProbe(driver, locatorOf({ n1: p, e1: empty, gone: null }));
    expect(await probe.modelOf('n1')).toBeNull();
    expect(await probe.modelOf('e1')).toBeNull();
    expect(await probe.modelOf('gone')).toBeNull();
  });

  test('size 没变就不再读文件；文件长大后重扫拿到新模型', async () => {
    const p = await write('cache.jsonl', [claudeLine('claude-sonnet-5')]);
    const r = counting(driver);
    const probe = new ModelProbe(r, locatorOf({ k1: p }));
    expect(await probe.modelOf('k1')).toBe('claude-sonnet-5');
    const after1 = r.reads;
    expect(after1).toBeGreaterThan(0);
    expect(await probe.modelOf('k1')).toBe('claude-sonnet-5');
    expect(r.reads).toBe(after1); // 命中缓存，没再读

    await fsp.appendFile(p, claudeLine('claude-opus-5') + '\n');
    expect(await probe.modelOf('k1')).toBe('claude-opus-5');
    expect(r.reads).toBeGreaterThan(after1);
  });

  test('带模型的行被挤出尾部窗口 → 沿用上次已知值', async () => {
    const p = await write('window.jsonl', [claudeLine('claude-opus-5')]);
    const probe = new ModelProbe(driver, locatorOf({ w1: p }), { tailBytes: 512 });
    expect(await probe.modelOf('w1')).toBe('claude-opus-5');
    // 追加一条超过窗口的无模型行：新窗口里已经看不到 assistant 行了
    const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4000) } });
    await fsp.appendFile(p, huge + '\n');
    expect(await probe.modelOf('w1')).toBe('claude-opus-5');
  });
});
