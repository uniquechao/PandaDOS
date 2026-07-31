/**
 * core/agent-compat —— claude code / codex 双代理配置互认（issue 维度代理切换的配套）。
 *
 * 三类，全部「缺失才写、绝不覆盖」（幂等；人工文件永远优先）：
 * 1. 家目录双代理互认技能（两边 CLI 都认 skills/<name>/SKILL.md 格式）：
 *    - <codexHome>/skills/claude-config-compat/SKILL.md：教 codex 读 CLAUDE.md 与 .claude/；
 *    - <claudeHome>/skills/agents-md-compat/SKILL.md：教 claude 读 AGENTS.md 与 .codex/。
 * 2. 家目录内置行为技能 artifacts-to-cwd（claude+codex 各一份）：产物一律落当前工作目录，
 *    好进项目文件列表被预览（ensureArtifactSkill；随服务启动 + 每次会话激活各装一次）。
 * 3. 项目 cwd 桥接文件：CLAUDE.md / AGENTS.md 缺一边时生成指向另一边的桥（根文件每次
 *    会话必读，比技能匹配更可靠）。
 *
 * 调用点：ConversationManager.activate + server 启动（best-effort，失败静默——与 trustDir 同纪律）。
 * 依赖方向：core 最内层，用与 ExecutorDriver 结构兼容的最小接口。
 */

export interface CompatDriver {
  /** 只用「存在与否」（null = 不存在）；返回体形状不限，兼容 ConvDriver/ExecutorDriver */
  statPath(path: string): Promise<object | null>;
  readFileRange(path: string, offset: number, limit: number): Promise<{ data: Uint8Array; size: number }>;
  writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void>;
}

export interface CompatHomes {
  /** 执行机 ~/.claude（缺省不装 claude 侧技能） */
  claudeHome?: string;
  /** 执行机 ~/.codex（缺省不装 codex 侧技能） */
  codexHome?: string;
}

const GEN_MARK = 'tmux-butler 自动生成';
const MODULE_GUIDE_START = '<!-- mando:module-guide:start -->';
const MODULE_GUIDE_END = '<!-- mando:module-guide:end -->';

export const MANDO_ISSUE_SKILL = `---
name: mando-issue
description: Use whenever working on an issue or module in a repository containing .butler/modules/INDEX.md, or when a prompt provides a Mando module or issue process-page path.
---

# Mando Issue 模块记忆（${GEN_MARK}）

1. 从当前工作目录向上定位项目根目录，先读 \`.butler/modules/INDEX.md\`。
2. 读取当前模块的 \`MODULE.md\`，再读 prompt 指定的 issue 过程页。
3. 实施中只记录关键设计、决策、文件和测试，不写逐条终端流水。
4. 完成前更新 issue 过程页；只有长期仍有效的知识才提炼回 \`MODULE.md\`。
5. 不自行批量创建模块。文档身份、数据库事实和代码冲突时停止写入并明确报告。
`;

const MODULE_GUIDE_BLOCK = `${MODULE_GUIDE_START}
## Mando issue 模块记忆

处理 issue 或修改代码前，先读取 \`.butler/modules/INDEX.md\`，再读取当前模块的
\`MODULE.md\` 和当前 issue 过程页。遵循全局技能 \`mando-issue\`：实施中维护过程页，
完成时只把长期有效的知识提炼回模块文档，不记录逐条终端流水。
${MODULE_GUIDE_END}`;

/** codex 侧默认技能：读懂 Claude Code 的项目配置 */
export const CODEX_COMPAT_SKILL = `---
name: claude-config-compat
description: Use when working in any repo that contains CLAUDE.md or a .claude/ directory - read and honor Claude Code project configuration (CLAUDE.md instructions, .claude/skills, .claude/commands) as if it were AGENTS.md content.
---

# Claude Code 配置兼容（${GEN_MARK}）

仓库里出现以下任一文件时，视同 AGENTS.md 的一部分并遵照执行：

1. \`CLAUDE.md\`（根目录及子目录）：项目约定/构建测试命令/禁区，效力等同 AGENTS.md。
2. \`.claude/skills/<name>/SKILL.md\`：技能定义。当前任务与其 frontmatter description
   匹配时，先完整读取该 SKILL.md 再动手。
3. \`.claude/commands/<name>.md\`：斜杠命令。用户消息以 \`/<name>\` 开头时按该文件的
   模板执行（\`$ARGUMENTS\` 替换为命令参数）。
4. \`~/.claude/CLAUDE.md\`（用户全局约定，如存在）。

冲突时以更具体者优先：显式用户指令 > 项目 CLAUDE.md/AGENTS.md > 全局配置。
`;

