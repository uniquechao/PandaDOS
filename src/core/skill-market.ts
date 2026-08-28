/**
 * core/skill-market —— 技能市场（多市场源 + 扫描 + 驱动大模型 富化）。
 *
 * 市场 = 一个 git 仓库（agentskills 格式：目录 + SKILL.md，claude/codex 通用）。
 * - 源注册在 DB skill_markets（004 迁移内置 4 个，admin 可增删）；
 * - 同步 = 控制面浅克隆/拉取到 `~/.panda/skill-markets/<name>`（离线可浏览，v1 语义）；
 * - 扫描 = 递归找「含 SKILL.md 的目录」（深度 ≤3，命中即技能、不再下钻）；
 * - 富化 = 驱动大模型 中文描述/标签/推荐，缓存 DB skill_i18n（描述指纹变更才重译，
 *   每条完成即落库——客户端断流也不浪费 token；v1 market-cache.json 平移进 DB）。
 *
 * 安装动作不在本模块（见 core/skills.installSkillDir——市场只负责「源在哪、有什么」）。
 */
import type { Database } from 'bun:sqlite';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LlmClient } from '../agents/llm';
import { RUNTIME_DATA_DIR_NAME } from './branding';
import { parseSkillMd } from './skills';

const pExecFile = promisify(execFile);

/** git 同步限时（浅克隆大合集仓库也应在此内完成） */
const GIT_SYNC_TIMEOUT_MS = 300_000;
/** 技能扫描深度（含 SKILL.md 的目录相对市场根 ≤3 层，实测覆盖全部内置源） */
const SCAN_MAX_DEPTH = 3;
/** 单市场技能数上限（防怪仓库拖垮列表） */
const SCAN_MAX_SKILLS = 2000;

// ---------- 形状 ----------

export interface SkillMarket {
  id: number;
  name: string;
  repo: string;
  subdir: string;
  note: string;
  enabled: boolean;
  lastSyncTs: number | null;
  lastError: string | null;
  personaSourceEpoch: number;
}

/** 市场里的一条技能（rel = 相对市场根的目录路径，安装/读取的键） */
export interface MarketSkill {
  key: string; // `<market>/<rel>`
  market: string;
  rel: string;
  /** 安装用目录名（rel 末段） */
  name: string;
  /** frontmatter name（展示名，可能含空格）；缺省 = name */
  title: string;
  /** rel 去掉末段（如 skills / document-skills），空 = 根 */
  category: string;
  description: string;
  // ── 驱动大模型 富化（命中缓存才有）──
  descZh?: string;
  tags?: string[];
  recommend?: boolean;
  reason?: string;
}

export interface MarketRow {
  id: number;
  name: string;
  repo: string;
  subdir: string;
  note: string;
  enabled: number;
  last_sync_ts: number | null;
  last_error: string | null;
  persona_source_epoch: number;
}

// ---------- 基础 ----------

/** 市场缓存根目录（PANDA_SKILL_MARKETS_DIR 供测试注入） */
export function marketsBaseDir(): string {
  return process.env.PANDA_SKILL_MARKETS_DIR ?? path.join(homedir(), RUNTIME_DATA_DIR_NAME, 'skill-markets');
}

export const MARKET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * 归一化仓库地址：`owner/repo` 简写 → GitHub https；已是 https/ssh 原样。
 * 非法（含空白/引号/以 - 开头等）返回 null——地址会进 execFile 参数数组，不拼 shell，
 * 但仍拒绝畸形输入防 git 参数注入（如 --upload-pack）。
 */
