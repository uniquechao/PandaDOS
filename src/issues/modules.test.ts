import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../core/migrate';
import { parseReasoningEffort, REASONING_EFFORTS } from '../core/types';
import { migrateIssueEngine } from './engine';
import {
  ModuleManager,
  ModuleStore,
  normalizeModuleSkills,
  normalizeModuleSlug,
  OPT_IN_SKILLS,
  resolveModuleSkills,
  type ModuleSuggestion,
} from './modules';

function setup(): { db: Database; modules: ModuleStore } {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  migrate(db);
  migrateIssueEngine(db);
  db.run(
    `INSERT INTO users (username, token_hash, role, created_ts)
     VALUES ('owner', 'hash', 'user', 1)`,
  );
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', '', '/workspace', '/root/.claude/projects')`,
  );
  db.run(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
     VALUES ('demo', 1, '/workspace/demo', 1, 1)`,
  );
  return { db, modules: new ModuleStore(db) };
}

describe('normalizeModuleSlug', () => {
  test('规范化英文短语为 2–4 词 kebab-case', () => {
    expect(normalizeModuleSlug(' Terminal  Runtime ')).toBe('terminal-runtime');
    expect(normalizeModuleSlug('issue___execution---engine')).toBe('issue-execution-engine');
    expect(normalizeModuleSlug('api v2 gateway')).toBe('api-v2-gateway');
  });

  test('拒绝词数、长度和非英文输入不符合约束的名称', () => {
    expect(normalizeModuleSlug('web')).toBeNull();
    expect(normalizeModuleSlug('one-two-three-four-five')).toBeNull();
    expect(normalizeModuleSlug('终端运行时')).toBeNull();
    expect(normalizeModuleSlug(`${'a'.repeat(20)}-${'b'.repeat(20)}`)).toBeNull();
  });
});

describe('ModuleStore', () => {
  test('创建项目共享模块并按项目隔离 slug', () => {
    const { db, modules } = setup();
    const first = modules.create({
      projectId: 1,
      slug: 'terminal-runtime',
      displayName: '终端运行时',
      agent: 'codex',
      source: 'manual',
      createdBy: 1,
    });

    expect(first).toMatchObject({
      projectId: 1,
      slug: 'terminal-runtime',
      displayName: '终端运行时',
      agent: 'codex',
      source: 'manual',
      status: 'active',
      syncStatus: 'ready',
      conversationId: null,
    });
    expect(modules.get(first.id)).toEqual(first);
    expect(modules.listByProject(1)).toEqual([first]);
    expect(() =>
      modules.create({
        projectId: 1,
        slug: 'terminal-runtime',
        displayName: '重复',
        agent: 'claude',
        source: 'auto',
      }),
    ).toThrow();
    db.close();
  });

  test('统计活跃自动模块，人工和归档模块不计入上限', () => {
    const { db, modules } = setup();
    const auto = modules.create({
      projectId: 1,
      slug: 'terminal-runtime',
      displayName: 'Terminal Runtime',
      agent: 'claude',
      source: 'auto',
    });
    modules.create({
      projectId: 1,
      slug: 'issue-engine',
      displayName: 'Issue Engine',
      agent: 'codex',
      source: 'manual',
    });
    expect(modules.countActiveAuto(1)).toBe(1);
    modules.archive(auto.id);
    expect(modules.countActiveAuto(1)).toBe(0);
    db.close();
  });

  test('绑定唯一 conversation、记录同步错误并 touch', () => {
    const { db, modules } = setup();
    const module = modules.create({
      projectId: 1,
      slug: 'terminal-runtime',
      displayName: 'Terminal Runtime',
      agent: 'claude',
      source: 'legacy',
    });
    db.run(
      `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
       VALUES ('conv-module', 1, 'terminal-runtime', 1, 'claude', 'issue')`,
    );

    modules.setConversation(module.id, 'conv-module');
    expect(modules.get(module.id)?.conversationId).toBe('conv-module');
    modules.setSyncError(module.id, 'disk full');
    expect(modules.get(module.id)).toMatchObject({ syncStatus: 'error', syncError: 'disk full' });
    modules.setSyncReady(module.id);
    modules.touch(module.id, 1234);
    expect(modules.get(module.id)).toMatchObject({
      syncStatus: 'ready',
      syncError: null,
      lastUsedTs: 1234,
    });
    db.close();
  });

  test('issues.module_id 外键只能引用同库模块实体', () => {
    const { db, modules } = setup();
    const module = modules.create({
      projectId: 1,
      slug: 'issue-engine',
      displayName: 'Issue Engine',
      agent: 'claude',
      source: 'auto',
    });
    db.run(
      `INSERT INTO issues (project_id, title, category, status, module, module_id, impl_mode, agent, created_ts)
       VALUES (1, 'A', 'task', 'pending', 'issue-engine', ?, 'seq', 'claude', 1)`,
      [module.id],
    );
    expect(
      db.query<{ module_id: number }, []>('SELECT module_id FROM issues').get()?.module_id,
    ).toBe(module.id);
    expect(() =>
      db.run(
        `INSERT INTO issues (project_id, title, category, status, module, module_id, impl_mode, agent, created_ts)
         VALUES (1, 'B', 'task', 'pending', 'missing', 999, 'seq', 'claude', 2)`,
      ),
    ).toThrow();
    db.close();
  });
});

describe('ModuleManager.resolve', () => {
  function manager(
    modules: ModuleStore,
    suggest: (input: { allowNew: boolean; manualName?: string }) => Promise<ModuleSuggestion>,
  ) {
    const synced: string[] = [];
    return {
      synced,
      manager: new ModuleManager(modules, {
        suggest,
        docs: {
          async ensureModule(module) {
            synced.push(module.slug);
          },
          async refreshIndex() {},
        },
      }),
    };
  }

  test('显式 moduleId 与手动已有名称直接复用，不调用分类器', async () => {
    const { db, modules } = setup();
    const existing = modules.create({
      projectId: 1,
      slug: 'terminal-runtime',
      displayName: '终端运行时',
      agent: 'codex',
      source: 'manual',
    });
    let calls = 0;
    const { manager: resolver } = manager(modules, async () => {
      calls++;
      return { kind: 'existing', moduleId: existing.id };
    });
    expect((await resolver.resolve({ projectId: 1, title: 'A', agent: 'claude', moduleId: existing.id })).id).toBe(existing.id);
    expect((await resolver.resolve({ projectId: 1, title: 'B', agent: 'claude', moduleName: '终端运行时' })).id).toBe(existing.id);
    expect(calls).toBe(0);
    db.close();
  });

  test('中文手动名称生成英文 slug，固定使用用户选择的代理并同步文档', async () => {
    const { db, modules } = setup();
    const { manager: resolver, synced } = manager(modules, async (input) => {
      expect(input.manualName).toBe('终端运行时');
      return { kind: 'new', slug: 'terminal-runtime', displayName: '终端运行时', purpose: '终端执行' };
    });
    const got = await resolver.resolve({
      projectId: 1,
      title: '隔离终端',
      agent: 'codex',
      moduleName: '终端运行时',
      createdBy: 1,
    });
    expect(got).toMatchObject({ slug: 'terminal-runtime', agent: 'codex', source: 'manual' });
    expect(synced).toEqual(['terminal-runtime']);
    db.close();
  });

  test('分类器不可用时仍记住用户手动名称', async () => {
    const { db, modules } = setup();
    const { manager: resolver } = manager(modules, async () => {
      throw new Error('offline');
    });
    expect(
      await resolver.resolve({
        projectId: 1,
        title: '临时需求',
        agent: 'claude',
        moduleName: '支付与账单',
        createdBy: 1,
      }),
    ).toMatchObject({
      slug: 'general-work',
      displayName: '支付与账单',
      source: 'manual',
    });
    db.close();
  });

  test('自动归类优先已有；允许新增时创建 auto 模块', async () => {
    const { db, modules } = setup();
    const existing = modules.create({
      projectId: 1,
      slug: 'issue-engine',
      displayName: 'Issue Engine',
      agent: 'claude',
      source: 'auto',
    });
    const first = manager(modules, async () => ({ kind: 'existing', moduleId: existing.id })).manager;
    // 同代理的 existing 建议直接复用（跨代理建议被拒的场景另有专测）
    expect((await first.resolve({ projectId: 1, title: '队列修复', agent: 'claude' })).id).toBe(existing.id);

    const second = manager(modules, async () => ({
      kind: 'new',
      slug: 'terminal-runtime',
      displayName: 'Terminal Runtime',
      purpose: '终端执行',
    })).manager;
    expect(await second.resolve({ projectId: 1, title: '终端隔离', agent: 'codex' })).toMatchObject({
      slug: 'terminal-runtime',
      agent: 'codex',
      source: 'auto',
    });
    db.close();
  });

  test('达到 8 个自动模块后禁止新增，非法建议确定性复用已有同代理模块', async () => {
    const { db, modules } = setup();
    for (let i = 0; i < 8; i++) {
      modules.create({
        projectId: 1,
        slug: `area-${i}`,
        displayName: `Area ${i}`,
        agent: 'claude',
        source: 'auto',
      });
    }
    let allowNew = true;
    const { manager: resolver } = manager(modules, async (input) => {
      allowNew = input.allowNew;
      return { kind: 'new', slug: 'ninth-module', displayName: 'Ninth', purpose: 'no' };
    });
    const got = await resolver.resolve({ projectId: 1, title: '未知需求', agent: 'claude' });
    expect(allowNew).toBe(false);
    expect(got.slug).toBe('area-0');
    expect(modules.countActiveAuto(1)).toBe(8);
    db.close();
  });

  test('软上限按全部 active 模块计：legacy/manual 也算数，超限即禁止自动新增', async () => {
    const { db, modules } = setup();
    for (let i = 0; i < 8; i++) {
      modules.create({
        projectId: 1,
        slug: `legacy-mod-${i}`,
        displayName: `Legacy ${i}`,
        agent: 'claude',
        source: i % 2 === 0 ? 'legacy' : 'manual', // 全非 auto——旧口径下上限永不触发
      });
    }
    let allowNew = true;
    const { manager: resolver } = manager(modules, async (input) => {
      allowNew = input.allowNew;
      return { kind: 'new', slug: 'brand-new-module', displayName: 'New', purpose: 'x' };
    });
    const got = await resolver.resolve({ projectId: 1, title: '新需求', agent: 'claude' });
    expect(allowNew).toBe(false);
    expect(got.slug).toBe('legacy-mod-0'); // 复用最早的同代理模块
    db.close();
  });

  test('超限兜底不跨代理：无同代理模块时按代理建兜底模块，而不是挂进别家反改 agent', async () => {
    const { db, modules } = setup();
    for (let i = 0; i < 8; i++) {
      modules.create({
        projectId: 1,
        slug: `area-${i}`,
        displayName: `Area ${i}`,
        agent: 'claude',
        source: 'auto',
      });
    }
    const { manager: resolver } = manager(modules, async () => {
      throw new Error('offline'); // 分类器失约 → 走确定性兜底
    });
    const got = await resolver.resolve({ projectId: 1, title: '未知需求', agent: 'codex' });
    expect(got).toMatchObject({ agent: 'codex', source: 'auto', slug: 'general-work-codex' });
    db.close();
  });

  test('分类器给出跨代理 existing 建议 → 拒绝，回落同代理模块', async () => {
    const { db, modules } = setup();
    const claudeMod = modules.create({
      projectId: 1,
      slug: 'issue-engine',
      displayName: 'Issue Engine',
      agent: 'claude',
      source: 'auto',
    });
    const codexMod = modules.create({
      projectId: 1,
      slug: 'terminal-runtime',
      displayName: 'Terminal Runtime',
      agent: 'codex',
      source: 'auto',
    });
    const { manager: resolver } = manager(modules, async () => ({
      kind: 'existing',
      moduleId: claudeMod.id, // LLM 幻觉：给 codex issue 指了 claude 模块
    }));
    const got = await resolver.resolve({ projectId: 1, title: '终端需求', agent: 'codex' });
    expect(got.id).toBe(codexMod.id);
    db.close();
  });
});

describe('ModuleManager.merge', () => {
  function mergeManager(modules: ModuleStore) {
    const refreshed: string[][] = [];
    const manager = new ModuleManager(modules, {
      suggest: async () => {
        throw new Error('merge 流程不应咨询分类器');
      },
      docs: {
        async ensureModule() {},
        async refreshIndex(list) {
          refreshed.push(list.map((m) => m.slug));
        },
      },
    });
    return { manager, refreshed };
  }

  function twoModules(modules: ModuleStore) {
    const target = modules.create({
      projectId: 1,
      slug: 'issue-engine',
      displayName: 'Issue 引擎',
      agent: 'claude',
      source: 'legacy',
    });
    const source = modules.create({
      projectId: 1,
      slug: 'legacy-two',
      displayName: '旧模块二',
      agent: 'codex',
      source: 'legacy',
    });
    return { target, source };
  }

  test('归档来源、touch 目标并刷新索引；repoint 在归档前拿到活跃来源', async () => {
    const { db, modules } = setup();
    const { target, source } = twoModules(modules);
    const { manager, refreshed } = mergeManager(modules);
    const repointed: Array<{ target: number; sources: number[]; sourceActive: boolean }> = [];

    const got = await manager.merge({
      projectId: 1,
      targetId: target.id,
      sourceIds: [source.id, source.id], // 重复输入应去重
      repoint(t, sources) {
        repointed.push({
          target: t.id,
          sources: sources.map((s) => s.id),
          sourceActive: modules.get(source.id)!.status === 'active',
        });
      },
    });

    expect(repointed).toEqual([{ target: target.id, sources: [source.id], sourceActive: true }]);
    expect(modules.get(source.id)!.status).toBe('archived');
    expect(modules.get(target.id)!.lastUsedTs).not.toBeNull();
    expect(refreshed).toEqual([['issue-engine']]); // 归档后索引只剩目标
    expect(got.target.id).toBe(target.id);
    expect(got.sources.map((s) => s.status)).toEqual(['archived']);
    db.close();
  });

  test('非法输入与 repoint 抛错都整体中止，不归档不刷索引', async () => {
    const { db, modules } = setup();
    const { target, source } = twoModules(modules);
    const { manager, refreshed } = mergeManager(modules);
    const noop = () => {};

    await expect(
      manager.merge({ projectId: 1, targetId: target.id, sourceIds: [], repoint: noop }),
    ).rejects.toThrow(/来源/);
    await expect(
      manager.merge({ projectId: 1, targetId: target.id, sourceIds: [target.id], repoint: noop }),
    ).rejects.toThrow(/目标/);
    await expect(
      manager.merge({ projectId: 1, targetId: 999, sourceIds: [source.id], repoint: noop }),
    ).rejects.toThrow(/目标/);

    modules.archive(source.id);
    await expect(
      manager.merge({ projectId: 1, targetId: target.id, sourceIds: [source.id], repoint: noop }),
    ).rejects.toThrow(/来源/);
    db.run(`UPDATE project_modules SET status = 'active' WHERE id = ?`, [source.id]);

    await expect(
      manager.merge({
        projectId: 1,
        targetId: target.id,
        sourceIds: [source.id],
        repoint() {
          throw new Error('有执行中 issue');
        },
      }),
    ).rejects.toThrow('有执行中 issue');
    expect(modules.get(source.id)!.status).toBe('active');
    expect(refreshed).toEqual([]);
    db.close();
  });
});

describe('ModuleManager.rename / archiveModule', () => {
  function docsManager(modules: ModuleStore) {
    const ensured: Array<{ slug: string; displayName: string; status: string }> = [];
    const refreshed: string[][] = [];
    const manager = new ModuleManager(modules, {
      suggest: async () => {
        throw new Error('不应咨询分类器');
      },
      docs: {
        async ensureModule(m) {
          ensured.push({ slug: m.slug, displayName: m.displayName, status: m.status });
        },
        async refreshIndex(list) {
          refreshed.push(list.map((m) => m.slug));
        },
      },
    });
    return { manager, ensured, refreshed };
  }

  test('rename 只改显示名并同步文档；空名/越项目/已归档拒绝', async () => {
    const { db, modules } = setup();
    const m = modules.create({
      projectId: 1,
      slug: 'issue-engine',
      displayName: '旧名',
      agent: 'claude',
      source: 'legacy',
    });
    const { manager, ensured, refreshed } = docsManager(modules);
    const got = await manager.rename(1, m.id, '新名字');
    expect(got).toMatchObject({ id: m.id, slug: 'issue-engine', displayName: '新名字' });
    expect(modules.get(m.id)!.displayName).toBe('新名字');
    expect(ensured).toEqual([{ slug: 'issue-engine', displayName: '新名字', status: 'active' }]);
    expect(refreshed).toEqual([['issue-engine']]);

    await expect(manager.rename(1, m.id, '   ')).rejects.toThrow(/显示名/);
    await expect(manager.rename(2, m.id, 'x')).rejects.toThrow(/不存在/);
    modules.archive(m.id);
    await expect(manager.rename(1, m.id, 'x')).rejects.toThrow(/不存在|归档/);
    db.close();
  });

  test('archiveModule 归档并把 status 同步进文档与索引', async () => {
    const { db, modules } = setup();
    const keep = modules.create({
      projectId: 1,
      slug: 'issue-engine',
      displayName: '保留',
      agent: 'claude',
      source: 'legacy',
    });
    const m = modules.create({
      projectId: 1,
      slug: 'legacy-two',
      displayName: '要归档',
      agent: 'codex',
      source: 'legacy',
    });
    const { manager, ensured, refreshed } = docsManager(modules);
    const got = await manager.archiveModule(1, m.id);
    expect(got.status).toBe('archived');
    expect(modules.get(m.id)!.status).toBe('archived');
    expect(ensured).toEqual([{ slug: 'legacy-two', displayName: '要归档', status: 'archived' }]);
    expect(refreshed).toEqual([['issue-engine']]); // 归档后索引只剩保留者
    await expect(manager.archiveModule(1, m.id)).rejects.toThrow(/不存在|归档/); // 幂等拒绝
    void keep;
    db.close();
  });
});

describe('ModuleManager.createManual / renameSlug / syncIssueIndex', () => {
  function docsManager(modules: ModuleStore) {
    const ensured: string[] = [];
    const refreshed: string[][] = [];
    const renamedDirs: Array<{ from: string; to: string }> = [];
    const issueIndexes: Array<{ slug: string; ids: number[] }> = [];
    let failRenameDir = false;
    const manager = new ModuleManager(modules, {
      suggest: async () => {
        throw new Error('不应咨询分类器');
      },
      docs: {
        async ensureModule(m) {
          ensured.push(m.slug);
        },
        async refreshIndex(list) {
          refreshed.push(list.map((m) => m.slug));
        },
        async renameDir(m, newSlug) {
          if (failRenameDir) throw new Error('目录迁移失败');
          renamedDirs.push({ from: m.slug, to: newSlug });
        },
        async refreshIssueIndex(m, items) {
          issueIndexes.push({ slug: m.slug, ids: items.map((i) => i.id) });
        },
      },
    });
    return {
      manager,
      ensured,
      refreshed,
      renamedDirs,
      issueIndexes,
      setFailRenameDir: (v: boolean) => void (failRenameDir = v),
    };
  }

  test('createManual：直接建 manual 模块；slug 撞现存（含归档）拒绝；坏 slug 拒绝', async () => {
    const { db, modules } = setup();
    const { manager } = docsManager(modules);
    const m = await manager.createManual({
      projectId: 1,
      slug: 'file-preview',
      displayName: '文件预览',
      agent: 'claude',
      createdBy: 1,
    });
    expect(m).toMatchObject({ slug: 'file-preview', displayName: '文件预览', source: 'manual', syncStatus: 'ready' });
    modules.archive(m.id);
    await expect(
      manager.createManual({ projectId: 1, slug: 'file-preview', displayName: '重复', agent: 'codex' }),
    ).rejects.toThrow(/占用/);
    await expect(
      manager.createManual({ projectId: 1, slug: '###', displayName: 'x', agent: 'claude' }),
    ).rejects.toThrow(/非法/);
    db.close();
  });

  test('renameSlug：目录先迁、库后改、meta/索引刷新；冲突与失败路径不落半套', async () => {
    const { db, modules } = setup();
    const m = modules.create({
      projectId: 1,
      slug: 'legacy-module-01',
      displayName: 'Git 页面',
      agent: 'claude',
      source: 'legacy',
    });
    const other = modules.create({
      projectId: 1,
      slug: 'occupied-slot',
      displayName: '占坑',
      agent: 'claude',
      source: 'manual',
    });
    const { manager, ensured, refreshed, renamedDirs, setFailRenameDir } = docsManager(modules);

    // slug 冲突（含归档口径同 bySlug）→ 拒绝且目录未动
    await expect(manager.renameSlug(1, m.id, 'occupied-slot')).rejects.toThrow(/占用/);
    expect(renamedDirs).toEqual([]);

    // 目录迁移失败 → 库内 slug 未动（可安全重试）
    setFailRenameDir(true);
    await expect(manager.renameSlug(1, m.id, 'git-pages')).rejects.toThrow(/目录迁移失败/);
    expect(modules.get(m.id)!.slug).toBe('legacy-module-01');

    setFailRenameDir(false);
    const updated = await manager.renameSlug(1, m.id, 'git-pages', 'Git 页面全新');
    expect(updated).toMatchObject({ slug: 'git-pages', displayName: 'Git 页面全新' });
    expect(renamedDirs).toEqual([{ from: 'legacy-module-01', to: 'git-pages' }]);
    expect(ensured.at(-1)).toBe('git-pages');
    expect(refreshed.at(-1)).toContain('git-pages');

    // 同 slug 视为只改显示名（不迁目录）
    const same = await manager.renameSlug(1, m.id, 'git-pages', '再改名');
    expect(same.displayName).toBe('再改名');
    expect(renamedDirs).toHaveLength(1);
    void other;
    db.close();
  });

  test('syncIssueIndex：按 moduleId 过滤 issue 并刷新该模块 ISSUES.md', async () => {
    const { db, modules } = setup();
    const m = modules.create({
      projectId: 1,
      slug: 'file-preview',
      displayName: '文件预览',
      agent: 'claude',
      source: 'manual',
    });
    const { manager, issueIndexes } = docsManager(modules);
    await manager.syncIssueIndex(m, [
      { id: 1, title: 'a', status: 'done', moduleId: m.id },
      { id: 2, title: 'b', status: 'pending', moduleId: 999 },
    ]);
    expect(issueIndexes).toEqual([{ slug: 'file-preview', ids: [1] }]);
    db.close();
  });
});

describe('035 legacy 回填迁移', () => {
  test('容忍 created_by 指向已删除用户的旧 issue（落 NULL 而非崩溃）', () => {
    const { db } = setup();
    // 复现生产：历史连接未开外键时删过用户，留下孤儿 created_by
    db.run(
      `INSERT INTO users (username, token_hash, role, created_ts)
       VALUES ('ghost', 'hash', 'user', 1)`,
    );
    const ghostId = (db.query<{ id: number }, []>(`SELECT id FROM users WHERE username = 'ghost'`).get())!.id;
    db.run(
      `INSERT INTO issues (project_id, title, category, status, module, impl_mode, agent, created_ts, created_by)
       VALUES (1, '旧任务', 'task', 'done', '旧模块', 'seq', 'claude', 1, ?)`,
      [ghostId],
    );
    db.run('PRAGMA foreign_keys = OFF');
    db.run('DELETE FROM users WHERE id = ?', [ghostId]);
    db.run('PRAGMA foreign_keys = ON');

    // 让 035 重新作为 pending 迁移执行（首轮空库跑过一次是 no-op）
    db.run('DELETE FROM schema_migrations WHERE id = 35');
    expect(() => migrateIssueEngine(db)).not.toThrow();

    const module = db
      .query<{ id: number; created_by: number | null; agent: string }, []>(
        `SELECT id, created_by, agent FROM project_modules WHERE source = 'legacy' AND display_name = '旧模块'`,
      )
      .get();
    expect(module).toMatchObject({ created_by: null, agent: 'claude' });
    const issue = db
      .query<{ module_id: number | null }, []>(`SELECT module_id FROM issues WHERE title = '旧任务'`)
      .get();
    expect(issue?.module_id).toBe(module!.id);
    db.close();
  });
});

describe('模块级技能挂载（046 / #277 I-02）', () => {
  test('未配置 = null；写入去重保序、空数组是「显式一个都不挂」、null 清回默认', () => {
    const { modules } = setup();
    const m = modules.create({
      projectId: 1, slug: 'issue-engine', displayName: '引擎', agent: 'claude', source: 'manual', createdBy: 1,
    });
    expect(m.skills).toBeNull(); // 新模块未配置

    expect(modules.setSkills(m.id, ['panda-issue', 'superpowers', 'panda-issue']).skills)
      .toEqual(['panda-issue', 'superpowers']);
    expect(modules.get(m.id)!.skills).toEqual(['panda-issue', 'superpowers']);
    expect(modules.setSkills(m.id, []).skills).toEqual([]);
    expect(modules.setSkills(m.id, null).skills).toBeNull();
  });

  test('非法技能名直接拒绝：配置里不许出现路径', () => {
    expect(() => normalizeModuleSkills(['../etc/passwd'])).toThrow(/非法技能名/);
    expect(() => normalizeModuleSkills('superpowers' as unknown)).toThrow(/数组/);
    expect(normalizeModuleSkills([' panda-issue ', '', null])).toEqual(['panda-issue']);
    expect(normalizeModuleSkills(null)).toBeNull();
  });

  test('resolveModuleSkills：未配置沿用项目默认并剔掉需显式开启的重技能，配过则完全以配置为准', () => {
    const projectDefault = ['panda-issue', 'artifacts', 'superpowers'];
    expect(OPT_IN_SKILLS).toContain('superpowers');
    // 未配置：superpowers 不跟着项目默认自动挂
    expect(resolveModuleSkills({ skills: null }, projectDefault)).toEqual(['panda-issue', 'artifacts']);
    expect(resolveModuleSkills({}, projectDefault)).toEqual(['panda-issue', 'artifacts']);
    // 显式勾了就挂；显式空数组就一个都不挂
    expect(resolveModuleSkills({ skills: ['superpowers'] }, projectDefault)).toEqual(['superpowers']);
    expect(resolveModuleSkills({ skills: [] }, projectDefault)).toEqual([]);
  });
});

describe('推理档位（048 / #281）', () => {
  test('模块默认档：未配置为 null；写入合法值；null 清回未配置', () => {
    const { modules } = setup();
    const m = modules.create({
      projectId: 1, slug: 'issue-engine', displayName: '引擎', agent: 'codex', source: 'manual', createdBy: 1,
    });
    expect(m.reasoningEffort).toBeNull();

    expect(modules.setReasoningEffort(m.id, 'low').reasoningEffort).toBe('low');
    expect(modules.get(m.id)!.reasoningEffort).toBe('low');
    expect(modules.setReasoningEffort(m.id, 'high').reasoningEffort).toBe('high');
    expect(modules.setReasoningEffort(m.id, null).reasoningEffort).toBeNull();
  });

  test('非法档位直接拒绝：存进去只会变成启动命令里谁也不认识的参数', () => {
    const { modules } = setup();
    const m = modules.create({
      projectId: 1, slug: 'issue-engine', displayName: '引擎', agent: 'codex', source: 'manual', createdBy: 1,
    });
    expect(() => modules.setReasoningEffort(m.id, 'ultra' as never)).toThrow(/非法推理档位/);
    expect(modules.get(m.id)!.reasoningEffort).toBeNull();
  });

  test('parseReasoningEffort：认不出的值当未配置，不猜也不报错', () => {
    expect(parseReasoningEffort('medium')).toBe('medium');
    expect(parseReasoningEffort('HIGH')).toBeNull();
    expect(parseReasoningEffort(null)).toBeNull();
    expect(parseReasoningEffort(3)).toBeNull();
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high']);
  });
});
