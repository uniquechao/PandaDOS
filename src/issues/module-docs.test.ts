import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectModule } from '../core/types';
import { LocalDriver } from '../executor/local';
import { ModuleDocs, moduleIssueRelPath } from './module-docs';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fsp.rm(cleanups.pop()!, { recursive: true, force: true });
});

async function setup(): Promise<{ cwd: string; docs: ModuleDocs; module: ProjectModule }> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-module-docs-'));
  cleanups.push(cwd);
  return {
    cwd,
    docs: new ModuleDocs(new LocalDriver(), cwd),
    module: {
      id: 5,
      projectId: 12,
      slug: 'terminal-runtime',
      displayName: '终端运行时',
      agent: 'codex',
      source: 'manual',
      status: 'active',
      conversationId: null,
      syncStatus: 'ready',
      syncError: null,
      createdBy: 1,
      createdTs: 10,
      lastUsedTs: null,
    },
  };
}

describe('ModuleDocs', () => {
  test('初始化模块总索引、MODULE.md 与 ISSUES.md', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    await docs.refreshIndex([module]);

    const index = await fsp.readFile(path.join(cwd, '.butler/modules/INDEX.md'), 'utf8');
    expect(index).toContain('terminal-runtime/MODULE.md');
    expect(index).toContain('codex');
    const moduleMd = await fsp.readFile(
      path.join(cwd, '.butler/modules/terminal-runtime/MODULE.md'),
      'utf8',
    );
    expect(moduleMd).toContain('module_id: 5');
    expect(moduleMd).toContain('slug: terminal-runtime');
    expect(moduleMd).toContain('agent: codex');
    expect(moduleMd).toContain('## 职责边界');
    const issues = await fsp.readFile(
      path.join(cwd, '.butler/modules/terminal-runtime/ISSUES.md'),
      'utf8',
    );
    expect(issues).toContain('mando:issues:start');
  });

  test('创建 issue 过程页并按状态刷新模块索引', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    const rel = await docs.createIssuePage(module, {
      id: 72,
      title: 'Terminal Process Isolation',
      body: '对话和 issue 互不影响',
      status: 'pending',
      agent: 'codex',
      createdTs: 100,
    });
    expect(rel).toBe('.butler/modules/terminal-runtime/issues/72-terminal-process-isolation.md');

    await docs.refreshIssueIndex(module, [
      { id: 72, title: 'Terminal Process Isolation', status: 'pending', docPath: rel },
      { id: 70, title: 'Old work', status: 'done', docPath: moduleIssueRelPath(module.slug, 70, 'Old work') },
    ]);
    const page = await fsp.readFile(path.join(cwd, rel), 'utf8');
    expect(page).toContain('issue_id: 72');
    expect(page).toContain('module: terminal-runtime');
    expect(page).toContain('## 设计与实施');
    await fsp.appendFile(path.join(cwd, rel), '\n人工过程记录：保留我。\n');
    await docs.createIssuePage(module, {
      id: 72,
      title: 'Terminal Process Isolation',
      body: '对话和 issue 互不影响',
      status: 'implementing',
      agent: 'codex',
      createdTs: 100,
    });
    const updated = await fsp.readFile(path.join(cwd, rel), 'utf8');
    expect(updated).toContain('status: implementing');
    expect(updated).toContain('人工过程记录：保留我。');
    const index = await fsp.readFile(
      path.join(cwd, '.butler/modules/terminal-runtime/ISSUES.md'),
      'utf8',
    );
    expect(index).toContain('## 待办');
    expect(index).toContain('72-terminal-process-isolation.md');
    expect(index).toContain('## 已完成');
  });

  test('幂等刷新只替换管理区块，保留人工与 agent 正文', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    const modulePath = path.join(cwd, '.butler/modules/terminal-runtime/MODULE.md');
    await fsp.appendFile(modulePath, '\n## 人工约束\n绝不能覆盖这一段。\n');
    await docs.ensureModule({ ...module, lastUsedTs: 99 });
    const twice = await fsp.readFile(modulePath, 'utf8');
    expect(twice.match(/绝不能覆盖这一段。/g)).toHaveLength(1);
    expect(twice.match(/mando:module-meta:start/g)).toHaveLength(1);
  });

  test('renameDir：整目录迁移 + meta slug 改写 + 旧目录删除；人工正文原样', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    const rel = await docs.createIssuePage(module, {
      id: 72,
      title: 'Terminal Process Isolation',
      body: 'b',
      status: 'done',
      agent: 'codex',
      createdTs: 100,
    });
    const oldModuleMd = path.join(cwd, '.butler/modules/terminal-runtime/MODULE.md');
    await fsp.appendFile(oldModuleMd, '\n## 人工约束\n改名后也要在。\n');

    await docs.renameDir(module, 'terminal-core');
    const renamed = { ...module, slug: 'terminal-core' };
    // ensureModule 按新 slug 校验身份必须通过（meta slug 已被改写）
    await docs.ensureModule(renamed);
    const moved = await fsp.readFile(path.join(cwd, '.butler/modules/terminal-core/MODULE.md'), 'utf8');
    expect(moved).toContain('slug: terminal-core');
    expect(moved).toContain('module_id: 5');
    expect(moved).toContain('改名后也要在。');
    // issue 过程页跟着走；旧目录整体消失
    const movedPage = await fsp.readFile(
      path.join(cwd, '.butler/modules/terminal-core/issues', path.basename(rel)),
      'utf8',
    );
    expect(movedPage).toContain('issue_id: 72');
    await expect(fsp.stat(path.join(cwd, '.butler/modules/terminal-runtime'))).rejects.toThrow();
  });

  test('renameDir：目标目录已存在拒绝；文件 module_id 不符拒绝；旧目录缺失静默返回', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    await fsp.mkdir(path.join(cwd, '.butler/modules/occupied-slot'), { recursive: true });
    await expect(docs.renameDir(module, 'occupied-slot')).rejects.toThrow('已存在');
    await expect(docs.renameDir({ ...module, id: 99 }, 'fresh-slot')).rejects.toThrow('身份冲突');
    // 身份冲突时旧目录未被动过
    await fsp.stat(path.join(cwd, '.butler/modules/terminal-runtime/MODULE.md'));
    // 无档可迁：不抛错
    await docs.renameDir({ ...module, id: 6, slug: 'not-exist-mod' }, 'whatever-name');
  });

  test('MODULE 身份与数据库冲突时拒绝覆盖', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    await expect(docs.ensureModule({ ...module, id: 6 })).rejects.toThrow('身份冲突');
    const text = await fsp.readFile(
      path.join(cwd, '.butler/modules/terminal-runtime/MODULE.md'),
      'utf8',
    );
    expect(text).toContain('module_id: 5');
    expect(text).not.toContain('module_id: 6');
  });
});
