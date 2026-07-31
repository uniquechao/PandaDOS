/**
 * core/readme-summary —— 项目 README 简介（手动触发）。
 *
 * 语义：用户在项目卡片/项目内点「更新简介」时，读项目 cwd 下的 README，调
 * 驱动大模型 生成 ≤SUMMARY_MAX_CHARS 字简介（说清项目名字/内容/定位），落 projects 表
 * （005 迁移：readme_md5 / readme_summary / readme_checked_ts）。
 *
 * 只看 README（不含 issue、不扫 docs/），force 强制：无 md5 缓存闸门，点一次生成一次。
 * 无每日巡检——生成完全由用户手动触发（web/routes/projects.ts 的端点）。
 *
 * 失败姿势：
 * - 无 README / 读不到 → 返回 { ok:false, reason:'no-readme' }（端点转 400，不动旧简介）；
 * - LLM 失败 → summarizeReadme 抛错，由端点兜成 502（旧简介不动）。
 */
import type { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import type { LlmClient } from '../agents/llm';
import type { ExecutorDriver } from '../executor/driver';
import { readDriverText } from './skills';

/** 本模块需要的 Driver 子集（结构兼容 ExecutorDriver，测试可传替身） */
export type ReadmeDriver = Pick<ExecutorDriver, 'listDir' | 'statPath' | 'readFileRange'>;

/** 简介上限（需求「不超过 200 字」；按 Unicode 码点截，防 emoji 腰斩） */
export const SUMMARY_MAX_CHARS = 200;
/** README 读取上限（readDriverText 截断；喂 LLM 前再截 MAX_PROMPT_CHARS） */
const MAX_README_BYTES = 64 * 1024;
/** 喂给 LLM 的 README 字符上限（简介只需开头就够，防超长 README 烧钱） */
const MAX_PROMPT_CHARS = 6000;

export function md5hex(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * 在项目 cwd 下找 README（大小写不敏感）：优先 .md/.markdown，
 * 其次无扩展 README，再次 .txt/.rst。目录缺失/不可读返回 null。
 */
export async function findReadmePath(driver: ReadmeDriver, cwd: string): Promise<string | null> {
  let entries;
  try {
    entries = await driver.listDir(cwd);
  } catch {
    return null;
  }
  // 排名越小越优先
  const rank = (name: string): number => {
    const m = /^readme(\.(md|markdown|txt|rst))?$/i.exec(name);
    if (!m) return -1;
    const ext = (m[2] ?? '').toLowerCase();
    if (ext === 'md' || ext === 'markdown') return 0;
    if (ext === '') return 1;
    return 2;
  };
  let best: { name: string; rank: number } | null = null;
  for (const e of entries) {
    if (e.type !== 'file') continue;
    const r = rank(e.name);
    if (r < 0) continue;
    if (!best || r < best.rank) best = { name: e.name, rank: r };
  }
  return best ? `${cwd.replace(/\/+$/, '')}/${best.name}` : null;
}

/** 生成简介的提示词（jsonMode 不必要：要的就是一段纯文本） */
export function buildSummaryPrompt(projectName: string, readme: string) {
  const body = readme.length > MAX_PROMPT_CHARS ? readme.slice(0, MAX_PROMPT_CHARS) : readme;
  return [
    {
      role: 'system' as const,
      content: '你是项目管理助手，负责为开发项目写简介。只输出简介正文，不要标题、引号、markdown 或任何多余说明。',
    },
    {
      role: 'user' as const,
      content:
        `请根据 README 为项目「${projectName}」写一段不超过 ${SUMMARY_MAX_CHARS} 字的中文简介，` +
        `必须说清：项目名字、项目内容、项目定位。\n\nREADME 内容（可能截断）：\n${body}`,
    },
  ];
}

/** 调 LLM 生成简介并截到上限；空回答抛错（交上层按失败重试） */
export async function summarizeReadme(
  llm: LlmClient,
  projectName: string,
  readme: string,
): Promise<string> {
  const r = await llm.chat(buildSummaryPrompt(projectName, readme));
  const text = r.content.trim();
  if (!text) throw new Error('LLM 返回空简介');
  const points = [...text];
  return points.length > SUMMARY_MAX_CHARS ? points.slice(0, SUMMARY_MAX_CHARS).join('') : text;
}

// ---------- 手动生成（端点接线用） ----------

export interface GenerateSummaryDeps {
  db: Database;
  llm: LlmClient;
  /** 项目所在执行机的 Driver（server.ts driverForProject 的返回值结构兼容） */
  driver: ReadmeDriver;
  /** 测试注入时钟 */
  now?: () => number;
}

/** helper 需要的最小项目信息（id 定位落库、name/cwd 喂提示词与找 README） */
export interface SummaryProject {
  id: number;
  name: string;
  cwd: string;
}

export type GenerateSummaryResult =
  | { ok: true; summary: string }
  | { ok: false; reason: 'no-readme' };

/**
 * 为单个项目重新生成 README 简介并落库（force：无 md5 闸门，点一次生成一次）。
 * 找不到 README → { ok:false, reason:'no-readme' }（不调 LLM、旧简介不动）；
 * LLM 失败 → summarizeReadme 抛错（调用方兜错，旧简介不动）。
 */
export async function generateProjectReadmeSummary(
  deps: GenerateSummaryDeps,
  project: SummaryProject,
): Promise<GenerateSummaryResult> {
  const { db, llm, driver } = deps;
  const path = await findReadmePath(driver, project.cwd);
  const text = path ? await readDriverText(driver, path, MAX_README_BYTES) : null;
  if (text === null) return { ok: false, reason: 'no-readme' };

  const summary = await summarizeReadme(llm, project.name, text);
  const now = deps.now ? deps.now() : Date.now();
  db.query(
    'UPDATE projects SET readme_md5 = ?, readme_summary = ?, readme_checked_ts = ? WHERE id = ?',
  ).run(md5hex(text), summary, now, project.id);
  return { ok: true, summary };
}
