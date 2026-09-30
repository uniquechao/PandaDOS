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
  /** 升级时仅用于清除带自动生成标记的旧品牌技能目录。 */
  removeTree?(path: string): Promise<void>;
}

export interface CompatHomes {
  /** 执行机 ~/.claude（缺省不装 claude 侧技能） */
  claudeHome?: string;
  /** 执行机 ~/.codex（缺省不装 codex 侧技能） */
  codexHome?: string;
}

const GEN_MARK = 'panda 自动生成';
const LEGACY_GEN_MARK = 'mando 自动生成';
const MODULE_GUIDE_START = '<!-- panda:module-guide:start -->';
const MODULE_GUIDE_END = '<!-- panda:module-guide:end -->';
const LEGACY_MODULE_GUIDE_START = '<!-- mando:module-guide:start -->';
const LEGACY_MODULE_GUIDE_END = '<!-- mando:module-guide:end -->';

export const PANDA_ISSUE_SKILL = `---
name: panda-issue
description: Use whenever working on an issue or module in a repository containing .panda/modules/INDEX.md, or when a prompt provides a PandaDOS module or issue process-page path.
---

# PandaDOS Issue 模块记忆（${GEN_MARK}）

> 本文件仅供人阅读：运行时规则已内联进注入 prompt（见 \`src/issues/prompts.ts\` 的 \`moduleDocsRule\`），代理不再需要读这个技能。改规则请两边一起改。

1. 从当前工作目录向上定位项目根目录，先读 \`.panda/modules/INDEX.md\`。
2. 读取当前模块的 \`MODULE.md\`，再读 prompt 指定的 issue 过程页。
3. 实施中只记录关键设计、决策、文件和测试，不写逐条终端流水。
4. 完成前更新 issue 过程页；只有长期仍有效的知识才提炼回 \`MODULE.md\`。
5. 不自行批量创建模块。文档身份、数据库事实和代码冲突时停止写入并明确报告。
`;

/**
 * 内置技能 panda-issue-inbox（#368）：让不在 PandaDOS 队列里的本地 claude/codex 直接读取
 * 项目新增 issue。只读：走 HTTP API（Bearer token，脚本经 stdin 传给 curl 不进 ps），
 * 未配 token 时退回读 `.panda/modules` 过程页。脚本与 SKILL.md 同目录，claude/codex 各一份。
 */
export const PANDA_ISSUE_INBOX_SKILL = `---
name: panda-issue-inbox
description: Use when the user asks to read, list, check, pull or pick up new/pending/latest PandaDOS issues (新增 issue、待办 issue、issue 队列、有什么新任务) for the current project from a local agent session.
---

# PandaDOS 新增 issue 读取（${GEN_MARK}）

本地代理（不在 PandaDOS 队列里跑的 claude / codex）用本技能**只读**获取当前项目的 issue。
助手脚本与本文件同目录：\`~/.claude/skills/panda-issue-inbox/panda-issues.sh\`
（codex 为 \`~/.codex/skills/panda-issue-inbox/panda-issues.sh\`），用 \`sh <脚本> <命令>\` 调用。

## 1. 配置（首次）

脚本按顺序取配置：环境变量 → \`~/.panda/agent.env\`（shell 格式，可写下面三个变量）。

- \`PANDA_URL\`：PandaDOS 地址，缺省 \`http://127.0.0.1:8802\`。
- \`PANDA_TOKEN\` 或 \`PANDA_TOKEN_FILE\`：用户自己的登录 token（文件建议 chmod 600）。
- \`PANDA_PROJECT_ID\`：可选，省去按 cwd 匹配项目。

未配置 token 时脚本以退出码 2 失败：不要自己去翻别的凭据文件，告诉用户如何配置，
同时改走第 3 节的离线读取。

## 2. 在线读取（推荐）

1. \`sh panda-issues.sh projects\`：列出可访问项目，按 \`cwd\` 与当前项目根（\`git rev-parse --show-toplevel\`）匹配出项目 id。
2. \`sh panda-issues.sh new <项目id>\`：列出上次确认之后新建的 issue（首次 = 全部）。
   输出为 JSON 数组，关注 \`id\`、\`title\`、\`body\`、\`status\`、\`category\`、\`module\`、\`createdTs\`。
3. \`sh panda-issues.sh issue <项目id> <issueId>\`：单条详情（含子任务、门禁、工作流）。
4. \`sh panda-issues.sh issues <项目id> [since毫秒] [status逗号列表]\`：自定义过滤，
   如 \`issues 3 0 pending,clarifying\`。
5. 用户确认已看过后：\`sh panda-issues.sh ack <项目id> <最大createdTs>\` 推进游标
   （游标存于项目 \`.panda/tmp/issue-inbox/\`，已被 git 忽略）。

## 3. 离线读取（无 token / 服务不可达）

从项目根读 \`.panda/modules/INDEX.md\` → 各模块 \`ISSUES.md\` 的「进行中 / 待办」小节 →
对应 \`issues/<id>-*.md\` 过程页的「原始需求」。仅覆盖已归模块的 issue，需向用户说明。

## 4. 纪律

- 只读：不改 issue 状态、不写数据库、不调用任何 POST/PATCH/DELETE 接口。
- 向用户汇报时按编号列出 id、标题、状态、一句话需求；不要回显 token。
- \`pending\` 等状态的 issue 可能正被 PandaDOS 自动排队执行。用户要在本地实现某条时，
  先提醒可能与队列冲突，由用户决定（如先在 PandaDOS 里取消或暂停）。
`;

