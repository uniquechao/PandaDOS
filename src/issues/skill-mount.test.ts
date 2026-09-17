import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDriver } from '../executor/local';
import {
  PROJECT_SKILLS_REL,
  SKILL_GITIGNORE_MARKER,
  SKILL_STORE_REL,
  ensureSkillGitignore,
  listProjectSkillNames,
  mountModuleSkills,
  trackedSkillNames,
} from './skill-mount';

const driver = new LocalDriver();
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个真 git 仓库，skills 里放几个技能；tracked 里的会被 git add + commit */
async function repo(skills: string[], tracked: string[] = []): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'panda-skills-'));
  dirs.push(cwd);
  for (const name of skills) {
    mkdirSync(join(cwd, PROJECT_SKILLS_REL, name), { recursive: true });
    writeFileSync(join(cwd, PROJECT_SKILLS_REL, name, 'SKILL.md'), `# ${name}\n`);
  }
  await driver.git(cwd, ['init', '-q']);
  await driver.git(cwd, ['config', 'user.email', 't@example.com']);
  await driver.git(cwd, ['config', 'user.name', 'T']);
  if (tracked.length) {
    for (const name of tracked) {
      await driver.git(cwd, ['add', '--', `${PROJECT_SKILLS_REL}/${name}`]);
    }
    await driver.git(cwd, ['commit', '-q', '-m', 'skills']);
  }
  return cwd;
}

const linkTarget = (cwd: string, name: string): string | null => {
  const p = join(cwd, PROJECT_SKILLS_REL, name);
  try {
    return lstatSync(p).isSymbolicLink() ? require('node:fs').readlinkSync(p) : null;
  } catch {
    return null;
  }
};

describe('trackedSkillNames', () => {
  test('只报被跟踪的那些', async () => {
    const cwd = await repo(['kept', 'free'], ['kept']);
    expect([...(await trackedSkillNames(driver, cwd))!]).toEqual(['kept']);
  });

  test('不是 git 仓库 → null（= 全部当被跟踪，一个都不搬）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'panda-skills-'));
    dirs.push(cwd);
    expect(await trackedSkillNames(driver, cwd)).toBeNull();
  });
});

describe('ensureSkillGitignore', () => {
  test('首次追加、二次幂等', async () => {
    const cwd = await repo(['a']);
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
    expect(await ensureSkillGitignore(driver, cwd)).toBe(true);
    const text = readFileSync(join(cwd, '.gitignore'), 'utf8');
    expect(text).toContain('node_modules/');
    expect(text).toContain(SKILL_GITIGNORE_MARKER);
    expect(text).toContain('/.claude/skills/');
    expect(text).toContain('/.panda/skills/');
    expect(await ensureSkillGitignore(driver, cwd)).toBe(false);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toBe(text);
  });

  test('没有 .gitignore 也能建出来', async () => {
    const cwd = await repo(['a']);
    expect(await ensureSkillGitignore(driver, cwd)).toBe(true);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain(SKILL_GITIGNORE_MARKER);
  });
});

