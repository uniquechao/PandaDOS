/**
 * issues/validation —— ValidationRunner：把门禁（类型检查 / 单测 / 构建）从 Agent 会话里搬出去跑（#279 / I-03）。
 *
 * 病灶：门禁一直是「让代理自己在会话里跑」。实测单条 issue 里重复跑了 15 次门禁
 * （typecheck ≥ 5 次、全量 bun test 多次），外加 4 次只为「看跑完没有」的空轮询——
 * **每一次轮询都是一次 200k 上下文的完整模型请求**。把它挪到会话外之后，这几分钟代理是
 * 空闲的、不烧 token；这正是本条的收益，**不要为了「利用空闲」再把并发引回来**。
 *
 * 本文件刻意把纯逻辑与执行分开：
 * - 纯逻辑（命令解析、范围推导、命令拼装、结果归约）不碰 Driver、不碰时钟，全部可单测；
 * - 执行只有 `runValidation` 一个入口，依赖收窄成一个 `runCommand`（ExecutorDriver 的受限入口）。
 */
import type { CommandResult } from '../executor/driver';
import type { ValidationCommand, ValidationScope } from '../core/types';

// ---------- 常量 ----------

/** 探测默认门禁时认的 package.json scripts，**顺序即执行顺序**：先快后慢，早失败早停。 */
export const DEFAULT_SCRIPT_ORDER: readonly string[] = ['typecheck', 'test', 'build-ui'];

/** 单条门禁命令的超时（ms）。全量 bun test 实测 ~70s，留足余量但别让卡死命令拖住引擎。 */
export const VALIDATION_TIMEOUT_MS = 15 * 60 * 1000;

/** 回灌给代理的失败输出上限：注入预算总共才 2000，失败详情只能占一小块。 */
export const VALIDATION_TAIL_CHARS = 1200;

/** 改动文件超过这个数就别费劲定向了，直接全量（大改动的定向推导既不准也省不了多少） */
export const MAX_TARGETED_SOURCE_FILES = 40;

/**
 * 碰了就必须全量的「公共文件」。
 *
 * 判据不是「重要」，而是**改了它，测试影响面无法由文件名推导**：类型底座、Driver 接口、
 * 迁移与 schema、i18n catalog（有跨全仓的一致性校验）、构建与依赖配置。
 * 宁可多跑一次全量，也不要给出一个「定向全绿、全量爆炸」的假绿灯。
 */
export const FULL_SCOPE_PATTERNS: readonly RegExp[] = [
  /^package\.json$/,
  /^bun\.lock(b)?$/,
  /^tsconfig[^/]*\.json$/,
  /^[^/]*\.config\.[cm]?[jt]s$/,
  /^src\/core\/types\.ts$/,
  /^src\/core\/migrate\.ts$/,
  /^src\/executor\/driver\.ts$/,
  /(^|\/)migrations\//,
  /^shared\/i18n\//,
  /^scripts\//,
  /^\.github\//,
];

// ---------- 命令解析 ----------

/**
 * 从 package.json 文本探测默认门禁命令。
 * 解析不了、或一条 script 都没命中 → 空数组（调用方据此记事件并跳过门禁，别假装跑过）。
 */
export function detectValidationCommands(packageJsonText: string | null): ValidationCommand[] {
  if (!packageJsonText) return [];
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(packageJsonText) as unknown;
    const s = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).scripts : null;
    if (s && typeof s === 'object' && !Array.isArray(s)) scripts = s as Record<string, unknown>;
  } catch {
    return [];
  }
  return DEFAULT_SCRIPT_ORDER
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => ({ label: name, argv: ['bun', 'run', name] }));
}

/**
 * 最终门禁命令：**项目配置优先**。
 * `null` = 未配置 → 按 package.json 探测；空数组 = 显式「不跑门禁」，原样返回（两者不同，别合并）。
 */
export function resolveValidationCommands(
  configured: ValidationCommand[] | null | undefined,
  packageJsonText: string | null,
): ValidationCommand[] {
  if (configured) return configured;
  return detectValidationCommands(packageJsonText);
}

