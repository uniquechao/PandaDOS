/**
 * core/git-identity 单测 —— git 提交身份的读取与补齐（issue #272 / B-01）。
 * Driver 用结构替身：不碰真实执行机，也不改测试机上的 ~/.gitconfig。
 */
import { describe, expect, test } from 'bun:test';
import {
  buildFallbackIdentity,
  DEFAULT_IDENTITY_USER,
  ensureGitIdentity,
  IDENTITY_EMAIL_DOMAIN,
  readGitIdentity,
  type GitIdentityDriver,
} from './git-identity';

// ---------- 替身 ----------

interface StubOptions {
  /** 已生效的配置（缺键即「未配置」，对应 `--get` 退出码 1） */
  config?: Record<string, string>;
  /** 读某个键时报错（模拟配置文件损坏）：键 → stderr */
  readError?: Record<string, string>;
  /** 写某个作用域时失败：作用域 → stderr（如 HOME 只读时的 --global） */
  writeError?: Partial<Record<'global' | 'local', string>>;
  /** git() 直接抛（SSH 断线一类） */
  throwOn?: (args: string[]) => string | null;
}

interface Stub extends GitIdentityDriver {
  calls: string[][];
  config: Record<string, string>;
}

function stubDriver(opts: StubOptions = {}): Stub {
  const config = { ...(opts.config ?? {}) };
  const calls: string[][] = [];
  return {
    calls,
    config,
    async git(_cwd: string, args: string[]) {
      calls.push([...args]);
      const thrown = opts.throwOn?.(args);
      if (thrown) throw new Error(thrown);
      if (args[0] === 'config' && args[1] === '--get') {
        const key = args[2]!;
        const err = opts.readError?.[key];
        if (err) return { code: 128, out: '', err };
        const value = config[key];
        return value ? { code: 0, out: `${value}\n`, err: '' } : { code: 1, out: '', err: '' };
      }
      if (args[0] === 'config' && (args[1] === '--global' || args[1] === '--local')) {
        const scope = args[1] === '--global' ? 'global' : 'local';
        const err = opts.writeError?.[scope];
        if (err) return { code: 4, out: '', err };
        config[args[2]!] = args[3]!;
        return { code: 0, out: '', err: '' };
      }
      throw new Error(`替身未覆盖的 git 调用：${args.join(' ')}`);
    },
  };
}

const FALLBACK = { name: 'panda', email: 'panda@users.noreply.pandados.local' };

// ---------- 兜底身份 ----------

describe('buildFallbackIdentity', () => {
  test('runUser 优先于 ownerUsername，再退到默认用户名', () => {
    expect(buildFallbackIdentity({ runUser: 'panda', ownerUsername: 'admin' })).toEqual({
      name: 'panda',
      email: `panda@${IDENTITY_EMAIL_DOMAIN}`,
    });
    expect(buildFallbackIdentity({ runUser: '  ', ownerUsername: 'admin' })).toEqual({
      name: 'admin',
      email: `admin@${IDENTITY_EMAIL_DOMAIN}`,
    });
    expect(buildFallbackIdentity()).toEqual({
      name: DEFAULT_IDENTITY_USER,
      email: `${DEFAULT_IDENTITY_USER}@${IDENTITY_EMAIL_DOMAIN}`,
    });
    expect(buildFallbackIdentity({ runUser: null, ownerUsername: null }).name)
      .toBe(DEFAULT_IDENTITY_USER);
  });

  test('显示名保留原样，邮箱 local part 安全化；折完为空时退回默认用户名', () => {
    // 中文属主名：name 照常展示，邮箱不能带非 ASCII
    const zh = buildFallbackIdentity({ ownerUsername: '徐世超' });
    expect(zh.name).toBe('徐世超');
    expect(zh.email).toBe(`${DEFAULT_IDENTITY_USER}@${IDENTITY_EMAIL_DOMAIN}`);
    // 混合名：不安全字符折成单个 -，首尾的 - 去掉
    expect(buildFallbackIdentity({ ownerUsername: 'zhang san+ops' }).email)
      .toBe(`zhang-san-ops@${IDENTITY_EMAIL_DOMAIN}`);
  });

  test('换行/控制字符被压平截断，不会写坏 config 文件', () => {
    const dirty = buildFallbackIdentity({ runUser: 'bad\nname\ttail' });
    expect(dirty.name).toBe('bad name tail');
    expect(dirty.name).not.toContain('\n');
    expect(buildFallbackIdentity({ runUser: 'x'.repeat(500) }).name).toHaveLength(100);
  });
});

// ---------- 读取 ----------

