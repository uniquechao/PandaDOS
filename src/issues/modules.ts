/**
 * issues/modules —— 项目共享模块的身份、固定代理与运行态存储。
 *
 * Markdown 同步和自动归类分别由后续的 ModuleDocs / ModuleManager 负责；本文件只维护
 * 可由 SQLite 强约束的事实，避免模块身份在引擎、路由和 UI 各自解释。
 */
import type { Database } from 'bun:sqlite';
import type { AgentKind, ProjectModule } from '../core/types';
import { moduleIssueRelPath } from './module-docs';

export type ModuleSource = ProjectModule['source'];

export interface CreateModuleInput {
  projectId: number;
  slug: string;
  displayName: string;
  agent: AgentKind;
  source: ModuleSource;
  createdBy?: number | null;
  createdTs?: number;
}

export type ModuleSuggestion =
  | { kind: 'existing'; moduleId: number }
  | { kind: 'new'; slug: string; displayName: string; purpose: string };

export interface ResolveModuleInput {
  projectId: number;
  title: string;
  body?: string | null;
  agent: AgentKind;
  moduleId?: number;
  moduleName?: string;
  createdBy?: number | null;
}

export interface ModuleDocsPort {
  ensureModule(module: ProjectModule): Promise<void>;
  refreshIndex(modules: ProjectModule[]): Promise<void>;
  /** slug 改名时把 .butler/modules/<旧slug>/ 目录整体迁到新 slug 并改写 meta；缺省 = 不支持改 slug。 */
  renameDir?(module: ProjectModule, newSlug: string): Promise<void>;
  createIssuePage?(module: ProjectModule, issue: {
    id: number;
    title: string;
    body: string | null;
    status: string;
    agent: AgentKind;
    createdTs: number;
  }): Promise<string>;
  refreshIssueIndex?(module: ProjectModule, issues: Array<{
    id: number;
    title: string;
    status: string;
    docPath: string;
  }>): Promise<void>;
}

export interface ModuleMergeInput {
  projectId: number;
  targetId: number;
  sourceIds: number[];
  /** 归档来源前由调用方（引擎）重指 issues；抛错则整体中止，不归档、不刷索引。 */
  repoint(target: ProjectModule, sources: ProjectModule[]): void | Promise<void>;
}

export interface ModuleManagerDeps {
  suggest(input: {
    projectId: number;
    title: string;
    body?: string | null;
    agent: AgentKind;
    modules: ProjectModule[];
    allowNew: boolean;
    manualName?: string;
  }): Promise<ModuleSuggestion>;
  docs: ModuleDocsPort;
}

interface ModuleRow {
  id: number;
  project_id: number;
  slug: string;
  display_name: string;
  agent: string;
  source: string;
  status: string;
  conversation_id: string | null;
  sync_status: string;
  sync_error: string | null;
  created_by: number | null;
  created_ts: number;
  last_used_ts: number | null;
}

function mapModule(r: ModuleRow): ProjectModule {
  return {
    id: r.id,
    projectId: r.project_id,
    slug: r.slug,
    displayName: r.display_name,
    agent: r.agent === 'codex' ? 'codex' : 'claude',
    source: r.source === 'manual' ? 'manual' : r.source === 'legacy' ? 'legacy' : 'auto',
    status: r.status === 'archived' ? 'archived' : 'active',
    conversationId: r.conversation_id,
    syncStatus: r.sync_status === 'error' ? 'error' : 'ready',
    syncError: r.sync_error,
    createdBy: r.created_by,
    createdTs: r.created_ts,
    lastUsedTs: r.last_used_ts,
  };
}

/**
 * 规范化系统生成的英文短语。中文手动名称必须先经分类器生成英文 slug，不能在这里
 * 做不稳定的拼音/翻译猜测。
 */
export function normalizeModuleSlug(input: string): string | null {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/.test(slug)) return null;
  if (slug.length > 40) return null;
  return slug;
}

