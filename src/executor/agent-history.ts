/**
 * 执行机 Agent 历史发现。
 *
 * 只通过 ExecutorDriver 的只读文件能力工作，因此本机与 SSH 执行机行为一致；这里不登记
 * 项目、不创建 conversations，调用方可在权限校验后消费发现结果。
 */
import { posix } from 'node:path';
import { rolloutSessionId } from '../core/agent-locator';
import { parseLines } from '../core/jsonl';
import type { AgentKind, Executor } from '../core/types';
import type { ExecutorDriver } from './driver';

export type AgentHistoryReader = Pick<ExecutorDriver, 'listDir' | 'statPath' | 'readFileRange'>;

export interface AgentHistorySession {
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  jsonlPath: string;
  createdTs: number;
  updatedTs: number;
  /** Codex 优先使用原生 thread_name；其余回退到第一条真实用户消息摘要。 */
  title: string | null;
}

export interface AgentHistoryProject {
  agent: AgentKind;
  cwd: string;
  /** cwd 的末段，仅作候选默认显示名。 */
  name: string;
  latestTs: number;
  sessions: AgentHistorySession[];
}

export interface AgentHistoryDiscoveryResult {
  projects: AgentHistoryProject[];
  sessions: AgentHistorySession[];
}

export interface AgentHistoryDiscoveryOptions {
  /** 单个会话为提取元数据与标题最多读取的文件头字节数。 */
  headBytes?: number;
  /** 每种 Agent 最多解析的历史文件数，防止错误配置扫穿超大目录。 */
  maxFilesPerAgent?: number;
}

const DEFAULT_HEAD_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 2_000;
const INDEX_READ_CHUNK_BYTES = 256 * 1024;

function normalizeCwd(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  return value === '/' ? value : value.replace(/\/+$/, '');
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ts = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function titleFromLines(lines: string[]): string | null {
  const text = parseLines(lines, 0).msgs.find((message) => message.role === 'user')?.text;
  if (!text) return null;
  const title = text.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 120) : null;
}

function completeLines(data: Uint8Array, fullFile: boolean): string[] {
  const text = new TextDecoder('utf-8').decode(data);
  const lines = text.split('\n');
  if (!fullFile) lines.pop(); // 文件头最后一行可能被截断，不能把半条 JSON 当损坏数据解析
  return lines;
}

async function readHead(
  reader: AgentHistoryReader,
  path: string,
  headBytes: number,
): Promise<{ lines: string[]; updatedTs: number } | null> {
  try {
    const stat = await reader.statPath(path);
    if (!stat || stat.size <= 0 || stat.isDirectory) return null;
    const want = Math.min(stat.size, headBytes);
    const { data } = await reader.readFileRange(path, 0, want);
    return {
      lines: completeLines(data, data.length >= stat.size),
      updatedTs: stat.mtimeMs ?? 0,
    };
  } catch {
    return null;
  }
}

function parseClaudeSession(
  path: string,
  lines: string[],
  updatedTs: number,
): AgentHistorySession | null {
  const fileSessionId = posix.basename(path).replace(/\.jsonl$/, '');
  let sessionId = fileSessionId;
  let cwd: string | null = null;
  let createdTs: number | null = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { cwd?: unknown; sessionId?: unknown; timestamp?: unknown };
      const entryCwd = normalizeCwd(entry.cwd);
      if (entryCwd && !cwd) cwd = entryCwd;
      if (typeof entry.sessionId === 'string' && entry.sessionId.trim()) sessionId = entry.sessionId;
      const ts = parseTimestamp(entry.timestamp);
      if (ts !== null && (createdTs === null || ts < createdTs)) createdTs = ts;
      if (cwd && createdTs !== null && sessionId !== fileSessionId) break;
    } catch {
      // 单行损坏不应遮蔽同文件后续仍可用的元数据。
    }
  }
  if (!cwd || !sessionId) return null;
  const ts = createdTs ?? updatedTs;
  return {
    agent: 'claude',
    sessionId,
    cwd,
    jsonlPath: path,
    createdTs: ts,
    updatedTs: Math.max(updatedTs, ts),
    title: titleFromLines(lines),
  };
}

