/**
 * issues/validation 单测（#279 / I-03）。
 * 纯逻辑部分全是普通数据入参；执行部分用一个记账假执行器，不碰真 Driver。
 */
import { describe, expect, test } from 'bun:test';
import type { CommandResult } from '../executor/driver';
import type { ValidationCommand, ValidationScope } from '../core/types';
import {
  buildValidationCommands,
  candidateTestFiles,
  detectValidationCommands,
  deriveValidationScope,
  failureTail,
  forcesFullScope,
  isTestCommand,
  isTestFile,
  MAX_TARGETED_SOURCE_FILES,
  resolveValidationCommands,
  runValidation,
  VALIDATION_TAIL_CHARS,
  type ValidationExecutor,
} from './validation';

const pkg = JSON.stringify({
  scripts: { dev: 'x', typecheck: 'tsc --noEmit', test: 'bun test', 'build-ui': 'vite build' },
});

describe('命令解析：项目配置 > package.json 探测', () => {
  test('按固定顺序探测 typecheck / test / build-ui（先快后慢，早失败早停）', () => {
    expect(detectValidationCommands(pkg)).toEqual([
      { label: 'typecheck', argv: ['bun', 'run', 'typecheck'] },
      { label: 'test', argv: ['bun', 'run', 'test'] },
      { label: 'build-ui', argv: ['bun', 'run', 'build-ui'] },
    ]);
    // 只有一部分 script 时只出那一部分
    expect(detectValidationCommands(JSON.stringify({ scripts: { test: 'bun test' } })))
      .toEqual([{ label: 'test', argv: ['bun', 'run', 'test'] }]);
  });

  test('读不到 / 解析不了 / 没有匹配 script → 空数组（别假装跑过门禁）', () => {
    expect(detectValidationCommands(null)).toEqual([]);
    expect(detectValidationCommands('{坏')).toEqual([]);
    expect(detectValidationCommands(JSON.stringify({ scripts: { dev: 'x' } }))).toEqual([]);
    expect(detectValidationCommands(JSON.stringify({ scripts: 'nope' }))).toEqual([]);
  });

  test('项目配置优先；null=未配置走探测，空数组=显式不跑门禁（两者不合并）', () => {
    const configured: ValidationCommand[] = [{ label: 'ci', argv: ['make', 'ci'] }];
    expect(resolveValidationCommands(configured, pkg)).toEqual(configured);
    expect(resolveValidationCommands(null, pkg)).toHaveLength(3);
    expect(resolveValidationCommands(undefined, pkg)).toHaveLength(3);
    expect(resolveValidationCommands([], pkg)).toEqual([]); // 显式不跑，不回退探测
  });
});

describe('范围推导：定向是主路径，但拿不准一律退回全量', () => {
  const existing = new Set([
    'src/issues/engine.test.ts',
    'src/issues/validation.test.ts',
    'ui/src/lib/fmt.test.ts',
  ]);

  test('源文件 → 同名测试文件；本身是测试文件的原样进清单', () => {
    expect(candidateTestFiles('src/issues/engine.ts')).toEqual([
      'src/issues/engine.test.ts',
      'src/issues/engine.test.tsx',
    ]);
    expect(candidateTestFiles('./ui/src/lib/fmt.ts')[0]).toBe('ui/src/lib/fmt.test.ts');
    expect(candidateTestFiles('src/issues/engine.test.ts')).toEqual(['src/issues/engine.test.ts']);
    expect(candidateTestFiles('README.md')).toEqual([]);
    expect(isTestFile('a/b.test.tsx')).toBe(true);
    expect(isTestFile('a/b.ts')).toBe(false);
  });

  test('命中存在的测试文件 → targeted，清单去重排序', () => {
    const scope = deriveValidationScope(
      ['src/issues/engine.ts', 'src/issues/validation.ts', 'src/issues/engine.test.ts'],
      existing,
    );
    expect(scope.kind).toBe('targeted');
    expect(scope.files).toEqual(['src/issues/engine.test.ts', 'src/issues/validation.test.ts']);
    expect(scope.reason).toContain('推导出');
  });

  test('四种退回全量的情况，理由都写清楚给人看', () => {
    expect(deriveValidationScope([], existing)).toMatchObject({ kind: 'full', reason: '拿不到本次改动的文件清单' });

    const forced = deriveValidationScope(['src/issues/engine.ts', 'src/core/types.ts'], existing);
    expect(forced.kind).toBe('full');
    expect(forced.reason).toContain('src/core/types.ts');

    const many = Array.from({ length: MAX_TARGETED_SOURCE_FILES + 1 }, (_, i) => `src/x/f${i}.ts`);
    expect(deriveValidationScope(many, existing)).toMatchObject({ kind: 'full' });
    expect(deriveValidationScope(many, existing).reason).toContain('改动面过大');

    expect(deriveValidationScope(['src/x/no-test.ts', 'docs/a.md'], existing))
      .toMatchObject({ kind: 'full', reason: '没有推导出对应的测试文件' });
  });

  test('公共文件判据：类型底座 / Driver 接口 / 迁移 / i18n / 构建配置一律全量', () => {
    for (const p of [
      'package.json', 'bun.lock', 'tsconfig.json', 'vite.config.ts',
      'src/core/types.ts', 'src/core/migrate.ts', 'src/executor/driver.ts',
      'src/issues/migrations/047_validation.sql', 'shared/i18n/catalogs/ja.ts', 'scripts/x.sh',
    ]) {
      expect(forcesFullScope(p)).toBe(true);
    }
    expect(forcesFullScope('src/issues/engine.ts')).toBe(false);
    expect(forcesFullScope('ui/src/components/ChatPane.tsx')).toBe(false);
  });

  test('full 范围不留文件清单（跑的是全量，留着只会误导 UI）', () => {
    expect(deriveValidationScope(['src/core/types.ts'], existing).files).toEqual([]);
  });
});

