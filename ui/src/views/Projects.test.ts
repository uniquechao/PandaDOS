/**
 * 项目卡「归档/启用」（issue #99 子任务 4）：源码级约束（对齐 Chat.test.ts 的字符串校验法）。
 * 守住：入口仅属主/admin、先确认再 PATCH status、归档清收藏与最近访问、
 * 归档卡片显示「启用」、按钮不触发整卡导航。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Projects.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const setArchivedBody =
  source.match(/const setArchived = async[\s\S]*?\n  };/)?.[0] ?? '';

describe('项目归档/启用', () => {
  test('入口仅属主/admin（与后端 project-owner 口径一致）', () => {
    expect(source).toContain("me.role === 'admin' || p.ownerUserId === me.id");
    expect(source).toContain('{canManage(p) && (');
  });

  test('先 confirm 再 PATCH status，成功后就地更新卡片', () => {
    expect(setArchivedBody).not.toBe('');
    expect(setArchivedBody).toContain('if (!confirm(');
    expect(setArchivedBody).toContain("'PATCH'");
    expect(setArchivedBody).toContain("status: archived ? 'archived' : 'active'");
    // confirm 在请求之前（守住「误点即归档」）
    expect(setArchivedBody.indexOf('confirm(')).toBeLessThan(setArchivedBody.indexOf("'PATCH'"));
    expect(setArchivedBody).toContain('patchProject(p.id, r.project)');
  });

  test('归档同时清收藏与最近访问；启用不清', () => {
    expect(source).toContain("import { removeFavorite, useFavorites } from '../lib/favorites'");
    expect(source).toContain("import { removeRecent } from '../lib/recent'");
    const cleanup = setArchivedBody.match(/if \(archived\) \{[\s\S]*?\}/)?.[0] ?? '';
    expect(cleanup).toContain('removeFavorite(p.id)');
    expect(cleanup).toContain('removeRecent(p.id)');
  });

  test('归档卡片显示「启用」，其余显示「归档」；点按不触发整卡导航', () => {
    expect(source).toContain("{p.status === 'archived' ? tr('project.enableVerb') : tr('project.archiveVerb')}");
    expect(source).toContain("void setArchived(p, p.status !== 'archived')");
    // 按钮在整卡 onClick 里，必须 stopPropagation（与其它 pcard-act 一致）
    const btn = source.match(/\{canManage\(p\) && \([\s\S]*?<\/button>/)?.[0] ?? '';
    expect(btn).toContain('e.stopPropagation()');
  });
});

describe('项目卡操作胶囊', () => {
  test('胶囊挤不下时整颗换行、文字不在胶囊内断行（#99 加到 7 颗后必换）', () => {
    const acts = css.match(/\.pcard-acts \{([^}]*)\}/)?.[1] ?? '';
    expect(acts).toContain('flex-wrap: wrap');
    const act = css.match(/\.pcard-act \{([^}]*)\}/)?.[1] ?? '';
    expect(act).toContain('white-space: nowrap');
  });
});

describe('迁移工程目录（admin）', () => {
  const modal = source.match(/function CwdMigrateModal[\s\S]*?\ntype ProjFilter/)?.[0] ?? '';

  test('入口仅 admin 可见，点按不触发整卡导航', () => {
    const entry = source.match(/\{me\.role === 'admin' && \([\s\S]*?project\.migrateWorkspace[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(entry).not.toBe('');
    expect(entry).toContain('e.stopPropagation()');
    expect(entry).toContain('setMigrating(p)');
  });

  test('弹窗调 cwd-migrate，目标 = 父目录 + 新目录名（后端要求目标不存在）', () => {
    expect(modal).not.toBe('');
    expect(modal).toContain('/cwd-migrate`');
    expect(modal).toContain('{ dest }');
    expect(modal).toContain("const dest = `${parent === '/' ? '' : parent}/${name.trim()}`");
    // 复用现有目录浏览器选父目录
    expect(modal).toContain('<DirPicker');
    expect(modal).toContain('setParent(path');
  });

  test('前置校验错误展示 + 「旧对话不可恢复」提醒', () => {
    expect(modal).toContain('setErr(x instanceof ApiError ? x.message : String(x))');
    expect(modal).toContain('{err && <div class="err">{err}</div>}');
    expect(modal).toContain("tr('project.migrateWarning')");
  });

  test('成功后就地更新项目并提示关闭的会话数；目录名为空/请求中禁点', () => {
    expect(modal).toContain('killedSessions');
    expect(modal).toContain('onMigrated(r.project)');
    expect(modal).toContain('const canGo = !!name.trim() && !busy');
    expect(source).toContain('onMigrated={(proj) => patchProject(proj.id, proj)}');
  });
});
