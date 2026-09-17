import { readSkillPolicy, saveSkillPolicy, effectiveSkillPolicy } from '../../core/skill-policy';
/**
 * web/routes/skills —— 技能与技能市场（v1 skills/market 平移 + v2 多用户/多执行机语义）。
 *
 * 项目维度（auth:'project-access'，属主/成员/admin）：
 *   GET    /api/projects/:projectId/skills            全局+项目技能清单（全局=项目所在执行机）
 *   GET    /api/projects/:projectId/skills/file?path= 读 SKILL.md（词法限定在技能根内）
 *   POST   /api/projects/:projectId/skills/install    {market, rel} 装进项目 .claude/skills
 *                                                     并把 .codex/skills 做成共享链接（codex 通用）
 *   DELETE /api/projects/:projectId/skills/:name      从项目卸载
 *
 * 市场浏览（auth:'user'，全体可看可翻译可同步）：
 *   GET    /api/market/skills                         多市场清单（离线缓存 + LLM 富化合并）
 *   GET    /api/market/skills/file?market=&rel=       预览市场技能的 SKILL.md
 *   POST   /api/market/sync                           {name?} git 浅克隆/拉取（缺省全部）
 *   POST   /api/market/enrich?force=1                 驱动大模型 富化，NDJSON 流式逐条推送
 *
 * admin 维度（auth:'admin'）：
 *   GET    /api/admin/skill-markets                   市场源列表
 *   POST   /api/admin/skill-markets                   {name, repo, subdir?, note?} 加源
 *   DELETE /api/admin/skill-markets/:name             删源（含本地缓存与富化缓存）
 *   POST   /api/admin/skills/install-global           {market, rel, executorId?} 全局安装
 *                                                     （落执行机 ~/.claude/skills + codex 共享链接；缺省全部执行机）
 *   DELETE /api/admin/skills/global/:name?executorId= 全局卸载
 *
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';
import type { LlmClient } from '../../agents/llm';
import {
  enrichSkillsStream,
  addMarket,
  listMarkets,
  listMarketSkills,
  marketSkillDir,
  readMarketSkillMd,
  removeMarket,
  syncMarkets,
} from '../../core/skill-market';
import {
  agentHomesFromClaudeDir,
  ensureCodexShare,
  installSkillDir,
  listGlobalSkills,
  listProjectSkills,
  readSkillFile,
  SKILL_NAME_RE,
  skillReadRoots,
  uninstallSkill,
  type AgentHomes,
  type SkillsDriver,
} from '../../core/skills';
import type { Executor, Project } from '../../core/types';
import { getProject } from '../../issues/engine';
import { json, type RouteDef } from '../middleware';
import { getExecutorById } from './executors';

export interface SkillsRoutesDeps {
  db: Database;
  /** 驱动大模型 富化用（server.ts createLlmClient 同实例，共享并发闸） */
  llm: LlmClient;
  driverForProject(project: Project): SkillsDriver;
  /** 按执行机取 Driver（admin 全局安装用）；null = 暂无可用连接 */
  driverFor(executor: Executor): SkillsDriver | null;
}

/** 执行机的 claude/codex home（claude_dir 形如 …/.claude/projects；推不出兜底控制面 home） */
function homesOf(ex: Executor | undefined): AgentHomes {
  return (
    (ex ? agentHomesFromClaudeDir(ex.claudeDir) : null) ?? {
      claudeHome: path.posix.join(homedir(), '.claude'),
      codexHome: path.posix.join(homedir(), '.codex'),
    }
  );
}

function listAllExecutors(db: Database): Executor[] {
  const ids = db.query<{ id: number }, []>('SELECT id FROM executors ORDER BY id').all();
  return ids.map((r) => getExecutorById(db, r.id)).filter((e): e is Executor => !!e);
}

/** 全局安装/卸载的目标执行机集合：executorId 指定单台，缺省全部。 */
function targetExecutors(db: Database, executorId: unknown): Executor[] | { error: string } {
  if (executorId === undefined || executorId === null || executorId === '') return listAllExecutors(db);
  const id = Number(executorId);
  if (!Number.isInteger(id) || id <= 0) return { error: 'executorId 无效' };
  const ex = getExecutorById(db, id);
  return ex ? [ex] : { error: '执行机不存在' };
}

