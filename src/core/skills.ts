import { createHash } from 'node:crypto';
/**
 * core/skills —— 技能（agentskills 格式：目录 + SKILL.md）在执行机上的读写。
 *
 * 一切执行机操作走 Driver（Local/SSH 同构，spec §2 边界）：
 * - 列表：项目技能 `<cwd>/.claude/skills`、全局技能 `<claudeHome>/skills` + 已装插件
 *   自带技能（v1 平移：现代 CC 技能多来自插件市场，只扫 skills/ 会「全局为空」）；
 * - 查看：按 listSkills 回传的绝对路径读 SKILL.md，词法限定在允许根内（与 files.ts
 *   resolveProjectPath 同哲学；SFTP 无 realpath，词法校验 + 根路径由控制面拼出）；
 * - 安装：市场技能目录（控制面本地 FS）逐文件 writeFile 到目标（项目 / 执行机全局）；
 * - claude/codex 共用：`.codex/skills` 做成指向 `.claude/skills` 的符号链接
 *   （codex 同样认 `~/.codex/skills` 与 `<repo>/.codex/skills`，SKILL.md 格式通用）；
 *   已是实目录时不破坏用户数据——双写兜底（两边各装一份）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ExecutorDriver } from '../executor/driver';

/** 本模块需要的 Driver 子集（结构兼容 ExecutorDriver，测试可传替身） */
export type SkillsDriver = Pick<
  ExecutorDriver,
  'statPath' | 'listDir' | 'readFileRange' | 'writeFile' | 'symlink' | 'readlink' | 'removeTree'
>;

/** 一个技能（v1 SkillInfo 同构 + source 徽章） */
export interface SkillInfo {
  name: string;
  /** SKILL.md 在执行机上的绝对路径（查看时回传，作为读取键） */
  path: string;
  /** 摘要：frontmatter description，否则首个非空 markdown 行；≤200 字符 */
  summary: string;
  mtimeMs: number;
  scope: 'global' | 'project';
  /** 来源徽章：内置 / codex / 插件名 */
  source?: string;
  pluginId?: string;
  version?: string;
  contentDigest?: string;
  dependencyMetadata?: string;
}

/** 技能目录名白名单（安装/卸载的末段名；杜绝路径穿越） */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** claude_dir（…/.claude/projects）→ 同 home 的 ~/.claude 与 ~/.codex（server.agentHomesOf 同构） */
export interface AgentHomes {
  claudeHome: string;
  codexHome: string;
}

export function agentHomesFromClaudeDir(claudeProjectsDir: string): AgentHomes | null {
  const m = claudeProjectsDir.replace(/\/+$/, '').match(/^(.*)\/\.claude\/projects$/);
  return m ? { claudeHome: `${m[1]}/.claude`, codexHome: `${m[1]}/.codex` } : null;
}

// ---------- SKILL.md 解析 ----------

/**
 * 从 SKILL.md 文本提取 frontmatter（name/description）与摘要。
 * 摘要 = description，否则首个非空、非 --- 行（剥 # 前缀），截 200。
 */
export function parseSkillMd(text: string): { name?: string; description: string } {
  const lines = text.split(/\r?\n/);
  let name: string | undefined;
  let desc = '';
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const ln = lines[i]!;
      if (ln.trim() === '---') break;
      const m = ln.match(/^\s*(name|description)\s*:\s*(.*)$/i);
      if (!m) continue;
      let v = m[2]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (m[1]!.toLowerCase() === 'name' && !name) name = v.trim();
      if (m[1]!.toLowerCase() === 'description' && !desc) desc = v.trim();
    }
  }
  if (!desc) {
    for (const ln of lines) {
      const t = ln.trim();
      if (!t || t === '---') continue;
      desc = t.replace(/^#+\s*/, '').trim();
      break;
    }
  }
  return { ...(name ? { name } : {}), description: desc.slice(0, 200) };
}

/** 经 Driver 读小文本文件（≤maxBytes）；不存在/非文件返回 null，不抛错。 */
export async function readDriverText(
  driver: Pick<ExecutorDriver, 'statPath' | 'readFileRange'>,
  file: string,
  maxBytes = 256 * 1024,
): Promise<string | null> {
  try {
    const st = await driver.statPath(file);
    if (!st || !st.isFile) return null;
    const fr = await driver.readFileRange(file, 0, maxBytes);
    return new TextDecoder().decode(fr.data);
  } catch {
    return null;
  }
}

