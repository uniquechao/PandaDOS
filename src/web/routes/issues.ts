import { normalizeSkillPolicy } from '../../core/skill-policy';
/**
 * web/routes/issues —— issue CRUD + start + 卡点 approve/reject + 时间线（spec §9-2）。
 * - 状态迁移一律走引擎 applyEvent（封死 v1 web.ts:535-538 直通 store 的旁路，评审 M8）；
 * - 卡点决定回引擎 decideGate（gates 表 waiting→decided CAS，一次性防重放）；
 * - 全部单项目路由 auth:'project-access'（:projectId 解析，属主/成员/admin 皆可协作），跨项目资源（issue/gate）
 *   在 handler 内核对归属，防「拿自己项目 id 操作别人 issue」。
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { MessageBumper } from '../../core/activity';
import type { AttentionKind } from '../../issues/attention';
import type { Database } from 'bun:sqlite';
import { projectAgentSupport } from '../../core/executors';
import {
  parseAutoApproveLevel,
  parseReasoningEffort,
  type AgentKind,
  type IssueCategory,
  type ProjectModule,
  type ReasoningEffort,
} from '../../core/types';
import { isUploadRel } from '../../core/uploads';
import {
  isEditableStatus,
  IssueWorkflowSelectionError,
  MAX_SUBTASK_TEXT_LENGTH,
  type IssueEngine,
  type EngineIssue,
  type ImplMode,
  type UpdateUnstartedSubtaskResult,
} from '../../issues/engine';
import { normalizeModuleSkills } from '../../issues/modules';
import { resolveReasoningEffort } from '../../core/reasoning';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

export interface IssuesRoutesDeps {
  db: Database;
  engine: IssueEngine;
  modules?: {
    listByProject(projectId: number): ProjectModule[];
    get?(id: number): ProjectModule | undefined;
    changeAgent?(projectId: number, moduleId: number, agent: AgentKind): ProjectModule;
    /** 模块技能挂载（046 / #277）；缺省 = 该装配不支持配置 */
    setSkills?(id: number, skills: string[] | null): ProjectModule;
    /** 模块默认推理档（048 / #281）；缺省 = 该装配不支持配置 */
    setReasoningEffort?(id: number, effort: ReasoningEffort | null): ProjectModule;
  };
  /**
   * waiting_input 派生标记：该 issue 是否在等人工输入（CC 弹窗升级人工未处理 / 菜单滞留）。
   * 状态机不为此加状态——它是「实施中但被弹窗卡住」的横切观测。缺省恒 false（测试/最小装配）。
   */
  waitingInput?(issue: EngineIssue): boolean;
  /**
   * 用户 id → 用户名解析（issue 列表/详情/新建回显 createdByName 用；缺省恒 null）。
   * 生产由 routes/index.ts 接 UserStore.byId；未接则前端回退显示「—」。
   */
  usernameById?(userId: number): string | null;
  /**
   * 用户消息计数（013）：澄清答复被引擎接受（注入到在跑的会话）后记一笔——它和在对话里
   * 发一句话是同一件事。缺省不接 = 不统计。
   */
  messages?: MessageBumper;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

function num(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function optionalPositiveId(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function workflowSelectionError(error: IssueWorkflowSelectionError): Response {
  const status = error.reason === 'not_found' ? 404 : 409;
  return json(
    apiError(`workflow.${error.reason}`, error.message, status, {}, error.issues),
    status,
  );
}

function zeroBasedIndex(v: string | undefined): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function subtaskUpdateError(result: Extract<UpdateUnstartedSubtaskResult, { ok: false }>): Response {
  switch (result.reason) {
    case 'text_required':
      return json(apiError('issue.subtask_text_required', 'Enter subtask text.', 400), 400);
    case 'text_too_long':
      return json(
        apiError(
          'issue.subtask_text_too_long',
          `Subtask text must not exceed ${MAX_SUBTASK_TEXT_LENGTH} characters.`,
          400,
          { max: MAX_SUBTASK_TEXT_LENGTH },
        ),
        400,
      );
    case 'not_found':
      return json(apiError('issue.subtask_not_found', 'The subtask does not exist.', 404), 404);
    case 'already_dispatched':
      return json(
        apiError(
          'issue.subtask_already_dispatched',
          'Only subtasks that have not been dispatched can be edited.',
          409,
        ),
        409,
      );
  }
}

/** 目标分支只收保守 Git 分支字符集；更严格的引用存在性由后续执行阶段在真实仓库确认。 */
const ISSUE_TARGET_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** 源必须来自分支清单接口的完整本地/远程跟踪 ref，不能保存含糊短名。 */
const ISSUE_SOURCE_REF_RE = /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,299}$/;

function validRefParts(value: string, prefixParts = 0): boolean {
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value.endsWith('.')) return false;
  return value
    .split('/')
    .slice(prefixParts)
    .every((part) => !!part && !part.startsWith('.') && !part.endsWith('.lock'));
}

