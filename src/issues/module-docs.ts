/**
 * issues/module-docs —— `.mando/modules` 的版本化模块知识与 issue 过程页。
 *
 * 数据库拥有调度事实；这里拥有可进 git 的长期认知。系统只改显式 managed block，
 * MODULE.md 的人工/agent 正文永不整文件重写。
 */
import type { ProjectModule } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';

const ROOT_REL = '.mando/modules';
const DECODER = new TextDecoder();

type DocDriver = Pick<
  ExecutorDriver,
  'statPath' | 'readFileRange' | 'writeFile' | 'listDir' | 'removeTree'
>;

export interface ModuleIssuePageInput {
  id: number;
  title: string;
  body: string | null;
  status: string;
  agent: 'claude' | 'codex';
  createdTs: number;
}

export interface ModuleIssueIndexItem {
  id: number;
  title: string;
  status: string;
  docPath: string;
}

async function readText(driver: DocDriver, path: string): Promise<string | null> {
  const st = await driver.statPath(path);
  if (!st || st.isDirectory) return null;
  const { data } = await driver.readFileRange(path, 0, Math.max(1, st.size));
  return DECODER.decode(data);
}

function block(name: string, body: string): string {
  return `<!-- mando:${name}:start -->\n${body.trimEnd()}\n<!-- mando:${name}:end -->`;
}