describe('命令拼装：只给测试那条追加文件，typecheck/构建照旧全量', () => {
  const base: ValidationCommand[] = [
    { label: 'typecheck', argv: ['bun', 'run', 'typecheck'] },
    { label: 'test', argv: ['bun', 'run', 'test'] },
  ];
  const targeted: ValidationScope = { kind: 'targeted', files: ['a.test.ts', 'b.test.ts'], reason: 'x' };

  test('targeted 时把文件拼进测试命令', () => {
    const out = buildValidationCommands(base, targeted);
    expect(out[0]!.argv).toEqual(['bun', 'run', 'typecheck']); // 类型检查缩不了
    expect(out[1]!.argv).toEqual(['bun', 'run', 'test', 'a.test.ts', 'b.test.ts']);
    expect(out[1]!.label).toContain('定向 2 个文件');
  });

  test('full 或空清单时原样返回，且不共享数组引用', () => {
    const out = buildValidationCommands(base, { kind: 'full', files: [], reason: 'x' });
    expect(out).toEqual(base);
    expect(out[0]!.argv).not.toBe(base[0]!.argv);
  });

  test('isTestCommand 认 label 也认 argv（自定义命令也能定向）', () => {
    expect(isTestCommand({ label: 'test', argv: ['make', 'check'] })).toBe(true);
    expect(isTestCommand({ label: '门禁', argv: ['bun', 'test'] })).toBe(true);
    expect(isTestCommand({ label: 'typecheck', argv: ['bun', 'run', 'typecheck'] })).toBe(false);
  });
});

