/**
 * web/routes/admin —— admin 后台 API（spec §7；v1 web.ts admin 块平移入库）。
 * - 用户 CRUD + token 重置（明文一次）+ 每用户设定代编
 *   （列表另带活跃统计：最近使用时间 last_seen_ts + 今天/总任务数 + 今天/总消息数，见 core/activity）
 * - 执行机 CRUD（host/port/ssh_user/key_ref/workspace_root/claude_dir）
 * - 项目归属调整（v2 一律 DB 显式归属，v1 属主推断链已废）
 * - 活跃概览（last_login + 项目数）
 * 建用户时经注入的 Driver（writeFile）在每台执行机上建 workspace 目录；
 * 失败不静默——收进响应 warnings（评审铁律：任何失败要么上抛要么可见）。
 * 全部路由 auth:'admin'；只 export 定义，注册由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import { posix } from 'node:path';
import { safeLlmConfig, saveLlmConfig } from '../../agents/llm';
import { activityStatsByUser } from '../../core/activity';
import {
  executorAgentReferences,
  getExecutor,
  listExecutors,
  mapExecutor,
  type ExecutorRow,
} from '../../core/executors';
import { SessionStore } from '../../core/sessions';
import type { Executor, UserRole } from '../../core/types';
import { detectExecutorCapabilities } from '../../executor/discovery';
import type { ExecutorDriver } from '../../executor/driver';
import { MAX_LIST_ENTRIES } from '../../core/files';
import {
  provisionUserWorkspace,
  USERNAME_RE,
  type UserStore,
} from '../../core/users';
import { UsageStore, type UsageBucket } from '../../core/usage-store';
import { costOf } from '../../core/usage';
import { weeklyReport } from '../../core/usage-weekly';
import { IssueStore } from '../../issues/engine';
import { json, type RouteDef } from '../middleware';
import { parseSettingsBody } from './me';

export interface AdminRoutesDeps {
  db: Database;
  users: UserStore;
  /**
   * 为某台执行机构造 Driver（生产 = SshDriver 连接池；测试 = LocalDriver 指向临时目录）。
   * 返回 null = 该执行机暂无可用连接（建用户时记 warning，不阻塞）。
   */
  driverFor(executor: Executor): ExecutorDriver | null;
  /**
   * 为尚未保存的执行机草稿构造一次性 Driver。生产不得放进按 executor id 缓存的连接池，
   * 以免多个草稿共用错误连接；缺省回退 driverFor 仅供轻量测试装配。
   */
  previewDriverFor?(executor: Executor): ExecutorDriver | null;
  /**
   * M5：执行机登记信息变更（PATCH）/删除（DELETE）后回调——server 用它失效 Driver 池里
   * 该执行机的缓存连接，下次使用按新配置懒建（热加载，不用重启）。新建（POST）无需回调：
   * 新 id 池里本无缓存，天然懒建可见。
   */
  onExecutorChanged?(executorId: number): void;
}

// ---------- 小工具 ----------

/** 面向 UI 的安全用户视图（绝不含 token_hash） */
function safeUser(u: {
  id: number;
  username: string;
  role: string;
  feishuOpenid: string | null;
  createdTs: number;
  lastLoginTs: number | null;
  lastSeenTs?: number | null;
}) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    feishuOpenid: u.feishuOpenid,
    createdTs: u.createdTs,
    lastLoginTs: u.lastLoginTs,
    // 最近使用时间（012）：认证链每次成功认证 touch（写库 5min 节流），比「上次登录」更能反映活跃
    lastSeenTs: u.lastSeenTs ?? null,
  };
}