// ---------- 范围推导 ----------

const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;
const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;

function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '');
}

/** 这个改动文件本身是不是测试文件 */
export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(normalizePath(path));
}

/** 改了它就只能全量（见 FULL_SCOPE_PATTERNS 的说明） */
export function forcesFullScope(path: string): boolean {
  const p = normalizePath(path);
  return FULL_SCOPE_PATTERNS.some((re) => re.test(p));
}

/**
 * 一个源文件对应的候选测试文件（**只按文件名推，不碰磁盘**）：
 * `src/a/b.ts` → `src/a/b.test.ts`；`.tsx` 同理。存在性由调用方用 driver 校验。
 */
export function candidateTestFiles(path: string): string[] {
  const p = normalizePath(path);
  if (isTestFile(p)) return [p];
  if (!SOURCE_FILE_RE.test(p)) return []; // .md / .css / .sql 推不出测试
  const base = p.replace(SOURCE_FILE_RE, '');
  return [`${base}.test.ts`, `${base}.test.tsx`];
}

/**
 * 推导本轮门禁范围。
 *
 * `existing` 是「候选里**确实存在**的测试文件」集合（调用方拿 driver 校验后传进来）——
 * 这样本函数保持纯函数，磁盘访问留在 `runValidation` 的调用侧。
 *
 * 退回全量的四种情况都写进 `reason`，因为这句话会显示给人看：拿不到改动清单、
 * 改动碰了公共文件、改动面太大、一个测试文件都推不出来。
 */
export function deriveValidationScope(
  changedFiles: readonly string[],
  existing: ReadonlySet<string>,
): ValidationScope {
  const files = changedFiles.map(normalizePath).filter((f) => f.length > 0);
  if (files.length === 0) return { kind: 'full', files: [], reason: '拿不到本次改动的文件清单' };

  if (files.every(f => /\.(md|txt|rst)$/i.test(f))) return { kind: 'docs', files, reason: '仅文档改动，检查差异格式' };

  const forced = files.find((f) => forcesFullScope(f));
  if (forced) return { kind: 'full', files: [], reason: `改动碰了公共文件 ${forced}` };

  if (files.length > MAX_TARGETED_SOURCE_FILES) {
    return { kind: 'full', files: [], reason: `改动面过大（${files.length} 个文件）` };
  }

  const picked: string[] = [];
  for (const f of files) {
    for (const candidate of candidateTestFiles(f)) {
      if (existing.has(candidate) && !picked.includes(candidate)) picked.push(candidate);
    }
  }
  if (picked.length === 0) {
    const modules = new Set(files.map(f => f.split('/').slice(0, f.startsWith('ui/') ? 3 : 2).join('/') + '/'));
    for (const candidate of existing) if ([...modules].some(prefix => candidate.startsWith(prefix))) picked.push(candidate);
  }
  if (picked.length === 0) {
    return { kind: 'full', files: [], reason: '没有推导出对应的测试文件' };
  }
  return {
    kind: 'targeted',
    files: picked.sort(),
    reason: `按 ${files.length} 个改动文件推导出 ${picked.length} 个测试文件`,
  };
}

// ---------- 命令拼装 ----------

/** 这条命令是不是「跑测试」的那条（定向验证只改它，typecheck / build 照旧全量） */
export function isTestCommand(command: ValidationCommand): boolean {
  return command.label === 'test' || command.argv.includes('test');
}

/**
 * 把定向范围拼进命令：只给测试那条命令追加文件参数（`bun run test a.test.ts …`），
 * 其余命令原样保留——typecheck 与构建本来就是全量的，缩不了也不该缩。
 * `full` 范围原样返回。
 */
export function buildValidationCommands(
  base: readonly ValidationCommand[],
  scope: ValidationScope,
): ValidationCommand[] {
  if (scope.kind === 'docs') return [{ label: 'diff-check', argv: ['git', 'diff', '--check'] }];
  if (scope.kind === 'full' || scope.files.length === 0) return base.map((c) => ({ ...c, argv: [...c.argv] }));
  return base.map((c) =>
    isTestCommand(c)
      ? { label: `${c.label}（定向 ${scope.files.length} 个文件）`, argv: [...c.argv, ...scope.files] }
      : { ...c, argv: [...c.argv] },
  );
}

