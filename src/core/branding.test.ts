import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AUTH_COOKIE_NAME,
  ENV_PREFIX,
  PRODUCT_NAME,
  PRODUCT_SLUG,
  PROJECT_DATA_DIR,
  RUNTIME_DATA_DIR_NAME,
} from './branding';
import { DEFAULT_DB_PATH } from './db';

describe('PandaDOS 品牌命名契约', () => {
  test('展示名、技术标识、环境变量和目录使用唯一规范', () => {
    expect(PRODUCT_NAME).toBe('PandaDOS');
    expect(PRODUCT_SLUG).toBe('panda');
    expect(ENV_PREFIX).toBe('PANDA');
    expect(PROJECT_DATA_DIR).toBe('.panda');
    expect(RUNTIME_DATA_DIR_NAME).toBe('.panda');
    expect(AUTH_COOKIE_NAME).toBe('panda_token');
    expect(DEFAULT_DB_PATH).toBe(join(homedir(), '.panda', 'panda.db'));
  });

  test('常规工作树不包含旧产品标识', () => {
    const root = resolve(import.meta.dir, '../..');
    const allowed = new Set([
      'docs/superpowers/plans/2026-07-31-mando-product-rename.md',
      'docs/superpowers/specs/2026-07-31-mando-product-rename-design.md',
      // 升级边界只识别并清除旧自动生成区块，不会继续生成或维护旧协议。
      'src/core/agent-compat.ts',
      'src/core/agent-compat.test.ts',
      'src/core/branding.test.ts',
      'ui/src/lib/projcolor.test.ts',
      'ui/src/pandados.style.test.ts',
    ]);
    // 模块过程页属于必须原样保留的用户 Issue 历史；运行时、源码、配置和其他文档仍受旧品牌扫描约束。
    const allowedPrefixes = ['.panda/modules/', 'docs/releases/', 'docs/superpowers/'];
    const legacy = /butler2|tmux[-_]butler|butler|\.butler|\bmando\b|mandoai|mando_token|mando\.db|\.mando|MANDO_/i;
    const violations: string[] = [];
    const tracked = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root });
    expect(tracked.exitCode).toBe(0);
    for (const file of tracked.stdout.toString().split('\0').filter(Boolean)) {
      if (allowed.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix)) || file === 'panda_ai_public') continue;
      const path = join(root, file);
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      if (legacy.test(file)) violations.push(`${file} (path)`);
      if (stat.isFile() && stat.size <= 2_000_000 && legacy.test(readFileSync(path, 'utf8'))) violations.push(`${file} (content)`);
    }
    expect(violations).toEqual([]);
  });
});