/** claude 侧默认技能：读懂 codex 的项目配置 */
export const CLAUDE_COMPAT_SKILL = `---
name: agents-md-compat
description: Use when working in any repo that contains AGENTS.md, AGENT.md or a .codex/ or .agents/ directory - read and honor Codex project configuration (AGENTS.md instructions, .codex skills and rules) as if it were CLAUDE.md content.
---

# Codex 配置兼容（${GEN_MARK}）

仓库里出现以下任一文件时，视同 CLAUDE.md 的一部分并遵照执行：

1. \`AGENTS.md\`（根目录及子目录；含 \`AGENT.md\` 变体）：项目约定/构建测试命令/禁区，
   效力等同 CLAUDE.md。
2. \`.codex/\` 或 \`.agents/\` 目录内的技能与规则（如 \`skills/<name>/SKILL.md\`）：
   当前任务匹配其 description 时先完整读取再动手。
3. \`~/.codex/AGENTS.md\`（用户全局约定，如存在）。

冲突时以更具体者优先：显式用户指令 > 项目 AGENTS.md/CLAUDE.md > 全局配置。
`;

/**
 * 内置行为技能：产物（图片/网页/代码/文档等）一律落**当前工作目录**——这样才会出现在
 * 项目文件列表里、能在对话侧栏被预览。claude 与 codex 各装一份（两边都认 skills/<name>/SKILL.md）。
 * description 用英文触发词（任务一旦要产出文件就命中），正文中文与其它内置技能同风格。
 */
export const ARTIFACT_CWD_SKILL = `---
name: artifacts-to-cwd
description: Use whenever a task produces a file, image, chart, diagram, screenshot, webpage, PDF, document, or any generated artifact - always create it inside the current working directory (the project folder) using a relative path, never in /tmp, the home directory, or any absolute path outside the project, so it appears in the project file list and can be previewed in the chat.
---

# 产物一律落当前工作目录（${GEN_MARK}）

你在一个「对话/项目工作台」里干活，产物要能在网页里被列出与预览。因此：

1. 任何生成的文件——图片、图表、示意图、截图、网页(HTML)、PDF、代码、文档、数据文件等——
   一律写到**当前工作目录（项目根目录）**或其子目录，用**相对路径**（如 \`./out.png\`、\`assets/chart.svg\`）；
   绝不写到 \`/tmp\`、\`/var\`、家目录或工作目录之外的绝对路径——那些不进项目文件列表、用户看不到。
2. 生成图片/图表：用代码或工具（matplotlib / PIL / canvas / mermaid…）把文件**保存到当前目录**，
   文件名清晰（如 \`bar-chart.png\`）；别只在内存里展示或只打印 base64。要多张就落多个文件、别覆盖。
3. 生成网页：把 \`.html\` 及其引用的 \`.css/.js/图片\`一起落在当前目录（相对引用），便于整体预览。
4. 产出后，在回复里明确列出生成了哪些文件（相对路径），方便用户点开预览。

一句话：先把东西**存成当前目录里的文件**，再在对话里说明——别让产物只活在临时目录或终端输出里。
`;

/** 项目桥：有 CLAUDE.md 没 AGENTS.md 时生成（codex 每会话必读根 AGENTS.md） */
export const AGENTS_MD_BRIDGE = `# AGENTS.md —— Claude 配置兼容桥（${GEN_MARK}）

本仓库的权威 agent 指南是根目录的 CLAUDE.md。开始任何工作前：

1. 通读根目录 \`CLAUDE.md\`，其中全部约定（编码规范、构建/测试命令、禁区）对你同样生效。
2. 若存在 \`.claude/\` 目录，将其视为本文件的一部分：
   - \`.claude/skills/<name>/SKILL.md\`：技能。任务与其 description 匹配时先读再动手；
   - \`.claude/commands/<name>.md\`：斜杠命令。用户输入 \`/<name>\` 时按该文件执行；
   - \`.claude/agents/*.md\`：子代理角色定义，可作分工参考。
3. 人工维护的内容请写入 CLAUDE.md；本文件删除后会被自动重建。
`;

/** 项目桥：有 AGENTS.md（或 AGENT.md）没 CLAUDE.md 时生成（@import 全文引入） */
export function claudeMdBridge(agentsFile: string): string {
  return `# CLAUDE.md —— Codex 配置兼容桥（${GEN_MARK}）

本仓库的权威 agent 指南是根目录的 ${agentsFile}，全文引入：

@${agentsFile}

另外：若存在 \`.codex/\` 或 \`.agents/\` 目录，其中的技能/规则（如 \`skills/<name>/SKILL.md\`）
同样适用，任务匹配时先读再动手。人工维护的内容请写入 ${agentsFile}；本文件删除后会被自动重建。
`;
}

async function exists(d: CompatDriver, path: string): Promise<boolean> {
  return (await d.statPath(path).catch(() => null)) !== null;
}

/** 缺失才写；返回是否本次写入 */
async function writeIfMissing(d: CompatDriver, path: string, content: string): Promise<boolean> {
  if (await exists(d, path)) return false;
  await d.writeFile(path, content);
  return true;
}

async function readText(d: CompatDriver, path: string): Promise<string | null> {
  const st = await d.statPath(path).catch(() => null);
  if (!st) return null;
  const size = Math.max(1, Number((st as { size?: unknown }).size) || 1024 * 1024);
  const { data } = await d.readFileRange(path, 0, size);
  return new TextDecoder().decode(data);
}

