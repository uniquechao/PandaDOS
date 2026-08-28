/**
 * core/skill-market 单测：seed 迁移 / 源管理（校验+去重+删除清缓存）/
 * 扫描（深度/不嵌套/上限）/ 富化缓存（指纹命中与失效）/ 流式富化事件序 / 定位与预览。
 * git 同步不打网络——用本地 file:// 仓库验证 clone/pull 路径。
 */
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmClient, LlmResult } from '../agents/llm';
import { openDb } from './db';
import { migrate } from './migrate';
import {
  addMarket,
  descHash,
  enrichSkills,
  enrichSkillsStream,
  listMarkets,
  listMarketSkills,
  marketSkillDir,
  normalizeRepo,
  readMarketSkillMd,
  removeMarket,
  scanMarketSkills,
  syncMarkets,
  updateMarket,
  marketSnapshot,
} from './skill-market';

function makeDb(): Database {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'skill-mkt-'));
}

/** 在 baseDir/market 下放一个技能（模拟已同步的市场缓存） */
function mkMarketSkill(baseDir: string, market: string, rel: string, desc: string): void {
  const dir = join(baseDir, market, ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${rel.split('/').pop()}\ndescription: ${desc}\n---\n# t`);
}

/** 固定回复的 LlmClient 替身 */
function fakeLlm(reply: unknown): LlmClient & { calls: number } {
  const c = {
    calls: 0,
    async chat(): Promise<LlmResult> {
      c.calls++;
      const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
      return { content, toolCalls: [], raw: { role: 'assistant', content } };
    },
  };
  return c;
}

describe('seed 迁移与源管理', () => {
  test('004 迁移内置 4 个市场源', () => {
    const db = makeDb();
    const names = listMarkets(db).map((m) => m.name);
    expect(names).toEqual(['anthropics-skills', 'superpowers', 'claude-code-skills', 'codex-skills']);
    expect(listMarkets(db).every((m) => m.enabled)).toBe(true);
  });

  test('normalizeRepo：owner/repo 简写 → GitHub；拒绝畸形（防 git 参数注入）', () => {
    expect(normalizeRepo('foo/bar')).toBe('https://github.com/foo/bar.git');
    expect(normalizeRepo('https://gitee.com/a/b.git')).toBe('https://gitee.com/a/b.git');
    expect(normalizeRepo('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(normalizeRepo('--upload-pack=/bin/sh')).toBeNull();
    expect(normalizeRepo('a b')).toBeNull();
    expect(normalizeRepo('')).toBeNull();
  });

  test('addMarket 校验名与子目录；同名拒绝；removeMarket 连缓存目录与 i18n 一起清', () => {
    const db = makeDb();
    const baseDir = tmp();
    expect(addMarket(db, { name: '非法名', repo: 'a/b' }).ok).toBe(false);
    expect(addMarket(db, { name: 'm1', repo: 'a/b', subdir: '../x' }).ok).toBe(false);
    expect(addMarket(db, { name: 'm1', repo: 'a/b', note: '备注' }).ok).toBe(true);
    expect(addMarket(db, { name: 'm1', repo: 'c/d' }).error).toBe('同名市场已存在');
    // 缓存目录 + i18n 行
    mkdirSync(join(baseDir, 'm1'), { recursive: true });
    db.query(
      "INSERT INTO skill_i18n (skill_key, desc_hash, desc_zh, updated_ts) VALUES ('m1/a', 'h', '中', 0)",
    ).run();
    expect(removeMarket(db, 'm1', baseDir).ok).toBe(true);
    expect(existsSync(join(baseDir, 'm1'))).toBe(false);
    expect(db.query('SELECT COUNT(*) c FROM skill_i18n').get()).toEqual({ c: 0 });
    expect(removeMarket(db, 'm1', baseDir).ok).toBe(false);
  });

  test('updateMarket validates and atomically preserves source identity', () => {
    const db = makeDb();
    const before = listMarkets(db).find((market) => market.name === 'superpowers')!;
    expect(updateMarket(db, 'superpowers', {
      repo: 'openai/superpowers', subdir: 'skills', note: 'personas', enabled: false,
    })).toEqual({ ok: true });
    const after = listMarkets(db).find((market) => market.name === 'superpowers')!;
    expect(after).toMatchObject({
      id: before.id,
      repo: 'https://github.com/openai/superpowers.git',
      subdir: 'skills',
      note: 'personas',
      enabled: false,
    });
    expect(updateMarket(db, 'superpowers', { subdir: '../escape' }).ok).toBe(false);
    expect(updateMarket(db, 'missing', { enabled: true }).ok).toBe(false);
  });
});

describe('扫描', () => {
  test('顶层与嵌套技能都扫出；命中 SKILL.md 不再下钻；subdir 限定', () => {
    const baseDir = tmp();
    mkMarketSkill(baseDir, 'm', 'top-skill', '顶层');
    mkMarketSkill(baseDir, 'm', 'skills/nested-skill', '嵌套');
    // 技能内部的子目录含 SKILL.md 也不该算独立技能
    mkMarketSkill(baseDir, 'm', 'top-skill/inner', '不该出现');
    // 点目录忽略
    mkMarketSkill(baseDir, 'm', '.github/fake', '忽略');
    const all = scanMarketSkills('m', '', baseDir);
    expect(all.map((s) => s.rel)).toEqual(['skills/nested-skill', 'top-skill']);
    expect(all[0]!.category).toBe('skills');
    expect(all[1]!.category).toBe('');
    const sub = scanMarketSkills('m', 'skills', baseDir);
    expect(sub.map((s) => s.rel)).toEqual(['skills/nested-skill']);
    // 未同步目录 → []
    expect(scanMarketSkills('nope', '', baseDir)).toEqual([]);
  });

  test('listMarketSkills：多市场聚合 + count + needSync', () => {
    const db = makeDb();
    const baseDir = tmp();
    const empty = listMarketSkills(db, baseDir);
    expect(empty.needSync).toBe(true);
    mkMarketSkill(baseDir, 'superpowers', 'skills/tdd', 'test driven');
    const r = listMarketSkills(db, baseDir);
    expect(r.needSync).toBe(false);
    expect(r.skills.length).toBe(1);
    expect(r.markets.find((m) => m.name === 'superpowers')!.count).toBe(1);
    expect(r.markets.find((m) => m.name === 'codex-skills')!.count).toBe(0);
  });
});

describe('定位与预览', () => {
  test('marketSkillDir 词法限定；readMarketSkillMd 读全文', () => {
    const db = makeDb();
    const baseDir = tmp();
    mkMarketSkill(baseDir, 'superpowers', 'skills/tdd', 'd');
    const ok = marketSkillDir(db, 'superpowers', 'skills/tdd', baseDir);
    expect(ok.ok).toBe(true);
    expect(ok.name).toBe('tdd');
    expect(marketSkillDir(db, 'superpowers', '../escape', baseDir).ok).toBe(false);
    expect(marketSkillDir(db, 'superpowers', '/abs', baseDir).ok).toBe(false);
    expect(marketSkillDir(db, 'no-such', 'a', baseDir).ok).toBe(false);
    expect(marketSkillDir(db, 'superpowers', 'skills/none', baseDir).ok).toBe(false);
    const md = readMarketSkillMd(db, 'superpowers', 'skills/tdd', baseDir);
    expect(md.ok).toBe(true);
    expect(md.content).toContain('description: d');
  });
});

describe('git 同步（本地 file:// 仓库）', () => {
  test('clone 后可扫描；再次同步走 pull；失败市场记 last_error 不拖累别家', async () => {
    const db = makeDb();
    const baseDir = tmp();
    // 造一个真实 git 仓库当"远端"
    const remote = tmp();
    mkdirSync(join(remote, 'my-skill'));
    writeFileSync(join(remote, 'my-skill', 'SKILL.md'), '---\ndescription: 本地技能\n---\n');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['-C', remote, 'init', '-q'], { env });
    execFileSync('git', ['-C', remote, 'add', '.'], { env });
    execFileSync('git', ['-C', remote, 'commit', '-qm', 'init'], { env });
    // 清 seed，注册本地市场 + 一个必失败市场
    db.query('DELETE FROM skill_markets').run();
    db.query(
      'INSERT INTO skill_markets (name, repo, subdir, note, enabled, created_ts) VALUES (?, ?, ?, ?, 1, 0)',
    ).run('local-m', remote, '', '');
    db.query(
      'INSERT INTO skill_markets (name, repo, subdir, note, enabled, created_ts) VALUES (?, ?, ?, ?, 1, 0)',
    ).run('bad-m', '/no/such/repo', '', '');
    const r1 = await syncMarkets(db, { baseDir });
    expect(r1.ok).toBe(true);
    const good = r1.results.find((x) => x.name === 'local-m')!;
    const bad = r1.results.find((x) => x.name === 'bad-m')!;
    expect(good.ok).toBe(true);
    expect(good.count).toBe(1);
    expect(bad.ok).toBe(false);
    expect(listMarkets(db).find((m) => m.name === 'bad-m')!.lastError).toBeTruthy();
    expect((await marketSnapshot(db, 'local-m', baseDir))?.commit).toMatch(/^[a-f0-9]{40}$/);
    db.query("UPDATE skill_markets SET repo = 'https://example.com/other.git' WHERE name = 'local-m'").run();
    expect(await marketSnapshot(db, 'local-m', baseDir)).toBeNull();
    db.query('UPDATE skill_markets SET repo = ? WHERE name = ?').run(remote, 'local-m');
    // 远端加技能 → pull 增量可见
    mkdirSync(join(remote, 'second'));
    writeFileSync(join(remote, 'second', 'SKILL.md'), '# 2');
    execFileSync('git', ['-C', remote, 'add', '.'], { env });
    execFileSync('git', ['-C', remote, 'commit', '-qm', 'more'], { env });
    const r2 = await syncMarkets(db, { baseDir, only: 'local-m' });
    expect(r2.results[0]!.count).toBe(2);
  }, 60_000);
});

describe('驱动大模型 富化', () => {
  test('流式事件序 meta→item→done；缓存命中不再调用；描述变更才重译；force 全量', async () => {
    const db = makeDb();
    const baseDir = tmp();
    mkMarketSkill(baseDir, 'm', 'a-skill', 'first desc');
    db.query('DELETE FROM skill_markets').run();
    db.query(
      'INSERT INTO skill_markets (name, repo, subdir, note, enabled, created_ts) VALUES (?, ?, ?, ?, 1, 0)',
    ).run('m', 'x/y', '', '');
    const llm = fakeLlm({ descZh: '中文', tags: ['测试', '工具'], recommend: true, reason: '好用' });
    const events: string[] = [];
    for await (const ev of enrichSkillsStream(db, llm, { baseDir })) events.push(ev.type);
    expect(events).toEqual(['meta', 'item', 'done']);
    expect(llm.calls).toBe(1);
    // 合并进列表
    const list = listMarketSkills(db, baseDir);
    expect(list.skills[0]!.descZh).toBe('中文');
    expect(list.skills[0]!.tags).toEqual(['测试', '工具']);
    expect(list.skills[0]!.recommend).toBe(true);
    // 再富化：全命中缓存，零调用
    const r2 = await enrichSkills(db, llm, { baseDir });
    expect(r2.enriched).toBe(0);
    expect(llm.calls).toBe(1);
    // 描述变更 → 指纹失效 → 重译
    mkMarketSkill(baseDir, 'm', 'a-skill', 'CHANGED desc');
    await enrichSkills(db, llm, { baseDir });
    expect(llm.calls).toBe(2);
    // force 全量重译
    await enrichSkills(db, llm, { baseDir, force: true });
    expect(llm.calls).toBe(3);
  });

  test('解析失败 yield item-error；市场为空 yield error', async () => {
    const db = makeDb();
    const baseDir = tmp();
    // 空市场
    const evs1: string[] = [];
    for await (const ev of enrichSkillsStream(db, fakeLlm('{}'), { baseDir })) evs1.push(ev.type);
    expect(evs1).toEqual(['error']);
    // 坏 JSON → item-error
    mkMarketSkill(baseDir, 'anthropics-skills', 's1', 'd');
    const evs2: string[] = [];
    for await (const ev of enrichSkillsStream(db, fakeLlm('not-json'), { baseDir })) evs2.push(ev.type);
    expect(evs2).toEqual(['meta', 'item-error', 'done']);
  });

  test('descHash 稳定且区分描述', () => {
    expect(descHash('a')).toBe(descHash('a'));
    expect(descHash('a')).not.toBe(descHash('b'));
    expect(descHash('a')).toMatch(/^[0-9a-f]{12}$/);
  });
});
