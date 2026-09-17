/**
 * toolfmt —— 工具调用的「人话」渲染（v1 src/toolfmt.ts 平移，两边保持同构）。
 * 原始 JSON 入参在气泡里不知所云（{"replace_all":false,"file_path":...} 还被截成半截）；
 * 解析 jsonl 时手里还有结构化的 input 对象，就地生成：
 * - title：折叠态一眼看懂的标题（动词 + 目标，如「✏️ 改 Login.tsx」）；
 * - body：展开态的可读正文（路径 / ±diff / $ 命令），UI 按 - / + 行前缀给 diff 着色。
 *
 * full 模式（issue #288）：气泡流里的 body 必须省着占带宽，故各字段按 FIELD / CMD_FIELD /
 * PATCH_FIELD 截断；但「查看完整内容」要按 off 回源 jsonl 重解析一次，那一次必须一个字不少。
 * 因此所有截断上限都走参数，full=true 时统一放开成 Infinity（clip/one 遇 Infinity 原样返回）。
 * 标题不受影响——它是折叠态的一行摘要，再全也只该是一行。
 */

/** 单字段头尾截断（单行拼接场景，用 … 连接不换行） */
function clip(s: unknown, n: number): string {
  const t = String(s ?? "").trim();
  if (t.length <= n) return t;
  const half = Math.floor(n / 2);
  return `${t.slice(0, half)}…[省略${t.length - n}字]…${t.slice(-half)}`;
}

/** 标题里的目标片段：压成单行再截断 */
function one(s: unknown, n = 60): string {
  return clip(String(s ?? "").replace(/\s+/g, " "), n);
}

function base(p: unknown): string {
  const s = String(p ?? "").replace(/\/+$/, "");
  return s.slice(s.lastIndexOf("/") + 1) || s || "?";
}

const FIELD = 360; // 正文单字段上限
const CMD_FIELD = 600; // 命令正文上限（$ 命令行）
const PATCH_FIELD = 1200; // apply_patch 正文上限（多文件补丁比单字段长）

/** old/new 拼 ±diff 文本：每行加 "- "/"+ " 前缀，前端按前缀着色 */
function diffBlock(oldS: unknown, newS: unknown, limit = FIELD): string {
  const mark = (s: string, p: string) => s.split("\n").map((l) => p + l).join("\n");
  const parts: string[] = [];
  const o = String(oldS ?? ""), n = String(newS ?? "");
  if (o) parts.push(mark(clip(o, limit), "- "));
  if (n) parts.push(mark(clip(n, limit), "+ "));
  return parts.join("\n");
}

function host(u: unknown): string {
  try { return new URL(String(u)).host; } catch { return one(u, 40); }
}

interface CodexWrappedCall {
  name: string;
  input: string;
}

/** 找到字符串字面量结尾；不执行来自 rollout 的 JavaScript。 */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return -1;
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === quote) return i;
  }
  return -1;
}

/** 解码常见 JS 字符串转义；模板插值保持原文，绝不 eval。 */
function decodeStringLiteral(literal: string): string {
  if (literal[0] === '"') {
    try { return String(JSON.parse(literal)); } catch { /* 继续走安全兜底 */ }
  }
  const body = literal.slice(1, -1);
  return body.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\\'"`nrtbfv0]))/g, (_m, u, x, c) => {
    if (u) return String.fromCharCode(Number.parseInt(u, 16));
    if (x) return String.fromCharCode(Number.parseInt(x, 16));
    const escaped: Record<string, string> = {
      "\\": "\\", "'": "'", '"': '"', "`": "`",
      n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0",
    };
    return escaped[c] ?? c;
  });
}

