import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDriver } from '../executor/local';
import {
  ensureArtifactSkill,
  ensureCompatSkills,
  ensureMandoIssueSkill,
  ensureModuleGuideBlocks,
  ensureProjectBridge,
} from './agent-compat';

let dir: string;
const driver = new LocalDriver();

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-compat-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('ensureCompatSkills', () => {
  test('双侧安装 + 二次调用不覆盖 + 缺 home 跳过', async () => {
    const claudeHome = path.join(dir, 'h1', '.claude');
    const codexHome = path.join(dir, 'h1', '.codex');
    const wrote = await ensureCompatSkills(driver, { claudeHome, codexHome });
    expect(wrote).toHaveLength(2);
    const cx = await fsp.readFile(path.join(codexHome, 'skills/claude-config-compat/SKILL.md'), 'utf8');
    expect(cx).toContain('name: claude-config-compat');
    expect(cx).toContain('.claude/commands');
    const cl = await fsp.readFile(path.join(claudeHome, 'skills/agents-md-compat/SKILL.md'), 'utf8');
    expect(cl).toContain('name: agents-md-compat');
    expect(cl).toContain('AGENT.md');

    expect(await ensureCompatSkills(driver, { claudeHome, codexHome })).toHaveLength(0); // 幂等
    expect(await ensureCompatSkills(driver, { codexHome: path.join(dir, 'h2', '.codex') })).toHaveLength(1); // 单侧
  });
});

describe('ensureArtifactSkill', () => {
  test('claude+codex 各装一份「产物落 cwd」技能 + 幂等 + 缺 home 跳过', async () => {
    const claudeHome = path.join(dir, 'a1', '.claude');
    const codexHome = path.join(dir, 'a1', '.codex');
    const wrote = await ensureArtifactSkill(driver, { claudeHome, codexHome });
    expect(wrote).toHaveLength(2);
    const cl = await fsp.readFile(path.join(claudeHome, 'skills/artifacts-to-cwd/SKILL.md'), 'utf8');
    expect(cl).toContain('name: artifacts-to-cwd');
    expect(cl).toContain('当前工作目录');
    const cx = await fsp.readFile(path.join(codexHome, 'skills/artifacts-to-cwd/SKILL.md'), 'utf8');
    expect(cx).toContain('name: artifacts-to-cwd');

    expect(await ensureArtifactSkill(driver, { claudeHome, codexHome })).toHaveLength(0); // 幂等
    expect(await ensureArtifactSkill(driver, { claudeHome: path.join(dir, 'a2', '.claude') })).toHaveLength(1); // 单侧
  });
});

describe('ensureMandoIssueSkill', () => {
  test('Claude/Codex 安装同源 mando-issue，全局幂等且不覆盖人工修改', async () => {
    const claudeHome = path.join(dir, 'm1', '.claude');
    const codexHome = path.join(dir, 'm1', '.codex');
    expect(await ensureMandoIssueSkill(driver, { claudeHome, codexHome })).toHaveLength(2);
    const clPath = path.join(claudeHome, 'skills/mando-issue/SKILL.md');
    const cxPath = path.join(codexHome, 'skills/mando-issue/SKILL.md');
    const cl = await fsp.readFile(clPath, 'utf8');
    expect(cl).toBe(await fsp.readFile(cxPath, 'utf8'));
    expect(cl).toContain('name: mando-issue');
    expect(cl).toContain('.mando/modules/INDEX.md');
    expect(await ensureMandoIssueSkill(driver, { claudeHome, codexHome })).toHaveLength(0);

    await fsp.writeFile(clPath, '# 人工版本');
    expect(await ensureMandoIssueSkill(driver, { claudeHome, codexHome })).toHaveLength(0);
    expect(await fsp.readFile(clPath, 'utf8')).toBe('# 人工版本');
  });
});

describe('ensureModuleGuideBlocks', () => {
  test('保留人工根指南，只幂等维护 mando-issue 区块', async () => {
    const cwd = path.join(dir, 'module-guides');
    await fsp.mkdir(cwd, { recursive: true });
    await fsp.writeFile(path.join(cwd, 'AGENTS.md'), '# 人工 AGENTS\n');
    await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), '# 人工 CLAUDE\n');
    expect(await ensureModuleGuideBlocks(driver, cwd)).toHaveLength(2);
    expect(await ensureModuleGuideBlocks(driver, cwd)).toHaveLength(0);
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const text = await fsp.readFile(path.join(cwd, name), 'utf8');
      expect(text).toContain(`# 人工 ${name === 'AGENTS.md' ? 'AGENTS' : 'CLAUDE'}`);
      expect(text.match(/mando:module-guide:start/g)).toHaveLength(1);
      expect(text).toContain('.mando/modules/INDEX.md');
    }
  });

  test('根指南都缺失时创建 AGENTS.md 与 CLAUDE.md 模块入口', async () => {
    const cwd = path.join(dir, 'module-guides-empty');
    await fsp.mkdir(cwd, { recursive: true });
    expect(await ensureModuleGuideBlocks(driver, cwd)).toEqual([
      path.join(cwd, 'AGENTS.md'),
      path.join(cwd, 'CLAUDE.md'),
    ]);
    expect(await fsp.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('mando-issue');
    expect(await fsp.readFile(path.join(cwd, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
  });
});

describe('ensureProjectBridge', () => {
  test('有 CLAUDE.md 缺 AGENTS.md → 生成 AGENTS.md 桥', async () => {
    const cwd = path.join(dir, 'proj-claude-only');
    await fsp.mkdir(cwd, { recursive: true });
    await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), '# 项目约定');
    const wrote = await ensureProjectBridge(driver, cwd);
    expect(wrote).toEqual([path.join(cwd, 'AGENTS.md')]);
    expect(await fsp.readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toContain('CLAUDE.md');
  });

  test('有 AGENT.md 缺 CLAUDE.md → 生成 CLAUDE.md 桥（@import 指向 AGENT.md）', async () => {
    const cwd = path.join(dir, 'proj-agent-only');
    await fsp.mkdir(cwd, { recursive: true });
    await fsp.writeFile(path.join(cwd, 'AGENT.md'), '# agents 约定');
    const wrote = await ensureProjectBridge(driver, cwd);
    expect(wrote).toEqual([path.join(cwd, 'CLAUDE.md')]);
    expect(await fsp.readFile(path.join(cwd, 'CLAUDE.md'), 'utf8')).toContain('@AGENT.md');
  });

  test('两边都有或都没有 → 不写；已有文件绝不覆盖', async () => {
    const empty = path.join(dir, 'proj-empty');
    await fsp.mkdir(empty, { recursive: true });
    expect(await ensureProjectBridge(driver, empty)).toEqual([]);

    const both = path.join(dir, 'proj-both');
    await fsp.mkdir(both, { recursive: true });
    await fsp.writeFile(path.join(both, 'CLAUDE.md'), 'c');
    await fsp.writeFile(path.join(both, 'AGENTS.md'), 'a');
    expect(await ensureProjectBridge(driver, both)).toEqual([]);
    expect(await fsp.readFile(path.join(both, 'AGENTS.md'), 'utf8')).toBe('a');
  });
});