describe('readGitIdentity', () => {
  test('读到生效身份；未配置的键返回空串而不是失败', async () => {
    const both = await readGitIdentity(
      stubDriver({ config: { 'user.name': 'PandaDOS', 'user.email': 'bot@example.com' } }),
      '/repo',
    );
    expect(both).toEqual({ ok: true, name: 'PandaDOS', email: 'bot@example.com' });

    const none = await readGitIdentity(stubDriver(), '/repo');
    expect(none).toEqual({ ok: true, name: '', email: '' });

    const half = await readGitIdentity(stubDriver({ config: { 'user.name': 'PandaDOS' } }), '/repo');
    expect(half).toEqual({ ok: true, name: 'PandaDOS', email: '' });
  });

  test('读配置报错（非 0/1 退出码）→ ok:false 并带原因', async () => {
    const r = await readGitIdentity(
      stubDriver({ readError: { 'user.name': 'fatal: bad config line 3' } }),
      '/repo',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('user.name');
    expect(r.error).toContain('bad config line 3');
  });

  test('git 调用抛错（SSH 断线一类）也收敛成 ok:false，不抛穿', async () => {
    const r = await readGitIdentity(
      stubDriver({ throwOn: (args) => (args[2] === 'user.email' ? 'connection reset' : null) }),
      '/repo',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('connection reset');
  });
});

// ---------- 补齐 ----------

describe('ensureGitIdentity', () => {
  test('已有身份：一个字都不动，changed:false 且不写任何配置', async () => {
    const driver = stubDriver({ config: { 'user.name': '徐世超-hq', 'user.email': 'me@haiqiao.com' } });
    const r = await ensureGitIdentity(driver, '/repo', FALLBACK);
    expect(r).toEqual({ ok: true, changed: false, scope: null, name: '徐世超-hq', email: 'me@haiqiao.com' });
    expect(driver.calls.some((args) => args[1] === '--global' || args[1] === '--local')).toBe(false);
  });

  test('全空：优先写 global 补齐', async () => {
    const driver = stubDriver();
    const r = await ensureGitIdentity(driver, '/repo', FALLBACK);
    expect(r).toEqual({ ok: true, changed: true, scope: 'global', ...FALLBACK });
    expect(driver.calls.filter((args) => args[1] === '--global')).toEqual([
      ['config', '--global', 'user.name', FALLBACK.name],
      ['config', '--global', 'user.email', FALLBACK.email],
    ]);
    expect(driver.calls.some((args) => args[1] === '--local')).toBe(false);
  });

  test('只缺一个键：只补那个键，已有值不被覆盖', async () => {
    const driver = stubDriver({ config: { 'user.name': '徐世超-hq' } });
    const r = await ensureGitIdentity(driver, '/repo', FALLBACK);
    expect(r).toMatchObject({ ok: true, changed: true, scope: 'global', name: '徐世超-hq', email: FALLBACK.email });
    expect(driver.calls.filter((args) => args[1] === '--global')).toEqual([
      ['config', '--global', 'user.email', FALLBACK.email],
    ]);
    expect(driver.config['user.name']).toBe('徐世超-hq');
  });

  test('global 写不动（HOME 只读）→ 退 local，仍算成功', async () => {
    const driver = stubDriver({ writeError: { global: 'error: could not lock config file' } });
    const r = await ensureGitIdentity(driver, '/repo', FALLBACK);
    expect(r).toEqual({ ok: true, changed: true, scope: 'local', ...FALLBACK });
    expect(driver.calls.filter((args) => args[1] === '--local')).toEqual([
      ['config', '--local', 'user.name', FALLBACK.name],
      ['config', '--local', 'user.email', FALLBACK.email],
    ]);
    expect(driver.config).toEqual({ 'user.name': FALLBACK.name, 'user.email': FALLBACK.email });
  });

  // 项目登记写的是「某个项目属主」的身份，落进 global 会让先建项目的人成为整机默认提交人
  test('scopes:[local] 收窄作用域：只写 local，一次都不碰 global', async () => {
    const driver = stubDriver();
    const r = await ensureGitIdentity(driver, '/repo', FALLBACK, { scopes: ['local'] });
    expect(r).toEqual({ ok: true, changed: true, scope: 'local', ...FALLBACK });
    expect(driver.calls.some((args) => args[1] === '--global')).toBe(false);

    // 收窄后就没有退路了：local 写不动即失败，不会偷偷改去写 global
    const denied = stubDriver({ writeError: { local: 'not in a git directory' } });
    const failed = await ensureGitIdentity(denied, '/repo', FALLBACK, { scopes: ['local'] });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('not in a git directory');
    expect(denied.calls.some((args) => args[1] === '--global')).toBe(false);
  });

  test('两个作用域都写不动 → ok:false 并带最后一次原因', async () => {
    const driver = stubDriver({
      writeError: { global: 'HOME not writable', local: 'not in a git directory' },
    });
    const r = await ensureGitIdentity(driver, '/repo', FALLBACK);
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.scope).toBeNull();
    expect(r.error).toContain('--local');
    expect(r.error).toContain('not in a git directory');
    // 失败也回报「本该生效」的身份，方便调用方直接落事件
    expect({ name: r.name, email: r.email }).toEqual(FALLBACK);
  });

  test('读配置失败时不尝试写入，直接失败返回', async () => {
    const driver = stubDriver({ readError: { 'user.name': 'fatal: bad config' } });
    const r = await ensureGitIdentity(driver, '/repo', FALLBACK);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('bad config');
    expect(driver.calls.some((args) => args[1] === '--global' || args[1] === '--local')).toBe(false);
  });
});