// ---------- 列表 ----------

/** 扫描一个根目录下的技能（含 SKILL.md 的直接子目录）。根缺失/出错返回 []。 */
export async function scanSkillsDir(
  driver: SkillsDriver,
  base: string,
  scope: 'global' | 'project',
  source?: string,
): Promise<SkillInfo[]> {
  const out: SkillInfo[] = [];
  let entries;
  try {
    const st = await driver.statPath(base);
    if (!st || !st.isDirectory) return out;
    entries = await driver.listDir(base);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.type !== 'dir' && e.type !== 'symlink') continue;
    const md = path.posix.join(base, e.name, 'SKILL.md');
    try {
      const st = await driver.statPath(md);
      if (!st || !st.isFile) continue;
      const text = (await readDriverText(driver, md)) ?? '';
      const metadata = await readDriverText(driver,path.posix.join(base,e.name,'agents','openai.yaml'));
      out.push({
        name: e.name,
        path: md,
        summary: parseSkillMd(text).description,
        contentDigest:createHash('sha256').update(text).update(metadata ?? '').digest('hex'),
        ...(metadata ? {dependencyMetadata:metadata.slice(0,4000)} : {}),
        mtimeMs: st.mtimeMs,
        scope,
        ...(source ? { source } : {}),
      });
    } catch {
      /* 非技能目录，跳过 */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** settings.json 中被显式禁用的插件键（enabledPlugins[key] === false） */
async function disabledPlugins(driver: SkillsDriver, claudeHome: string): Promise<Set<string>> {
  const off = new Set<string>();
  const text = await readDriverText(driver, path.posix.join(claudeHome, 'settings.json'));
  if (!text) return off;
  try {
    const j = JSON.parse(text) as { enabledPlugins?: Record<string, unknown> };
    for (const [k, v] of Object.entries(j.enabledPlugins ?? {})) if (v === false) off.add(k);
  } catch {
    /* 损坏视为无禁用 */
  }
  return off;
}

/** 已安装且未禁用插件的 skills 目录（installed_plugins.json，key 形如 `<plugin>@<marketplace>`） */
async function installedPluginSkillDirs(
  driver: SkillsDriver,
  claudeHome: string,
): Promise<{ plugin: string; pluginId: string; dir: string }[]> {
  const out: { plugin: string; pluginId: string; dir: string }[] = [];
  const text = await readDriverText(
    driver,
    path.posix.join(claudeHome, 'plugins', 'installed_plugins.json'),
    1024 * 1024,
  );
  if (!text) return out;
  try {
    const j = JSON.parse(text) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    const off = await disabledPlugins(driver, claudeHome);
    const seen = new Set<string>();
    for (const [key, records] of Object.entries(j.plugins ?? {})) {
      if (off.has(key)) continue;
      const plugin = key.includes('@') ? key.slice(0, key.indexOf('@')) : key;
      for (const rec of records ?? []) {
        const ip = rec?.installPath;
        if (!ip || typeof ip !== 'string') continue;
        const dir = path.posix.join(ip, 'skills');
        if (seen.has(dir)) continue;
        seen.add(dir);
        out.push({ plugin, pluginId: key, dir });
      }
    }
  } catch {
    /* 清单损坏 → 只有内置 */
  }
  return out;
}

/**
 * 全局技能 = `<claudeHome>/skills`（内置）+ 各已启用插件自带技能 + `<codexHome>/skills`
 * 为实目录时的 codex 专属技能（已 symlink 共用则内容同源，跳过防重复）。按 path 去重。
 */
export async function listGlobalSkills(driver: SkillsDriver, homes: AgentHomes): Promise<SkillInfo[]> {
  const merged: SkillInfo[] = [];
  const seen = new Set<string>();
  const push = (arr: SkillInfo[]): void => {
    for (const s of arr) {
      if (!seen.has(s.path)) {
        seen.add(s.path);
        merged.push(s);
      }
    }
  };
  push(await scanSkillsDir(driver, path.posix.join(homes.claudeHome, 'skills'), 'global', '内置'));
  for (const { plugin, pluginId, dir } of await installedPluginSkillDirs(driver, homes.claudeHome)) {
    push((await scanSkillsDir(driver, dir, 'global', plugin)).map(s => ({...s,pluginId,version:path.posix.basename(path.posix.dirname(dir))})));
  }
  const codexSkills = path.posix.join(homes.codexHome, 'skills');
  if ((await driver.readlink(codexSkills)) === null) {
    push(await scanSkillsDir(driver, codexSkills, 'global', 'codex'));
  }
  const cache = path.posix.join(homes.codexHome, 'plugins', 'cache');
  async function walkPlugins(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    const entries = await driver.listDir(dir).catch(() => []);
    for (const entry of entries) {
      if (entry.type !== 'dir') continue;
      const child = path.posix.join(dir, entry.name);
      if (entry.name === 'skills') {
        const plugin = path.posix.basename(path.posix.dirname(dir));
        push((await scanSkillsDir(driver, child, 'global', plugin)).map(s=>({...s,version:path.posix.basename(dir)})));
      } else await walkPlugins(child, depth+1);
    }
  }
  await walkPlugins(cache,0);
  push(await scanSkillsDir(driver,path.posix.join(path.posix.dirname(homes.codexHome),'.agents','skills'),'global','agents'));
  merged.sort((a, b) => a.name.localeCompare(b.name) || (a.source ?? '').localeCompare(b.source ?? ''));
  return merged;
}

/** 项目技能 = `<cwd>/.claude/skills` + `.codex/skills` 为实目录时的 codex 专属技能。 */
export async function listProjectSkills(driver: SkillsDriver, cwd: string): Promise<SkillInfo[]> {
  const merged: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const s of await scanSkillsDir(driver, path.posix.join(cwd, '.claude', 'skills'), 'project')) {
    if (!seen.has(s.path)) {
      seen.add(s.path);
      merged.push(s);
    }
  }
  for (const s of await scanSkillsDir(driver, path.posix.join(cwd, '.agents', 'skills'), 'project', 'agents')) {
    if (!seen.has(s.path)) { seen.add(s.path); merged.push(s); }
  }
  const codexSkills = path.posix.join(cwd, '.codex', 'skills');
  if ((await driver.readlink(codexSkills)) === null) {
    for (const s of await scanSkillsDir(driver, codexSkills, 'project', 'codex')) {
      if (!seen.has(s.path)) {
        seen.add(s.path);
        merged.push(s);
      }
    }
  }
  return merged;
}

// ---------- 查看 ----------

/** 词法包含判定：p 恰为 root 或在 root/ 之下（两侧都已 normalize 才有意义） */
function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
}

