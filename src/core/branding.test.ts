import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AUTH_COOKIE_NAME,
  ENV_PREFIX,
  PRODUCT_NAME,
  PRODUCT_SLUG,
  PROJECT_DATA_DIR,
  RUNTIME_DATA_DIR_NAME,
} from './branding';

describe('Mando 品牌命名契约', () => {
  test('展示名、技术标识、环境变量和目录使用唯一规范', () => {
    expect(PRODUCT_NAME).toBe('MandoAI');
    expect(PRODUCT_SLUG).toBe('mando');
    expect(ENV_PREFIX).toBe('MANDO');
    expect(PROJECT_DATA_DIR).toBe('.mando');
    expect(RUNTIME_DATA_DIR_NAME).toBe('.mando');
    expect(AUTH_COOKIE_NAME).toBe('mando_token');
  });

  test('常规工作树不包含旧产品标识', () => {
    const root = resolve(import.meta.dir, '../..');
    const allowed = new Set([
      'src/core/mando-migration.ts',
      'src/core/mando-migration.test.ts',
      'src/core/branding.test.ts',
      'tools/migrate-to-mando.ts',
      'tools/migrate-to-mando.test.ts',
    ]);
    const legacy = /butler2|tmux[-_]butler|butler|\.butler/i;
    const violations: string[] = [];
    const tracked = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root });
    expect(tracked.exitCode).toBe(0);
    for (const file of tracked.stdout.toString().split('\0').filter(Boolean)) {
      if (allowed.has(file) || file === 'mando_ai_public' || file.startsWith('mando_ai_public/')) continue;
      const path = join(root, file);
      const stat = statSync(path);
      if (legacy.test(file)) violations.push(`${file} (path)`);
      if (stat.isFile() && stat.size <= 2_000_000 && legacy.test(readFileSync(path, 'utf8'))) violations.push(`${file} (content)`);
    }
    expect(violations).toEqual([]);
  });
});
