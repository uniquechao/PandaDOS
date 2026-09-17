import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectModule } from '../core/types';
import { LocalDriver } from '../executor/local';
import {
  appendModuleKnowledge,
  formatModuleKnowledgeEntry,
  MAX_KNOWLEDGE_ENTRY_CHARS,
  ModuleDocs,
  moduleIssueRelPath,
  parseModuleKnowledge,
} from './module-docs';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fsp.rm(cleanups.pop()!, { recursive: true, force: true });
});

async function setup(): Promise<{ cwd: string; docs: ModuleDocs; module: ProjectModule }> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-module-docs-'));
  cleanups.push(cwd);
  return {
    cwd,
    docs: new ModuleDocs(new LocalDriver(), cwd),
    module: {
      id: 5,
      syncUid: '018bcfe5-6800-7102-8304-05060708090b',
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

    const index = await fsp.readFile(path.join(cwd, '.panda/modules/INDEX.md'), 'utf8');
    expect(index).toContain('terminal-runtime/MODULE.md');
    expect(index).toContain('codex');
    const moduleMd = await fsp.readFile(
      path.join(cwd, '.panda/modules/terminal-runtime/MODULE.md'),
      'utf8',
    );
    expect(moduleMd).toContain('module_id: 5');
    expect(moduleMd).toContain('slug: terminal-runtime');
    expect(moduleMd).toContain('agent: codex');
    expect(moduleMd).toContain('## 职责边界');
    const issues = await fsp.readFile(
      path.join(cwd, '.panda/modules/terminal-runtime/ISSUES.md'),
      'utf8',
    );
    expect(issues).toContain('panda:issues:start');
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
    expect(rel).toBe('.panda/modules/terminal-runtime/issues/72-terminal-process-isolation.md');

    await docs.refreshIssueIndex(module, [
      { id: 72, title: 'Terminal Process Isolation', status: 'pending', docPath: rel },
      { id: 70, title: 'Old work', status: 'done', docPath: moduleIssueRelPath(module.slug, 70, 'Old work') },
    ]);
    const page = await fsp.readFile(path.join(cwd, rel), 'utf8');
    expect(page).toContain('issue_id: 72');
    expect(page).toContain('module: terminal-runtime');
    expect(page).toContain('## 设计与实施');
    await fsp.appendFile(path.join(cwd, rel), '\n人工过程记录：保留我。\n');
    const updatedRel = await docs.createIssuePage(module, {
      id: 72,
      title: 'Terminal Process Isolation Updated',
      body: '更新后的当前需求',
      status: 'implementing',
      agent: 'codex',
      createdTs: 100,
    });
    const updated = await fsp.readFile(path.join(cwd, updatedRel), 'utf8');
    expect(updated).toContain('status: implementing');
    expect(updated).toContain('# #72 Terminal Process Isolation Updated');
    expect(updated).toContain('## 原始需求\n\n更新后的当前需求');
    expect(updated).not.toContain('对话和 issue 互不影响');
    expect(updated).toContain('## 设计与实施');
    expect(updated).toContain('人工过程记录：保留我。');
    await expect(fsp.stat(path.join(cwd, rel))).rejects.toThrow();
    const index = await fsp.readFile(
      path.join(cwd, '.panda/modules/terminal-runtime/ISSUES.md'),
      'utf8',
    );
    expect(index).toContain('## 待办');
    expect(index).toContain('72-terminal-process-isolation.md');
    expect(index).toContain('## 已完成');
  });

  test('执行总结写入过程页受管区块且幂等更新', async () => {
    const { cwd, docs, module } = await setup();
    const issue = {
      id: 72,
      title: 'Terminal Process Isolation',
      body: '对话和 issue 互不影响',
      status: 'done',
      agent: 'codex' as const,
      createdTs: 100,
    };
    await docs.ensureModule(module);
    await docs.createIssuePage(module, issue);
    await docs.recordResultSummary(module, issue, '第一次总结');
    await docs.recordResultSummary(module, issue, '最终总结');

    const page = await fsp.readFile(
      path.join(cwd, moduleIssueRelPath(module.slug, issue.id, issue.title)),
      'utf8',
    );
    expect(page).toContain('<!-- panda:result-summary:start -->');
    expect(page).toContain('最终总结');
    expect(page).not.toContain('第一次总结');
    expect(page.match(/panda:result-summary:start/g)).toHaveLength(1);
  });

  test('幂等刷新只替换管理区块，保留人工与 agent 正文', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    const modulePath = path.join(cwd, '.panda/modules/terminal-runtime/MODULE.md');
    await fsp.appendFile(modulePath, '\n## 人工约束\n绝不能覆盖这一段。\n');
    await docs.ensureModule({ ...module, lastUsedTs: 99 });
    const twice = await fsp.readFile(modulePath, 'utf8');
    expect(twice.match(/绝不能覆盖这一段。/g)).toHaveLength(1);
    expect(twice.match(/panda:module-meta:start/g)).toHaveLength(1);
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
    const oldModuleMd = path.join(cwd, '.panda/modules/terminal-runtime/MODULE.md');
    await fsp.appendFile(oldModuleMd, '\n## 人工约束\n改名后也要在。\n');

    await docs.renameDir(module, 'terminal-core');
    const renamed = { ...module, slug: 'terminal-core' };
    // ensureModule 按新 slug 校验身份必须通过（meta slug 已被改写）
    await docs.ensureModule(renamed);
    const moved = await fsp.readFile(path.join(cwd, '.panda/modules/terminal-core/MODULE.md'), 'utf8');
    expect(moved).toContain('slug: terminal-core');
    expect(moved).toContain('module_id: 5');
    expect(moved).toContain('改名后也要在。');
    // issue 过程页跟着走；旧目录整体消失
    const movedPage = await fsp.readFile(
      path.join(cwd, '.panda/modules/terminal-core/issues', path.basename(rel)),
      'utf8',
    );
    expect(movedPage).toContain('issue_id: 72');
    await expect(fsp.stat(path.join(cwd, '.panda/modules/terminal-runtime'))).rejects.toThrow();
  });

  test('renameDir：目标目录已存在拒绝；文件 module_id 不符拒绝；旧目录缺失静默返回', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    await fsp.mkdir(path.join(cwd, '.panda/modules/occupied-slot'), { recursive: true });
    await expect(docs.renameDir(module, 'occupied-slot')).rejects.toThrow('已存在');
    await expect(docs.renameDir({ ...module, id: 99 }, 'fresh-slot')).rejects.toThrow('身份冲突');
    // 身份冲突时旧目录未被动过
    await fsp.stat(path.join(cwd, '.panda/modules/terminal-runtime/MODULE.md'));
    // 无档可迁：不抛错
    await docs.renameDir({ ...module, id: 6, slug: 'not-exist-mod' }, 'whatever-name');
  });

  test('MODULE 身份与数据库冲突时拒绝覆盖', async () => {
    const { cwd, docs, module } = await setup();
    await docs.ensureModule(module);
    await expect(docs.ensureModule({
      ...module,
      id: 6,
      syncUid: '018bcfe5-6800-7102-8304-05060708090a',
    })).rejects.toThrow('身份冲突');
    const text = await fsp.readFile(
      path.join(cwd, '.panda/modules/terminal-runtime/MODULE.md'),
      'utf8',
    );
    expect(text).toContain('module_id: 5');
    expect(text).not.toContain('module_id: 6');
  });
});