export function parseIssueGitPatch(
  body: Record<string, unknown>,
  currentTarget: string | null,
  currentSource: string | null,
): {
  patch?: { targetBranch?: string | null; sourceRef?: string | null };
  error?: string;
} {
  const targetGiven = Object.prototype.hasOwnProperty.call(body, 'targetBranch');
  const sourceGiven = Object.prototype.hasOwnProperty.call(body, 'sourceRef');
  const patch: { targetBranch?: string | null; sourceRef?: string | null } = {};
  let target = currentTarget;
  let source = currentSource;

  if (targetGiven) {
    if (body.targetBranch === null || body.targetBranch === '') {
      target = null;
    } else if (typeof body.targetBranch !== 'string') {
      return { error: 'targetBranch 必须是字符串或 null' };
    } else {
      target = body.targetBranch.trim();
      if (!ISSUE_TARGET_BRANCH_RE.test(target) || !validRefParts(target)) {
        return { error: 'targetBranch 不是合法的目标分支名' };
      }
    }
    patch.targetBranch = target;
  }

  if (sourceGiven) {
    if (body.sourceRef === null || body.sourceRef === '') {
      source = null;
    } else if (typeof body.sourceRef !== 'string') {
      return { error: 'sourceRef 必须是字符串或 null' };
    } else {
      source = body.sourceRef.trim();
      if (!ISSUE_SOURCE_REF_RE.test(source) || !validRefParts(source, 2)) {
        return { error: 'sourceRef 必须是 refs/heads/* 或 refs/remotes/* 完整引用' };
      }
    }
    patch.sourceRef = source;
  }

  // 清空目标分支等于退出自定义分支模式；源 ref 随之清空，避免留下不可执行的半套配置。
  if (targetGiven && target === null) {
    source = null;
    patch.sourceRef = null;
  }
  if (source !== null && target === null) return { error: '设置 sourceRef 前必须先设置 targetBranch' };
  return { patch };
}

/** issue 必须属于路径里的项目（防跨项目指鹿为马） */
function issueOf(engine: IssueEngine, params: Record<string, string>): EngineIssue | null {
  const pid = num(params.projectId);
  const iid = num(params.issueId);
  if (!pid || !iid) return null;
  const issue = engine.store.get(iid);
  return issue && issue.projectId === pid ? issue : null;
}