export const PANDA_ISSUE_INBOX_SCRIPT = `#!/bin/sh
# PandaDOS 新增 issue 只读助手（${GEN_MARK}）。用法见同目录 SKILL.md。
set -eu
CONF="\${PANDA_AGENT_ENV:-\$HOME/.panda/agent.env}"
if [ -r "\$CONF" ]; then . "\$CONF"; fi
URL="\${PANDA_URL:-http://127.0.0.1:8802}"
URL="\${URL%/}"
TOKEN="\${PANDA_TOKEN:-}"
if [ -z "\$TOKEN" ] && [ -n "\${PANDA_TOKEN_FILE:-}" ] && [ -r "\$PANDA_TOKEN_FILE" ]; then
  TOKEN=\$(tr -d ' \\r\\n' < "\$PANDA_TOKEN_FILE")
fi

die() { echo "panda-issues: \$1" >&2; exit "\${2:-1}"; }
need_token() {
  [ -n "\$TOKEN" ] || die "未配置 token：设置 PANDA_TOKEN / PANDA_TOKEN_FILE，或写入 \$CONF" 2
}
# token 经 stdin 传给 curl 配置，不出现在进程参数里
api() {
  need_token
  printf 'header = "Authorization: Bearer %s"\\n' "\$TOKEN" |
    curl -fsS --max-time 20 -K - "\$URL\$1" || die "请求失败：\$URL\$1" 3
}
pid_of() { p="\${1:-\${PANDA_PROJECT_ID:-}}"; [ -n "\$p" ] || die "缺项目 id（先运行 projects）"; echo "\$p"; }
cursor_file() {
  root=\$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  echo "\$root/.panda/tmp/issue-inbox/\$1.since"
}

cmd="\${1:-help}"
[ \$# -gt 0 ] && shift
case "\$cmd" in
  projects) api "/api/projects" ;;
  issues)
    p=\$(pid_of "\${1:-}")
    q="?since=\${2:-0}"
    [ -n "\${3:-}" ] && q="\$q&status=\$3"
    api "/api/projects/\$p/issues\$q" ;;
  issue)
    p=\$(pid_of "\${1:-}")
    [ -n "\${2:-}" ] || die "缺 issue id"
    api "/api/projects/\$p/issues/\$2" ;;
  new)
    p=\$(pid_of "\${1:-}")
    f=\$(cursor_file "\$p")
    since=0
    if [ -r "\$f" ]; then since=\$(tr -dc '0-9' < "\$f"); fi
    api "/api/projects/\$p/issues?since=\${since:-0}" ;;
  ack)
    p=\$(pid_of "\${1:-}")
    case "\${2:-}" in ''|*[!0-9]*) die "ack 需要毫秒时间戳" ;; esac
    f=\$(cursor_file "\$p")
    mkdir -p "\$(dirname "\$f")"
    echo "\$2" > "\$f"
    echo "已记录游标 \$2 → \$f" ;;
  *)
    echo "用法: sh panda-issues.sh projects | new <项目id> | issues <项目id> [since] [status,...] | issue <项目id> <issueId> | ack <项目id> <createdTs>" ;;
esac
`;