// ---------- 结果归约 ----------

export interface ValidationStepResult {
  label: string;
  argv: string[];
  code: number;
  timedOut: boolean;
  durationMs: number;
}

export interface ValidationRun {
  ok: boolean;
  /** 没有任何可执行命令（未配置且探测不到）——不是通过，也不是失败 */
  skipped: boolean;
  scope: ValidationScope;
  steps: ValidationStepResult[];
  /** 失败那一步（ok=true 时为 null） */
  failed: ValidationStepResult | null;
  /** 回灌给代理的失败输出尾部（已裁剪；ok=true 时为空串） */
  tail: string;
  durationMs: number;
}

/**
 * 失败输出的注入用尾部：**保尾不保头**（失败清单、错误栈、summary 都在末尾），
 * 且 **stderr 的尾部优先保住**——bun/tsc 的失败详情与 summary 都落在 stderr。
 *
 * 早期实现是「err + out 拼成一条再截尾」，结果 out 排在后面、截尾时先保住的是 stdout：
 * 全量 `bun test` 的 stdout 全是各用例打的噪声（每起一个测试服务器就打一行首启 token），
 * 于是回灌给代理的 1200 字里**一条 `(fail)` 都没有**，只有一堆 token 行——生产上真的发生过，
 * 门禁报了 code 1 却谁也不知道挂在哪。所以这里改成：先给 stderr 留够尾部，
 * 剩下的预算才轮到 stdout（stdout 放前面，stderr 收尾，最重要的在最后）。
 */
export function failureTail(result: Pick<CommandResult, 'out' | 'err'>, limit = VALIDATION_TAIL_CHARS): string {
  const err = result.err.trim();
  const out = result.out.trim();
  if (!err) return out.length <= limit ? out : out.slice(-limit);
  const errTail = err.length <= limit ? err : err.slice(-limit);
  const sep = '\n---\n';
  const rest = limit - errTail.length - sep.length;
  if (!out || rest <= 0) return errTail;
  const outTail = out.length <= rest ? out : out.slice(-rest);
  return `${outTail}${sep}${errTail}`;
}

/** 门禁执行的最小依赖：只要 ExecutorDriver 的受限执行入口，不要整个 Driver */
export interface ValidationExecutor {
  runCommand(cwd: string, argv: string[], timeoutMs: number): Promise<CommandResult>;
}

/**
 * 逐条执行门禁，**首个失败即停**。
 *
 * 早停是刻意的：门禁的目的是给出「能不能收尾」的判定，不是攒一份完整体检报告；
 * typecheck 挂了还接着跑 15 分钟全量测试，等于白烧执行机的时间。
 */
export async function runValidation(
  exec: ValidationExecutor,
  cwd: string,
  commands: readonly ValidationCommand[],
  scope: ValidationScope,
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<ValidationRun> {
  const timeoutMs = opts.timeoutMs ?? VALIDATION_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const planned = buildValidationCommands(commands, scope);
  const steps: ValidationStepResult[] = [];

  if (planned.length === 0) {
    return {
      ok: false, skipped: true, scope, steps, failed: null,
      tail: '', durationMs: now() - started,
    };
  }

  for (const command of planned) {
    const r = await exec.runCommand(cwd, command.argv, timeoutMs);
    const step: ValidationStepResult = {
      label: command.label,
      argv: command.argv,
      code: r.code,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
    };
    steps.push(step);
    if (r.code !== 0 || r.timedOut) {
      const tail = r.timedOut
        ? `门禁「${command.label}」超时（>${Math.round(timeoutMs / 1000)}s）被终止。\n${failureTail(r)}`.trim()
        : failureTail(r);
      return { ok: false, skipped: false, scope, steps, failed: step, tail, durationMs: now() - started };
    }
  }
  return { ok: true, skipped: false, scope, steps, failed: null, tail: '', durationMs: now() - started };
}