/** 本 scope 允许读取 SKILL.md 的根目录（项目 + 全局 + 插件目录，供查看端点做边界） */
export function skillReadRoots(cwd: string | null, homes: AgentHomes | null): string[] {
  const roots: string[] = [];
  if (cwd) {
    roots.push(path.posix.join(cwd, '.claude', 'skills'), path.posix.join(cwd, '.codex', 'skills'));
  }
  if (homes) {
    roots.push(
      path.posix.join(homes.claudeHome, 'skills'),
      path.posix.join(homes.claudeHome, 'plugins'),
      path.posix.join(homes.codexHome, 'skills'),
    );
  }
  return roots;
}

/**
 * 读单个技能的 SKILL.md：reqPath 必须词法归一后落在任一允许根内、且以 /SKILL.md 结尾。
 * 找不到/越界返回 {ok:false}，不抛异常。
 */
export async function readSkillFile(
  driver: SkillsDriver,
  roots: string[],
  reqPath: string,
): Promise<{ ok: boolean; name?: string; content?: string; error?: string }> {
  const norm = path.posix.normalize(reqPath);
  if (path.posix.basename(norm) !== 'SKILL.md' || !norm.startsWith('/')) {
    return { ok: false, error: '非法路径' };
  }
  if (!roots.some((r) => within(norm, path.posix.normalize(r)))) {
    return { ok: false, error: '越界' };
  }
  const content = await readDriverText(driver, norm);
  if (content === null) return { ok: false, error: 'SKILL.md 不存在' };
  return { ok: true, name: path.posix.basename(path.posix.dirname(norm)), content };
}

// ---------- 安装 / 卸载 ----------