/** 替换唯一 managed block；不存在则在文件末尾追加。人工区块原样保留。 */
export function upsertManagedBlock(text: string, name: string, body: string): string {
  const next = block(name, body);
  const re = new RegExp(
    `<!-- mando:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:start -->[\\s\\S]*?<!-- mando:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:end -->`,
  );
  if (re.test(text)) return text.replace(re, next);
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${text.length ? '\n' : ''}${next}\n`;
}

function issueFileSlug(title: string): string {
  const words = title
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter(Boolean)
    .slice(0, 6);
  return words?.length ? words.join('-').slice(0, 60).replace(/-+$/, '') : 'issue';
}

export function moduleIssueRelPath(moduleSlug: string, issueId: number, title: string): string {
  return `${ROOT_REL}/${moduleSlug}/issues/${issueId}-${issueFileSlug(title)}.md`;
}

function statusGroup(status: string): 'pending' | 'active' | 'done' {
  if (status === 'pending') return 'pending';
  if (status === 'done' || status === 'blocked' || status === 'cancelled') return 'done';
  return 'active';
}

export class ModuleDocs {
  private readonly root: string;

  constructor(
    private readonly driver: DocDriver,
    cwd: string,
  ) {
    this.root = cwd.replace(/\/+$/, '');
  }

  private abs(rel: string): string {
    return `${this.root}/${rel}`;
  }

  async ensureModule(module: ProjectModule): Promise<void> {
    const moduleRel = `${ROOT_REL}/${module.slug}/MODULE.md`;
    const modulePath = this.abs(moduleRel);
    const existing = await readText(this.driver, modulePath);
    const identity = existing?.match(
      /module_id:\s*(\d+)[\s\S]*?slug:\s*([a-z0-9-]+)[\s\S]*?agent:\s*(claude|codex)/,
    );
    if (
      identity &&
      (Number(identity[1]) !== module.id || identity[2] !== module.slug || identity[3] !== module.agent)
    ) {
      throw new Error(
        `模块身份冲突：文件=${identity[1]}/${identity[2]}/${identity[3]} 数据库=${module.id}/${module.slug}/${module.agent}`,
      );
    }
    const meta = [
      '---',
      `module_id: ${module.id}`,
      `project_id: ${module.projectId}`,
      `slug: ${module.slug}`,
      `display_name: ${JSON.stringify(module.displayName)}`,
      `agent: ${module.agent}`,
      `status: ${module.status}`,
      `last_used_ts: ${module.lastUsedTs ?? 'null'}`,
      '---',
    ].join('\n');
    const base =
      existing ??
      `# ${module.displayName}\n\n## 职责边界\n\n请在这里维护模块负责和不负责的范围。\n\n` +
        `## 关联源码路径\n\n- （待 agent 根据实际代码补充）\n\n` +
        `## 长期设计约束\n\n- （只记录当前仍有效的约束）\n\n` +
        `## 接口与测试\n\n- （待补充）\n`;
    const next = upsertManagedBlock(base, 'module-meta', meta);
    if (next !== existing) await this.driver.writeFile(modulePath, next);

    const issuesPath = this.abs(`${ROOT_REL}/${module.slug}/ISSUES.md`);
    if ((await readText(this.driver, issuesPath)) === null) {
      await this.driver.writeFile(
        issuesPath,
        `# ${module.displayName} · Issues\n\n${block(
          'issues',
          '## 进行中\n\n（无）\n\n## 待办\n\n（无）\n\n## 已完成\n\n（无）',
        )}\n`,
      );
    }
  }

  /**
   * slug 改名的文档侧迁移：`.mando/modules/<旧slug>/` 整目录搬到 `<新slug>/`，
   * 并把新 MODULE.md 的 meta slug 改写成新值（否则 ensureModule 身份校验必炸）。
   * Driver 无 move 原语（加接口要同步 4 处），目录只有少量 md——递归复制 + 删旧实现。
   * 迁移前校验 MODULE.md 身份（module_id 必须对上）；旧目录不存在则视为无档可迁（直接返回）。
   */
  async renameDir(module: ProjectModule, newSlug: string): Promise<void> {
    const oldRel = `${ROOT_REL}/${module.slug}`;
    const newRel = `${ROOT_REL}/${newSlug}`;
    const oldAbs = this.abs(oldRel);
    const newAbs = this.abs(newRel);
    const st = await this.driver.statPath(oldAbs);
    if (!st || !st.isDirectory) return; // 无档可迁：ensureModule 稍后按新 slug 初始化
    if (await this.driver.statPath(newAbs)) {
      throw new Error(`模块文档目录已存在：${newRel}`);
    }
    const oldDoc = await readText(this.driver, `${oldAbs}/MODULE.md`);
    const idInFile = oldDoc?.match(/module_id:\s*(\d+)/);
    if (idInFile && Number(idInFile[1]) !== module.id) {
      throw new Error(`模块身份冲突：文件 module_id=${idInFile[1]} 数据库=${module.id}，中止迁移`);
    }
    await this.copyTree(oldAbs, newAbs);
    // meta slug 同步改写（display_name/agent 等以 ensureModule 后续 upsert 为准，这里只救身份字段）
    const moved = await readText(this.driver, `${newAbs}/MODULE.md`);
    if (moved) {
      await this.driver.writeFile(
        `${newAbs}/MODULE.md`,
        moved.replace(/^(slug:\s*)[a-z0-9-]+$/m, `$1${newSlug}`),
      );
    }
    await this.driver.removeTree(oldAbs);
  }

  private async copyTree(from: string, to: string): Promise<void> {
    for (const entry of await this.driver.listDir(from)) {
      const src = `${from}/${entry.name}`;
      const dst = `${to}/${entry.name}`;
      if (entry.type === 'dir') {
        await this.copyTree(src, dst);
      } else if (entry.type === 'file') {
        const st = await this.driver.statPath(src);
        if (!st || st.isDirectory) continue;
        const { data } = await this.driver.readFileRange(src, 0, Math.max(1, st.size));
        await this.driver.writeFile(dst, data); // writeFile 自动建父目录
      }
      // symlink/other：模块文档目录不应出现，跳过（copy 语义按内容，不复刻链接）
    }
  }

  async refreshIndex(modules: ProjectModule[]): Promise<void> {
    const path = this.abs(`${ROOT_REL}/INDEX.md`);
    const existing = (await readText(this.driver, path)) ?? '# 项目模块索引\n';
    const lines = modules
      .slice()
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(
        (m) =>
          `- [${m.displayName}（${m.slug}）](${m.slug}/MODULE.md) · ${m.agent} · ${m.status} · [issues](${m.slug}/ISSUES.md)`,
      );
    const next = upsertManagedBlock(existing, 'module-index', lines.length ? lines.join('\n') : '（无模块）');
    if (next !== existing) await this.driver.writeFile(path, next);
  }

  async createIssuePage(module: ProjectModule, issue: ModuleIssuePageInput): Promise<string> {
    const rel = moduleIssueRelPath(module.slug, issue.id, issue.title);
    const path = this.abs(rel);
    const existing = await readText(this.driver, path);
    const meta = [
      '---',
      `issue_id: ${issue.id}`,
      `module_id: ${module.id}`,
      `module: ${module.slug}`,
      `agent: ${issue.agent}`,
      `status: ${issue.status}`,
      `created_ts: ${issue.createdTs}`,
      '---',
    ].join('\n');
    const base =
      existing ??
      `# #${issue.id} ${issue.title}\n\n` +
        `## 原始需求\n\n${issue.body?.trim() || '（无补充正文）'}\n\n` +
        `## 澄清与设计\n\n（由 agent 维护）\n\n` +
        `## 设计与实施\n\n（由 agent 维护关键节点，不记录逐条终端流水）\n\n` +
        `## 修改文件与测试\n\n（由 agent 在完成前填写）\n\n` +
        `## 结果与遗留事项\n\n（由 agent 在完成前填写）\n`;
    const next = upsertManagedBlock(base, 'issue-meta', meta);
    if (next !== existing) await this.driver.writeFile(path, next);
    return rel;
  }

  async refreshIssueIndex(module: ProjectModule, issues: ModuleIssueIndexItem[]): Promise<void> {
    const path = this.abs(`${ROOT_REL}/${module.slug}/ISSUES.md`);
    const existing = (await readText(this.driver, path)) ?? `# ${module.displayName} · Issues\n`;
    const groups = {
      active: issues.filter((i) => statusGroup(i.status) === 'active'),
      pending: issues.filter((i) => statusGroup(i.status) === 'pending'),
      done: issues.filter((i) => statusGroup(i.status) === 'done'),
    };
    const render = (items: ModuleIssueIndexItem[]): string =>
      items.length
        ? items.map((i) => `- [#${i.id} ${i.title}](${i.docPath.split('/').pop() ? `issues/${i.docPath.split('/').pop()}` : i.docPath}) · ${i.status}`).join('\n')
        : '（无）';
    const body = `## 进行中\n\n${render(groups.active)}\n\n## 待办\n\n${render(groups.pending)}\n\n## 已完成\n\n${render(groups.done)}`;
    const next = upsertManagedBlock(existing, 'issues', body);
    if (next !== existing) await this.driver.writeFile(path, next);
  }
}
