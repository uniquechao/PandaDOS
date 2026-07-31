/**
 * core/model-probe —— 「这条对话现在用的是哪个模型」的探测（issue #109）。
 *
 * 模型名不进 DB、不猜默认值：唯一可信来源是代理自己写的会话 jsonl，读文件尾部窗口倒序扫
 * **最新一条**带模型的行即可（用户在终端里 `/model` 换了模型，下一轮就会写进新行）。
 * 两种格式（与 core/jsonl 同一批文件，行 type 空间不相交，可在同一扫描里自动识别）：
 * - claude：`{type:'assistant', message:{model:'claude-opus-5', …}}`；
 *   注意 CC 给 API 报错等合成消息写的是 `model:'<synthetic>'`，那不是模型名，必须跳过。
 * - codex：`{type:'turn_context', payload:{model:'gpt-5.6-sol', …}}`，每轮一条；
 *   兜底 `{type:'session_meta', payload:{model?}}`（老版本/首轮尚未写 turn_context 时）。
 *
 * 读法与代价：只读尾部 MODEL_TAIL_BYTES 字节（窗口首行多半是半截行，JSON.parse 失败即丢），
 * 并按 (path,size) 缓存——文件没长大就直接给上次的结果，页面轮询不会反复拉文件。
 * 窗口里扫不到（比如中间夹了一条超大工具输出把带模型的行挤出窗口）就沿用上次已知值，
 * 从没扫到过则返回 null（调用方据此「不显示」，绝不拿代理默认模型顶替）。
 */
import { readRange, type JsonlReader } from './jsonl';

/** 尾部探测窗口：128KB 足够装下最近若干轮（claude 每条 assistant 行、codex 每轮 turn_context 都带模型） */
export const MODEL_TAIL_BYTES = 128 * 1024;

/** CC 给合成消息（API 报错等）写的占位模型名，不是真模型 */
const SYNTHETIC_MODEL = '<synthetic>';

/** 模型名合法性：非空字符串、不是合成占位符 */
function cleanModel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s === SYNTHETIC_MODEL) return null;
  return s;
}

/**
 * 一条已 JSON.parse 的 jsonl 行 → 模型原始名（claude / codex 双格式）；不带模型返回 null。
 */
export function parseModelFromEntry(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const row = e as { type?: unknown; message?: { model?: unknown }; payload?: { model?: unknown } };
  if (row.type === 'assistant') return cleanModel(row.message?.model);
  if (row.type === 'turn_context' || row.type === 'session_meta') return cleanModel(row.payload?.model);
  return null;
}

/**
 * 在一段 jsonl 文本里倒序找最新一条带模型的行；找不到返回 null。
 * 文本可以从行中间开始（尾部窗口的常态）——半截行 JSON.parse 失败，直接丢。
 */
export function scanModelInText(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!.trim();
    if (!ln) continue;
    let e: unknown;
    try {
      e = JSON.parse(ln);
    } catch {
      continue;
    }
    const m = parseModelFromEntry(e);
    if (m) return m;
  }
  return null;
}

/** 对话 id → jsonl 路径（core/agent-locator.AgentJsonlLocator 结构子集） */
export interface ModelProbeLocator {
  locate(convId: string): Promise<string | null>;
}

interface CacheEntry {
  path: string;
  size: number;
  model: string | null;
}

/**
 * 按对话探测当前模型（带 (path,size) 缓存）。装配一份即可（reader = 主执行机 Driver，
 * locator = 与引擎/WS 同源的 AgentJsonlLocator，claude/codex 都能定位）。
 */
export class ModelProbe {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly tailBytes: number;

  constructor(
    private readonly reader: JsonlReader,
    private readonly locator: ModelProbeLocator,
    opts?: { tailBytes?: number },
  ) {
    this.tailBytes = Math.max(1, opts?.tailBytes ?? MODEL_TAIL_BYTES);
  }

  /** 丢弃某对话的缓存（对话换了会话文件时用；locate 本身也有失效重扫） */
  invalidate(convId: string): void {
    this.cache.delete(convId);
  }

  /** 该对话当前用的模型原始名；定位不到 / 文件没写 / 从没扫到过 → null（调用方不显示） */
  async modelOf(convId: string): Promise<string | null> {
    const path = await this.locator.locate(convId).catch(() => null);
    if (!path) return null;
    const st = await this.reader.statPath(path).catch(() => null);
    if (!st || st.size <= 0) return null;
    const prev = this.cache.get(convId);
    const known = prev && prev.path === path ? prev.model : null;
    if (prev && prev.path === path && prev.size === st.size) return prev.model;

    const offset = Math.max(0, st.size - this.tailBytes);
    let chunk: Uint8Array;
    try {
      chunk = await readRange(this.reader, path, offset, st.size - offset);
    } catch {
      return known;
    }
    const found = scanModelInText(new TextDecoder('utf-8').decode(chunk));
    // 窗口内没扫到（超大工具输出把带模型的行挤出去了）→ 沿用上次已知值，别闪回「不显示」
    const model = found ?? known;
    this.cache.set(convId, { path, size: st.size, model });
    return model;
  }
}
