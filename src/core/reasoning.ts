/**
 * core/reasoning —— 推理档位（codex `model_reasoning_effort`）的定档规则（#281 / I-04）。
 *
 * 病灶：执行机的 `~/.codex/config.toml` 一刀切 `model_reasoning_effort = "high"`，
 * 本周 5.706M 输出 token 里 1.558M 花在推理上。绝大多数 issue 用不着 high。
 *
 * **这个参数是进程启动参数，会话跑起来之后改不了**。所以规则只有一条：**在会话启动那一刻定档**。
 * 不要设计成「按阶段动态下发」，也不要为了切档去重启会话——重启一次会话的代价（重建上下文、
 * 重新读代码）远大于省下来的那点推理 token。
 *
 * 纯函数：入参是普通数据，不碰 DB、不碰 driver。
 */
import type { AgentKind, ReasoningEffort } from './types';

/**
 * 这个代理支不支持推理档位（#281 / Q1 的能力位）。
 *
 * 只有 codex 有 `model_reasoning_effort` 这个启动参数；claude CLI 没有对应开关。
 * **调用方一律问这里，别各写各的 `agent === 'codex'`** —— 以后多一个支持档位的代理，
 * 改这一处就够了，而散落各处的字面量比较一定会漏。
 */
export function supportsReasoningEffort(agent: AgentKind): boolean {
  return agent === 'codex';
}

/**
 * 控制面默认档（模块也没配时用它）。
 *
 * 取 medium 而不是沿用全局 high：默认值决定了绝大多数会话的成本，
 * 真正需要 high 的（迁移、状态机、并发恢复）应当由模块或 issue 显式提档。
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

/** 一次性会话（澄清 / 模块整理 / 降级路径的执行总结 / 设计运行）统一用它 */
export const ONE_SHOT_REASONING_EFFORT: ReasoningEffort = 'low';

/** 定档结果：档位 + 它是从哪一层来的（排查时最想知道的就是这个） */
export interface ResolvedReasoning {
  effort: ReasoningEffort;
  source: 'issue' | 'module' | 'default';
}

/**
 * 定档顺序：**issue 覆盖 > 模块档 > 默认档**。
 * 每层的 `null`/`undefined` 都表示「继承下一层」，不是「关掉」。
 */
export function resolveReasoningEffort(input: {
  issue?: ReasoningEffort | null;
  module?: ReasoningEffort | null;
  fallback?: ReasoningEffort;
}): ResolvedReasoning {
  if (input.issue) return { effort: input.issue, source: 'issue' };
  if (input.module) return { effort: input.module, source: 'module' };
  return { effort: input.fallback ?? DEFAULT_REASONING_EFFORT, source: 'default' };
}

/**
 * 拼给 codex 的启动参数。用 `-c key=value` 的形式（与 `CODEX_NO_UPDATE_FLAG` 同款）：
 * 它每次启动都生效，不依赖执行机上 config.toml 的内容，也就不会被别人改配置带偏。
 * 值加引号是 TOML 字符串的要求。
 */
export function codexReasoningArg(effort: ReasoningEffort): string {
  return `-c model_reasoning_effort="${effort}"`;
}
