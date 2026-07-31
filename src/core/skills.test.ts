/**
 * core/skills 单测：SKILL.md 解析 / 扫描（内置+插件+codex）/ 读取边界 /
 * 安装（覆盖+限制）/ codex 共享链接（新建/已链/实目录双写）/ 卸载。
 * 全部走 LocalDriver 打真实临时目录——与生产同一条代码路径。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDriver } from '../executor/local';
import {
  agentHomesFromClaudeDir,
  ensureCodexShare,
  installSkillDir,
  listGlobalSkills,
  listProjectSkills,
  parseSkillMd,
  readSkillFile,
  scanSkillsDir,
  SKILL_NAME_RE,
  skillReadRoots,
  uninstallSkill,
  walkLocalSkillDir,
} from './skills';

const driver = new LocalDriver();

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'skills-test-'));
}

function mkSkill(base: string, name: string, desc = `${name} 的描述`): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n正文`);
  return dir;
}

describe('parseSkillMd', () => {
  test('frontmatter 提取 name/description，引号剥除', () => {
    const r = parseSkillMd('---\nname: "foo"\ndescription: \'做某事\'\n---\n# T');
    expect(r.name).toBe('foo');
    expect(r.description).toBe('做某事');
  });

  test('无 frontmatter 取首个非空行并剥 #', () => {
    expect(parseSkillMd('\n\n## 标题 xx\n正文').description).toBe('标题 xx');
  });

  test('description 截断 200', () => {
    const r = parseSkillMd(`---\ndescription: ${'x'.repeat(300)}\n---\n`);
    expect(r.description.length).toBe(200);
  });
});

describe('agentHomesFromClaudeDir', () => {
  test('…/.claude/projects → 同 home 的 .claude/.codex', () => {
    expect(agentHomesFromClaudeDir('/root/.claude/projects/')).toEqual({
      claudeHome: '/root/.claude',
      codexHome: '/root/.codex',
    });
  });
  test('非标准路径 → null', () => {
    expect(agentHomesFromClaudeDir('/data/whatever')).toBeNull();
  });
});

describe('scanSkillsDir / 列表', () => {
  test('扫出含 SKILL.md 的子目录，忽略杂物；根缺失返回 []', async () => {
    const base = tmp();
    mkSkill(base, 'bbb');
    mkSkill(base, 'aaa');
    mkdirSync(join(base, 'not-skill'));
    writeFileSync(join(base, 'stray.txt'), 'x');
    const ss = await scanSkillsDir(driver, base, 'global', '内置');
    expect(ss.map((s) => s.name)).toEqual(['aaa', 'bbb']);
    expect(ss[0]!.summary).toBe('aaa 的描述');
    expect(ss[0]!.source).toBe('内置');
    expect(await scanSkillsDir(driver, join(base, 'nope'), 'global')).toEqual([]);
  });

  test('listGlobalSkills：内置 + 插件（installed_plugins.json，禁用剔除）+ codex 实目录', async () => {
    const home = tmp();
    const claudeHome = join(home, '.claude');
    const codexHome = join(home, '.codex');
    mkSkill(join(claudeHome, 'skills'), 'builtin-a');
    // 插件 p1 启用、p2 禁用
    const p1 = join(home, 'cache', 'p1');
    const p2 = join(home, 'cache', 'p2');
    mkSkill(join(p1, 'skills'), 'plug-skill');
    mkSkill(join(p2, 'skills'), 'off-skill');
    mkdirSync(join(claudeHome, 'plugins'), { recursive: true });
    writeFileSync(
      join(claudeHome, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'p1@m': [{ installPath: p1 }], 'p2@m': [{ installPath: p2 }] } }),
    );
    writeFileSync(join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'p2@m': false } }));
    // codex 实目录（未链接）→ 也要列出
    mkSkill(join(codexHome, 'skills'), 'codex-only');
    const ss = await listGlobalSkills(driver, { claudeHome, codexHome });
    expect(ss.map((s) => `${s.name}:${s.source}`)).toEqual([
      'builtin-a:内置',
      'codex-only:codex',
      'plug-skill:p1',
    ]);
  });

  test('codex/skills 已是 symlink 时不重复列（内容同源）', async () => {
    const home = tmp();
    const claudeHome = join(home, '.claude');
    const codexHome = join(home, '.codex');
    mkSkill(join(claudeHome, 'skills'), 'shared');
    mkdirSync(codexHome, { recursive: true });
    symlinkSync(join(claudeHome, 'skills'), join(codexHome, 'skills'));
    const ss = await listGlobalSkills(driver, { claudeHome, codexHome });
    expect(ss.map((s) => s.name)).toEqual(['shared']);
  });

  test('listProjectSkills：.claude/skills + codex 实目录', async () => {
    const cwd = tmp();
    mkSkill(join(cwd, '.claude', 'skills'), 'proj-a');
    mkSkill(join(cwd, '.codex', 'skills'), 'codex-b');
    const ss = await listProjectSkills(driver, cwd);
    expect(ss.map((s) => `${s.name}:${s.source ?? ''}`)).toEqual(['proj-a:', 'codex-b:codex']);
  });
});

describe('readSkillFile 边界', () => {
  test('根内可读、根外越界、必须以 SKILL.md 结尾', async () => {
    const cwd = tmp();
    const dir = mkSkill(join(cwd, '.claude', 'skills'), 'ok');
    const roots = skillReadRoots(cwd, null);
    const good = await readSkillFile(driver, roots, join(dir, 'SKILL.md'));
    expect(good.ok).toBe(true);
    expect(good.name).toBe('ok');
    expect(good.content).toContain('# ok');
    // 越界（/etc/passwd 伪装）
    const bad = await readSkillFile(driver, roots, '/etc/passwd');
    expect(bad.ok).toBe(false);
    // .. 穿越归一后越界
    const sneak = await readSkillFile(driver, roots, join(cwd, '.claude', 'skills', '..', '..', '..', 'x', 'SKILL.md'));
    expect(sneak.ok).toBe(false);
    // 非 SKILL.md
    const notmd = await readSkillFile(driver, roots, join(dir, 'other.md'));
    expect(notmd.ok).toBe(false);
  });
});

describe('安装 / codex 共享 / 卸载', () => {
  test('walkLocalSkillDir：缺 SKILL.md 报错、跳过点目录和符号链接', async () => {
    const src = tmp();
    writeFileSync(join(src, 'a.txt'), 'x');
    await expect(walkLocalSkillDir(src)).rejects.toThrow('缺少 SKILL.md');
    writeFileSync(join(src, 'SKILL.md'), '# s');
    mkdirSync(join(src, '.git'));
    writeFileSync(join(src, '.git', 'HEAD'), 'ref');
    symlinkSync(join(src, 'a.txt'), join(src, 'lnk'));
    const files = await walkLocalSkillDir(src);
    expect(files.map((f) => f.rel).sort()).toEqual(['SKILL.md', 'a.txt']);
  });

  test('installSkillDir：整目录落位（含子目录/执行位）+ 覆盖安装', async () => {
    const src = tmp();
    writeFileSync(join(src, 'SKILL.md'), '---\ndescription: d\n---\n');
    mkdirSync(join(src, 'scripts'));
    writeFileSync(join(src, 'scripts', 'run.sh'), '#!/bin/sh\necho hi', { mode: 0o755 });
    const destBase = join(tmp(), 'skills');
    const r = await installSkillDir(driver, src, destBase, 'demo');
    expect(r.files).toBe(2);
    expect(readFileSync(join(destBase, 'demo', 'SKILL.md'), 'utf8')).toContain('description: d');
    const st = await driver.statPath(join(destBase, 'demo', 'scripts', 'run.sh'));
    expect(st && (st.mode & 0o111) !== 0).toBe(true);
    // 覆盖：旧文件应消失
    writeFileSync(join(destBase, 'demo', 'stale.txt'), 'old');
    await installSkillDir(driver, src, destBase, 'demo');
    expect(existsSync(join(destBase, 'demo', 'stale.txt'))).toBe(false);
    // 非法名
    await expect(installSkillDir(driver, src, destBase, '../evil')).rejects.toThrow('非法技能名');
  });

  test('ensureCodexShare：不存在→建链；已是链→already；实目录→copy；普通文件→skip', async () => {
    const cwd = tmp();
    const claudeSkills = join(cwd, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });
    const codexSkills = join(cwd, '.codex', 'skills');
    expect(await ensureCodexShare(driver, codexSkills, '../.claude/skills')).toBe('linked');
    expect(readlinkSync(codexSkills)).toBe('../.claude/skills');
    expect(await ensureCodexShare(driver, codexSkills, '../.claude/skills')).toBe('already');
    // 实目录
    const cwd2 = tmp();
    mkdirSync(join(cwd2, '.codex', 'skills'), { recursive: true });
    expect(await ensureCodexShare(driver, join(cwd2, '.codex', 'skills'), 't')).toBe('copy');
    // 普通文件
    const cwd3 = tmp();
    mkdirSync(join(cwd3, '.codex'), { recursive: true });
    writeFileSync(join(cwd3, '.codex', 'skills'), 'not a dir');
    expect(await ensureCodexShare(driver, join(cwd3, '.codex', 'skills'), 't')).toBe('skip');
  });

  test('相对链接后：装进 .claude/skills 的技能从 .codex/skills 可见', async () => {
    const cwd = tmp();
    const src = tmp();
    writeFileSync(join(src, 'SKILL.md'), '# s');
    await installSkillDir(driver, src, join(cwd, '.claude', 'skills'), 'shared');
    await ensureCodexShare(driver, join(cwd, '.codex', 'skills'), '../.claude/skills');
    expect(readFileSync(join(cwd, '.codex', 'skills', 'shared', 'SKILL.md'), 'utf8')).toBe('# s');
  });

  test('uninstallSkill：symlink 共用删一份即消失；实目录双侧删', async () => {
    // symlink 情形
    const cwd = tmp();
    const src = tmp();
    writeFileSync(join(src, 'SKILL.md'), '# s');
    const cs = join(cwd, '.claude', 'skills');
    const xs = join(cwd, '.codex', 'skills');
    await installSkillDir(driver, src, cs, 'a');
    await ensureCodexShare(driver, xs, '../.claude/skills');
    await uninstallSkill(driver, cs, xs, 'a');
    expect(existsSync(join(cs, 'a'))).toBe(false);
    expect(existsSync(join(xs, 'a'))).toBe(false);
    // 实目录双写情形
    const cwd2 = tmp();
    const cs2 = join(cwd2, '.claude', 'skills');
    const xs2 = join(cwd2, '.codex', 'skills');
    await installSkillDir(driver, src, cs2, 'b');
    await installSkillDir(driver, src, xs2, 'b');
    await uninstallSkill(driver, cs2, xs2, 'b');
    expect(existsSync(join(cs2, 'b'))).toBe(false);
    expect(existsSync(join(xs2, 'b'))).toBe(false);
    // 非法名拒绝
    await expect(uninstallSkill(driver, cs2, xs2, '../x')).rejects.toThrow('非法技能名');
  });
});

describe('SKILL_NAME_RE', () => {
  test('放行常规名，拒绝穿越/怪名', () => {
    expect(SKILL_NAME_RE.test('web-perf_1.2')).toBe(true);
    expect(SKILL_NAME_RE.test('..')).toBe(false);
    expect(SKILL_NAME_RE.test('a/b')).toBe(false);
    expect(SKILL_NAME_RE.test('.hidden')).toBe(false);
    expect(SKILL_NAME_RE.test('')).toBe(false);
  });
});