function idParam(params: Record<string, string>): number | null {
  const n = Number(params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  return typeof o[key] === 'string' && (o[key] as string).length > 0 ? (o[key] as string) : undefined;
}

function normalizedAbsolute(value: string): boolean {
  return posix.isAbsolute(value) && posix.normalize(value) === value;
}

function previewExecutor(body: Record<string, unknown>): Executor | string {
  const host = str(body, 'host') ?? '127.0.0.1';
  const port = body.port === undefined ? 22 : Number(body.port);
  const suppliedKeyRef = str(body, 'keyRef');
  const local = (host === '127.0.0.1' || host === 'localhost') && suppliedKeyRef === undefined;
  const sshUser = str(body, 'sshUser') ?? (local ? '' : undefined);
  const keyRef = suppliedKeyRef ?? (local ? '' : undefined);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port 必须是 1-65535 的整数';
  if (sshUser === undefined || keyRef === undefined) return '远程执行机需要 SSH 用户和私钥路径或引用名';
  return {
    id: 0,
    name: str(body, 'name') ?? 'preview',
    host,
    port,
    sshUser,
    keyRef,
    workspaceRoot: typeof body.workspaceRoot === 'string' ? body.workspaceRoot : '',
    claudeDir: typeof body.claudeDir === 'string' ? body.claudeDir : '',
    codexDir: typeof body.codexDir === 'string' ? body.codexDir : '',
    supportsClaude: true,
    supportsCodex: true,
    isSystemLocal: local,
    capabilitiesCheckedTs: null,
    status: 'unknown',
  };
}

async function closePreviewDriver(driver: ExecutorDriver): Promise<void> {
  await Promise.resolve((driver as { close?: () => Promise<void> | void }).close?.()).catch(() => {});
}

// ---------- 路由 ----------

export function adminRoutes(deps: AdminRoutesDeps): RouteDef[] {
  const { db, users } = deps;

  return [
    // ===== 成本视图（#282 / I-08、I-09；仅管理员，跨所有项目） =====
    {
      /**
       * 三档聚合：项目 / issue / 「非 Issue 会话」。
       *
       * 时间窗（from/to）**只作用于 issue 档**（按 issue 创建时间筛）：项目与会话档的用量是
       * 按会话累计的，表里没有按时间分桶的数据，硬按 `updated_ts`（最后一次扫描时刻）过滤
       * 只会给出一个看起来精确的错数。响应里用 `windowAppliesTo` 明说这件事，别让人误读。
       */
      method: 'GET',
      path: '/api/admin/usage',
      auth: 'admin',
      handler: ({ url }) => {
        const usage = new UsageStore(db);
        const issues = new IssueStore(db);
        const num = (key: string): number | undefined => {
          const raw = url.searchParams.get(key);
          const n = raw === null ? Number.NaN : Number(raw);
          return Number.isFinite(n) ? n : undefined;
        };
        const projectId = num('projectId');
        const from = num('from');
        const to = num('to');
        const limit = Math.min(Math.max(num('limit') ?? 100, 1), 500);

        const names = new Map<number, string>();
        for (const p of db.query<{ id: number; name: string }, []>('SELECT id, name FROM projects').all()) {
          names.set(p.id, p.name);
        }
        const pricing = usage.pricing();
        const named = <T extends UsageBucket>(rows: T[]): Array<T & { projectName: string; costUsd: number }> =>
          rows
            .filter((r) => projectId === undefined || r.projectId === projectId)
            .map((r) => ({ ...r, projectName: names.get(r.projectId) ?? '', costUsd: costOf(r, pricing) }));

        const meta = new Map<number, { projectId: number; title: string; status: string; createdTs: number }>();
        for (const row of db
          .query<{ id: number; project_id: number; title: string; status: string; created_ts: number }, []>(
            'SELECT id, project_id, title, status, created_ts FROM issues',
          )
          .all()) {
          meta.set(row.id, {
            projectId: row.project_id, title: row.title, status: row.status, createdTs: row.created_ts,
          });
        }

        const issueRows = usage
          .listIssueUsage(projectId)
          .flatMap((bucket) => {
            const info = bucket.issueId === undefined ? undefined : meta.get(bucket.issueId);
            if (!info) return [];
            if (from !== undefined && info.createdTs < from) return [];
            if (to !== undefined && info.createdTs > to) return [];
            const stats = issues.issueCostStats(bucket.issueId!);
            return [{
              issueId: bucket.issueId!,
              projectId: info.projectId,
              projectName: names.get(info.projectId) ?? '',
              title: info.title,
              status: info.status,
              createdTs: info.createdTs,
              usage: stats.usage,
              testRetries: stats.testRetries,
              nudges: stats.nudges,
              judged: stats.judged,
              clarifies: stats.clarifies,
              validationMs: stats.validationMs,
              validationRuns: stats.validationRuns,
              costUsd: costOf(stats.usage, pricing),
            }];
          })
          .slice(0, limit);

        return json({
          ok: true,
          window: {
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            // 时间窗只筛 issue 档；项目/会话档是累计值
            windowAppliesTo: 'issues',
          },
          pricing,
          grand: usage.grandTotal(),
          grandCostUsd: costOf(usage.grandTotal(), pricing),
          projects: named(usage.listProjectUsage()),
          chat: named(usage.listChatUsage()),
          unattributed: named(usage.unattributedByProject()),
          issues: issueRows,
        });
      },
    },

    {
      /**
       * 周度视图（#295）：按模块把「钱」和「完成 / 失败 / 恢复」并排放，
       * 回答 #282 设埋点的初衷问题——**只优化 token，有没有把可靠性一起优化没了**。
       *
       * 与上面那个累计口径的 `/api/admin/usage` 不同，本条**真的按时间分桶**（065 的
       * `usage_daily`），所以周区间是实打实的筛选，不需要再声明 `windowAppliesTo`。
       * 口径（北京时间日切、周一起算、失败率/恢复率的分母）统一在 core/usage-weekly 的
       * 文件头，这里只做参数解析与项目名拼接，别在这一层再算一遍。
       *
       * `weekStart` 收周内任意一天的日键（`YYYY-MM-DD`），内部归一到那一周的周一；
       * 缺省 = 现在所在那一周。格式不对直接 400——静默回退到本周会让人对着错的一周做决策。
       */
      method: 'GET',
      path: '/api/admin/usage/weekly',
      auth: 'admin',
      handler: ({ url }) => {
        const rawWeek = url.searchParams.get('weekStart');
        if (rawWeek !== null && !/^\d{4}-\d{2}-\d{2}$/.test(rawWeek)) {
          return json({ ok: false, error: 'weekStart 必须是 YYYY-MM-DD' }, 400);
        }
        const rawProject = url.searchParams.get('projectId');
        const projectId = rawProject === null ? undefined : Number(rawProject);
        if (projectId !== undefined && !Number.isFinite(projectId)) {
          return json({ ok: false, error: 'projectId 必须是数字' }, 400);
        }

        const report = weeklyReport(db, {
          ...(rawWeek === null ? {} : { week: rawWeek }),
          ...(projectId === undefined ? {} : { projectId }),
        });

        const names = new Map<number, string>();
        for (const p of db.query<{ id: number; name: string }, []>('SELECT id, name FROM projects').all()) {
          names.set(p.id, p.name);
        }
        return json({
          ok: true,
          ...(projectId === undefined ? {} : { projectId }),
          week: report.week,
          pricing: report.pricing,
          days: report.days,
          modules: report.modules.map((m) => ({ ...m, projectName: names.get(m.projectId) ?? '' })),
          totals: report.totals,
        });
      },
    },

    {
      /** 单价表（#282 / Q2）：后台可配，绝不写死在代码里 */
      method: 'GET',
      path: '/api/admin/usage/pricing',
      auth: 'admin',
      handler: () => json({ ok: true, pricing: new UsageStore(db).pricing() }),
    },
    {
      method: 'PUT',
      path: '/api/admin/usage/pricing',
      auth: 'admin',
      handler: async ({ req }) => {
        const b = await req.json().catch(() => ({})) as Record<string, unknown>;
        const store = new UsageStore(db);
        const cur = store.pricing();
        const num = (key: string, fallback: number): number =>
          typeof b[key] === 'number' && Number.isFinite(b[key] as number) ? (b[key] as number) : fallback;
        try {
          return json({
            ok: true,
            pricing: store.setPricing({
              currency: typeof b.currency === 'string' && b.currency.trim() ? b.currency.trim() : cur.currency,
              inputPerMTok: num('inputPerMTok', cur.inputPerMTok),
              cachedInputPerMTok: num('cachedInputPerMTok', cur.cachedInputPerMTok),
              outputPerMTok: num('outputPerMTok', cur.outputPerMTok),
              reasoningPerMTok: num('reasoningPerMTok', cur.reasoningPerMTok),
            }),
          });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 400);
        }
      },
    },
    {
      /**
       * 回扫（#282 / Q3）：把游标与累计清零，下一轮采集从头重算——历史回填与基线对齐都靠它。
       * 同时清 issue_usage（那张表是累加的，不清就会重复计数）。
       */
      method: 'POST',
      path: '/api/admin/usage/rescan',
      auth: 'admin',
      handler: async ({ req }) => {
        const b = await req.json().catch(() => ({})) as Record<string, unknown>;
        const projectId = typeof b.projectId === 'number' && Number.isFinite(b.projectId) ? b.projectId : undefined;
        const reset = new UsageStore(db).resetScan(projectId);
        return json({ ok: true, reset });
      },
    },

    // ===== 驱动大模型配置 =====
    {
      method: 'GET',
      path: '/api/admin/llm-config',
      auth: 'admin',
      handler: () => json(safeLlmConfig(db)),
    },
    {
      method: 'PUT',
      path: '/api/admin/llm-config',
      auth: 'admin',
      handler: async ({ req }) => {
        const b = await readBody(req);
        if (typeof b.baseUrl !== 'string' || typeof b.model !== 'string') {
          return json({ ok: false, error: '接口地址和模型名称必须是字符串' }, 400);
        }
        const baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
        const model = b.model.trim();
        if (baseUrl) {
          try {
            const url = new URL(baseUrl);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
          } catch {
            return json({ ok: false, error: '接口地址必须是有效的 http(s) URL' }, 400);
          }
        }
        const replacementKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
        const clearApiKey = b.clearApiKey === true;
        if (clearApiKey && replacementKey) {
          return json({ ok: false, error: '不能同时清除并设置 API Key' }, 400);
        }
        saveLlmConfig(db, {
          baseUrl,
          model,
          ...(clearApiKey ? { apiKey: '' } : replacementKey ? { apiKey: replacementKey } : {}),
        });
        return json({ ok: true, config: safeLlmConfig(db) });
      },
    },

    // ===== 用户 CRUD =====
    {
      method: 'GET',
      path: '/api/admin/users',
      auth: 'admin',
      handler: () => {
        // 统计列（issue #102）：任务数按 issues.created_by 归属，消息数取 013 计数表，
        // 「今天」按 Asia/Shanghai 日切（见 core/activity）。一次取齐，缺记录的用户全 0。
        const stats = activityStatsByUser(db);
        return json(
          users.list().map((u) => {
            const s = stats.get(u.id);
            return {
              ...safeUser(u),
              todayTasks: s?.todayTasks ?? 0,
              totalTasks: s?.totalTasks ?? 0,
              todayMessages: s?.todayMessages ?? 0,
              totalMessages: s?.totalMessages ?? 0,
            };
          }),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/admin/users',
      auth: 'admin',
      handler: async ({ req }) => {
        const b = await readBody(req);
        const username = typeof b.username === 'string' ? b.username : '';
        if (!USERNAME_RE.test(username)) {
          return json({ ok: false, error: '用户名只能用字母数字 _ -（1-40 位）' }, 400);
        }
        if (users.byUsername(username)) return json({ ok: false, error: '用户名已存在' }, 400);
        const role: UserRole = b.role === 'admin' ? 'admin' : 'user';
        const created = users.create(username, role);

        // 每台执行机建 workspace（u<id> 目录）；失败进 warnings，不静默
        const provisioned: string[] = [];
        const warnings: string[] = [];
        for (const ex of listExecutors(db)) {
          const driver = deps.driverFor(ex);
          if (!driver) {
            warnings.push(`${ex.name}: 无可用 driver，workspace 未创建`);
            continue;
          }
          try {
            provisioned.push(`${ex.name}:${await provisionUserWorkspace(driver, ex.workspaceRoot, created.user)}`);
          } catch (e) {
            warnings.push(`${ex.name}: ${String(e)}`);
          }
        }
        // token 明文仅此一次返回（UI 标「仅显示一次」）
        return json({
          ok: true,
          user: safeUser(created.user),
          token: created.token,
          workspace: { provisioned, warnings },
        });
      },
    },
    {
      method: 'PATCH',
      path: '/api/admin/users/:id',
      auth: 'admin',
      handler: async ({ req, params }) => {
        const id = idParam(params);
        const u = id ? users.byId(id) : undefined;
        if (!id || !u) return json({ ok: false, error: '无此用户' }, 404);
        const b = await readBody(req);
        if (typeof b.username === 'string') {
          if (!USERNAME_RE.test(b.username)) {
            return json({ ok: false, error: '用户名只能用字母数字 _ -（1-40 位）' }, 400);
          }
          const other = users.byUsername(b.username);
          if (other && other.id !== id) return json({ ok: false, error: '用户名已存在' }, 400);
          users.rename(id, b.username);
        }
        if (b.role === 'admin' || b.role === 'user') {
          if (u.role === 'admin' && b.role === 'user' && users.countAdmins() <= 1) {
            return json({ ok: false, error: '不能降级最后一个 admin' }, 400);
          }
          users.setRole(id, b.role);
        }
        return json({ ok: true, user: safeUser(users.byId(id)!) });
      },
    },
    {
      method: 'DELETE',
      path: '/api/admin/users/:id',
      auth: 'admin',
      handler: ({ params }) => {
        const id = idParam(params);
        const u = id ? users.byId(id) : undefined;
        if (!id || !u) return json({ ok: false, error: '无此用户' }, 404);
        if (u.role === 'admin' && users.countAdmins() <= 1) {
          return json({ ok: false, error: '不能删最后一个 admin' }, 400);
        }
        try {
          users.remove(id);
        } catch {
          // 外键约束：projects/issues/sessions 仍引用（默认安全，先转移归属）
          return json({ ok: false, error: '该用户名下还有项目/数据，先调整归属再删' }, 400);
        }
        return json({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/admin/users/:id/token',
      auth: 'admin',
      handler: ({ params }) => {
        const id = idParam(params);
        const token = id ? users.resetToken(id) : null;
        if (!token) return json({ ok: false, error: '无此用户' }, 404);
        // 重置即吊销：飞书扫码签发的登录会话一并失效（重置常用于踢人/换钥匙）
        new SessionStore(db).revokeForUser(id!);
        // 明文仅此一次
        return json({ ok: true, token });
      },
    },

    // ===== 每用户设定代编（persona/memory/autopilot 默认） =====
    {
      method: 'GET',
      path: '/api/admin/users/:id/settings',
      auth: 'admin',
      handler: ({ params }) => {
        const id = idParam(params);
        if (!id || !users.byId(id)) return json({ ok: false, error: '无此用户' }, 404);
        return json(users.getSettings(id));
      },
    },
    {
      method: 'PUT',
      path: '/api/admin/users/:id/settings',
      auth: 'admin',
      handler: async ({ req, params }) => {
        const id = idParam(params);
        if (!id || !users.byId(id)) return json({ ok: false, error: '无此用户' }, 404);
        const parsed = parseSettingsBody(await req.json().catch(() => null));
        if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
        return json({ ok: true, settings: users.putSettings(id, parsed.patch) });
      },
    },

    // ===== 执行机 CRUD =====
    {
      method: 'GET',
      path: '/api/admin/executors',
      auth: 'admin',
      handler: () => json(listExecutors(db)),
    },
    {
      method: 'POST',
      path: '/api/admin/executors/preview/detect',
      auth: 'admin',
      handler: async ({ req }) => {
        const body = await readBody(req);
        const draft = previewExecutor(body);
        if (typeof draft === 'string') return json({ ok: false, error: draft }, 400);
        const driver = (deps.previewDriverFor ?? deps.driverFor)(draft);
        if (!driver) return json({ ok: false, error: '执行机连接不可用' }, 502);
        try {
          return json({ ok: true, detection: await detectExecutorCapabilities(draft, driver) });
        } catch (error) {
          return json(
            {
              ok: false,
              error: `执行机探测失败: ${error instanceof Error ? error.message : String(error)}`,
            },
            502,
          );
        } finally {
          if (deps.previewDriverFor) await closePreviewDriver(driver);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/admin/executors/preview/fs',
      auth: 'admin',
      handler: async ({ req }) => {
        const body = await readBody(req);
        const draft = previewExecutor(body);
        if (typeof draft === 'string') return json({ ok: false, error: draft }, 400);
        const rawPath = typeof body.path === 'string' && body.path.length > 0 ? body.path : '/';
        if (!normalizedAbsolute(rawPath)) return json({ ok: false, error: 'path 必须是规范化绝对路径' }, 400);
        const driver = (deps.previewDriverFor ?? deps.driverFor)(draft);
        if (!driver) return json({ ok: false, error: '执行机连接不可用' }, 502);
        try {
          const stat = await driver.statPath(rawPath);
          if (!stat) return json({ ok: true, path: rawPath, root: '/', dirs: [], missing: true });
          if (!stat.isDirectory) return json({ ok: false, error: '不是目录' }, 400);
          const all = (await driver.listDir(rawPath))
            .filter((entry) => entry.type === 'dir')
            .map((entry) => entry.name)
            .sort((a, b) => {
              const hidden = Number(a.startsWith('.')) - Number(b.startsWith('.'));
              return hidden || a.localeCompare(b);
            });
          return json({
            ok: true,
            path: rawPath,
            root: '/',
            dirs: all.slice(0, MAX_LIST_ENTRIES),
            ...(all.length > MAX_LIST_ENTRIES ? { truncated: true } : {}),
          });
        } catch (error) {
          return json(
            {
              ok: false,
              error: `读取目录失败: ${error instanceof Error ? error.message : String(error)}`,
            },
            502,
          );
        } finally {
          if (deps.previewDriverFor) await closePreviewDriver(driver);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/admin/executors',
      auth: 'admin',
      handler: async ({ req }) => {
        const b = await readBody(req);
        const name = str(b, 'name');
        const host = str(b, 'host') ?? '127.0.0.1'; // host 不填 = 本机执行机
        const workspaceRoot = str(b, 'workspaceRoot');
        const claudeDir = str(b, 'claudeDir');
        const codexDir = str(b, 'codexDir') ?? '';
        const supportsClaude = b.supportsClaude === undefined ? true : b.supportsClaude === true;
        const supportsCodex =
          b.supportsCodex === undefined ? codexDir.length > 0 : b.supportsCodex === true;
        if (
          (b.supportsClaude !== undefined && typeof b.supportsClaude !== 'boolean') ||
          (b.supportsCodex !== undefined && typeof b.supportsCodex !== 'boolean')
        ) {
          return json({ ok: false, error: 'supportsClaude/supportsCodex 必须是布尔值' }, 400);
        }
        if (
          b.capabilitiesCheckedTs !== undefined &&
          (typeof b.capabilitiesCheckedTs !== 'number' ||
            !Number.isSafeInteger(b.capabilitiesCheckedTs) ||
            b.capabilitiesCheckedTs < 0)
        ) {
          return json({ ok: false, error: 'capabilitiesCheckedTs 必须是非负整数' }, 400);
        }
        const port = b.port === undefined ? 22 : Number(b.port);
        // 本机执行机（server buildDriver：host 为 127.0.0.1/localhost 且 keyRef 为空 → LocalDriver）
        // 不需要 SSH 凭据，sshUser/keyRef 允许省略；远程执行机二者必填。
        const isLocalHost = host === '127.0.0.1' || host === 'localhost';
        const sshUser = str(b, 'sshUser') ?? (isLocalHost ? '' : undefined);
        const keyRef = str(b, 'keyRef') ?? (isLocalHost ? '' : undefined);
        if (
          !name ||
          sshUser === undefined ||
          keyRef === undefined ||
          !workspaceRoot ||
          (!supportsClaude && !supportsCodex) ||
          (supportsClaude && !claudeDir) ||
          (supportsCodex && !codexDir)
        ) {
          return json(
            {
              ok: false,
              error:
                'name/workspaceRoot 必填且至少启用一个 Agent；启用 Claude/Codex 时对应目录必填；非本机 host 还需 sshUser/keyRef',
            },
            400,
          );
        }
        if (
          !normalizedAbsolute(workspaceRoot) ||
          (supportsClaude && !normalizedAbsolute(claudeDir!)) ||
          (supportsCodex && !normalizedAbsolute(codexDir))
        ) {
          return json({ ok: false, error: 'workspace 与已启用 Agent 目录必须是规范化绝对路径' }, 400);
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return json({ ok: false, error: 'port 必须是 1-65535 的整数' }, 400);
        }
        const row = db
          .query<
            ExecutorRow,
            [string, string, number, string, string, string, string, string, number, number, number | null]
          >(
            `INSERT INTO executors
               (name, host, port, ssh_user, key_ref, workspace_root, claude_dir, codex_dir,
                supports_claude, supports_codex, capabilities_checked_ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .get(
            name,
            host,
            port,
            sshUser,
            keyRef,
            workspaceRoot,
            claudeDir ?? '',
            codexDir,
            supportsClaude ? 1 : 0,
            supportsCodex ? 1 : 0,
            typeof b.capabilitiesCheckedTs === 'number' ? b.capabilitiesCheckedTs : null,
          );
        if (!row) return json({ ok: false, error: '创建失败' }, 500);
        return json({ ok: true, executor: mapExecutor(row) });
      },
    },
    {
      method: 'PATCH',
      path: '/api/admin/executors/:id',
      auth: 'admin',
      handler: async ({ req, params }) => {
        const id = idParam(params);
        const existing = id ? getExecutor(db, id) : undefined;
        if (!id || !existing) return json({ ok: false, error: '无此执行机' }, 404);
        const b = await readBody(req);
        if (
          existing.isSystemLocal &&
          ['host', 'port', 'sshUser', 'keyRef'].some((key) => b[key] !== undefined)
        ) {
          return json({ ok: false, error: '系统本机执行机不能改成远程连接' }, 409);
        }
        const sets: string[] = [];
        const vals: (string | number | null)[] = [];
        if (
          (b.supportsClaude !== undefined && typeof b.supportsClaude !== 'boolean') ||
          (b.supportsCodex !== undefined && typeof b.supportsCodex !== 'boolean')
        ) {
          return json({ ok: false, error: 'supportsClaude/supportsCodex 必须是布尔值' }, 400);
        }
        if (
          b.capabilitiesCheckedTs !== undefined &&
          b.capabilitiesCheckedTs !== null &&
          (typeof b.capabilitiesCheckedTs !== 'number' ||
            !Number.isSafeInteger(b.capabilitiesCheckedTs) ||
            b.capabilitiesCheckedTs < 0)
        ) {
          return json({ ok: false, error: 'capabilitiesCheckedTs 必须是非负整数或 null' }, 400);
        }
        const nextClaude =
          typeof b.supportsClaude === 'boolean' ? b.supportsClaude : existing.supportsClaude;
        const nextCodex =
          typeof b.supportsCodex === 'boolean' ? b.supportsCodex : existing.supportsCodex;
        const nextWorkspace = str(b, 'workspaceRoot') ?? existing.workspaceRoot;
        const nextClaudeDir = str(b, 'claudeDir') ?? existing.claudeDir;
        const nextCodexDir = str(b, 'codexDir') ?? existing.codexDir;
        if (!nextClaude && !nextCodex) {
          return json({ ok: false, error: '至少启用一个 Agent' }, 400);
        }
        if (
          !normalizedAbsolute(nextWorkspace) ||
          (nextClaude && !normalizedAbsolute(nextClaudeDir)) ||
          (nextCodex && !normalizedAbsolute(nextCodexDir))
        ) {
          return json({ ok: false, error: 'workspace 与已启用 Agent 目录必须是规范化绝对路径' }, 400);
        }
        for (const [agent, was, next] of [
          ['claude', existing.supportsClaude, nextClaude],
          ['codex', existing.supportsCodex, nextCodex],
        ] as const) {
          if (!was || next) continue;
          const references = executorAgentReferences(db, id, agent);
          if (references.issues || references.modules || references.conversations) {
            const label = agent === 'claude' ? 'Claude' : 'Codex';
            return json(
              { ok: false, error: `该执行机仍有内容使用 ${label}，不能取消`, references },
              409,
            );
          }
        }
        const strFields: Array<[string, string]> = [
          ['name', 'name'],
          ['host', 'host'],
          ['sshUser', 'ssh_user'],
          ['keyRef', 'key_ref'],
          ['workspaceRoot', 'workspace_root'],
          ['claudeDir', 'claude_dir'],
          ['codexDir', 'codex_dir'],
        ];
        for (const [key, col] of strFields) {
          const v = str(b, key);
          if (v !== undefined) {
            sets.push(`${col} = ?`);
            vals.push(v);
          }
        }
        if (typeof b.supportsClaude === 'boolean') {
          sets.push('supports_claude = ?');
          vals.push(b.supportsClaude ? 1 : 0);
        }
        if (typeof b.supportsCodex === 'boolean') {
          sets.push('supports_codex = ?');
          vals.push(b.supportsCodex ? 1 : 0);
        }
        if (b.capabilitiesCheckedTs === null || typeof b.capabilitiesCheckedTs === 'number') {
          sets.push('capabilities_checked_ts = ?');
          vals.push(b.capabilitiesCheckedTs as number | null);
        }
        if (b.port !== undefined) {
          const port = Number(b.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return json({ ok: false, error: 'port 必须是 1-65535 的整数' }, 400);
          }
          sets.push('port = ?');
          vals.push(port);
        }
        if (sets.length === 0) return json({ ok: false, error: '没有可更新的字段' }, 400);
        db.query(`UPDATE executors SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
        deps.onExecutorChanged?.(id); // M5：连接参数可能变了，失效池内旧 Driver
        return json({ ok: true, executor: getExecutor(db, id) });
      },
    },
    {
      method: 'POST',
      path: '/api/admin/executors/:id/detect',
      auth: 'admin',
      handler: async ({ req, params }) => {
        const id = idParam(params);
        const existing = id ? getExecutor(db, id) : undefined;
        if (!id || !existing) return json({ ok: false, error: '无此执行机' }, 404);
        const driver = deps.driverFor(existing);
        if (!driver) return json({ ok: false, error: '执行机连接不可用' }, 502);
        const b = await readBody(req);
        const current = { ...existing };
        for (const key of ['workspaceRoot', 'claudeDir', 'codexDir'] as const) {
          if (b[key] === undefined) continue;
          if (typeof b[key] !== 'string' || !posix.isAbsolute(b[key] as string)) {
            return json({ ok: false, error: `${key} 必须是绝对路径` }, 400);
          }
          current[key] = b[key] as string;
        }
        try {
          return json({ ok: true, detection: await detectExecutorCapabilities(current, driver) });
        } catch (error) {
          return json(
            {
              ok: false,
              error: `执行机探测失败: ${error instanceof Error ? error.message : String(error)}`,
            },
            502,
          );
        }
      },
    },
    {
      method: 'DELETE',
      path: '/api/admin/executors/:id',
      auth: 'admin',
      handler: ({ params }) => {
        const id = idParam(params);
        const existing = id ? getExecutor(db, id) : undefined;
        if (!id || !existing) return json({ ok: false, error: '无此执行机' }, 404);
        if (existing.isSystemLocal) {
          return json({ ok: false, error: '系统本机执行机不能删除' }, 409);
        }
        try {
          db.query('DELETE FROM executors WHERE id = ?').run(id);
        } catch {
          return json({ ok: false, error: '仍有项目/会话挂在该执行机上，先迁移再删' }, 400);
        }
        deps.onExecutorChanged?.(id); // M5：关掉并逐出池内旧 Driver
        return json({ ok: true });
      },
    },

    // ===== 项目归属调整（DB 显式归属，无推断） =====
    {
      method: 'PUT',
      path: '/api/admin/projects/:id/owner',
      auth: 'admin',
      handler: async ({ req, params }) => {
        const id = idParam(params);
        const proj = id
          ? db.query<{ id: number }, [number]>('SELECT id FROM projects WHERE id = ?').get(id)
          : null;
        if (!id || !proj) return json({ ok: false, error: '无此项目' }, 404);
        const b = await readBody(req);
        const userId = Number(b.userId);
        if (!Number.isInteger(userId) || !users.byId(userId)) {
          return json({ ok: false, error: '无此用户' }, 400);
        }
        db.query('UPDATE projects SET owner_user_id = ? WHERE id = ?').run(userId, id);
        return json({ ok: true });
      },
    },

    // ===== 活跃概览：last_login + 项目数 =====
    {
      method: 'GET',
      path: '/api/admin/overview',
      auth: 'admin',
      handler: () => {
        const rows = db
          .query<
            {
              id: number;
              username: string;
              role: string;
              last_login_ts: number | null;
              project_count: number;
            },
            []
          >(
            `SELECT u.id, u.username, u.role, u.last_login_ts,
                    (SELECT COUNT(*) FROM projects p WHERE p.owner_user_id = u.id) AS project_count
             FROM users u ORDER BY u.id`,
          )
          .all();
        return json({
          users: rows.map((r) => ({
            id: r.id,
            username: r.username,
            role: r.role,
            lastLoginTs: r.last_login_ts,
            projectCount: r.project_count,
          })),
        });
      },
    },
  ];
}