export function issuesRoutes(deps: IssuesRoutesDeps): RouteDef[] {
  const { db, engine } = deps;
  const unsupported = (projectId: number, agent: AgentKind): Response | null => {
    const support = projectAgentSupport(db, projectId, agent);
    return support.ok ? null : json({ ok: false, error: support.error }, 409);
  };
  /**
   * 这条 issue 生效的推理档与它来自哪一层（048 / #281）。
   * 只读派生，给 UI 展示与排查用——真正定档发生在会话启动时（codex 的 effort 是启动参数）。
   */
  const reasoningOf = (issue: EngineIssue) => {
    const module = issue.moduleId
      ? deps.modules?.listByProject(issue.projectId).find((m) => m.id === issue.moduleId)
      : undefined;
    return resolveReasoningEffort({
      issue: issue.reasoningEffort ?? null,
      module: module?.reasoningEffort ?? null,
    });
  };

  const waitingInput = (issue: EngineIssue): boolean => {
    try {
      return deps.waitingInput?.(issue) ?? false;
    } catch {
      return false; // 派生标记失败不拖垮列表接口
    }
  };
  /**
   * 「这条 issue 在等什么」（#275 / I-07）：把 blocked 这个统一出口按原因拆开。
   * 与 waitingInput 同款容错——派生失败降级成 'none'，不拖垮列表接口。
   */
  const attentionKind = (issue: EngineIssue): AttentionKind => {
    try {
      return engine.attentionKindOf(issue, waitingInput(issue));
    } catch {
      return 'none';
    }
  };
  /** 派生标记：澄清问题还没被回答（跨状态——创建时问题开跑后仍显示到回答为止，spec 第 5 点） */
  const clarifyPending = (issue: EngineIssue): boolean => {
    try {
      return engine.store.clarifyPendingOf(issue.id);
    } catch {
      return false;
    }
  };
  /** 派生标记：执行中代理在等你澄清（NEED_CLARIFY / PM 兜底判 clarify）——issue 页覆盖显示「等待用户澄清」 */
  const awaitingClarify = (issue: EngineIssue): boolean => {
    try {
      return engine.store.execClarifyWait(issue.id) !== null;
    } catch {
      return false;
    }
  };
  /** 创建者用户名回显（created_by 为空 → null；解析失败/未接 → null）。不缓存以随改名实时反映。 */
  const createdByName = (issue: EngineIssue): string | null => {
    if (issue.createdBy == null) return null;
    try {
      return deps.usernameById?.(issue.createdBy) ?? null;
    } catch {
      return null;
    }
  };
  return [
    // ===== CRUD =====
    {
      method: 'GET',
      path: '/api/projects/:projectId/modules',
      auth: 'project-access',
      handler: ({ params }) => {
        const pid = num(params.projectId);
        if (!pid) return json({ ok: false, error: '缺 projectId' }, 400);
        return json({ modules: deps.modules?.listByProject(pid) ?? [] });
      },
    },
    {
      // 触发模块智能整理（手动，可选执行代理）：后台单飞跑 org-<pid> 独立会话分析。
      // 在途重复触发 → 409；装配不支持/无 issue 等 → 400。
      method: 'POST',
      path: '/api/projects/:projectId/modules/organize',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const pid = num(params.projectId);
        if (!pid) return json({ ok: false, error: '缺 projectId' }, 400);
        const b = await readBody(req);
        const agent: AgentKind | undefined =
          b.agent === 'codex' ? 'codex' : b.agent === 'claude' ? 'claude' : undefined;
        const denied = unsupported(pid, agent ?? 'claude');
        if (denied) return denied;
        const r = engine.organizeModules(pid, agent, user?.id);
        if (!r.ok) return json(r, r.error.includes('进行中') ? 409 : 400);
        return json({ ok: true });
      },
    },
    {
      // 整理状态（UI 轮询）：running + 最近一次方案（逐项 applied 标记）+ 失败记录。
      method: 'GET',
      path: '/api/projects/:projectId/modules/organize',
      auth: 'project-access',
      handler: ({ params }) => {
        const pid = num(params.projectId);
        if (!pid) return json({ ok: false, error: '缺 projectId' }, 400);
        return json({ ok: true, ...engine.organizeStatus(pid) });
      },
    },
    {
      // 执行整理方案中的一项（用户逐项确认；index 为方案 actions 下标）。
      // 引擎按当前库内事实重校验 + 防重放；成功返回稳定动作类型与结构化参数。
      method: 'POST',
      path: '/api/projects/:projectId/modules/organize/apply',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const pid = num(params.projectId);
        if (!pid) return json({ ok: false, error: '缺 projectId' }, 400);
        const b = await readBody(req);
        const index = Number(b.index);
        if (!Number.isInteger(index) || index < 0) return json({ ok: false, error: '缺 index' }, 400);
        const r = await engine.applyOrganizeAction(pid, index, user!.id);
        return r.ok ? json(r) : json(r, 400);
      },
    },
    {
      // 执行模块合并（用户确认后调用）：issues 重指/翻代理/归档来源全在 engine.mergeModules。
      method: 'POST',
      path: '/api/projects/:projectId/modules/merge',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const pid = num(params.projectId);
        if (!pid) return json({ ok: false, error: '缺 projectId' }, 400);
        const b = await readBody(req);
        const targetId = Number(b.targetId);
        const sourceIds = (Array.isArray(b.sourceIds) ? b.sourceIds : [])
          .map((s) => Number(s))
          .filter((s) => Number.isInteger(s) && s > 0);
        if (!Number.isInteger(targetId) || targetId <= 0 || !sourceIds.length) {
          return json({ ok: false, error: '缺 targetId / sourceIds' }, 400);
        }
        try {
          const r = await engine.mergeModules(pid, sourceIds, targetId);
          return json({ ok: true, target: r.target, movedIssueIds: r.movedIssueIds });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 400);
        }
      },
    },
    {
      // 模块改名/归档：displayName 改显示名；slug 改 slug（引擎三处同步：模块行/文档目录/
      // issues.module 文本列）；status:'archived' 归档（有未完结 issue 会被引擎拒绝）。
      // 可同请求：slug（可携 displayName）→ 仅 displayName → 归档。
      method: 'PATCH',
      path: '/api/projects/:projectId/modules/:moduleId',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const pid = num(params.projectId);
        const mid = num(params.moduleId);
        if (!pid || !mid) return json({ ok: false, error: '缺 projectId / moduleId' }, 400);
        const b = await readBody(req);
        const displayName = typeof b.displayName === 'string' ? b.displayName.trim() : '';
        const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
        const wantArchive = b.status === 'archived';
        const requestedAgent: AgentKind | null =
          b.agent === 'claude' || b.agent === 'codex' ? b.agent : null;
        // 技能配置（046 / #277）：显式传 null = 清回「沿用项目默认」，数组 = 显式指定。
        // 字段缺省（undefined）表示这次请求不碰技能，不能与 null 混为一谈。
        const skillsGiven = 'skills' in b;
        // 模块默认推理档（048 / #281）：null = 清回未配置（用控制面默认档）
        const effortGiven = 'reasoningEffort' in b;
        const effort = effortGiven && b.reasoningEffort !== null
          ? parseReasoningEffort(b.reasoningEffort)
          : null;
        if (effortGiven && b.reasoningEffort !== null && effort === null) {
          return json({ ok: false, error: '非法推理档位' }, 400);
        }
        if (!displayName && !slug && !wantArchive && !requestedAgent && !skillsGiven && !effortGiven) {
          return json({ ok: false, error: '缺 displayName / slug / status / agent / skills / reasoningEffort' }, 400);
        }
        if (skillsGiven && !deps.modules?.setSkills) {
          return json({ ok: false, error: '当前装配不支持配置模块技能' }, 503);
        }
        if (effortGiven && !deps.modules?.setReasoningEffort) {
          return json({ ok: false, error: '当前装配不支持配置模块推理档' }, 503);
        }
        if (requestedAgent) {
          const denied = unsupported(pid, requestedAgent);
          if (denied) return denied;
          if (!deps.modules?.changeAgent) {
            return json({ ok: false, error: '当前装配不支持修改模块 Agent' }, 503);
          }
        }
        try {
          let updated: ProjectModule | null = null;
          if (skillsGiven) {
            const module = deps.modules!.get?.(mid);
            if (module && module.projectId !== pid) throw new Error('无此模块');
            updated = deps.modules!.setSkills!(mid, normalizeModuleSkills(b.skills));
          }
          if (effortGiven) {
            const module = deps.modules!.get?.(mid);
            if (module && module.projectId !== pid) throw new Error('无此模块');
            updated = deps.modules!.setReasoningEffort!(mid, effort);
          }
          if (requestedAgent) updated = deps.modules!.changeAgent!(pid, mid, requestedAgent);
          if (slug) updated = await engine.renameModuleSlug(pid, mid, slug, displayName || undefined);
          else if (displayName) updated = await engine.renameModule(pid, mid, displayName);
          if (wantArchive) updated = await engine.archiveModule(pid, mid);
          return json({ ok: true, module: updated });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 400);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/issues',
      auth: 'project-access',
      handler: ({ params }) => {
        const pid = num(params.projectId);
        if (!pid) return json({ ok: false, error: '缺 projectId' }, 400);
        return json(
          engine.store
            .listByProject(pid)
            .map((i) => ({
              ...i,
              createdByName: createdByName(i),
              waitingInput: waitingInput(i),
              clarifyPending: clarifyPending(i),
              awaitingClarify: awaitingClarify(i),
              attentionKind: attentionKind(i),
            })),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/issues',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const pid = num(params.projectId);
        if (!pid) return json({ ok: false, error: '缺 projectId' }, 400);
        const b = await readBody(req);
        const title = typeof b.title === 'string' ? b.title.trim() : '';
        if (!title) return json({ ok: false, error: '缺 title' }, 400);
        const workflowTemplateId = optionalPositiveId(b.workflowTemplateId);
        if (workflowTemplateId === null) {
          return json(apiError('workflow.selection_invalid', 'Choose a valid workflow template.', 400), 400);
        }
        const category: IssueCategory =
          b.category === 'debug' ? 'debug' : b.category === 'design' ? 'design' : 'task';
        if (b.executionMode !== undefined && b.executionMode !== 'direct' && b.executionMode !== 'planned') return json({ ok: false, error: 'Invalid executionMode' }, 400);
        const implMode: ImplMode = b.implMode === 'team' ? 'team' : 'seq';
        const agent: AgentKind = b.agent === 'codex' ? 'codex' : 'claude';
        const selectedModule = num(
          typeof b.moduleId === 'number' ? String(b.moduleId) : undefined,
        );
        const effectiveAgent =
          (selectedModule
            ? deps.modules?.listByProject(pid).find((m) => m.id === selectedModule)?.agent
            : undefined) ?? agent;
        const denied = unsupported(pid, effectiveAgent);
        if (denied) return denied;
        const git = parseIssueGitPatch(b, null, null);
        if (git.error) return json({ ok: false, error: git.error }, 400);
        // 截图路径必须确实落在项目上传目录内（isUploadRel，挡住伪造路径引用任意文件——v1 双卡语义）
        const images = Array.isArray(b.images)
          ? (b.images as unknown[])
              .filter((p): p is string => typeof p === 'string' && p.length > 0 && isUploadRel(p))
              .slice(0, 6)
          : [];
        try {
          const issue = await engine.createIssue(pid, {
            title,
            body: typeof b.body === 'string' ? b.body : null,
            category,
            moduleId: num(typeof b.moduleId === 'number' ? String(b.moduleId) : undefined) ?? undefined,
            moduleName:
              typeof b.moduleName === 'string'
                ? b.moduleName
                : typeof b.module === 'string'
                  ? b.module
                  : undefined,
            implMode,
            ...(b.skillPolicy !== undefined ? {skillPolicy:normalizeSkillPolicy(b.skillPolicy)} : {}),
            executionMode: b.executionMode as 'direct' | 'planned' | undefined,
            agent,
            // #115：新建时就能定档位；没带/带脏值 = 'medium'（引擎侧同样兜底）
            autoApprove: parseAutoApproveLevel(b.autoApprove) ?? 'medium',
            ...git.patch,
            imagesJson: images.length ? JSON.stringify(images) : null,
            createdBy: user!.id,
            ...(workflowTemplateId !== undefined ? { workflowTemplateId } : {}),
          });
          return json({
            ok: true,
            issue: { ...issue, createdByName: createdByName(issue) },
            workflow: engine.workflowSnapshot(issue.id),
          });
        } catch (e) {
          if (e instanceof IssueWorkflowSelectionError) return workflowSelectionError(e);
          return json({ ok: false, error: String(e).slice(0, 200) }, 400);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/issues/:issueId',
      auth: 'project-access',
      handler: ({ params }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        return json({
          issue: {
            ...issue,
            createdByName: createdByName(issue),
            waitingInput: waitingInput(issue),
            clarifyPending: clarifyPending(issue),
            awaitingClarify: awaitingClarify(issue),
            attentionKind: attentionKind(issue),
          },
          subtasks: engine.store.subtasksOf(issue),
          gates: engine.store.listGates(issue.id),
          conversationSegments: issue.convId
            ? engine.store.listConversationSegments(issue.convId)
            : [],
          // 模块整条时间线（跨会话，#277 / I-01）：轮换后旧记录还在，只是换了一条 conv
          moduleSegments: issue.moduleId ? engine.store.listModuleSegments(issue.moduleId) : [],
          // 待恢复意图（#283）：用户点过「继续运行」但项目忙，正等接力自动恢复
          unblockRequest: engine.store.pendingUnblockRequest(issue.id),
          // 可拆回的合并（#289）：有快照才给拆；宿主已开跑时前端把按钮置灰并说明原因
          mergedFrom: (() => {
            const merge = engine.store.lastUnmergeableMerge(issue.id);
            if (!merge) return null;
            return {
              members: merge.snapshot.map((entry) => ({ id: entry.id, title: entry.title })),
              canUnmerge: issue.status === 'pending',
            };
          })(),
          // 推理档（048 / #281）：生效档位 + 来源（issue/模块/默认）
          reasoning: { ...reasoningOf(issue), override: issue.reasoningEffort ?? null },
          // 门禁（#279 / I-03）：本轮范围 + 最近一次结果，执行页只读展示
          validation: {
            scope: issue.validationScope ?? null,
            last: engine.store.lastValidation(issue.id),
          },
          workflow: engine.workflowSnapshot(issue.id),
          workflowRuntime: engine.workflowRuntime(issue.id),
        });
      },
    },
    {
      method: 'PATCH',
      path: '/api/projects/:projectId/issues/:issueId/subtasks/:subtaskIndex',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json(apiError('issue.not_found', 'The issue does not exist.', 404), 404);
        const index = zeroBasedIndex(params.subtaskIndex);
        if (index === null) return json(apiError('issue.subtask_not_found', 'The subtask does not exist.', 404), 404);
        const body = await readBody(req);
        const text = typeof body.text === 'string' ? body.text : '';
        const result = await engine.updateUnstartedSubtask(issue.id, index, text, user!.id);
        if (!result.ok) return subtaskUpdateError(result);
        return json({ ok: true, index: result.index, subtask: result.subtask });
      },
    },
    {
      method: 'PATCH',
      path: '/api/projects/:projectId/issues/:issueId',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const body = await readBody(req);
        // 推理档覆盖（048 / #281）**不受「可编辑状态」限制**：它不是需求内容，而是
        // 「下次会话启动时用哪个档」的配置——codex 的 effort 是进程启动参数，改了也不会
        // 影响正在跑的那个进程，所以跑到一半发现该提档，改完等下次启动生效即可。
        if ('reasoningEffort' in body) {
          const wanted = body.reasoningEffort === null ? null : parseReasoningEffort(body.reasoningEffort);
          if (body.reasoningEffort !== null && wanted === null) {
            return json({ ok: false, error: '非法推理档位' }, 400);
          }
          engine.store.setIssueReasoningEffort(issue.id, wanted);
          if (Object.keys(body).length === 1) {
            const fresh = engine.store.get(issue.id)!;
            return json({ ok: true, issue: fresh, reasoning: { ...reasoningOf(fresh), override: fresh.reasoningEffort ?? null } });
          }
        }
        // 可改内容的状态见 EDITABLE_STATES（pending / blocked / cancelled）。blocked 保存后仍受阻，
        // 必须再明确提交解除方法，才会从受阻前的阶段继续运行。
        // 已开跑的走澄清/打回把意见带回 CC，直接改 title/body 于事无补（CC 已读过原文）且会造成
        // 人机认知不一致；done 是真终态同样不给改。
        if (!isEditableStatus(issue.status)) {
          return json(
            {
              ok: false,
              error:
                issue.status === 'done'
                  ? '已完成的 issue 不能改内容'
                  : `执行中（${issue.status}）的 issue 不能直接改内容，请用澄清/打回把修改意见带回`,
            },
            400,
          );
        }
        const b = body;
        const git = parseIssueGitPatch(b, issue.targetBranch, issue.sourceRef);
        if (git.error) return json({ ok: false, error: git.error }, 400);
        const wantsModuleChange =
          num(typeof b.moduleId === 'number' ? String(b.moduleId) : undefined) !== null ||
          typeof b.moduleName === 'string' ||
          typeof b.module === 'string';
        const selectedModule = num(
          typeof b.moduleId === 'number' ? String(b.moduleId) : undefined,
        );
        const requestedAgent: AgentKind =
          (selectedModule
            ? deps.modules?.listByProject(issue.projectId).find((m) => m.id === selectedModule)?.agent
            : undefined) ??
          (b.agent === 'codex' ? 'codex' : b.agent === 'claude' ? 'claude' : issue.agent);
        if (wantsModuleChange || b.agent === 'claude' || b.agent === 'codex') {
          const denied = unsupported(issue.projectId, requestedAgent);
          if (denied) return denied;
        }
        // 截图：body 含 images 才动（缺省不碰旧图）；合法 rel 过滤（isUploadRel 挡伪造路径）+ 最多 6 张，
        // 与建 issue 同款校验；空数组 → images_json 置 null（清空所有截图）。
        const patchImages = 'images' in b;
        const images =
          patchImages && Array.isArray(b.images)
            ? (b.images as unknown[])
                .filter((p): p is string => typeof p === 'string' && p.length > 0 && isUploadRel(p))
                .slice(0, 6)
            : [];
        const patch: Parameters<typeof engine.store.patchMeta>[1] = {
          source: b.source === 'sync' ? 'sync' : 'user',
          ...(typeof b.title === 'string' && b.title.trim() ? { title: b.title.trim() } : {}),
          ...('body' in b && (b.body === null || typeof b.body === 'string') ? { body: b.body as string | null } : {}),
          ...(b.category === 'task' || b.category === 'design' || b.category === 'debug'
            ? { category: b.category }
            : {}),
          ...(b.implMode === 'seq' || b.implMode === 'team' ? { implMode: b.implMode } : {}),
          ...(!wantsModuleChange && (b.agent === 'claude' || b.agent === 'codex') ? { agent: b.agent } : {}),
          ...git.patch,
          ...(patchImages ? { imagesJson: images.length ? JSON.stringify(images) : null } : {}),
        };
        let updated: EngineIssue;
        try {
          updated = await engine.updatePendingMeta(
            issue.id,
            patch,
            wantsModuleChange
              ? {
                  ...(num(typeof b.moduleId === 'number' ? String(b.moduleId) : undefined)
                    ? { moduleId: Number(b.moduleId) }
                    : {}),
                  ...((typeof b.moduleName === 'string' ? b.moduleName : typeof b.module === 'string' ? b.module : '')
                    ? { moduleName: String(b.moduleName ?? b.module) }
                    : {}),
                  ...(b.agent === 'claude' || b.agent === 'codex' ? { requestedAgent: b.agent } : {}),
                }
              : undefined,
          );
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 400);
        }
        // 需求内容实际变化（title/body/截图）→ 重新分析，重生成代理反馈/新问题；
        // 模块/类型等元数据不触发。scheduleClarify 自带「仅 pending + 每项目链式单飞」守卫。
        //
        // #283 / B-11：**只有用户编辑才重新澄清**。协作文件同步回写改出来的 diff 与用户编辑
        // 长得一模一样，靠内容比对根本分不出来，猜错的代价是白跑一次通读代码库的澄清分析
        // （#270 实测同一条 issue 连跑两次，两次都是 questions=0）。来源由 `source` 显式说明。
        const editSource = b.source === 'sync' ? 'sync' : 'user';
        const contentChanged =
          (patch.title !== undefined && patch.title !== issue.title) ||
          ('body' in patch && (patch.body ?? null) !== (issue.body ?? null)) ||
          ('imagesJson' in patch && (patch.imagesJson ?? null) !== (issue.imagesJson ?? null));
        if (contentChanged && editSource === 'user') engine.scheduleClarify(issue.id);
        return json({
          ok: true,
          issue: updated,
          reasoning: { ...reasoningOf(updated), override: updated.reasoningEffort ?? null },
        });
      },
    },
    {
      method: 'DELETE',
      path: '/api/projects/:projectId/issues/:issueId',
      auth: 'project-access',
      handler: async ({ params }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const removed = await engine.removeIssue(issue.id);
        if (!removed.ok) return json(removed, removed.error === '无此 issue' ? 404 : 400);
        return json(removed);
      },
    },

    // ===== 生命周期动作（一律经引擎/状态机） =====
    {
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/start',
      auth: 'project-access',
      handler: async ({ params }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const r = await engine.startIssue(issue.id);
        return r.ok ? json({ ok: true, issue: engine.store.get(issue.id) }) : json(r, 409);
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/clarify',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const b = await readBody(req);
        const answer = typeof b.answer === 'string' ? b.answer : '';
        if (!answer.trim()) return json({ ok: false, error: '缺 answer' }, 400);
        const r = await engine.clarify(issue.id, answer);
        if (r.ok && user) deps.messages?.bump(user.id); // 引擎收下了才计
        return r.ok ? json({ ok: true, issue: engine.store.get(issue.id) }) : json(r, 409);
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/cancel',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const r = await engine.cancelIssue(issue.id, user!.id);
        return r.ok ? json({ ok: true }) : json(r, 409);
      },
    },
    {
      // review 状态已发布、但 Git/进程故障让 waiting gate 未落库时，人工幂等重跑 entry action。
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/retry-gate',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const r = await engine.retryMissingGate(issue.id, user!.id);
        return r.ok ? json(r) : json(r, 409);
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/unblock',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const b = await readBody(req);
        const guidance = typeof b.guidance === 'string' ? b.guidance.trim() : '';
        if (!guidance) return json({ ok: false, error: '解除阻塞前必须填写补充意见或解除方法' }, 400);
        if (guidance.length > 4000) return json({ ok: false, error: '解除方法不能超过 4000 字' }, 400);
        const r = await engine.unblockIssue(issue.id, guidance, user!.id);
        if (!r.ok) return json(r, 409);
        // 项目忙 → 解除意图已排队（#283）：这是成功，不是 409。前端据此显示「等当前任务结束」
        return json({
          ok: true,
          ...('queued' in r ? { queued: true, requestedTs: r.requestedTs } : {}),
          issue: engine.store.get(issue.id),
          unblockRequest: engine.store.pendingUnblockRequest(issue.id),
        });
      },
    },
    {
      /**
       * 一键拆回智能合并（#289 / B-14）：按 tasks_merged 快照把宿主与被并项都还原回去。
       * 只在宿主未开跑时可用——开跑之后会话里已经按合并后的正文干过活了。
       */
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/unmerge',
      auth: 'project-access',
      handler: async ({ params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const r = await engine.unmergeIssues(issue.id, user!.id);
        return r.ok
          ? json({ ok: true, restored: r.restored, issue: engine.store.get(issue.id) })
          : json(r, 409);
      },
    },
    {
      /** 撤销尚未消费的解除意图（#283）：排错了/改主意了，得能收回来 */
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/unblock/cancel',
      auth: 'project-access',
      handler: ({ params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const r = engine.cancelUnblockRequest(issue.id, user!.id);
        return r.ok
          ? json({ ok: true, issue: engine.store.get(issue.id), unblockRequest: null })
          : json(r, 409);
      },
    },
    {
      // 复活重跑（#93）：cancelled → pending，随后接力立刻开跑。
      // 「取消 → 改需求 → 重新运行」里的最后一步，所以**编辑要在调本接口之前做完**——
      // 一落到 pending 就可能马上开跑，没有再改的窗口。回 issue 便于前端直接刷新状态。
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/reopen',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const b = await readBody(req);
        const guidance = typeof b.guidance === 'string' ? b.guidance : '';
        const r = await engine.reopenIssue(issue.id, user!.id, guidance);
        return r.ok ? json({ ok: true, issue: engine.store.get(issue.id) }) : json(r, 409);
      },
    },
    {
      // 置顶/取消置顶（调整排队优先级）；body.pinned 缺省=true（置顶）。仅 pending 可置顶。
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/pin',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const b = await readBody(req);
        const pinned = b.pinned === undefined ? true : b.pinned === true;
        const r = await engine.setPinned(issue.id, pinned, user!.id);
        return r.ok ? json({ ok: true, issue: engine.store.get(issue.id) }) : json(r, 409);
      },
    },

    {
      // 改自动批准档位（issue #108）：{level:'cautious'|'medium'|'auto'}。未开跑/驱动中/受阻
      // 都能改——正在跑的 issue 改完，下一次弹窗即按新档位分级；已完成/已取消的引擎拒改 → 409（#111）。
      method: 'POST',
      path: '/api/projects/:projectId/issues/:issueId/auto-approve',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        const level = parseAutoApproveLevel((await readBody(req)).level);
        if (!level) return json({ ok: false, error: 'level 必须是 cautious/medium/auto' }, 400);
        const r = engine.setAutoApprove(issue.id, level, user!.id);
        return r.ok ? json({ ok: true, issue: engine.store.get(issue.id) }) : json(r, 409);
      },
    },

    // ===== 时间线（全量 events，不截断） =====
    {
      method: 'GET',
      path: '/api/projects/:projectId/issues/:issueId/events',
      auth: 'project-access',
      handler: ({ params }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        return json(engine.store.listEvents(issue.id));
      },
    },

    // ===== 卡点 =====
    {
      method: 'GET',
      path: '/api/projects/:projectId/issues/:issueId/gates',
      auth: 'project-access',
      handler: ({ params }) => {
        const issue = issueOf(engine, params);
        if (!issue) return json({ ok: false, error: '无此 issue' }, 404);
        return json(engine.store.listGates(issue.id));
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/gates/:gateId/approve',
      auth: 'project-access',
      handler: async ({ params, user }) => {
        const pid = num(params.projectId);
        const gid = num(params.gateId);
        const gate = gid ? engine.store.getGate(gid) : undefined;
        const issue = gate ? engine.store.get(gate.issueId) : undefined;
        if (!pid || !gate || !issue || issue.projectId !== pid) {
          return json({ ok: false, error: '无此卡点' }, 404);
        }
        const r = await engine.decideGate(gate.id, user!.id, 'approve');
        return r.ok ? json({ ok: true, issue: engine.store.get(issue.id) }) : json(r, 409);
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/gates/:gateId/reject',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const pid = num(params.projectId);
        const gid = num(params.gateId);
        const gate = gid ? engine.store.getGate(gid) : undefined;
        const issue = gate ? engine.store.get(gate.issueId) : undefined;
        if (!pid || !gate || !issue || issue.projectId !== pid) {
          return json({ ok: false, error: '无此卡点' }, 404);
        }
        const b = await readBody(req);
        const note = typeof b.note === 'string' ? b.note.trim() : '';
        if (!note) return json({ ok: false, error: 'reject 必须带意见（note）' }, 400);
        const r = await engine.decideGate(gate.id, user!.id, 'reject', note);
        return r.ok ? json({ ok: true, issue: engine.store.get(issue.id) }) : json(r, 409);
      },
    },
  ];
}
