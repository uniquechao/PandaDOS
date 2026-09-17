/**
 * issues/skill-mount —— 按模块挂载技能的注入侧（#277 / I-02）。
 *
 * 背景：代理每次会话都会把 `<cwd>/.claude/skills` 下所有 SKILL.md 的 frontmatter 读一遍，
 * 命中就整篇再读。#270 实测 108 次工具调用里约 20 次在读 SKILL.md，其中一多半跟那条纯后端
 * Bug 毫无关系。「压缩后复用摘要」这类提示词约束靠不住（模型压缩后并不知道自己读过什么），
 * 唯一可靠的办法是**让它看不见**——启动时就不把无关技能挂进项目技能目录。
 *
 * 难点是 `.claude/skills` 里的东西通常被 git 跟踪，而 issue 流会自动 commit/push：
 * 直接按模块搬动被跟踪的文件，会把「这次不挂 pandados-frontend」变成一次删文件的提交。
 * 所以采用**实体外移 + 软链挂载**：
 *
 *   <cwd>/.panda/skills/store/<name>/    ← 技能实体（未被跟踪的那些搬到这里，gitignore 掉）
 *   <cwd>/.claude/skills/<name>          ← 指向 store 的软链，挂/摘只动这条链
 *
 * 摘链只是删一条未被跟踪的软链，工作区照样干净，自动提交不会带上它。
 *
 * **绝不动被 git 跟踪的技能**（本仓库自身的 pandados-* 就是）：它们记为 `pinned` 原样留着、
 * 始终可见。宁可少省一点 token，也不能让引擎去改别人提交进仓库的文件。
 *
 * 并发：同一项目同时只有一条 issue 在跑（`pickNext` 的 `isBusy` 保证），所以一个 cwd 上
 * 不会有两个模块同时抢这份挂载。
 */
import type { ExecutorDriver } from '../executor/driver';

/** 技能实体外移后的存放处（相对 cwd） */
export const SKILL_STORE_REL = '.panda/skills/store';

/** 项目技能目录（相对 cwd） */
export const PROJECT_SKILLS_REL = '.claude/skills';

/** .gitignore 里那段的标记行（幂等判据） */
export const SKILL_GITIGNORE_MARKER = '# panda:module-skills';

const DECODER = new TextDecoder();

export type SkillMountDriver = Pick<
  ExecutorDriver,
  | 'statPath'
  | 'listDir'
  | 'readFileRange'
  | 'writeFile'
  | 'mkdirp'
  | 'movePath'
  | 'symlink'
  | 'readlink'
  | 'removeTree'
  | 'git'
>;

export interface SkillMountPlan {
  /** 本次挂上的（软链存在，代理看得见） */
  mounted: string[];
  /** 本次摘掉的（软链已移除，代理看不见） */
  unmounted: string[];
  /** 被 git 跟踪、不敢动，始终可见 */
  pinned: string[];
}