/**
 * 家目录默认技能安装（幂等）。返回本次写入的路径（可观测/测试断言用）。
 * 只在对应 home 配了才装；失败上抛交调用方 best-effort。
 */
export async function ensureCompatSkills(d: CompatDriver, homes: CompatHomes): Promise<string[]> {
  const wrote: string[] = [];
  const jobs: Array<[string | undefined, string, string]> = [
    [homes.codexHome, 'skills/claude-config-compat/SKILL.md', CODEX_COMPAT_SKILL],
    [homes.claudeHome, 'skills/agents-md-compat/SKILL.md', CLAUDE_COMPAT_SKILL],
  ];
  for (const [home, rel, content] of jobs) {
    if (!home) continue;
    const path = `${home.replace(/\/+$/, '')}/${rel}`;
    if (await writeIfMissing(d, path, content)) wrote.push(path);
  }
  return wrote;
}

/**
 * 安装「产物落 cwd」内置行为技能到家目录 skills/（幂等，缺失才写）；claude 与 codex 各一份。
 * 随服务启动装一次 + 每次会话激活各调一次（best-effort，失败上抛交调用方吞）。返回本次写入的路径。
 */
export async function ensureArtifactSkill(d: CompatDriver, homes: CompatHomes): Promise<string[]> {
  const wrote: string[] = [];
  const rel = 'skills/artifacts-to-cwd/SKILL.md';
  for (const home of [homes.claudeHome, homes.codexHome]) {
    if (!home) continue;
    const path = `${home.replace(/\/+$/, '')}/${rel}`;
    if (await writeIfMissing(d, path, ARTIFACT_CWD_SKILL)) wrote.push(path);
  }
  return wrote;
}

/** Claude/Codex 双侧安装同源的模块 issue 工作流技能。人工文件不覆盖。 */
export async function ensureMandoIssueSkill(d: CompatDriver, homes: CompatHomes): Promise<string[]> {
  const wrote: string[] = [];
  const rel = 'skills/mando-issue/SKILL.md';
  for (const home of [homes.claudeHome, homes.codexHome]) {
    if (!home) continue;
    const path = `${home.replace(/\/+$/, '')}/${rel}`;
    const existing = await readText(d, path);
    if (existing === MANDO_ISSUE_SKILL) continue;
    if (existing !== null && !existing.includes(GEN_MARK)) continue;
    await d.writeFile(path, MANDO_ISSUE_SKILL);
    wrote.push(path);
  }
  return wrote;
}

/** 在已存在的根指南中幂等维护模块入口；只动本系统标记区块。 */
export async function ensureModuleGuideBlocks(d: CompatDriver, cwd: string): Promise<string[]> {
  const root = cwd.replace(/\/+$/, '');
  const wrote: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = `${root}/${name}`;
    const existing = await readText(d, path);
    if (existing === null) {
      const heading =
        name === 'CLAUDE.md'
          ? '# CLAUDE.md —— Mando 项目入口\n\n@AGENTS.md\n'
          : '# AGENTS.md —— Mando 项目入口\n';
      await d.writeFile(path, `${heading}\n${MODULE_GUIDE_BLOCK}\n`);
      wrote.push(path);
      continue;
    }
    const re = new RegExp(`${MODULE_GUIDE_START}[\\s\\S]*?${MODULE_GUIDE_END}`);
    const next = re.test(existing)
      ? existing.replace(re, MODULE_GUIDE_BLOCK)
      : `${existing}${existing.endsWith('\n') ? '' : '\n'}\n${MODULE_GUIDE_BLOCK}\n`;
    if (next === existing) continue;
    await d.writeFile(path, next);
    wrote.push(path);
  }
  return wrote;
}

/**
 * 项目 cwd 级桥接（幂等）：哪边的根指南缺失就生成指向另一边的桥。
 * 返回本次写入的路径。只桥根指南文件——目录级配置（.claude//.codex/）由默认技能覆盖。
 */
export async function ensureProjectBridge(d: CompatDriver, cwd: string): Promise<string[]> {
  const root = cwd.replace(/\/+$/, '');
  const wrote: string[] = [];
  const hasClaudeMd = await exists(d, `${root}/CLAUDE.md`);
  const agentsFile = (await exists(d, `${root}/AGENTS.md`))
    ? 'AGENTS.md'
    : (await exists(d, `${root}/AGENT.md`))
      ? 'AGENT.md'
      : null;

  if (hasClaudeMd && !agentsFile) {
    if (await writeIfMissing(d, `${root}/AGENTS.md`, AGENTS_MD_BRIDGE)) wrote.push(`${root}/AGENTS.md`);
  } else if (!hasClaudeMd && agentsFile) {
    if (await writeIfMissing(d, `${root}/CLAUDE.md`, claudeMdBridge(agentsFile))) {
      wrote.push(`${root}/CLAUDE.md`);
    }
  }
  return wrote;
}