describe('执行与归约', () => {
  const ok = (over: Partial<CommandResult> = {}): CommandResult =>
    ({ code: 0, out: '', err: '', timedOut: false, durationMs: 1, ...over });

  const fakeExec = (results: CommandResult[]): ValidationExecutor & { calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      async runCommand(_cwd, argv) {
        calls.push(argv);
        return results[calls.length - 1] ?? ok();
      },
    };
  };
  const base: ValidationCommand[] = [
    { label: 'typecheck', argv: ['bun', 'run', 'typecheck'] },
    { label: 'test', argv: ['bun', 'run', 'test'] },
    { label: 'build-ui', argv: ['bun', 'run', 'build-ui'] },
  ];
  const full: ValidationScope = { kind: 'full', files: [], reason: '全量' };

  test('全绿：按顺序跑完每一条', async () => {
    const exec = fakeExec([ok(), ok(), ok()]);
    const run = await runValidation(exec, '/repo', base, full);
    expect(run.ok).toBe(true);
    expect(run.skipped).toBe(false);
    expect(run.steps.map((s) => s.label)).toEqual(['typecheck', 'test', 'build-ui']);
    expect(exec.calls).toHaveLength(3);
  });

  test('首个失败即停：后面的命令一条都不跑（别白烧执行机时间）', async () => {
    const exec = fakeExec([ok({ code: 2, err: 'TS2345: 类型不匹配' })]);
    const run = await runValidation(exec, '/repo', base, full);
    expect(run.ok).toBe(false);
    expect(run.failed).toMatchObject({ label: 'typecheck', code: 2 });
    expect(run.steps).toHaveLength(1);
    expect(exec.calls).toHaveLength(1); // test / build-ui 没被调用
    expect(run.tail).toContain('TS2345');
  });

  test('超时算失败，尾部说明是超时而不是用例挂了', async () => {
    const exec = fakeExec([ok(), ok({ code: -1, timedOut: true, err: '' })]);
    const run = await runValidation(exec, '/repo', base, full, { timeoutMs: 60_000 });
    expect(run.ok).toBe(false);
    expect(run.failed).toMatchObject({ label: 'test', timedOut: true });
    expect(run.tail).toContain('超时');
    expect(run.tail).toContain('60s');
  });

  test('一条命令都没有 → skipped，既不是通过也不是失败', async () => {
    const exec = fakeExec([]);
    const run = await runValidation(exec, '/repo', [], full);
    expect(run).toMatchObject({ ok: false, skipped: true, failed: null });
    expect(exec.calls).toHaveLength(0);
  });

  test('定向范围经 runValidation 时真的拼进了测试命令', async () => {
    const exec = fakeExec([ok(), ok(), ok()]);
    await runValidation(exec, '/repo', base, { kind: 'targeted', files: ['a.test.ts'], reason: 'x' });
    expect(exec.calls[1]).toEqual(['bun', 'run', 'test', 'a.test.ts']);
    expect(exec.calls[0]).toEqual(['bun', 'run', 'typecheck']);
  });

  test('failureTail 保尾不保头，stderr 收尾', () => {
    expect(failureTail({ out: 'stdout 内容', err: 'stderr 内容' })).toBe('stdout 内容\n---\nstderr 内容');
    expect(failureTail({ out: '', err: '  ' })).toBe('');
    const long = { out: '', err: 'A'.repeat(VALIDATION_TAIL_CHARS + 500) + 'TAIL' };
    const tail = failureTail(long);
    expect(tail.length).toBe(VALIDATION_TAIL_CHARS);
    expect(tail.endsWith('TAIL')).toBe(true);
  });

  test('stdout 再吵也不能把 stderr 挤掉——门禁失败真的这么丢过现场', () => {
    // 生产实录：全量 bun test 的 stdout 全是各用例打的首启 token 行，旧实现把 err+out
    // 拼起来再截尾，于是回灌的 1200 字里一条 `(fail)` 都没有，只剩 token 噪声。
    const noisy = '[PandaDOS] 首启已创建 admin 用户…token…\n'.repeat(200);
    const failure = '(fail) some suite > some case\n 1 fail\nRan 2727 tests';
    const tail = failureTail({ out: noisy, err: failure });
    expect(tail.length).toBeLessThanOrEqual(VALIDATION_TAIL_CHARS);
    expect(tail).toContain('(fail) some suite > some case');
    expect(tail.endsWith('Ran 2727 tests')).toBe(true);
    // stderr 自己就超预算时，stdout 一个字都不占
    const hugeErr = { out: noisy, err: 'E'.repeat(VALIDATION_TAIL_CHARS + 100) + 'LAST' };
    const tail2 = failureTail(hugeErr);
    expect(tail2.length).toBe(VALIDATION_TAIL_CHARS);
    expect(tail2).not.toContain('首启已创建');
    expect(tail2.endsWith('LAST')).toBe(true);
  });
});

test('documentation gets a static diff check and a missing adjacent test uses the module suite',()=>{
 const docs=deriveValidationScope(['docs/guide.md'],new Set());
 expect(docs.kind).toBe('docs');
 expect(buildValidationCommands([{label:'test',argv:['bun','test']}],docs)).toEqual([{label:'diff-check',argv:['git','diff','--check']}]);
 const module=deriveValidationScope(['src/issues/new-helper.ts'],new Set(['src/issues/engine.test.ts']));
 expect(module).toMatchObject({kind:'targeted',files:['src/issues/engine.test.ts']});
});