export class ModuleStore {
  constructor(private readonly db: Database) {}

  get(id: number): ProjectModule | undefined {
    const row = this.db.query<ModuleRow, [number]>('SELECT * FROM project_modules WHERE id = ?').get(id);
    return row ? mapModule(row) : undefined;
  }

  listByProject(projectId: number, includeArchived = false): ProjectModule[] {
    const sql = includeArchived
      ? 'SELECT * FROM project_modules WHERE project_id = ? ORDER BY last_used_ts DESC, created_ts, id'
      : `SELECT * FROM project_modules
         WHERE project_id = ? AND status = 'active'
         ORDER BY last_used_ts DESC, created_ts, id`;
    return this.db.query<ModuleRow, [number]>(sql).all(projectId).map(mapModule);
  }

  create(input: CreateModuleInput): ProjectModule {
    const slug = normalizeModuleSlug(input.slug);
    if (!slug || slug !== input.slug) throw new Error(`非法模块 slug: ${input.slug}`);
    const displayName = input.displayName.trim().slice(0, 80);
    if (!displayName) throw new Error('模块显示名不能为空');
    const row = this.db
      .query<
        ModuleRow,
        [number, string, string, string, string, number | null, number]
      >(
        `INSERT INTO project_modules
           (project_id, slug, display_name, agent, source, created_by, created_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.projectId,
        slug,
        displayName,
        input.agent === 'codex' ? 'codex' : 'claude',
        input.source,
        input.createdBy ?? null,
        input.createdTs ?? Date.now(),
      );
    if (!row) throw new Error('创建模块失败');
    return mapModule(row);
  }

  countActiveAuto(projectId: number): number {
    return (
      this.db
        .query<{ n: number }, [number]>(
          `SELECT COUNT(*) AS n FROM project_modules
           WHERE project_id = ? AND source = 'auto' AND status = 'active'`,
        )
        .get(projectId)?.n ?? 0
    );
  }

  archive(id: number): void {
    this.db.query(`UPDATE project_modules SET status = 'archived' WHERE id = ?`).run(id);
  }

  /** 项目内按 slug 找模块（含归档——UNIQUE(project_id, slug) 的碰撞检查口径） */
  bySlug(projectId: number, slug: string): ProjectModule | undefined {
    const row = this.db
      .query<ModuleRow, [number, string]>('SELECT * FROM project_modules WHERE project_id = ? AND slug = ?')
      .get(projectId, slug);
    return row ? mapModule(row) : undefined;
  }

  /** 改 slug（唯一约束由 DB 兜底；文档目录迁移由 ModuleManager.renameSlug 编排） */
  setSlug(id: number, slug: string): void {
    const s = normalizeModuleSlug(slug);
    if (!s || s !== slug) throw new Error(`非法模块 slug: ${slug}`);
    this.db.query('UPDATE project_modules SET slug = ? WHERE id = ?').run(s, id);
  }

  rename(id: number, displayName: string): void {
    const name = displayName.trim().slice(0, 80);
    if (!name) throw new Error('模块显示名不能为空');
    this.db.query('UPDATE project_modules SET display_name = ? WHERE id = ?').run(name, id);
  }

  changeAgent(projectId: number, id: number, agent: AgentKind): ProjectModule {
    const module = this.get(id);
    if (!module || module.projectId !== projectId) throw new Error('无此模块');
    const activeIssues = this.db
      .query<{ n: number }, [number]>(
        `SELECT COUNT(*) AS n FROM issues
         WHERE module_id = ? AND status NOT IN ('done', 'cancelled')`,
      )
      .get(id)!.n;
    if (activeIssues > 0) throw new Error('模块仍有未结束 issue，不能切换 Agent');
    this.db.query('UPDATE project_modules SET agent = ? WHERE id = ?').run(agent, id);
    return this.get(id)!;
  }

  setConversation(id: number, conversationId: string): void {
    this.db
      .query('UPDATE project_modules SET conversation_id = ? WHERE id = ?')
      .run(conversationId, id);
  }

  setSyncError(id: number, error: string): void {
    this.db
      .query(`UPDATE project_modules SET sync_status = 'error', sync_error = ? WHERE id = ?`)
      .run(error.slice(0, 1000), id);
  }

  setSyncReady(id: number): void {
    this.db
      .query(`UPDATE project_modules SET sync_status = 'ready', sync_error = NULL WHERE id = ?`)
      .run(id);
  }

  touch(id: number, ts = Date.now()): void {
    this.db.query('UPDATE project_modules SET last_used_ts = ? WHERE id = ?').run(ts, id);
  }
}

/** 自动新增的软上限：项目 active 模块总数（含 legacy/manual）达到即停止自动建新，转复用 */
export const MAX_AUTO_MODULES = 8;

/**
 * 模块选择的唯一编排入口：显式选择 > 手动名称复用/生成 > 自动已有优先 > 克制新增。
 * 分类器输出永远要在这里重新校验，不能把 LLM 当数据库约束。
 */
export class ModuleManager {
  constructor(
    readonly store: ModuleStore,
    private readonly deps: ModuleManagerDeps,
  ) {}

  async resolve(input: ResolveModuleInput): Promise<ProjectModule> {
    const active = this.store.listByProject(input.projectId);
    if (input.moduleId !== undefined) {
      const selected = this.store.get(input.moduleId);
      if (!selected || selected.projectId !== input.projectId || selected.status !== 'active') {
        throw new Error('模块不存在或不属于当前项目');
      }
      if (selected.syncStatus !== 'ready') throw new Error(`模块文档未就绪：${selected.syncError ?? 'unknown'}`);
      return selected;
    }

    const manualName = input.moduleName?.trim();
    if (manualName) {
      const lower = manualName.toLowerCase();
      const matched = active.find(
        (m) => m.slug === normalizeModuleSlug(manualName) || m.displayName.toLowerCase() === lower,
      );
      if (matched) return matched;
      const directSlug = normalizeModuleSlug(manualName);
      if (directSlug) {
        return this.createReady({
          projectId: input.projectId,
          slug: directSlug,
          displayName: manualName,
          agent: input.agent,
          source: 'manual',
          createdBy: input.createdBy,
        });
      }
    }

    // 软上限按全部 active 模块计（legacy/manual 也算）：模块总量失控正是从「legacy 不计数」开始的。
    // 手动命名不受限——用户显式要新模块时永远给。
    const allowNew = manualName ? true : active.length < MAX_AUTO_MODULES;
    let suggestion: ModuleSuggestion | null = null;
    try {
      suggestion = await this.deps.suggest({
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        agent: input.agent,
        modules: active,
        allowNew,
        ...(manualName ? { manualName } : {}),
      });
    } catch {
      suggestion = null;
    }

    if (suggestion?.kind === 'existing') {
      const selected = active.find((m) => m.id === suggestion.moduleId);
      // 代理必须一致：模块代理会反向固定 issue 代理，分类器幻觉跨代理指派要在这里拦死
      if (selected?.syncStatus === 'ready' && selected.agent === input.agent) return selected;
    }
    if (suggestion?.kind === 'new' && allowNew) {
      const slug = normalizeModuleSlug(suggestion.slug);
      if (slug) {
        const collision = active.find((m) => m.slug === slug);
        if (collision) return collision;
        return this.createReady({
          projectId: input.projectId,
          slug,
          displayName: manualName || suggestion.displayName.trim() || slug,
          agent: input.agent,
          source: manualName ? 'manual' : 'auto',
          createdBy: input.createdBy,
        });
      }
    }

    // 上限达到或分类器失约：只在**同代理**模块里稳定复用最早的 ready 一个——跨代理复用会把
    // issue 的代理反改成模块代理，绝不允许。没有同代理模块时按代理建兜底模块（slug 按代理
    // 分开永不冲突），这是尊重代理选择的唯一途径，允许越过软上限。
    const fallbackExisting = active.find((m) => m.agent === input.agent && m.syncStatus === 'ready');
    if (fallbackExisting) return fallbackExisting;
    const fallbackSlug = input.agent === 'codex' ? 'general-work-codex' : 'general-work';
    return this.createReady({
      projectId: input.projectId,
      slug: fallbackSlug,
      displayName: manualName || (input.agent === 'codex' ? 'General Work (codex)' : 'General Work'),
      agent: input.agent,
      source: manualName ? 'manual' : 'auto',
      createdBy: input.createdBy,
    });
  }

  async recordIssue(
    module: ProjectModule,
    issue: { id: number; title: string; body: string | null; status: string; agent: AgentKind; createdTs: number },
    projectIssues: Array<{ id: number; title: string; status: string; moduleId: number | null }>,
  ): Promise<void> {
    if (!this.deps.docs.createIssuePage || !this.deps.docs.refreshIssueIndex) return;
    await this.deps.docs.createIssuePage(module, issue);
    const items = projectIssues
      .filter((i) => i.moduleId === module.id)
      .map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        docPath: moduleIssueRelPath(module.slug, i.id, i.title),
      }));
    await this.deps.docs.refreshIssueIndex(module, items);
    this.store.touch(module.id);
  }

  /**
   * 合并模块：来源整体并入目标后归档（slug 不复用、会话留在归档行上）。
   * issue 重指属于引擎领域，经 repoint 回调注入；模块行与文档索引在这里收口。
   */
  async merge(input: ModuleMergeInput): Promise<{ target: ProjectModule; sources: ProjectModule[] }> {
    const sourceIds = [...new Set(input.sourceIds)];
    if (sourceIds.length === 0) throw new Error('合并来源不能为空');
    if (sourceIds.includes(input.targetId)) throw new Error('目标模块不能同时作为来源');
    const target = this.store.get(input.targetId);
    if (!target || target.projectId !== input.projectId || target.status !== 'active') {
      throw new Error('目标模块不存在或已归档');
    }
    if (target.syncStatus !== 'ready') throw new Error(`目标模块文档未就绪：${target.syncError ?? 'unknown'}`);
    const sources = sourceIds.map((id) => {
      const m = this.store.get(id);
      if (!m || m.projectId !== input.projectId || m.status !== 'active') {
        throw new Error(`来源模块 ${id} 不存在或已归档`);
      }
      return m;
    });

    await input.repoint(target, sources);

    for (const s of sources) this.store.archive(s.id);
    this.store.touch(target.id);
    await this.deps.docs.refreshIndex(this.store.listByProject(input.projectId));
    return {
      target: this.store.get(target.id)!,
      sources: sources.map((s) => this.store.get(s.id)!),
    };
  }

  /**
   * 直接建模块（智能整理 create 动作 / 用户显式新建）：slug 由调用方给定（已语义化），
   * 不经分类器；source=manual 不受软上限约束。与项目内任何 slug（含归档）冲突即拒绝。
   */
  async createManual(input: {
    projectId: number;
    slug: string;
    displayName: string;
    agent: AgentKind;
    createdBy?: number | null;
  }): Promise<ProjectModule> {
    const slug = normalizeModuleSlug(input.slug);
    if (!slug) throw new Error(`非法模块 slug: ${input.slug}`);
    const clash = this.store.bySlug(input.projectId, slug);
    if (clash) throw new Error(`slug「${slug}」已被模块「${clash.displayName}」占用（${clash.status}）`);
    return this.createReady({
      projectId: input.projectId,
      slug,
      displayName: input.displayName,
      agent: input.agent,
      source: 'manual',
      createdBy: input.createdBy ?? null,
    });
  }

  /**
   * 改 slug（智能整理 rename 动作：legacy-module-NN → 语义化英文名）。三处同步的前两处
   * 在这里收口：文档目录整体迁移（renameDir，meta 同步改写）+ 模块行 slug；第三处
   * （issues.module 文本列，pickNext 靠它调度）属 issue 域，由引擎在调用后补齐。
   * 顺序：先迁目录后改库——目录迁移失败时库内 slug 未动，旧目录原样，可安全重试。
   */
  async renameSlug(
    projectId: number,
    moduleId: number,
    newSlug: string,
    displayName?: string,
  ): Promise<ProjectModule> {
    const m = this.requireActive(projectId, moduleId);
    const slug = normalizeModuleSlug(newSlug);
    if (!slug) throw new Error(`非法模块 slug: ${newSlug}`);
    if (slug === m.slug) {
      return displayName ? this.rename(projectId, moduleId, displayName) : m;
    }
    const clash = this.store.bySlug(projectId, slug);
    if (clash) throw new Error(`slug「${slug}」已被模块「${clash.displayName}」占用（${clash.status}）`);
    if (!this.deps.docs.renameDir) throw new Error('文档端口不支持改 slug');
    await this.deps.docs.renameDir(m, slug);
    this.store.setSlug(m.id, slug);
    if (displayName) this.store.rename(m.id, displayName);
    const updated = this.store.get(m.id)!;
    await this.deps.docs.ensureModule(updated);
    await this.deps.docs.refreshIndex(this.store.listByProject(projectId));
    return updated;
  }

  /** 刷新某模块的 ISSUES.md 索引（issue 被挪走后来源模块要除名；目标模块由 recordIssue 顺带刷） */
  async syncIssueIndex(
    module: ProjectModule,
    projectIssues: Array<{ id: number; title: string; status: string; moduleId: number | null }>,
  ): Promise<void> {
    if (!this.deps.docs.refreshIssueIndex) return;
    const items = projectIssues
      .filter((i) => i.moduleId === module.id)
      .map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        docPath: moduleIssueRelPath(module.slug, i.id, i.title),
      }));
    await this.deps.docs.refreshIssueIndex(module, items);
  }

  /** 改显示名（slug 是稳定目录名不动）；文档 meta 与索引同步刷新。 */
  async rename(projectId: number, moduleId: number, displayName: string): Promise<ProjectModule> {
    const m = this.requireActive(projectId, moduleId);
    this.store.rename(m.id, displayName);
    const updated = this.store.get(m.id)!;
    await this.deps.docs.ensureModule(updated);
    await this.deps.docs.refreshIndex(this.store.listByProject(projectId));
    return updated;
  }

  /** 归档单个模块（issue 域守卫在引擎侧做）；status 同步进文档 meta，索引里消失。 */
  async archiveModule(projectId: number, moduleId: number): Promise<ProjectModule> {
    const m = this.requireActive(projectId, moduleId);
    this.store.archive(m.id);
    const updated = this.store.get(m.id)!;
    await this.deps.docs.ensureModule(updated);
    await this.deps.docs.refreshIndex(this.store.listByProject(projectId));
    return updated;
  }

  private requireActive(projectId: number, moduleId: number): ProjectModule {
    const m = this.store.get(moduleId);
    if (!m || m.projectId !== projectId || m.status !== 'active') {
      throw new Error('模块不存在或已归档');
    }
    return m;
  }

  private async createReady(input: CreateModuleInput): Promise<ProjectModule> {
    const created = this.store.create(input);
    try {
      await this.deps.docs.ensureModule(created);
      await this.deps.docs.refreshIndex(this.store.listByProject(created.projectId));
      this.store.setSyncReady(created.id);
      return this.store.get(created.id)!;
    } catch (e) {
      this.store.setSyncError(created.id, String(e));
      throw new Error(`模块文档初始化失败：${String(e).slice(0, 200)}`);
    }
  }
}
