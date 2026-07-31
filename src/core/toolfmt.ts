/**
 * toolfmt —— 工具调用的「人话」渲染（v1 src/toolfmt.ts 平移，两边保持同构）。
 * 原始 JSON 入参在气泡里不知所云（{"replace_all":false,"file_path":...} 还被截成半截）；
 * 解析 jsonl 时手里还有结构化的 input 对象，就地生成：
 * - title：折叠态一眼看懂的标题（动词 + 目标，如「✏️ 改 Login.tsx」）；
 * - body：展开态的可读正文（路径 / ±diff / $ 命令），UI 按 - / + 行前缀给 diff 着色。
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

/** old/new 拼 ±diff 文本：每行加 "- "/"+ " 前缀，前端按前缀着色 */
function diffBlock(oldS: unknown, newS: unknown): string {
  const mark = (s: string, p: string) => s.split("\n").map((l) => p + l).join("\n");
  const parts: string[] = [];
  const o = String(oldS ?? ""), n = String(newS ?? "");
  if (o) parts.push(mark(clip(o, FIELD), "- "));
  if (n) parts.push(mark(clip(n, FIELD), "+ "));
  return parts.join("\n");
}

function host(u: unknown): string {
  try { return new URL(String(u)).host; } catch { return one(u, 40); }
}

/** 工具调用 → 人话标题 + 可读正文（未知工具退化为 key: value 列表） */
export function describeToolUse(tool: string, input: unknown): { title: string; body: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const i = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  try {
    switch (tool) {
      case "Edit": {
        const head = `${i.file_path ?? ""}${i.replace_all ? "（全部替换）" : ""}`;
        return { title: `✏️ 改 ${base(i.file_path)}`, body: [head, diffBlock(i.old_string, i.new_string)].filter(Boolean).join("\n") };
      }
      case "MultiEdit": {
        const edits: Array<Record<string, unknown>> = Array.isArray(i.edits) ? i.edits : [];
        const body = [String(i.file_path ?? ""), ...edits.map((e) => diffBlock(e.old_string, e.new_string))].filter(Boolean).join("\n──\n");
        return { title: `✏️ 改 ${base(i.file_path)} ×${edits.length}`, body };
      }
      case "Write":
        return {
          title: `📝 写 ${base(i.file_path)}`,
          body: `${i.file_path ?? ""}（共 ${String(i.content ?? "").length} 字）\n${clip(i.content, FIELD)}`,
        };
      case "Read": {
        const range = i.offset != null || i.limit != null ? `（第 ${i.offset ?? 1} 行起${i.limit != null ? `，读 ${i.limit} 行` : ""}）` : "";
        return { title: `📖 读 ${base(i.file_path)}`, body: `${i.file_path ?? ""}${range}` };
      }
      case "Bash":
        return { title: `💻 ${one(i.description || i.command)}`, body: `$ ${clip(i.command, 600)}` };
      case "Grep": {
        const scope = [i.path, i.glob, i.type].filter(Boolean).join(" ");
        return { title: `🔍 搜 ${one(i.pattern)}`, body: `${i.pattern ?? ""}${scope ? `\n范围: ${scope}` : ""}` };
      }
      case "Glob":
        return { title: `🔍 找 ${one(i.pattern)}`, body: `${i.pattern ?? ""}${i.path ? `\n目录: ${i.path}` : ""}` };
      case "TodoWrite": {
        const todos: Array<Record<string, unknown>> = Array.isArray(i.todos) ? i.todos : [];
        const icon = (s: unknown) => (s === "completed" ? "☑" : s === "in_progress" ? "◐" : "☐");
        return { title: `📋 待办 ${todos.length} 项`, body: todos.map((t) => `${icon(t.status)} ${one(t.content ?? t.activeForm, 80)}`).join("\n") };
      }
      case "Task":
        return { title: `🤖 ${one(i.description || "子代理")}`, body: clip(i.prompt, FIELD) };
      case "WebFetch":
        return { title: `🌐 读网页 ${host(i.url)}`, body: `${i.url ?? ""}${i.prompt ? `\n${one(i.prompt, 120)}` : ""}` };
      case "WebSearch":
        return { title: `🌐 搜索 ${one(i.query)}`, body: "" };
      case "AskUserQuestion": {
        const qs: Array<Record<string, unknown>> = Array.isArray(i.questions) ? i.questions : [];
        return { title: "❓ 问用户", body: qs.map((q) => `· ${one(q.question, 120)}`).join("\n") };
      }
      case "ExitPlanMode":
        return { title: "📋 计划完毕，待确认", body: clip(i.plan, FIELD) };
      default: {
        const body = Object.entries(i)
          .map(([k, v]) => `${k}: ${one(typeof v === "string" ? v : JSON.stringify(v), 200)}`)
          .join("\n");
        return { title: `🔧 ${tool}`, body };
      }
    }
  } catch {
    return { title: `🔧 ${tool}`, body: clip(JSON.stringify(input ?? {}), 400) };
  }
}