function parseCodexSession(
  path: string,
  lines: string[],
  updatedTs: number,
): AgentHistorySession | null {
  const filenameSessionId = rolloutSessionId(posix.basename(path));
  if (!filenameSessionId) return null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        type?: unknown;
        timestamp?: unknown;
        payload?: { id?: unknown; session_id?: unknown; cwd?: unknown; timestamp?: unknown };
      };
      if (entry.type !== 'session_meta' || !entry.payload) continue;
      const cwd = normalizeCwd(entry.payload.cwd);
      const rawSessionId = entry.payload.session_id ?? entry.payload.id ?? filenameSessionId;
      if (!cwd || typeof rawSessionId !== 'string' || !rawSessionId.trim()) return null;
      const createdTs = parseTimestamp(entry.payload.timestamp) ?? parseTimestamp(entry.timestamp) ?? updatedTs;
      return {
        agent: 'codex',
        sessionId: rawSessionId,
        cwd,
        jsonlPath: path,
        createdTs,
        updatedTs: Math.max(updatedTs, createdTs),
        title: titleFromLines(lines),
      };
    } catch {
      // 首行异常时继续找后续 session_meta；整文件不可用则最终跳过。
    }
  }
  return null;
}

async function listDirSafe(reader: AgentHistoryReader, path: string) {
  try {
    return await reader.listDir(path);
  } catch {
    return [];
  }
}

async function claudeFiles(reader: AgentHistoryReader, root: string): Promise<string[]> {
  const files: string[] = [];
  for (const projectDir of await listDirSafe(reader, root)) {
    if (projectDir.type !== 'dir') continue;
    const dir = posix.join(root, projectDir.name);
    for (const file of await listDirSafe(reader, dir)) {
      if (file.type === 'file' && file.name.endsWith('.jsonl')) files.push(posix.join(dir, file.name));
    }
  }
  return files;
}

async function codexFiles(reader: AgentHistoryReader, root: string): Promise<string[]> {
  const files: string[] = [];
  const numericDesc = (a: { name: string }, b: { name: string }) => Number(b.name) - Number(a.name);
  for (const year of (await listDirSafe(reader, root)).filter((e) => e.type === 'dir').sort(numericDesc)) {
    const yearDir = posix.join(root, year.name);
    for (const month of (await listDirSafe(reader, yearDir)).filter((e) => e.type === 'dir').sort(numericDesc)) {
      const monthDir = posix.join(yearDir, month.name);
      for (const day of (await listDirSafe(reader, monthDir)).filter((e) => e.type === 'dir').sort(numericDesc)) {
        const dayDir = posix.join(monthDir, day.name);
        for (const file of await listDirSafe(reader, dayDir)) {
          if (file.type === 'file' && rolloutSessionId(file.name)) files.push(posix.join(dayDir, file.name));
        }
      }
    }
  }
  return files;
}

interface CodexIndexTitle {
  title: string;
  updatedTs: number;
  lineNo: number;
}

/**
 * Codex App/CLI 把用户看到的会话标题追加到 `~/.codex/session_index.jsonl`。
 * 同一 id 可能多次出现；按 updated_at（相同时按后出现的行）取最新 thread_name。
 * 逐块读取避免将执行机上长期累积的索引一次性载入内存。
 */
async function codexTitles(
  reader: AgentHistoryReader,
  sessionsRoot: string,
  wantedIds: Set<string>,
): Promise<Map<string, string>> {
  const titles = new Map<string, CodexIndexTitle>();
  if (wantedIds.size === 0) return new Map();
  const root = sessionsRoot.replace(/\/+$/, '');
  const indexPath = posix.join(posix.dirname(root), 'session_index.jsonl');
  try {
    const stat = await reader.statPath(indexPath);
    if (!stat || stat.size <= 0 || stat.isDirectory) return new Map();
    const decoder = new TextDecoder('utf-8');
    let offset = 0;
    let pending = '';
    let lineNo = 0;
    const consume = (line: string) => {
      lineNo += 1;
      try {
        const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
        if (typeof entry.id !== 'string' || !wantedIds.has(entry.id)) return;
        if (typeof entry.thread_name !== 'string') return;
        const title = entry.thread_name.replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!title) return;
        const updatedTs = parseTimestamp(entry.updated_at) ?? 0;
        const previous = titles.get(entry.id);
        if (!previous || updatedTs > previous.updatedTs || (updatedTs === previous.updatedTs && lineNo > previous.lineNo)) {
          titles.set(entry.id, { title, updatedTs, lineNo });
        }
      } catch {
        // 单行损坏不影响其他会话标题。
      }
    };
    while (offset < stat.size) {
      const { data } = await reader.readFileRange(
        indexPath,
        offset,
        Math.min(INDEX_READ_CHUNK_BYTES, stat.size - offset),
      );
      if (data.length === 0) break;
      offset += data.length;
      const parts = (pending + decoder.decode(data, { stream: offset < stat.size })).split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) consume(line);
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
  } catch {
    // 索引是可选增强；缺失/瞬时读失败时保留 rollout 的用户消息回退标题。
  }
  return new Map([...titles].map(([id, value]) => [id, value.title]));
}

