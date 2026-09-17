/**
 * core/git-identity —— 「git 提交身份」的读取与补齐（issue #272 / B-01）。
 *
 * 背景：执行机上曾经根本不存在 `~/.gitconfig`，全局 `user.name` / `user.email` 为空，
 * 而项目登记只在「新建项目」那条路径写过 `--local` 身份，导入进来的项目一个都没写。
 * 于是每个新登记项目的第一次自动提交必然 `Author identity unknown`，引擎又把 commit
 * 失败直接打成 blocked——本周 45% 的 auto_commit 失败几乎全出自这里。
 *
 * 本模块是**身份判定与补齐的唯一维护点**：项目登记（web/routes/projects）、引擎的分支
 * 准备与自动提交自愈都走这里，不要在调用方各写各的 `config --get` / `config --local`。
 *
 * 两条纪律：
 * 1. **只补不覆盖**：已经有值的键一个字都不动（仓库 local 身份是用户自己的选择，
 *    全局身份只是兜底）。只有确实读不到的键才写。
 * 2. **优先写 global，写不动再退 local**：写 global 一次就把这台执行机上所有仓库
 *    （含 worktree、以后新建的项目）都修好；家目录只读 / HOME 不可写时退回 local，
 *    至少保证当前这个仓库能提交。两个作用域都失败才算失败。
 */
import type { ExecutorDriver } from '../executor/driver';

/** 本模块只需要 git 能力；测试可直接传桩 */
export type GitIdentityDriver = Pick<ExecutorDriver, 'git'>;

/** 兜底邮箱域：与 web/routes/projects 里既有的 local 身份约定保持一致 */
export const IDENTITY_EMAIL_DOMAIN = 'users.noreply.pandados.local';

/** 谁都没给时的最后兜底用户名（与全局 ~/.gitconfig 里写的机器人身份同源） */
export const DEFAULT_IDENTITY_USER = 'pandados';

/** git 身份写入的作用域 */
export type GitIdentityScope = 'global' | 'local';

export interface GitIdentity {
  name: string;
  email: string;
}

/** readGitIdentity 的结果；`ok:false` = 读配置本身失败（不是「没配置」） */
export interface GitIdentityRead extends GitIdentity {
  ok: boolean;
  /** 读失败时的原因；ok 时不带 */
  error?: string;
}

/** ensureGitIdentity 的结果 */
export interface EnsureGitIdentityResult extends GitIdentity {
  ok: boolean;
  /** 是否真的写了配置；已有身份时为 false */
  changed: boolean;
  /** 实际写入的作用域；没写时为 null */
  scope: GitIdentityScope | null;
  /** 失败原因；ok 时不带 */
  error?: string;
}

/** 生成兜底身份的输入（都可缺省，按 runUser → ownerUsername → 默认值取第一个非空） */
export interface FallbackIdentityInput {
  runUser?: string | null;
  ownerUsername?: string | null;
}

export interface EnsureGitIdentityOptions {
  /**
   * 候选作用域，按顺序尝试，第一个写成功即止。默认 `['global', 'local']`。
   *
   * **项目登记必须传 `['local']`**：那里写的是「这个项目属主」的身份，写进 global 等于
   * 让先建项目的那个人成为整台执行机的默认提交人，多用户下必然张冠李戴。运行期自愈
   * （引擎侧）才用默认顺序——它补的是机器缺省身份，global 一次修好所有仓库。
   */
  scopes?: readonly GitIdentityScope[];
}

/** 未指定时的作用域顺序：global 一次修好整机，写不动再退 local 保当前仓库 */
const DEFAULT_SCOPES: readonly GitIdentityScope[] = ['global', 'local'];

/** git config 值上限：身份是给人看的短标识，截断避免把异常长的用户名写进配置 */
const IDENTITY_MAX_LEN = 100;

/** 邮箱 local part 只留 RFC 常见安全字符；中文用户名等一律折成 `-` */
const EMAIL_LOCAL_UNSAFE_RE = /[^A-Za-z0-9._-]+/g;

/** 控制字符/换行会破坏 config 文件，统一压成单空格后再截断 */
function sanitizeConfigValue(raw: string): string {
  return raw.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, IDENTITY_MAX_LEN);
}

/** 由显示名推邮箱 local part；折完为空（如纯中文名）时退回默认用户名 */
function emailLocalPart(name: string): string {
  const local = name
    .replace(EMAIL_LOCAL_UNSAFE_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, IDENTITY_MAX_LEN);
  return local || DEFAULT_IDENTITY_USER;
}

/**
 * 兜底身份：项目 run_user → 项目属主用户名 → `pandados`，邮箱一律
 * `<安全化的用户名>@users.noreply.pandados.local`（不可投递的 noreply 域，
 * 不会把机器提交发到真人邮箱上）。
 */
