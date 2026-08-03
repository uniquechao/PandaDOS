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

describe('首次使用项目引导卡', () => {
  const card = source.match(/<section class="ph-onboarding"[\s\S]*?<\/section>/)?.[0] ?? '';

  test('无项目时提供可直接执行的导入与新建入口', () => {
    expect(card).not.toBe('');
    expect(source).toContain('projects !== null && all.length === 0');
    expect(card).toContain("tr('project.noProjects')");
    expect(card).toContain("tr('project.noProjectsImportHelp')");
    expect(card).toContain("tr('project.importExisting')");
    expect(card).toContain('onClick={() => setImporting(true)}');
    expect(card).toContain("tr('project.newProject')");
    expect(card).toContain('onClick={() => setCreating(true)}');
  });

  test('引导卡具备语义标题、键盘按钮和窄屏触控布局', () => {
    expect(card).toContain('aria-labelledby="project-first-run-title"');
    expect(card).toContain('type="button"');
    expect(css).toContain('.ph-onboarding {');
    expect(css).toContain('@media (max-width: 559px) {\n  .ph-onboarding');
    expect(css).toContain('.ph-onboarding-actions .btn { width: 100%; min-height: 44px;');
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

describe('统一项目导入界面（issue #7）', () => {
  const modal = source.match(/function ImportProjectModal[\s\S]*?\n}\s*$/)?.[0] ?? '';

  test('入口与弹窗不再限定 tmux，并提供三类执行机来源', () => {
    expect(source).toContain("tr('project.importShort')");
    expect(modal).toContain("const [source, setSource] = useState<ImportSource>('tmux')");
    expect(source).toContain("const IMPORT_SOURCES: readonly ImportSource[] = ['tmux', 'claude', 'codex']");
    expect(modal).toContain('/tmux-sessions`');
    expect(modal).toContain('/agent-projects?agent=${source}`');
  });

  test('按来源提交可信标识，Agent 项目成功后进入可继续的对话页', () => {
    expect(source).toContain('AgentProjectImportCandidatesResponse');
    expect(source).toContain('ProjectImportResponse');
    expect(modal).toContain("? { session: (picked as TmuxSessionInfo).name }");
    expect(modal).toContain(": { cwd: (picked as AgentProjectImportCandidate).cwd }");
    expect(source).toContain("nav(p.kind === 'chat' ? `/p/${p.id}/chat` : `/p/${p.id}`)");
    expect(modal).toContain("tr('project.linkedHistory'");
  });

  test('来源与候选均为键盘可操作按钮，并公开选中、加载、错误和禁用状态', () => {
    expect(modal).toContain('type="button"');
    expect(modal).toContain('aria-pressed={source === value}');
    expect(modal).toContain('aria-pressed={pickedSession?.name === s.name}');
    expect(modal).toContain('role="status" aria-live="polite"');
    expect(modal).toContain('role="alert"');
    expect(modal).toContain('disabled={!sourceEnabled(value)}');
    expect(modal).not.toContain('style={{');
  });

  test('PandaDOS 样式覆盖焦点、桌面/窄屏、触屏、Hover 与禁用态', () => {
    expect(css).toContain('.import-source-options { display: grid; grid-template-columns: repeat(3');
    expect(css).toContain('.import-source-option:focus-visible, .import-candidate:focus-visible');
    expect(css).toContain('@media (hover: hover) {\n  .import-source-option:hover:not(:disabled)');
    expect(css).toContain('.import-candidate:disabled { opacity: 0.45; cursor: not-allowed; transition: none; }');
    expect(css).toContain('@media (max-width: 559px) {\n  .import-source-options { grid-template-columns: 1fr;');
    expect(css).toContain('@media (pointer: coarse) {\n  .import-source-option, .import-candidate { min-height: 64px; }');
  });
});