describe('mountModuleSkills', () => {
  test('未跟踪的技能搬进 store，按 wanted 挂软链', async () => {
    const cwd = await repo(['wanted', 'unwanted']);
    const plan = await mountModuleSkills(driver, cwd, ['wanted']);
    expect(plan.mounted).toEqual(['wanted']);
    expect(plan.unmounted).toEqual(['unwanted']);
    expect(plan.pinned).toEqual([]);
    // 实体都在 store 里，没丢
    expect(existsSync(join(cwd, SKILL_STORE_REL, 'wanted', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(cwd, SKILL_STORE_REL, 'unwanted', 'SKILL.md'))).toBe(true);
    // 代理只看得见 wanted，且它是指向 store 的软链
    expect(linkTarget(cwd, 'wanted')).toBe(join(cwd, SKILL_STORE_REL, 'wanted'));
    expect(existsSync(join(cwd, PROJECT_SKILLS_REL, 'unwanted'))).toBe(false);
  });

  test('被 git 跟踪的技能只记 pinned，绝不搬也绝不摘', async () => {
    const cwd = await repo(['tracked', 'free'], ['tracked']);
    const plan = await mountModuleSkills(driver, cwd, []);
    expect(plan.pinned).toEqual(['tracked']);
    expect(plan.unmounted).toEqual(['free']);
    expect(existsSync(join(cwd, PROJECT_SKILLS_REL, 'tracked', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(cwd, SKILL_STORE_REL, 'tracked'))).toBe(false);
    // 工作区里只多出 .gitignore 这一处有意为之的改动：挂/摘软链不产生任何 git 变更，
    // 被跟踪的技能既没被删也没被改，自动提交不会带上它们
    const st = await driver.git(cwd, ['status', '--porcelain']);
    expect(st.out.trim().split('\n').filter(Boolean)).toEqual(['?? .gitignore']);
  });

  test('不是 git 仓库 → 一个都不搬（全部 pinned）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'panda-skills-'));
    dirs.push(cwd);
    mkdirSync(join(cwd, PROJECT_SKILLS_REL, 'a'), { recursive: true });
    writeFileSync(join(cwd, PROJECT_SKILLS_REL, 'a', 'SKILL.md'), '# a\n');
    const plan = await mountModuleSkills(driver, cwd, []);
    expect(plan.pinned).toEqual(['a']);
    expect(existsSync(join(cwd, PROJECT_SKILLS_REL, 'a', 'SKILL.md'))).toBe(true);
  });

  test('幂等 + 换模块时挂载集合跟着换', async () => {
    const cwd = await repo(['a', 'b']);
    await mountModuleSkills(driver, cwd, ['a']);
    const again = await mountModuleSkills(driver, cwd, ['a']);
    expect(again.mounted).toEqual(['a']);
    expect(again.unmounted).toEqual(['b']);
    const swapped = await mountModuleSkills(driver, cwd, ['b']);
    expect(swapped.mounted).toEqual(['b']);
    expect(swapped.unmounted).toEqual(['a']);
    expect(linkTarget(cwd, 'b')).toBe(join(cwd, SKILL_STORE_REL, 'b'));
    expect(existsSync(join(cwd, PROJECT_SKILLS_REL, 'a'))).toBe(false);
  });

  test('技能目录与 store 都为空 → 什么都不做（不建 .gitignore）', async () => {
    const cwd = await repo([]);
    const plan = await mountModuleSkills(driver, cwd, ['a']);
    expect(plan).toEqual({ mounted: [], unmounted: [], pinned: [] });
    expect(existsSync(join(cwd, '.gitignore'))).toBe(false);
  });

  test('store 与技能目录同名实体撞车 → 保守不动，记 pinned', async () => {
    const cwd = await repo(['dup']);
    mkdirSync(join(cwd, SKILL_STORE_REL, 'dup'), { recursive: true });
    writeFileSync(join(cwd, SKILL_STORE_REL, 'dup', 'SKILL.md'), '# store dup\n');
    const plan = await mountModuleSkills(driver, cwd, ['dup']);
    expect(plan.pinned).toContain('dup');
    expect(existsSync(join(cwd, PROJECT_SKILLS_REL, 'dup', 'SKILL.md'))).toBe(true);
  });

  test('listProjectSkillNames 汇总 store 与已挂软链，去重排序', async () => {
    const cwd = await repo(['b', 'a']);
    await mountModuleSkills(driver, cwd, ['a']);
    expect(await listProjectSkillNames(driver, cwd)).toEqual(['a', 'b']);
  });

  test('软链已存在但指向别处 → 重新指到 store', async () => {
    const cwd = await repo(['a']);
    await mountModuleSkills(driver, cwd, ['a']);
    rmSync(join(cwd, PROJECT_SKILLS_REL, 'a'));
    symlinkSync('/nonexistent/a', join(cwd, PROJECT_SKILLS_REL, 'a'));
    const plan = await mountModuleSkills(driver, cwd, ['a']);
    expect(plan.mounted).toEqual(['a']);
    expect(linkTarget(cwd, 'a')).toBe(join(cwd, SKILL_STORE_REL, 'a'));
  });
});