const MODULE_GUIDE_BLOCK = `${MODULE_GUIDE_START}
## PandaDOS issue 模块记忆

处理 issue 或修改代码前，先读取 \`.panda/modules/INDEX.md\`，再读取当前模块的
\`MODULE.md\` 和当前 issue 过程页。遵循全局技能 \`panda-issue\`：实施中维护过程页，
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
export async function ensurePandaIssueSkill(d: CompatDriver, homes: CompatHomes): Promise<string[]> {
  const wrote: string[] = [];
  const rel = 'skills/panda-issue/SKILL.md';
  for (const home of [homes.claudeHome, homes.codexHome]) {
    if (!home) continue;
    const normalizedHome = home.replace(/\/+$/, '');
    const legacyDir = `${normalizedHome}/skills/mando-issue`;
    const legacySkill = await readText(d, `${legacyDir}/SKILL.md`);
    if (
      d.removeTree &&
      legacySkill?.includes(LEGACY_GEN_MARK) &&
      legacySkill.includes('name: mando-issue') &&
      legacySkill.includes('.mando/modules/INDEX.md')
    ) {
      await d.removeTree(legacyDir);
      wrote.push(legacyDir);
    }
    const path = `${normalizedHome}/${rel}`;
    const existing = await readText(d, path);
    if (existing === PANDA_ISSUE_SKILL) continue;
    if (existing !== null && !existing.includes(GEN_MARK)) continue;
    await d.writeFile(path, PANDA_ISSUE_SKILL);
    wrote.push(path);
  }
  return wrote;
}

/**
 * 安装 panda-issue-inbox（SKILL.md + 助手脚本），claude/codex 各一份。
 * 与 panda-issue 同纪律：自动生成的旧版本随升级覆盖，人工改过（无生成标记）的文件不动。
 */
export async function ensurePandaIssueInboxSkill(d: CompatDriver, homes: CompatHomes): Promise<string[]> {
  const wrote: string[] = [];
  const files: Array<[string, string, number | undefined]> = [
    ['skills/panda-issue-inbox/SKILL.md', PANDA_ISSUE_INBOX_SKILL, undefined],
    ['skills/panda-issue-inbox/panda-issues.sh', PANDA_ISSUE_INBOX_SCRIPT, 0o755],
  ];
  for (const home of [homes.claudeHome, homes.codexHome]) {
    if (!home) continue;
    for (const [rel, content, mode] of files) {
      const path = `${home.replace(/\/+$/, '')}/${rel}`;
      const existing = await readText(d, path);
      if (existing === content) continue;
      if (existing !== null && !existing.includes(GEN_MARK)) continue;
      await d.writeFile(path, content, mode);
      wrote.push(path);
    }
  }
  return wrote;
}

/** 在已存在的根指南中幂等维护模块入口；清除旧品牌托管区块，只保留 PandaDOS 入口。 */
export async function ensureModuleGuideBlocks(d: CompatDriver, cwd: string): Promise<string[]> {
  const root = cwd.replace(/\/+$/, '');
  const wrote: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = `${root}/${name}`;
    const existing = await readText(d, path);
    if (existing === null) {
      const heading =
        name === 'CLAUDE.md'
          ? '# CLAUDE.md —— PandaDOS 项目入口\n\n@AGENTS.md\n'
          : '# AGENTS.md —— PandaDOS 项目入口\n';
      await d.writeFile(path, `${heading}\n${MODULE_GUIDE_BLOCK}\n`);
      wrote.push(path);
      continue;
    }
    const legacyRe = new RegExp(
      `\\n?${LEGACY_MODULE_GUIDE_START}[\\s\\S]*?${LEGACY_MODULE_GUIDE_END}\\n?`,
      'g',
    );
    const cleaned = existing.replace(legacyRe, '\n');
    const re = new RegExp(`${MODULE_GUIDE_START}[\\s\\S]*?${MODULE_GUIDE_END}`);
    const next = re.test(cleaned)
      ? cleaned.replace(re, MODULE_GUIDE_BLOCK)
      : `${cleaned}${cleaned.endsWith('\n') ? '' : '\n'}\n${MODULE_GUIDE_BLOCK}\n`;
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