export function normalizeRepo(repo: string): string | null {
  const r = repo.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}.git`;
  if (/^https:\/\/[\w.-]+\/[\w~:/.@-]+$/.test(r)) return r;
  if (/^git@[\w.-]+:[\w~/.@-]+$/.test(r)) return r;
  return null;
}

function rowToMarket(r: MarketRow): SkillMarket {
  return {
    id: r.id,
    name: r.name,
    repo: r.repo,
    subdir: r.subdir,
    note: r.note,
    enabled: r.enabled !== 0,
    lastSyncTs: r.last_sync_ts,
    lastError: r.last_error,
    personaSourceEpoch: r.persona_source_epoch ?? 0,
  };
}

export function listMarkets(db: Database): SkillMarket[] {
  return db
    .query<MarketRow, []>('SELECT * FROM skill_markets ORDER BY id')
    .all()
    .map(rowToMarket);
}

export function addMarket(
  db: Database,
  m: { name: string; repo: string; subdir?: string; note?: string },
): { ok: boolean; error?: string } {
  const name = (m.name ?? '').trim();
  if (!MARKET_NAME_RE.test(name)) return { ok: false, error: '市场名只允许字母数字 . _ -' };
  const repo = normalizeRepo(m.repo ?? '');
  if (!repo) return { ok: false, error: '仓库地址无效（支持 owner/repo、https、git@）' };
  const subdir = (m.subdir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (subdir && (subdir.includes('..') || !/^[\w./-]+$/.test(subdir))) {
    return { ok: false, error: '子目录无效' };
  }
  try {
    db.query(
      'INSERT INTO skill_markets (name, repo, subdir, note, enabled, created_ts) VALUES (?, ?, ?, ?, 1, ?)',
    ).run(name, repo, subdir, (m.note ?? '').trim().slice(0, 200), Date.now());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: /UNIQUE/i.test(String(e)) ? '同名市场已存在' : String(e).slice(0, 200) };
  }
}

function normalizeSubdir(value: string): string | null {
  const subdir = value.trim().replace(/^\/+|\/+$/g, '');
  if (subdir && (subdir.includes('..') || !/^[\w./-]+$/.test(subdir))) return null;
  return subdir;
}

/** Atomic source update; unlike delete+add it preserves cache, identity, and sync history. */
export function updateMarket(
  db: Database,
  name: string,
  patch: { repo?: string; subdir?: string; note?: string; enabled?: boolean },
): { ok: boolean; error?: string } {
  if (!MARKET_NAME_RE.test(name)) return { ok: false, error: '非法市场名' };
  const current = listMarkets(db).find((market) => market.name === name);
  if (!current) return { ok: false, error: '市场不存在' };
  const repo = patch.repo === undefined ? current.repo : normalizeRepo(patch.repo);
  if (!repo) return { ok: false, error: '仓库地址无效（支持 owner/repo、https、git@）' };
  const subdir = patch.subdir === undefined ? current.subdir : normalizeSubdir(patch.subdir);
  if (subdir === null) return { ok: false, error: '子目录无效' };
  const note = patch.note === undefined ? current.note : patch.note.trim().slice(0, 200);
  const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
  const locationChanged = repo !== current.repo || subdir !== current.subdir;
  const sourceChanged = locationChanged || enabled !== current.enabled;
  db.query(`
    UPDATE skill_markets
       SET repo = ?, subdir = ?, note = ?, enabled = ?,
           last_sync_ts = CASE WHEN ? THEN NULL ELSE last_sync_ts END,
           last_error = NULL,
           persona_source_epoch = persona_source_epoch + ?
     WHERE name = ?
  `).run(repo, subdir, note, enabled ? 1 : 0, locationChanged ? 1 : 0, sourceChanged ? 1 : 0, name);
  return { ok: true };
}

/** 删市场源：DB 行 + 本地缓存目录 + 该市场的富化缓存一并清。 */
export function removeMarket(db: Database, name: string, baseDir = marketsBaseDir()): { ok: boolean; error?: string } {
  if (!MARKET_NAME_RE.test(name)) return { ok: false, error: '非法市场名' };
  const r = db.query('DELETE FROM skill_markets WHERE name = ?').run(name);
  if (r.changes === 0) return { ok: false, error: '市场不存在' };
  db.query("DELETE FROM skill_i18n WHERE skill_key LIKE ? || '/%'").run(name);
  try {
    fs.rmSync(path.join(baseDir, name), { recursive: true, force: true });
  } catch {
    /* 缓存目录删不掉不影响正确性 */
  }
  return { ok: true };
}

// ---------- 同步（git 浅克隆/拉取） ----------

async function gitSyncOne(m: SkillMarket, baseDir: string): Promise<void> {
  const dir = path.join(baseDir, m.name);
  const opts = { timeout: GIT_SYNC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 };
  const cloned = fs.existsSync(path.join(dir, '.git'));
  if (cloned) {
    try {
      const origin = await pExecFile('git', ['-C', dir, 'remote', 'get-url', 'origin'], opts);
      if (origin.stdout.trim() === m.repo) {
        await pExecFile('git', ['-C', dir, 'pull', '--ff-only', '-q'], opts);
        return;
      }
    } catch {
      /* 浅仓库 force-push/历史改写 → 抹掉重克隆 */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(baseDir, { recursive: true });
  await pExecFile('git', ['clone', '-q', '--depth', '1', '--single-branch', m.repo, dir], opts);
}

export interface SyncResult {
  name: string;
  ok: boolean;
  count: number;
  error?: string;
}

/**
 * 同步市场（only 缺省 = 全部启用的）。逐个进行，单个失败不影响其它；
 * 成败与技能数写回 skill_markets（last_sync_ts / last_error）。
 */
export async function syncMarkets(
  db: Database,
  opts: { only?: string; baseDir?: string } = {},
): Promise<{ ok: boolean; results: SyncResult[] }> {
  const baseDir = opts.baseDir ?? marketsBaseDir();
  const markets = listMarkets(db).filter((m) => m.enabled && (!opts.only || m.name === opts.only));
  const results: SyncResult[] = [];
  for (const m of markets) {
    try {
      await gitSyncOne(m, baseDir);
      const count = scanMarketSkills(m.name, m.subdir, baseDir).length;
      db.query('UPDATE skill_markets SET last_sync_ts = ?, last_error = NULL WHERE name = ?').run(
        Date.now(),
        m.name,
      );
      results.push({ name: m.name, ok: true, count });
    } catch (e) {
      const msg = String((e as { stderr?: string; message?: string }).stderr || (e as Error).message || e)
        .slice(0, 300);
      db.query('UPDATE skill_markets SET last_error = ? WHERE name = ?').run(msg, m.name);
      results.push({ name: m.name, ok: false, count: 0, error: msg });
    }
  }
  return { ok: results.some((r) => r.ok) || results.length === 0, results };
}

/** Validated cache snapshot used to pin governed persona provenance. */
export async function marketSnapshot(
  db: Database,
  name: string,
  baseDir = marketsBaseDir(),
): Promise<{ root: string; commit: string } | null> {
  const market = MARKET_NAME_RE.test(name)
    ? listMarkets(db).find((candidate) => candidate.name === name)
    : undefined;
  if (!market) return null;
  const root = path.join(baseDir, name);
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const origin = await pExecFile('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      timeout: GIT_SYNC_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    if (origin.stdout.trim() !== market.repo) return null;
    const result = await pExecFile('git', ['-C', root, 'rev-parse', 'HEAD'], {
      timeout: GIT_SYNC_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const commit = result.stdout.trim();
    return /^[a-f0-9]{40}$/i.test(commit) ? { root, commit: commit.toLowerCase() } : null;
  } catch {
    return null;
  }
}

interface PersonaMarketSnapshotRow {
  market_name: string;
  repo: string;
  subdir: string;
  git_commit: string;
  synced_ts: number;
  source_epoch: number;
}

/** Admin-controlled provenance pin. Generic market sync may move HEAD but never advances this row. */
export async function approvePersonaMarketSnapshot(
  db: Database,
  name: string,
  baseDir = marketsBaseDir(),
): Promise<{ root: string; commit: string } | null> {
  const market = listMarkets(db).find((candidate) => candidate.name === name && candidate.enabled);
  if (!market) return null;
  const snapshot = await marketSnapshot(db, name, baseDir);
  if (!snapshot) return null;
  db.query(`INSERT INTO design_persona_market_snapshots
    (market_name, repo, subdir, git_commit, source_epoch, synced_ts)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_name) DO UPDATE SET
      repo = excluded.repo,
      subdir = excluded.subdir,
      git_commit = excluded.git_commit,
      source_epoch = excluded.source_epoch,
      synced_ts = excluded.synced_ts`
  ).run(name, market.repo, market.subdir, snapshot.commit, market.personaSourceEpoch, Date.now());
  return snapshot;
}

/** Read the last admin-approved commit only when it still matches the active source identity. */
export async function approvedPersonaMarketSnapshot(
  db: Database,
  name: string,
  baseDir = marketsBaseDir(),
): Promise<{ root: string; commit: string } | null> {
  const market = listMarkets(db).find((candidate) => candidate.name === name && candidate.enabled);
  if (!market) return null;
  const row = db.query<PersonaMarketSnapshotRow, [string]>(
    'SELECT * FROM design_persona_market_snapshots WHERE market_name = ?',
  ).get(name);
  if (!row || row.repo !== market.repo || row.subdir !== market.subdir
    || row.source_epoch !== market.personaSourceEpoch
    || !/^[a-f0-9]{40}$/i.test(row.git_commit)) return null;
  const root = path.join(baseDir, name);
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const origin = await pExecFile('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      timeout: GIT_SYNC_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    if (origin.stdout.trim() !== market.repo) return null;
    await pExecFile('git', ['-C', root, 'cat-file', '-e', `${row.git_commit}^{commit}`], {
      timeout: GIT_SYNC_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    return { root, commit: row.git_commit.toLowerCase() };
  } catch {
    return null;
  }
}

// ---------- 扫描 ----------

/** 递归扫描一个市场缓存目录的技能（同步 FS，只读控制面本地）。目录缺失返回 []。 */
export function scanMarketSkills(market: string, subdir: string, baseDir = marketsBaseDir()): MarketSkill[] {
  const root = path.join(baseDir, market);
  const scanRoot = subdir ? path.join(root, subdir) : root;
  const out: MarketSkill[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= SCAN_MAX_SKILLS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 命中即技能：含 SKILL.md 的目录不再下钻（技能不嵌套）
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const rel = path.relative(root, dir).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) return;
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 64 * 1024);
      } catch {
        return;
      }
      const meta = parseSkillMd(text);
      const name = path.posix.basename(rel);
      out.push({
        key: `${market}/${rel}`,
        market,
        rel,
        name,
        title: meta.name ?? name,
        category: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
        description: meta.description,
      });
      return;
    }
    if (depth >= SCAN_MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(scanRoot, subdir ? subdir.split('/').length : 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

// ---------- 富化缓存 ----------

interface I18nRow {
  skill_key: string;
  desc_hash: string;
  desc_zh: string;
  tags: string;
  recommend: number;
  reason: string;
}

/** 源描述指纹：描述没变就用缓存，绝不重复烧 token（v1 同款） */
export function descHash(desc: string): string {
  return crypto.createHash('sha1').update(desc ?? '').digest('hex').slice(0, 12);
}

interface Enrichment {
  descZh: string;
  tags: string[];
  recommend: boolean;
  reason: string;
}

function loadI18n(db: Database): Map<string, I18nRow> {
  const map = new Map<string, I18nRow>();
  for (const r of db.query<I18nRow, []>('SELECT * FROM skill_i18n').all()) map.set(r.skill_key, r);
  return map;
}

function i18nGet(cache: Map<string, I18nRow>, s: MarketSkill): Enrichment | null {
  const r = cache.get(s.key);
  if (!r || r.desc_hash !== descHash(s.description)) return null;
  let tags: string[] = [];
  try {
    const t = JSON.parse(r.tags) as unknown;
    if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === 'string');
  } catch {
    /* 缓存损坏当无标签 */
  }
  return { descZh: r.desc_zh, tags, recommend: r.recommend !== 0, reason: r.reason };
}

function i18nPut(db: Database, key: string, hash: string, e: Enrichment): void {
  db.query(
    `INSERT INTO skill_i18n (skill_key, desc_hash, desc_zh, tags, recommend, reason, updated_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(skill_key) DO UPDATE SET desc_hash = excluded.desc_hash, desc_zh = excluded.desc_zh,
       tags = excluded.tags, recommend = excluded.recommend, reason = excluded.reason, updated_ts = excluded.updated_ts`,
  ).run(key, hash, e.descZh, JSON.stringify(e.tags), e.recommend ? 1 : 0, e.reason, Date.now());
}

function mergeEnrichment(skills: MarketSkill[], cache: Map<string, I18nRow>): void {
  for (const s of skills) {
    const e = i18nGet(cache, s);
    if (e) {
      s.descZh = e.descZh;
      s.tags = e.tags;
      s.recommend = e.recommend;
      s.reason = e.reason;
    }
  }
}

// ---------- 列表（离线） ----------

export interface MarketList {
  ok: boolean;
  markets: (SkillMarket & { count: number })[];
  skills: MarketSkill[];
  /** true = 一个市场都没同步过（前端提示先同步） */
  needSync: boolean;
}

/** 读全部市场清单（纯本地缓存 + DB，不联网），合并富化字段。 */
export function listMarketSkills(db: Database, baseDir = marketsBaseDir()): MarketList {
  const markets = listMarkets(db);
  const skills: MarketSkill[] = [];
  const withCount = markets.map((m) => {
    if (!m.enabled) return { ...m, count: 0 };
    const ss = scanMarketSkills(m.name, m.subdir, baseDir);
    skills.push(...ss);
    return { ...m, count: ss.length };
  });
  mergeEnrichment(skills, loadI18n(db));
  return { ok: true, markets: withCount, skills, needSync: skills.length === 0 };
}

/** 定位市场技能的本地目录（安装源 / 预览）：rel 归一化 + 词法限定 + SKILL.md 必在。 */
export function marketSkillDir(
  db: Database,
  market: string,
  rel: string,
  baseDir = marketsBaseDir(),
): { ok: boolean; dir?: string; name?: string; error?: string } {
  if (!MARKET_NAME_RE.test(market)) return { ok: false, error: '非法市场名' };
  const row = db.query<MarketRow, [string]>('SELECT * FROM skill_markets WHERE name = ?').get(market);
  if (!row) return { ok: false, error: '市场不存在' };
  const root = path.join(baseDir, market);
  const norm = path.posix.normalize((rel ?? '').replace(/^\/+/, ''));
  if (!norm || norm === '.' || norm.startsWith('..') || path.posix.isAbsolute(norm)) {
    return { ok: false, error: '非法技能路径' };
  }
  const dir = path.join(root, ...norm.split('/'));
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return { ok: false, error: '技能不存在（先同步市场）' };
  return { ok: true, dir, name: path.posix.basename(norm) };
}

/** 读市场技能的 SKILL.md 全文（预览用，控制面本地）。 */
export function readMarketSkillMd(
  db: Database,
  market: string,
  rel: string,
  baseDir = marketsBaseDir(),
): { ok: boolean; name?: string; content?: string; error?: string } {
  const loc = marketSkillDir(db, market, rel, baseDir);
  if (!loc.ok || !loc.dir) return { ok: false, error: loc.error ?? '技能不存在' };
  try {
    const content = fs.readFileSync(path.join(loc.dir, 'SKILL.md'), 'utf8').slice(0, 256 * 1024);
    return { ok: true, name: loc.name ?? '', content };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// ---------- 驱动大模型 富化（流式） ----------

/** 流式富化事件：meta=开始(总数/待译) / item=单条完成 / item-error / done / error（v1 同构） */
export type EnrichEvent =
  | { type: 'meta'; total: number; todo: number }
  | { type: 'item'; skill: MarketSkill }
  | { type: 'item-error'; key: string }
  | { type: 'done'; enriched: number }
  | { type: 'error'; error: string };

/** 翻译单条（jsonMode）；解析失败返回 null。 */
async function translateOne(llm: LlmClient, s: MarketSkill): Promise<Enrichment | null> {
  const sys =
    '你是编码代理（Claude Code / Codex）技能市场的中文助理。把给定技能翻译并打标签。' +
    '只输出 JSON：{"descZh":"简洁中文描述≤60字","tags":["2~4个简短中文标签，如 前端/测试/Git"],' +
    '"recommend":是否值得大多数开发者尝试的布尔值,"reason":"一句中文推荐理由或用途≤30字"}';
  const user = `name: ${s.title}\n${s.category ? `分类: ${s.category}\n` : ''}描述: ${(s.description || '(无描述)').slice(0, 400)}`;
  const r = await llm.chat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { jsonMode: true },
  );
  try {
    const j = JSON.parse(r.content) as {
      descZh?: unknown;
      tags?: unknown;
      recommend?: unknown;
      reason?: unknown;
    };
    return {
      descZh: typeof j.descZh === 'string' ? j.descZh.trim().slice(0, 120) : '',
      tags: Array.isArray(j.tags)
        ? j.tags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 4)
        : [],
      recommend: Boolean(j.recommend),
      reason: typeof j.reason === 'string' ? j.reason.trim().slice(0, 60) : '',
    };
  } catch {
    return null;
  }
}

/**
 * 逐条富化并实时 yield（一次一条：客户端断流即停，已完成的都已落库不浪费）。
 * 只译「缓存缺失或描述已变」的；force=true 全部重译。
 */
export async function* enrichSkillsStream(
  db: Database,
  llm: LlmClient,
  opts: { force?: boolean; baseDir?: string } = {},
): AsyncGenerator<EnrichEvent> {
  const base = listMarketSkills(db, opts.baseDir ?? marketsBaseDir());
  if (base.needSync) {
    yield { type: 'error', error: '市场清单为空，请先同步' };
    return;
  }
  const cache = loadI18n(db);
  const todo = base.skills.filter((s) => opts.force || !i18nGet(cache, s));
  yield { type: 'meta', total: base.skills.length, todo: todo.length };
  if (todo.length === 0) {
    yield { type: 'done', enriched: 0 };
    return;
  }
  let enriched = 0;
  for (const s of todo) {
    try {
      const e = await translateOne(llm, s);
      if (!e) {
        yield { type: 'item-error', key: s.key };
        continue;
      }
      i18nPut(db, s.key, descHash(s.description), e);
      enriched++;
      yield { type: 'item', skill: { ...s, ...e } };
    } catch {
      yield { type: 'item-error', key: s.key };
    }
  }
  yield { type: 'done', enriched };
}

/** 非流式富化（程序化调用/测试）：drain 流，返回合并后的清单。 */
export async function enrichSkills(
  db: Database,
  llm: LlmClient,
  opts: { force?: boolean; baseDir?: string } = {},
): Promise<MarketList & { enriched: number; error?: string }> {
  let enriched = 0;
  let error: string | undefined;
  for await (const ev of enrichSkillsStream(db, llm, opts)) {
    if (ev.type === 'done') enriched = ev.enriched;
    else if (ev.type === 'error') error = ev.error;
  }
  const base = listMarketSkills(db, opts.baseDir ?? marketsBaseDir());
  return { ...base, enriched, ...(error ? { error } : {}) };
}