async function discoverAgent(
  reader: AgentHistoryReader,
  agent: AgentKind,
  root: string,
  headBytes: number,
  maxFiles: number,
): Promise<AgentHistorySession[]> {
  const paths = agent === 'claude' ? await claudeFiles(reader, root) : await codexFiles(reader, root);
  const sessions: AgentHistorySession[] = [];
  for (const path of paths.slice(0, maxFiles)) {
    const head = await readHead(reader, path, headBytes);
    if (!head) continue;
    const session = agent === 'claude'
      ? parseClaudeSession(path, head.lines, head.updatedTs)
      : parseCodexSession(path, head.lines, head.updatedTs);
    if (session) sessions.push(session);
  }
  if (agent === 'codex' && sessions.length > 0) {
    const titles = await codexTitles(reader, root, new Set(sessions.map((session) => session.sessionId)));
    for (const session of sessions) session.title = titles.get(session.sessionId) ?? session.title;
  }
  return sessions;
}

function groupProjects(sessions: AgentHistorySession[]): AgentHistoryProject[] {
  const groups = new Map<string, AgentHistoryProject>();
  for (const session of sessions) {
    const key = `${session.agent}\0${session.cwd}`;
    let project = groups.get(key);
    if (!project) {
      project = {
        agent: session.agent,
        cwd: session.cwd,
        name: posix.basename(session.cwd) || session.cwd,
        latestTs: session.updatedTs,
        sessions: [],
      };
      groups.set(key, project);
    }
    project.sessions.push(session);
    project.latestTs = Math.max(project.latestTs, session.updatedTs);
  }
  for (const project of groups.values()) {
    project.sessions.sort((a, b) => b.updatedTs - a.updatedTs || a.sessionId.localeCompare(b.sessionId));
  }
  return [...groups.values()].sort(
    (a, b) => b.latestTs - a.latestTs || a.cwd.localeCompare(b.cwd) || a.agent.localeCompare(b.agent),
  );
}

/**
 * 扫描一台执行机配置的 Claude/Codex 状态目录，返回可导入的会话及按 agent+cwd 聚合的项目。
 * 不支持的 Agent 不访问对应目录；损坏文件、缺失目录与瞬时读取失败均按单候选跳过。
 */
export async function discoverExecutorAgentHistory(
  reader: AgentHistoryReader,
  executor: Pick<Executor, 'claudeDir' | 'codexDir' | 'supportsClaude' | 'supportsCodex'>,
  options: AgentHistoryDiscoveryOptions = {},
): Promise<AgentHistoryDiscoveryResult> {
  const headBytes = Math.max(1, options.headBytes ?? DEFAULT_HEAD_BYTES);
  const maxFiles = Math.max(1, options.maxFilesPerAgent ?? DEFAULT_MAX_FILES);
  const [claude, codex] = await Promise.all([
    executor.supportsClaude
      ? discoverAgent(reader, 'claude', executor.claudeDir, headBytes, maxFiles)
      : Promise.resolve([]),
    executor.supportsCodex
      ? discoverAgent(reader, 'codex', executor.codexDir, headBytes, maxFiles)
      : Promise.resolve([]),
  ]);
  const sessions = [...claude, ...codex].sort(
    (a, b) => b.updatedTs - a.updatedTs || a.sessionId.localeCompare(b.sessionId),
  );
  return { projects: groupProjects(sessions), sessions };
}