/** 扫描 `tools.<name>(...)`，跳过字符串内容并按括号配对，不依赖脆弱的跨调用正则。 */
function codexWrappedCalls(script: string): CodexWrappedCall[] {
  const calls: CodexWrappedCall[] = [];
  for (let i = 0; i < script.length;) {
    if (script[i] === '"' || script[i] === "'" || script[i] === "`") {
      const end = stringEnd(script, i);
      i = end >= 0 ? end + 1 : script.length;
      continue;
    }
    if (!script.startsWith("tools.", i)) {
      i++;
      continue;
    }
    const nameStart = i + 6;
    let nameEnd = nameStart;
    while (nameEnd < script.length && /[A-Za-z0-9_$]/.test(script[nameEnd]!)) nameEnd++;
    const name = script.slice(nameStart, nameEnd);
    let open = nameEnd;
    while (/\s/.test(script[open] ?? "")) open++;
    if (!name || script[open] !== "(") {
      i = Math.max(nameEnd, i + 1);
      continue;
    }
    let depth = 0;
    let close = -1;
    for (let j = open; j < script.length; j++) {
      if (script[j] === '"' || script[j] === "'" || script[j] === "`") {
        const end = stringEnd(script, j);
        if (end < 0) break;
        j = end;
        continue;
      }
      if (script[j] === "(") depth++;
      else if (script[j] === ")" && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close < 0) break;
    calls.push({ name, input: script.slice(open + 1, close).trim() });
    i = close + 1;
  }
  return calls;
}

/** 从非严格 JSON 的对象字面量中安全读取常见字符串字段。 */
function looseStringField(source: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|[,{\\s])(?:["']${key}["']|${key})\\s*:`, "g");
  const m = re.exec(source);
  if (!m) return undefined;
  let at = m.index + m[0].length;
  while (/\s/.test(source[at] ?? "")) at++;
  const end = stringEnd(source, at);
  if (end < 0) return undefined;
  return decodeStringLiteral(source.slice(at, end + 1));
}

function wrappedInput(source: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    if (typeof parsed === "string") return { input: parsed };
  } catch {
    // Codex 也会生成 `{cmd:"..."}` 这种合法 JS、非严格 JSON；只取展示所需的字符串字段。
  }
  if (source[0] === '"' || source[0] === "'" || source[0] === "`") {
    const end = stringEnd(source, 0);
    if (end === source.length - 1) return { input: decodeStringLiteral(source) };
  }
  const out: Record<string, unknown> = {};
  for (const key of [
    "cmd", "command", "path", "file_path", "pattern", "query", "glob", "url", "prompt",
    "old_string", "new_string", "content", "detail", "workdir",
  ]) {
    const value = looseStringField(source, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 解析 `const patch = "..."; tools.apply_patch(patch)` 这类只读字符串绑定。 */
function resolvedWrappedInput(source: string, script: string): Record<string, unknown> {
  const identifier = source.trim();
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier)) {
    const assignment = new RegExp(`\\b(?:const|let|var)\\s+${identifier.replace(/\$/g, "\\$")}\\s*=\\s*`).exec(script);
    if (assignment) {
      const at = assignment.index + assignment[0].length;
      const end = stringEnd(script, at);
      if (end >= 0) return { input: decodeStringLiteral(script.slice(at, end + 1)) };
    }
  }
  return wrappedInput(source);
}

function commandDescription(input: Record<string, unknown>, limit = CMD_FIELD): { title: string; body: string } | null {
  const command = typeof input.cmd === "string"
    ? input.cmd.trim()
    : typeof input.command === "string"
      ? input.command.trim()
      : "";
  return command ? { title: `💻 ${one(command)}`, body: `$ ${clip(command, limit)}` } : null;
}

function patchDescription(input: Record<string, unknown>, limit = PATCH_FIELD): { title: string; body: string } | null {
  const patch = String(input.input ?? input.patch ?? "").trim();
  if (!patch) return null;
  const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
  const target = paths[0];
  const body = patch
    .split("\n")
    .filter((line) => line !== "*** Begin Patch" && line !== "*** End Patch")
    .map((line) => line.replace(/^\*\*\* (?:Add|Update|Delete) File: /, ""))
    .join("\n");
  const suffix = paths.length > 1 ? ` ×${paths.length}` : "";
  return {
    title: target ? `✏️ 改 ${base(target)}${suffix}` : "✏️ apply_patch",
    body: clip(body, limit),
  };
}

/** Codex functions.exec → 内层实际工具摘要；识别失败时返回 null，由调用方隐藏原生包装。 */
function codexExecDescription(i: Record<string, unknown>, full = false): { title: string; body: string } | null {
  const direct = commandDescription(i, full ? Infinity : CMD_FIELD);
  if (direct) return direct;
  const calls = codexWrappedCalls(String(i.input ?? ""));
  if (calls.length === 0) return null;
  const script = String(i.input ?? "");
  const descriptions = calls.map((call) => {
    const input = resolvedWrappedInput(call.input, script);
    if (call.name === "exec_command") {
      return commandDescription(input, full ? Infinity : CMD_FIELD) ?? { title: "💻 exec_command", body: "" };
    }
    return describeToolUse(call.name, input, full);
  });
  if (descriptions.length === 1) return descriptions[0]!;
  const commands = descriptions.every((d) => d.title.startsWith("💻 "));
  const title = commands
    ? `${descriptions[0]!.title} ×${descriptions.length}`
    : `🔧 ${calls.map((call) => call.name).join(" + ")}`;
  return { title, body: descriptions.map((d) => d.body).filter(Boolean).join("\n──\n") };
}

/** 移除 Codex exec 工具自身的执行包装，只把命令的 stdout/stderr 交给控制台视图。 */
export function normalizeToolResult(tool: string | undefined, result: string, codexCustomOutput = false): string {
  const envelope = /^Script (?:completed|failed)(?: successfully)?[ \t]*\r?\nWall time [^\r\n]*\r?\nOutput:[ \t]*(?:\r?\n)?/;
  const stripped = result.replace(envelope, "");
  if (stripped !== result && (codexCustomOutput || /^(?:exec|exec_command)$/i.test(tool ?? ""))) return stripped;
  if (codexCustomOutput && /^Script running with cell ID [^\r\n]+(?:\r?\n)?(?:Wall time [^\r\n]+)?(?:\r?\nOutput:[ \t]*)?$/i.test(result)) return "";
  return result;
}

/**
 * 工具调用 → 人话标题 + 可读正文（未知工具退化为 key: value 列表）。
 * full=true：正文各字段不截断（「查看完整内容」按 off 回源重解析时用），标题仍是一行摘要。
 */
export function describeToolUse(tool: string, input: unknown, full = false): { title: string; body: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const i = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  // full 模式把每处上限统一放开；截断上限只在这三个常量与下面的字面量里出现，别再散落新的数字
  const F = full ? Infinity : FIELD;
  const lim = (n: number): number => (full ? Infinity : n);
  try {
    switch (tool) {
      case "Edit": {
        const head = `${i.file_path ?? ""}${i.replace_all ? "（全部替换）" : ""}`;
        return { title: `✏️ 改 ${base(i.file_path)}`, body: [head, diffBlock(i.old_string, i.new_string, F)].filter(Boolean).join("\n") };
      }
      case "MultiEdit": {
        const edits: Array<Record<string, unknown>> = Array.isArray(i.edits) ? i.edits : [];
        const body = [String(i.file_path ?? ""), ...edits.map((e) => diffBlock(e.old_string, e.new_string, F))].filter(Boolean).join("\n──\n");
        return { title: `✏️ 改 ${base(i.file_path)} ×${edits.length}`, body };
      }
      case "Write":
        return {
          title: `📝 写 ${base(i.file_path)}`,
          body: `${i.file_path ?? ""}（共 ${String(i.content ?? "").length} 字）\n${clip(i.content, F)}`,
        };
      case "Read": {
        const range = i.offset != null || i.limit != null ? `（第 ${i.offset ?? 1} 行起${i.limit != null ? `，读 ${i.limit} 行` : ""}）` : "";
        return { title: `📖 读 ${base(i.file_path)}`, body: `${i.file_path ?? ""}${range}` };
      }
      case "Bash":
        return { title: `💻 ${one(i.description || i.command)}`, body: `$ ${clip(i.command, lim(CMD_FIELD))}` };
      case "exec":
      case "exec_command": {
        return codexExecDescription(i, full) ?? { title: `🔧 ${tool}`, body: "" };
      }
      case "apply_patch":
        return patchDescription(i, lim(PATCH_FIELD)) ?? { title: "✏️ apply_patch", body: "" };
      case "Grep": {
        const scope = [i.path, i.glob, i.type].filter(Boolean).join(" ");
        return { title: `🔍 搜 ${one(i.pattern)}`, body: `${i.pattern ?? ""}${scope ? `\n范围: ${scope}` : ""}` };
      }
      case "Glob":
        return { title: `🔍 找 ${one(i.pattern)}`, body: `${i.pattern ?? ""}${i.path ? `\n目录: ${i.path}` : ""}` };
      case "TodoWrite": {
        const todos: Array<Record<string, unknown>> = Array.isArray(i.todos) ? i.todos : [];
        const icon = (s: unknown) => (s === "completed" ? "☑" : s === "in_progress" ? "◐" : "☐");
        return { title: `📋 待办 ${todos.length} 项`, body: todos.map((t) => `${icon(t.status)} ${one(t.content ?? t.activeForm, lim(80))}`).join("\n") };
      }
      case "Task":
        return { title: `🤖 ${one(i.description || "子代理")}`, body: clip(i.prompt, F) };
      case "WebFetch":
        return { title: `🌐 读网页 ${host(i.url)}`, body: `${i.url ?? ""}${i.prompt ? `\n${one(i.prompt, lim(120))}` : ""}` };
      case "WebSearch":
        return { title: `🌐 搜索 ${one(i.query)}`, body: "" };
      case "AskUserQuestion": {
        const qs: Array<Record<string, unknown>> = Array.isArray(i.questions) ? i.questions : [];
        return { title: "❓ 问用户", body: qs.map((q) => `· ${one(q.question, lim(120))}`).join("\n") };
      }
      case "ExitPlanMode":
        return { title: "📋 计划完毕，待确认", body: clip(i.plan, F) };
      default: {
        const body = Object.entries(i)
          .map(([k, v]) => `${k}: ${one(typeof v === "string" ? v : JSON.stringify(v), lim(200))}`)
          .join("\n");
        return { title: `🔧 ${tool}`, body };
      }
    }
    const body = Object.entries(i)
      .map(([k, v]) => `${k}: ${one(typeof v === "string" ? v : JSON.stringify(v), lim(200))}`)
      .join("\n");
    return { title: `🔧 ${tool}`, body };
  } catch {
    return { title: `🔧 ${tool}`, body: clip(JSON.stringify(input ?? {}), lim(400)) };
  }
}
