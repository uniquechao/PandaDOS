/**
 * issues/module-docs —— `.panda/modules` 的版本化模块知识与 issue 过程页。
 *
 * 数据库拥有调度事实；这里拥有可进 git 的长期认知。系统只改显式 managed block，
 * MODULE.md 的人工/agent 正文永不整文件重写。
 */
import type { ProjectModule } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';

const ROOT_REL = '.panda/modules';
const DECODER = new TextDecoder();

type DocDriver = Pick<
  ExecutorDriver,
  'statPath' | 'readFileRange' | 'writeFile' | 'listDir' | 'movePath' | 'removeTree'
>;

export interface ModuleIssuePageInput {
  id: number;
  syncUid?: string;
  title: string;
  body: string | null;
  status: string;
  agent: 'claude' | 'codex';
  category?: 'task' | 'design' | 'debug';
  implMode?: 'seq' | 'team';
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
  return `<!-- panda:${name}:start -->\n${body.trimEnd()}\n<!-- panda:${name}:end -->`;
}

/** 替换唯一 managed block；不存在则在文件末尾追加。人工区块原样保留。 */
export function upsertManagedBlock(text: string, name: string, body: string): string {
  const next = block(name, body);
  const re = new RegExp(
    `<!-- panda:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:start -->[\\s\\S]*?<!-- panda:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:end -->`,
  );
  if (re.test(text)) return text.replace(re, next);
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${text.length ? '\n' : ''}${next}\n`;
}

/**
 * 模块知识区（#277 / I-01）：`<!-- panda:module-knowledge:start/end -->`。
 *
 * 为什么要有它：模块永久会话原本靠「继承上一条 issue 的 transcript」来保持连续性，
 * 每开一条新 issue 都把上一条的尾巴整段带进窗口，是纯浪费。改成每条 issue 独立 transcript 后，
 * 跨 issue 的连续性由这一小段**结构化知识**承担——它进 git、可审阅、体量恒定，
 * 而不是把几十 K 的对话历史一路拖着走。
 *
 * 三条纪律：
 * - **由引擎写，不依赖代理自觉**：内容在 segment 结束时确定性生成，代理不参与。
 * - **体量恒定**：只留最近 N 条，单条与总量都截断——它是「最近干了什么」的索引，不是档案。
 * - **同一 issue 只留最新一条**：一条 issue 可能 blocked 后又恢复、结束两次 segment，
 *   留两条只是噪音；按 issue 去重并移到末尾（末尾 = 最近）。
 */
export const MODULE_KNOWLEDGE_BLOCK = 'module-knowledge';
/** 保留的条目数上限 */
export const MAX_KNOWLEDGE_ENTRIES = 20;
/** 单条上限（含前缀）；超长按字符截断，不丢这条 */
export const MAX_KNOWLEDGE_ENTRY_CHARS = 300;
/** 整段正文上限；超了从最旧的开始丢 */
export const MAX_KNOWLEDGE_CHARS = 4000;

const KNOWLEDGE_HEADER =
  '（本区块由 PandaDOS 引擎在每条 issue 结束时自动维护，只保留最近若干条，手工修改会被覆盖。）';

export interface ModuleKnowledgeEntry {
  issueId: number;
  /** 收尾状态：done / blocked / cancelled … */
  status: string;
  title: string;
  /** 一句话结论（引擎从收尾摘要里取首段；可空） */
  note?: string;
}

function oneLine(s: string): string {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 单条的行格式；解析时只认 `- #<id> ` 开头的行，故格式与解析是一体的 */
export function formatModuleKnowledgeEntry(entry: ModuleKnowledgeEntry): string {
  const note = oneLine(entry.note ?? '');
  const line = `- #${entry.issueId} ${oneLine(entry.status)} · ${oneLine(entry.title)}${note ? ` —— ${note}` : ''}`;
  return line.length <= MAX_KNOWLEDGE_ENTRY_CHARS
    ? line
    : `${line.slice(0, MAX_KNOWLEDGE_ENTRY_CHARS - 1)}…`;
}

/** 从整份 MODULE.md 里读出知识条目（原样行）；没有该区块返回空数组 */
export function parseModuleKnowledge(text: string): string[] {
  const re = new RegExp(
    `<!-- panda:${MODULE_KNOWLEDGE_BLOCK}:start -->([\\s\\S]*?)<!-- panda:${MODULE_KNOWLEDGE_BLOCK}:end -->`,
  );
  const m = re.exec(text);
  if (!m) return [];
  return (m[1] ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => /^- #\d+ /.test(l));
}

/** 该条对应的 issue id（去重用）；解析不出返回 null */
function entryIssueId(line: string): number | null {
  const m = /^- #(\d+) /.exec(line);
  return m ? Number(m[1]) : null;
}

/**
 * 追加一条模块知识并整段重写（幂等：同样的输入产出同样的整段，不会越写越乱）。
 * 返回新的整份文档文本；不碰任何其它区块与人工正文。
 */
export function appendModuleKnowledge(
  text: string,
  entry: ModuleKnowledgeEntry,
  opts: { maxEntries?: number; maxChars?: number } = {},
): string {
  const maxEntries = opts.maxEntries ?? MAX_KNOWLEDGE_ENTRIES;
  const maxChars = opts.maxChars ?? MAX_KNOWLEDGE_CHARS;
  const line = formatModuleKnowledgeEntry(entry);
  // 同一 issue 只留最新一条：先剔掉旧的，再把新的放到末尾
  const kept = parseModuleKnowledge(text).filter((l) => entryIssueId(l) !== entry.issueId);
  let lines = [...kept, line];
  if (lines.length > Math.max(1, maxEntries)) lines = lines.slice(-Math.max(1, maxEntries));
  // 总量超限：从最旧的开始丢，但至少留住刚写进去的这一条
  while (lines.length > 1 && [KNOWLEDGE_HEADER, ...lines].join('\n').length > maxChars) {
    lines = lines.slice(1);
  }
  return upsertManagedBlock(text, MODULE_KNOWLEDGE_BLOCK, [KNOWLEDGE_HEADER, ...lines].join('\n'));
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

/** 找到“原始需求”之后首个过程页保留章节；正文自己的 Markdown 标题和 fenced code 不算边界。 */
export function issueOriginalRequestEnd(text: string, contentStart: number): number {
  const rest = text.slice(contentStart);
  const boundary = /^## (?:澄清与设计|设计与实施|修改文件与测试|结果与遗留事项)(?:\s.*)?$|^<!-- panda:issue-meta:start -->\s*$/;
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let offset = 0;
  for (const part of rest.match(/.*(?:\r?\n|$)/g) ?? []) {
    if (!part) continue;
    const line = part.replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      const kind = marker[0] as '`' | '~';
      if (!fence) fence = { marker: kind, length: marker.length };
      else if (fence.marker === kind && marker.length >= fence.length) fence = null;
    } else if (!fence && boundary.test(line)) {
      return contentStart + offset;
    }
    offset += part.length;
  }
  return text.length;
}

/** 同步数据库权威的标题/正文，其他过程章节和 managed block 原样保留。 */
export function syncIssueDocumentContent(
  text: string,
  issue: Pick<ModuleIssuePageInput, 'id' | 'title' | 'body'>,
): string {
  const title = `# #${issue.id} ${issue.title}`;
  const titleRe = new RegExp(`^# #${issue.id}(?:\\s.*)?$`, 'm');
  let next = titleRe.test(text) ? text.replace(titleRe, title) : `${title}\n\n${text}`;
  const body = issue.body?.trim() || '（无补充正文）';
  const section = /^## 原始需求[^\r\n]*(?:\r?\n|$)/m.exec(next);
  if (!section || section.index === undefined) {
    const titleEnd = next.indexOf('\n', next.indexOf(title));
    const at = titleEnd < 0 ? next.length : titleEnd + 1;
    return `${next.slice(0, at)}\n## 原始需求\n\n${body}\n${next.slice(at)}`;
  }
  const contentStart = section.index + section[0].length;
  const contentEnd = issueOriginalRequestEnd(next, contentStart);
  return `${next.slice(0, section.index)}## 原始需求\n\n${body}\n\n${next.slice(contentEnd)}`;
}

function statusGroup(status: string): 'pending' | 'active' | 'done' {
  if (status === 'pending') return 'pending';
  if (status === 'done' || status === 'blocked' || status === 'paused' || status === 'cancelled') return 'done';
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
    const fileUid = existing?.match(/^sync_uid:\s*([0-9a-f-]+)$/m)?.[1];
    const fileSlug = existing?.match(/^slug:\s*([a-z0-9-]+)$/m)?.[1];
    const fileAgent = existing?.match(/^agent:\s*(claude|codex)$/m)?.[1];
    if ((fileUid && module.syncUid && fileUid !== module.syncUid) ||
        (fileSlug && fileSlug !== module.slug) || (fileAgent && fileAgent !== module.agent)) {
      throw new Error(
        `模块身份冲突：文件=${fileUid ?? '?'}/${fileSlug ?? '?'}/${fileAgent ?? '?'} 数据库=${module.syncUid ?? '?'}/${module.slug}/${module.agent}`,
      );
    }
    const meta = [
      '---',
      ...(module.syncUid ? [`sync_uid: ${module.syncUid}`] : []),
      `module_id: ${module.id}`,
      `project_id: ${module.projectId}`,
      `slug: ${module.slug}`,
      `display_name: ${JSON.stringify(module.displayName)}`,
      `agent: ${module.agent}`,
      `source: ${module.source}`,
      `status: ${module.status}`,
      `created_ts: ${module.createdTs}`,
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
   * slug 改名的文档侧迁移：`.panda/modules/<旧slug>/` 整目录搬到 `<新slug>/`，
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
    let existing = await readText(this.driver, path);
    if (existing === null) {
      const issueDirRel = `${ROOT_REL}/${module.slug}/issues`;
      const issueDir = this.abs(issueDirRel);
      const oldNames = (await this.driver.listDir(issueDir).catch(() => []))
        .filter((entry) => entry.name.startsWith(`${issue.id}-`) && entry.name.endsWith('.md'))
        .map((entry) => entry.name);
      if (oldNames.length > 1) throw new Error(`Issue #${issue.id} 过程页身份冲突`);
      if (oldNames[0]) {
        await this.driver.movePath(`${issueDir}/${oldNames[0]}`, path);
        existing = await readText(this.driver, path);
      }
    }
    const meta = [
      '---',
      ...(issue.syncUid ? [`sync_uid: ${issue.syncUid}`] : []),
      `issue_id: ${issue.id}`,
      ...(module.syncUid ? [`module_uid: ${module.syncUid}`] : []),
      `module_id: ${module.id}`,
      `module: ${module.slug}`,
      `agent: ${issue.agent}`,
      `category: ${issue.category ?? 'task'}`,
      `impl_mode: ${issue.implMode ?? 'seq'}`,
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
    const next = upsertManagedBlock(syncIssueDocumentContent(base, issue), 'issue-meta', meta);
    if (next !== existing) await this.driver.writeFile(path, next);
    return rel;
  }

  /** 把 issue 收尾总结持久化到过程页；临时文件哨兵读回后即可安全清理。 */
  async recordResultSummary(
    module: ProjectModule,
    issue: ModuleIssuePageInput,
    summary: string,
  ): Promise<void> {
    const rel = await this.createIssuePage(module, issue);
    const path = this.abs(rel);
    const existing = (await readText(this.driver, path)) ?? '';
    const next = upsertManagedBlock(existing, 'result-summary', summary.trim());
    if (next !== existing) await this.driver.writeFile(path, next);
  }

  /**
   * 把一条模块知识写进该模块 MODULE.md 的知识区（#277 / I-01）。
   * 只改 managed block，人工正文与其它区块原样保留；内容一致时不写盘。
   */
  async recordModuleKnowledge(module: ProjectModule, entry: ModuleKnowledgeEntry): Promise<void> {
    const path = this.abs(`${ROOT_REL}/${module.slug}/MODULE.md`);
    const existing = (await readText(this.driver, path)) ?? `# ${module.displayName}\n`;
    const next = appendModuleKnowledge(existing, entry);
    if (next !== existing) await this.driver.writeFile(path, next);
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