/** 单技能安装上限（防市场仓库塞怪东西） */
export const MAX_SKILL_FILES = 400;
export const MAX_SKILL_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;

interface SkillFile {
  rel: string;
  abs: string;
  size: number;
  /** 可执行脚本保留执行位 */
  exec: boolean;
}

/**
 * 枚举控制面本地技能目录的全部文件（递归；跳过符号链接与点开头目录）。
 * 超限抛错——安装方给用户看得懂的报错。
 */
export async function walkLocalSkillDir(srcDir: string): Promise<SkillFile[]> {
  const out: SkillFile[] = [];
  let bytes = 0;
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .git 等
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(abs, r);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await fsp.stat(abs);
      if (st.size > MAX_SKILL_FILE_BYTES) throw new Error(`单文件超 5MB: ${r}`);
      bytes += st.size;
      if (bytes > MAX_SKILL_BYTES) throw new Error('技能目录超 20MB');
      out.push({ rel: r, abs, size: st.size, exec: (st.mode & 0o111) !== 0 });
      if (out.length > MAX_SKILL_FILES) throw new Error(`技能文件数超 ${MAX_SKILL_FILES}`);
    }
  }
  await walk(srcDir, '');
  if (!out.some((f) => f.rel === 'SKILL.md')) throw new Error('缺少 SKILL.md，不是有效技能目录');
  return out;
}

/**
 * 把控制面本地技能目录装到执行机 `<destBase>/<name>`（覆盖安装：已存在先删）。
 * name 必须过 SKILL_NAME_RE（调用方与此处双保险）。
 */
export async function installSkillDir(
  driver: SkillsDriver,
  srcDir: string,
  destBase: string,
  name: string,
): Promise<{ files: number; bytes: number }> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`非法技能名: ${name}`);
  const files = await walkLocalSkillDir(srcDir);
  const dest = path.posix.join(destBase, name);
  const st = await driver.statPath(dest);
  if (st) await driver.removeTree(dest);
  let bytes = 0;
  for (const f of files) {
    const data = new Uint8Array(await fsp.readFile(f.abs));
    if (f.exec) {
      await driver.writeFile(path.posix.join(dest, f.rel), data, 0o755);
    } else {
      await driver.writeFile(path.posix.join(dest, f.rel), data);
    }
    bytes += f.size;
  }
  return { files: files.length, bytes };
}

/** codex 共享结果：linked=本次建链 / already=早已是链接 / copy=实目录须双写 / skip=异物不动 */
export type CodexShareMode = 'linked' | 'already' | 'copy' | 'skip';

/**
 * 确保 codexSkills 与 claudeSkills 共用：
 * - 不存在 → 建符号链接（linkTarget 由调用方给：项目用相对 `../.claude/skills`，全局用绝对路径）；
 * - 已是链接 → 不动（无论指向哪，尊重用户自己的布局）；
 * - 已是实目录 → 返回 'copy'，调用方把技能再装一份进去（绝不搬动/删除用户已有内容）；
 * - 其它（普通文件等）→ 'skip'。
 */
export async function ensureCodexShare(
  driver: SkillsDriver,
  codexSkills: string,
  linkTarget: string,
): Promise<CodexShareMode> {
  if ((await driver.readlink(codexSkills)) !== null) return 'already';
  const st = await driver.statPath(codexSkills);
  if (!st) {
    try {
      await driver.symlink(linkTarget, codexSkills);
      return 'linked';
    } catch {
      return 'skip'; // 竞态/权限：退化为不共享，安装本体不受影响
    }
  }
  return st.isDirectory ? 'copy' : 'skip';
}

/**
 * 卸载技能：删 `<claudeSkillsBase>/<name>`；codexSkillsBase 为实目录时同名一并删
 * （symlink 共用时删一份即两侧消失）。不存在视为成功。
 */
export async function uninstallSkill(
  driver: SkillsDriver,
  claudeSkillsBase: string,
  codexSkillsBase: string,
  name: string,
): Promise<void> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`非法技能名: ${name}`);
  await driver.removeTree(path.posix.join(claudeSkillsBase, name));
  if ((await driver.readlink(codexSkillsBase)) === null) {
    const st = await driver.statPath(codexSkillsBase);
    if (st?.isDirectory) await driver.removeTree(path.posix.join(codexSkillsBase, name));
  }
}
