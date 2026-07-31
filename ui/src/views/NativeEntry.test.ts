import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (name: string): string =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('项目级原生 Bash 入口契约', () => {
  test('看板、项目卡片和对话页头都使用原生 Bash 文案并只导航项目终端路由', () => {
    for (const name of ['Board.tsx', 'Projects.tsx', 'Chat.tsx']) {
      const source = read(name);
      expect(source).toContain('原生 Bash');
      expect(source).toContain('/term');
    }
  });

  test('项目终端页明确连接 Bash target，并展示原生 Bash 标题', () => {
    const source = read('Term.tsx');
    expect(source).toContain('· 原生 Bash');
    expect(source).toContain("target={{ kind: 'bash' }}");
    expect(source).not.toContain('· 终端');
  });
});