export function skillsRoutes(deps: SkillsRoutesDeps): RouteDef[] {
  const { db, llm } = deps;

  /** 项目类 handler 公共前置 */
  function prepare(params: Record<string, string>): { project: Project; driver: SkillsDriver } | Response {
    const project = getProject(db, Number(params.projectId));
    if (!project) return json({ ok: false, error: '无此项目' }, 404);
    return { project, driver: deps.driverForProject(project) };
  }

  /** 在一台执行机的全局技能目录安装 + codex 共享链接（copy 兜底双写） */
  async function installGlobalOn(
    ex: Executor,
    srcDir: string,
    name: string,
  ): Promise<{ executor: string; ok: boolean; codexShare?: string; error?: string }> {
    const driver = deps.driverFor(ex);
    if (!driver) return { executor: ex.name, ok: false, error: '执行机不可用' };
    try {
      const homes = homesOf(ex);
      const claudeSkills = path.posix.join(homes.claudeHome, 'skills');
      const codexSkills = path.posix.join(homes.codexHome, 'skills');
      await installSkillDir(driver, srcDir, claudeSkills, name);
      const share = await ensureCodexShare(driver, codexSkills, claudeSkills);
      if (share === 'copy') await installSkillDir(driver, srcDir, codexSkills, name);
      return { executor: ex.name, ok: true, codexShare: share };
    } catch (e) {
      return { executor: ex.name, ok: false, error: String(e).slice(0, 200) };
    }
  }

  const policyRoutes: RouteDef[] = (['GET','PUT'] as const).map(method => ({
    method, path:'/api/projects/:projectId/skill-policy', auth:'project-access',
    handler: async ({req,params}) => {
      const pid=Number(params.projectId), query=new URL(req.url).searchParams;
      const mid=Number(query.get('moduleId') ?? 0), iid=Number(query.get('issueId') ?? 0);
      if (![pid,mid,iid].every(Number.isSafeInteger) || pid<=0 || mid<0 || iid<0 || (mid && iid)) return json({ok:false,error:'Invalid policy scope'},400);
      if (mid && !db.query('SELECT id FROM project_modules WHERE id=? AND project_id=?').get(mid,pid)) return json({ok:false,error:'Module not found'},404);
      const issue=iid ? db.query<{module_id:number|null},[number,number]>('SELECT module_id FROM issues WHERE id=? AND project_id=?').get(iid,pid) : null;
      if (iid && !issue) return json({ok:false,error:'Issue not found'},404);
      const scope={projectId:pid,moduleId:mid || undefined,issueId:iid || undefined};
      try {
        if (method==='PUT') saveSkillPolicy(db,scope,await req.json());
        return json({ok:true,policy:readSkillPolicy(db,scope),effective:effectiveSkillPolicy(db,{...scope,moduleId:mid || issue?.module_id || undefined}),applies:'next-session'});
      } catch(e) { return json({ok:false,error:String(e).slice(0,200)},400); }
    },
  }));
  return [
    ...policyRoutes,
    // ---------- 项目维度 ----------
    {
      method: 'GET',
      path: '/api/projects/:projectId/skills',
      auth: 'project-access',
      handler: async ({ params }) => {
        const c = prepare(params);
        if (c instanceof Response) return c;
        try {
          const homes = homesOf(getExecutorById(db, c.project.executorId));
          const [global, project] = await Promise.all([
            listGlobalSkills(c.driver, homes),
            listProjectSkills(c.driver, c.project.cwd),
          ]);
          return json({ ok: true, cwd: c.project.cwd, global, project });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/skills/file',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepare(params);
        if (c instanceof Response) return c;
        const reqPath = url.searchParams.get('path') ?? '';
        if (!reqPath) return json({ ok: false, error: '缺 path' }, 400);
        const homes = homesOf(getExecutorById(db, c.project.executorId));
        const r = await readSkillFile(c.driver, skillReadRoots(c.project.cwd, homes), reqPath);
        return json(r, r.ok ? 200 : 400);
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/skills/install',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const c = prepare(params);
        if (c instanceof Response) return c;
        const body = (await req.json().catch(() => null)) as { market?: unknown; rel?: unknown } | null;
        if (!body || typeof body.market !== 'string' || typeof body.rel !== 'string') {
          return json({ ok: false, error: '需要 {market, rel}' }, 400);
        }
        const loc = marketSkillDir(db, body.market, body.rel);
        if (!loc.ok || !loc.dir || !loc.name) return json({ ok: false, error: loc.error }, 400);
        if (!SKILL_NAME_RE.test(loc.name)) return json({ ok: false, error: '非法技能名' }, 400);
        try {
          const claudeSkills = path.posix.join(c.project.cwd, '.claude', 'skills');
          const codexSkills = path.posix.join(c.project.cwd, '.codex', 'skills');
          const r = await installSkillDir(c.driver, loc.dir, claudeSkills, loc.name);
          // 项目内用相对链接：仓库整体挪位置/多人 clone 布局不同也不断
          const share = await ensureCodexShare(c.driver, codexSkills, '../.claude/skills');
          if (share === 'copy') await installSkillDir(c.driver, loc.dir, codexSkills, loc.name);
          return json({ ok: true, name: loc.name, files: r.files, codexShare: share });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'DELETE',
      path: '/api/projects/:projectId/skills/:name',
      auth: 'project-access',
      handler: async ({ params }) => {
        const c = prepare(params);
        if (c instanceof Response) return c;
        const name = params.name ?? '';
        if (!SKILL_NAME_RE.test(name)) return json({ ok: false, error: '非法技能名' }, 400);
        try {
          await uninstallSkill(
            c.driver,
            path.posix.join(c.project.cwd, '.claude', 'skills'),
            path.posix.join(c.project.cwd, '.codex', 'skills'),
            name,
          );
          return json({ ok: true });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },

    // ---------- 市场浏览 ----------
    {
      method: 'GET',
      path: '/api/market/skills',
      auth: 'user',
      handler: () => json(listMarketSkills(db)),
    },
    {
      method: 'GET',
      path: '/api/market/skills/file',
      auth: 'user',
      handler: ({ url }) => {
        const r = readMarketSkillMd(
          db,
          url.searchParams.get('market') ?? '',
          url.searchParams.get('rel') ?? '',
        );
        return json(r, r.ok ? 200 : 400);
      },
    },
    {
      method: 'POST',
      path: '/api/market/sync',
      auth: 'user',
      handler: async ({ req }) => {
        const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
        const only = typeof body?.name === 'string' && body.name ? body.name : undefined;
        const r = await syncMarkets(db, only ? { only } : {});
        return json(r, r.ok ? 200 : 502);
      },
    },
    {
      method: 'POST',
      path: '/api/market/enrich',
      auth: 'user',
      handler: ({ url }) => {
        const force = url.searchParams.get('force') === '1';
        const gen = enrichSkillsStream(db, llm, { force });
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { value, done } = await gen.next();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(enc.encode(`${JSON.stringify(value)}\n`));
          },
          cancel() {
            void gen.return(undefined); // 客户端断流即停，不再烧 token
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no', // nginx 别缓冲，逐条实时到前端
          },
        });
      },
    },

    // ---------- admin：市场源管理 ----------
    {
      method: 'GET',
      path: '/api/admin/skill-markets',
      auth: 'admin',
      handler: () => json({ ok: true, markets: listMarkets(db) }),
    },
    {
      method: 'POST',
      path: '/api/admin/skill-markets',
      auth: 'admin',
      handler: async ({ req }) => {
        const body = (await req.json().catch(() => null)) as {
          name?: unknown;
          repo?: unknown;
          subdir?: unknown;
          note?: unknown;
        } | null;
        if (!body || typeof body.name !== 'string' || typeof body.repo !== 'string') {
          return json({ ok: false, error: '需要 {name, repo}' }, 400);
        }
        const r = addMarket(db, {
          name: body.name,
          repo: body.repo,
          subdir: typeof body.subdir === 'string' ? body.subdir : '',
          note: typeof body.note === 'string' ? body.note : '',
        });
        return json(r, r.ok ? 200 : 400);
      },
    },
    {
      method: 'DELETE',
      path: '/api/admin/skill-markets/:name',
      auth: 'admin',
      handler: ({ params }) => {
        const r = removeMarket(db, params.name ?? '');
        return json(r, r.ok ? 200 : 400);
      },
    },

    // ---------- admin：全局安装 / 卸载 ----------
    {
      method: 'POST',
      path: '/api/admin/skills/install-global',
      auth: 'admin',
      handler: async ({ req }) => {
        const body = (await req.json().catch(() => null)) as {
          market?: unknown;
          rel?: unknown;
          executorId?: unknown;
        } | null;
        if (!body || typeof body.market !== 'string' || typeof body.rel !== 'string') {
          return json({ ok: false, error: '需要 {market, rel}' }, 400);
        }
        const loc = marketSkillDir(db, body.market, body.rel);
        if (!loc.ok || !loc.dir || !loc.name) return json({ ok: false, error: loc.error }, 400);
        if (!SKILL_NAME_RE.test(loc.name)) return json({ ok: false, error: '非法技能名' }, 400);
        const targets = targetExecutors(db, body.executorId);
        if ('error' in targets) return json({ ok: false, error: targets.error }, 400);
        if (targets.length === 0) return json({ ok: false, error: '无执行机' }, 400);
        const results = [];
        for (const ex of targets) results.push(await installGlobalOn(ex, loc.dir!, loc.name!));
        return json({ ok: results.some((r) => r.ok), name: loc.name, results });
      },
    },
    {
      method: 'DELETE',
      path: '/api/admin/skills/global/:name',
      auth: 'admin',
      handler: async ({ url, params }) => {
        const name = params.name ?? '';
        if (!SKILL_NAME_RE.test(name)) return json({ ok: false, error: '非法技能名' }, 400);
        const targets = targetExecutors(db, url.searchParams.get('executorId') ?? undefined);
        if ('error' in targets) return json({ ok: false, error: targets.error }, 400);
        const results = [];
        for (const ex of targets) {
          const driver = deps.driverFor(ex);
          if (!driver) {
            results.push({ executor: ex.name, ok: false, error: '执行机不可用' });
            continue;
          }
          try {
            const homes = homesOf(ex);
            await uninstallSkill(
              driver,
              path.posix.join(homes.claudeHome, 'skills'),
              path.posix.join(homes.codexHome, 'skills'),
              name,
            );
            results.push({ executor: ex.name, ok: true });
          } catch (e) {
            results.push({ executor: ex.name, ok: false, error: String(e).slice(0, 200) });
          }
        }
        return json({ ok: results.some((r) => r.ok), results });
      },
    },
  ];
}
