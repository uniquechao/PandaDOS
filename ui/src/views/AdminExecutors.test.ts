import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'Admin.tsx'), 'utf8');

describe('Admin 执行机配置源码契约', () => {
  test('系统本机保护、检测建议与三个执行机目录入口齐全，新建草稿连接也可操作', () => {
    expect(source).toContain('!x.isSystemLocal');
    expect(source).toContain('/detect');
    expect(source).toContain("tr('admin.useSuggestion')");
    expect(source).toContain("tr('admin.chooseDirectory')");
    for (const field of ['workspaceRoot', 'claudeDir', 'codexDir']) {
      expect(source).toContain(field);
    }
    expect(source).not.toContain('disabled={!exec}');
    expect(source).not.toContain('保存后可浏览远端目录');
    expect(source).toContain('/api/admin/executors/preview/detect');
    expect(source).toContain('previewConnection');
  });
});