/** #277 / I-01：跨 issue 的连续性改由这一小段结构化知识承担，替代继承整条 transcript */
describe('模块知识区 module-knowledge（纯函数）', () => {
  const doc = [
    '# issue 引擎',
    '',
    '## 职责边界',
    '',
    '这段是人写的，永远不能被动。',
    '',
    '<!-- panda:module-index:start -->',
    '- [A](a/MODULE.md)',
    '<!-- panda:module-index:end -->',
    '',
  ].join('\n');
  const add = (text: string, id: number, extra: Partial<{ status: string; title: string; note: string }> = {}) =>
    appendModuleKnowledge(text, {
      issueId: id, status: extra.status ?? 'done', title: extra.title ?? `任务 ${id}`,
      ...(extra.note !== undefined ? { note: extra.note } : {}),
    });

  test('追加一条：只动自己的区块，人工正文与其它区块原样保留', () => {
    const out = add(doc, 7, { note: '已上线' });
    expect(out).toContain('- #7 done · 任务 7 —— 已上线');
    expect(out).toContain('这段是人写的，永远不能被动。');
    expect(out).toContain('<!-- panda:module-index:start -->');
    expect(out).toContain('<!-- panda:module-index:end -->');
    // 区块自带说明，避免有人手工去改
    expect(out).toContain('由 PandaDOS 引擎在每条 issue 结束时自动维护');
  });

  test('整段重写而不是逐行追加：重复写同样内容不会越写越乱', () => {
    const once = add(doc, 7, { note: 'n' });
    const twice = add(once, 7, { note: 'n' });
    expect(twice).toBe(once);
    expect(twice.match(/panda:module-knowledge:start/g)).toHaveLength(1);
  });

  test('同一 issue 只留最新一条，并移到末尾（末尾 = 最近）', () => {
    let out = add(doc, 1, { note: '第一次' });
    out = add(out, 2);
    out = add(out, 1, { note: '第二次' });
    const lines = parseModuleKnowledge(out);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('#2');
    expect(lines[1]).toContain('第二次');
    expect(out).not.toContain('第一次');
  });

  test('只留最近 N 条：更早的按顺序丢掉', () => {
    let out = doc;
    for (let i = 1; i <= 6; i++) out = add(out, i);
    out = appendModuleKnowledge(out, { issueId: 7, status: 'done', title: '任务 7' }, { maxEntries: 3 });
    const lines = parseModuleKnowledge(out);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.split(' ')[1])).toEqual(['#5', '#6', '#7']);
  });

  test('单条超长按字符截断，但不把这条丢掉', () => {
    const line = formatModuleKnowledgeEntry({
      issueId: 9, status: 'done', title: 'T'.repeat(1000), note: 'N'.repeat(1000),
    });
    expect(line.length).toBe(MAX_KNOWLEDGE_ENTRY_CHARS);
    expect(line).toStartWith('- #9 done · ');
    expect(line).toEndWith('…');
  });

  test('总量超限从最旧的开始丢，至少留住刚写进去的那条', () => {
    let out = doc;
    for (let i = 1; i <= 5; i++) out = add(out, i, { note: 'x'.repeat(200) });
    out = appendModuleKnowledge(out, { issueId: 99, status: 'done', title: '最新' }, { maxChars: 400 });
    const lines = parseModuleKnowledge(out);
    expect(lines.at(-1)).toContain('#99');
    expect(lines.join('\n').length).toBeLessThanOrEqual(400);
  });

  test('换行与多余空白压平：一条就是一行，否则解析会散架', () => {
    const out = add(doc, 3, { title: '多\n行\n标题', note: '带  空白\n的备注' });
    const lines = parseModuleKnowledge(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('- #3 done · 多 行 标题 —— 带 空白 的备注');
  });

  test('文档里没有该区块时凭空建；空文档也能写', () => {
    expect(parseModuleKnowledge('# 空\n')).toEqual([]);
    expect(add('', 1)).toContain('- #1 done · 任务 1');
  });

  test('区块被人手改坏（缺 end 标记）时不吞掉其它内容', () => {
    const broken = `${doc}\n<!-- panda:module-knowledge:start -->\n- #1 done · 旧的\n`;
    const out = add(broken, 2);
    expect(out).toContain('这段是人写的，永远不能被动。');
    expect(out).toContain('<!-- panda:module-index:start -->');
    expect(out).toContain('- #2 done · 任务 2');
  });
});