export function buildFallbackIdentity(input: FallbackIdentityInput = {}): GitIdentity {
  const candidates = [input.runUser, input.ownerUsername, DEFAULT_IDENTITY_USER];
  let name = DEFAULT_IDENTITY_USER;
  for (const candidate of candidates) {
    const value = sanitizeConfigValue(candidate ?? '');
    if (value) {
      name = value;
      break;
    }
  }
  return { name, email: `${emailLocalPart(name)}@${IDENTITY_EMAIL_DOMAIN}` };
}

/**
 * 读一个 git config 键。`--get` 的退出码语义：0 = 有值，1 = 没配置（正常，不是错误），
 * 其余（配置文件坏了、cwd 不可用…）才算读失败。
 */
async function readKey(
  driver: GitIdentityDriver,
  cwd: string,
  key: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  let result;
  try {
    result = await driver.git(cwd, ['config', '--get', key]);
  } catch (e) {
    return { ok: false, error: `读取 Git 配置 ${key} 失败：${String(e).slice(0, 200)}` };
  }
  if (result.code === 0) return { ok: true, value: result.out.trim() };
  if (result.code === 1) return { ok: true, value: '' }; // 键不存在
  const detail = (result.err || result.out).trim().slice(0, 200);
  return { ok: false, error: `读取 Git 配置 ${key} 失败：${detail || `退出码 ${result.code}`}` };
}

/**
 * 读取 cwd 下**生效的**提交身份（local > global > system 由 git 自己裁决）。
 * 未配置的键返回空串；只有读配置这件事本身失败才 `ok:false`。
 */
export async function readGitIdentity(
  driver: GitIdentityDriver,
  cwd: string,
): Promise<GitIdentityRead> {
  const name = await readKey(driver, cwd, 'user.name');
  if (!name.ok) return { ok: false, name: '', email: '', error: name.error };
  const email = await readKey(driver, cwd, 'user.email');
  if (!email.ok) return { ok: false, name: name.value, email: '', error: email.error };
  return { ok: true, name: name.value, email: email.value };
}

/** 按作用域写入若干键；任一键写失败即整体失败（调用方换下一个作用域重来） */
async function writeKeys(
  driver: GitIdentityDriver,
  cwd: string,
  scope: GitIdentityScope,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const [key, value] of entries) {
    let result;
    try {
      result = await driver.git(cwd, ['config', `--${scope}`, key, value]);
    } catch (e) {
      return { ok: false, error: `写入 Git 配置 ${key} 失败（--${scope}）：${String(e).slice(0, 200)}` };
    }
    if (result.code !== 0) {
      const detail = (result.err || result.out).trim().slice(0, 200);
      return {
        ok: false,
        error: `写入 Git 配置 ${key} 失败（--${scope}）：${detail || `退出码 ${result.code}`}`,
      };
    }
  }
  return { ok: true };
}

/**
 * 保证 cwd 下有可用的提交身份：已有则原样返回（`changed:false`），缺失则用 fallback 补齐。
 *
 * 默认补齐顺序 global → local：global 一次修好整台执行机，写不动（HOME 只读/不存在）再退
 * local 保当前仓库。退到 local 时会把**所有缺失键**都写一遍（哪怕其中某个刚在 global
 * 写成功了）——local 优先级更高、值又相同，重复写无害，换来的是不必维护「写了一半」的中间态。
 * 项目登记那种「写的是某个人的身份」的场景必须用 `scopes: ['local']` 收窄，见
 * {@link EnsureGitIdentityOptions.scopes}。
 */
export async function ensureGitIdentity(
  driver: GitIdentityDriver,
  cwd: string,
  fallback: GitIdentity,
  options: EnsureGitIdentityOptions = {},
): Promise<EnsureGitIdentityResult> {
  const current = await readGitIdentity(driver, cwd);
  if (!current.ok) {
    return {
      ok: false,
      changed: false,
      scope: null,
      name: fallback.name,
      email: fallback.email,
      error: current.error ?? '读取 Git 身份失败',
    };
  }
  const name = current.name || fallback.name;
  const email = current.email || fallback.email;
  const missing: Array<readonly [string, string]> = [];
  if (!current.name) missing.push(['user.name', fallback.name]);
  if (!current.email) missing.push(['user.email', fallback.email]);
  if (missing.length === 0) {
    return { ok: true, changed: false, scope: null, name, email };
  }

  const scopes = options.scopes?.length ? options.scopes : DEFAULT_SCOPES;
  let lastError = '';
  for (const scope of scopes) {
    const written = await writeKeys(driver, cwd, scope, missing);
    if (written.ok) return { ok: true, changed: true, scope, name, email };
    lastError = written.error;
  }
  return { ok: false, changed: false, scope: null, name, email, error: lastError };
}
