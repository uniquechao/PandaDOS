import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Modal.tsx', import.meta.url), 'utf8');

describe('Modal 键盘与无障碍契约', () => {
  test('声明模态对话框、首次聚焦、Escape 关闭并约束 Tab 焦点', () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("event.key !== 'Tab'");
    expect(source).toContain('focusable[0]?.focus()');
  });
});