function joinPath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, '')}/${rel}`;
}

async function readText(driver: SkillMountDriver, path: string): Promise<string | null> {
  const st = await driver.statPath(path).catch(() => null);
  if (!st || st.isDirectory) return null;
  const { data } = await driver.readFileRange(path, 0, Math.max(1, st.size));
  return DECODER.decode(data);
}

async function listNames(
  driver: SkillMountDriver,
  dir: string,
  type: 'dir' | 'symlink',
): Promise<string[]> {
  try {
    const st = await driver.statPath(dir);
    if (!st || !st.isDirectory) return [];
    return (await driver.listDir(dir)).filter((e) => e.type === type).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * `.claude/skills` 下哪些技能被 git 跟踪。
 *
 * 仓库不可用/不是 git 仓库时返回 `null` = **全部当成被跟踪**：宁可一个都不搬，
 * 也不能在判不准的情况下动用户的文件。
 */
export async function trackedSkillNames(
  driver: SkillMountDriver,
  cwd: string,
): Promise<Set<string> | null> {
  const r = await driver.git(cwd, ['ls-files', '--', PROJECT_SKILLS_REL]).catch(() => null);
  if (!r || r.code !== 0) return null;
  const out = new Set<string>();
  for (const line of r.out.split('\n')) {
    const rel = line.trim();
    if (!rel.startsWith(`${PROJECT_SKILLS_REL}/`)) continue;
    const name = rel.slice(PROJECT_SKILLS_REL.length + 1).split('/')[0];
    if (name) out.add(name);
  }
  return out;
}

/**
 * 往 `<cwd>/.gitignore` 追加挂载相关的忽略段（幂等，已有标记就不动）。
 *
 * 忽略 `/.claude/skills/` 不会让**已被跟踪**的技能消失（gitignore 对已跟踪文件无效），
 * 只是让运行期挂/摘的软链不进 `git add -A`。返回是否真的写了。
 */
export async function ensureSkillGitignore(
  driver: SkillMountDriver,
  cwd: string,
): Promise<boolean> {
  const file = joinPath(cwd, '.gitignore');
  const text = (await readText(driver, file)) ?? '';
  if (text.includes(SKILL_GITIGNORE_MARKER)) return false;
  const block = [
    `${SKILL_GITIGNORE_MARKER} 按模块挂载的技能：实体在 .panda/skills/store，`,
    '# .claude/skills 下是运行期生成的软链（已跟踪的技能不受影响，照常进版本库）',
    `/${SKILL_STORE_REL.split('/')[0]}/skills/`,
    `/${PROJECT_SKILLS_REL}/`,
    '',
  ].join('\n');
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  await driver.writeFile(file, `${text}${sep}${text.length ? '\n' : ''}${block}`);
  return true;
}

/** 这个项目一共有哪些可挂的技能（store 实体 ∪ `.claude/skills` 现存目录/软链），去重保序 */
export async function listProjectSkillNames(
  driver: SkillMountDriver,
  cwd: string,
): Promise<string[]> {
  const store = joinPath(cwd, SKILL_STORE_REL);
  const skills = joinPath(cwd, PROJECT_SKILLS_REL);
  const names = [
    ...(await listNames(driver, store, 'dir')),
    ...(await listNames(driver, skills, 'dir')),
    ...(await listNames(driver, skills, 'symlink')),
  ];
  const out: string[] = [];
  for (const n of names) if (!out.includes(n)) out.push(n);
  return out.sort();
}

/**
 * 按模块的技能清单调整 `<cwd>/.claude/skills` 的挂载状态。
 *
 * 幂等：可以每条 issue 起跑前无脑调用一次。未被跟踪的实体第一次会被搬进 store，
 * 之后只剩「加/删软链」。被跟踪的技能只统计不处理。
 */
export async function mountModuleSkills(
  driver: SkillMountDriver,
  cwd: string,
  wanted: readonly string[],
): Promise<SkillMountPlan> {
  const skillsDir = joinPath(cwd, PROJECT_SKILLS_REL);
  const storeDir = joinPath(cwd, SKILL_STORE_REL);
  const plan: SkillMountPlan = { mounted: [], unmounted: [], pinned: [] };

  const realDirs = await listNames(driver, skillsDir, 'dir');
  const storeDirs = await listNames(driver, storeDir, 'dir');
  if (realDirs.length === 0 && storeDirs.length === 0) return plan;

  await ensureSkillGitignore(driver, cwd);

  // 1) 把未被跟踪的实体一次性收进 store（被跟踪的原样留下，只记 pinned）
  const tracked = await trackedSkillNames(driver, cwd);
  for (const name of realDirs) {
    if (tracked === null || tracked.has(name)) {
      plan.pinned.push(name);
      continue;
    }
    const dst = joinPath(storeDir, name);
    if (await driver.statPath(dst).catch(() => null)) {
      // store 里已有同名实体：两边都是真目录，无法判定谁更新，保守不动
      plan.pinned.push(name);
      continue;
    }
    await driver.mkdirp(storeDir);
    await driver.movePath(joinPath(skillsDir, name), dst);
  }

  // 2) store 里的技能按 wanted 挂/摘（只动软链）
  for (const name of await listNames(driver, storeDir, 'dir')) {
    const link = joinPath(skillsDir, name);
    const target = joinPath(storeDir, name);
    const cur = await driver.readlink(link).catch(() => null);
    if (wanted.includes(name)) {
      if (cur === target) {
        plan.mounted.push(name);
        continue;
      }
      if (cur !== null) await driver.removeTree(link);
      else if (await driver.statPath(link).catch(() => null)) {
        // 同名实体又冒出来了（用户手动放的）：不覆盖
        plan.pinned.push(name);
        continue;
      }
      await driver.mkdirp(skillsDir);
      await driver.symlink(target, link);
      plan.mounted.push(name);
    } else if (cur !== null) {
      await driver.removeTree(link);
      plan.unmounted.push(name);
    } else if (!(await driver.statPath(link).catch(() => null))) {
      plan.unmounted.push(name);
    } else {
      plan.pinned.push(name);
    }
  }

  plan.mounted.sort();
  plan.unmounted.sort();
  plan.pinned.sort();
  return plan;
}
