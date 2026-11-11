import type { WorkspaceReclamationService } from '../issues/workspace-reclamation';
/**
 * agents/tools —— PM 问答工具四件套（v1 tools.ts 平移，评审 §2B 改造点全落地）：
 * - 作用域从「本机所有 tmux 会话」收窄到**本项目**（PM 只见自己项目，description 重写）；
 * - 执行全改走 ExecutorDriver + DB（capture_pane 不再本地 execFileSync；
 *   read_progress 走 JsonlLocator + readRecentMessages）；
 * - send_command 的注入必须经 KeyedMutex（tmuxLockKey 与引擎同一把锁，评审 H9 单驾驶员）；
 * - 项目归属硬校验在 executeTool 层做，不信 prompt（评审 5.3：schema description 不是护栏）。
 */
import type { Conversation } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { readRecentMessages } from '../core/jsonl';
import { judgeAgentLiveness } from '../core/agent-liveness';
import { KeyedMutex, projectLockKey, tmuxLockKey } from '../issues/mutex';
import { fmtChatEvent } from './progress';

// ---------- 依赖（最小结构接口；ConversationManager / JsonlLocator 结构兼容直传） ----------

export interface ToolConvOps {
  listByProject(projectId: number): Conversation[];
  currentConv(projectId: number): string | undefined;
  isExecutionConversation?(projectId:number,convId:string):boolean;
  tmuxName(projectId: number, convId?: string | null): string;
  /**
   * 强制重启代理（issue #97）：会话还在、里面只剩 bash 时用（activate 会因「会话还在」短路）。
   * 缺省 = 旧装配/精简 stub，此时只拒发不重启。
   */
  relaunch?(convId: string): Promise<unknown>;
}

export interface ToolLocator {
  locate(convId: string): Promise<string | null>;
}

export interface PmToolsDeps {
  workspaceResources?:Pick<WorkspaceReclamationService,'list'|'request'|'pin'>;
  /** 工具作用域锚点：一切寻址锁死在这个项目 */
  projectId: number;
  driver: ExecutorDriver;
  convs: ToolConvOps;
  locator: ToolLocator;
  mutex: KeyedMutex;
}

// ---------- 常量（v1 平移） ----------

/** read_progress 读 jsonl 末尾窗口（judgeDone 同款 16000B） */
export const READ_PROGRESS_BYTES = 16000;
/** read_progress 最多回的活动行数 */
export const READ_PROGRESS_LINES = 30;
/** capture_pane 保留的尾行数（v1 tools.ts:61） */
export const CAPTURE_TAIL_LINES = 25;

// ---------- 工具定义（OpenAI function-calling 兼容；description 已改项目作用域） ----------

export const TOOL_SCHEMAS = [
  {
    type:'function',
    function:{
      name:'workspace_resources',
      description:'Inspect this project’s persisted workspace reclamation jobs and executor capacity. Recheck a known job through the controlled collector; pin or unpin a diagnostic archive only when requested. Never accepts paths, shell commands, force removal or another project.',
      parameters:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['list','recheck','pin','unpin']},job_id:{type:'string'}},required:['action']},
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description:
        '列出**本项目**的对话与专用 tmux 会话状态（哪条对话激活中、各对话标签）。问"在跑什么/有哪些对话"用它',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_progress',
      description:
        '读取本项目某条对话最近的 Claude Code 活动（工具调用、结果、消息），用于回答它在干嘛/进展如何；不给 conv_id 则读当前激活对话',
      parameters: {
        type: 'object',
        properties: { conv_id: { type: 'string', description: '对话 id（可选，默认当前激活对话）' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'capture_pane',
      description: '抓取本项目专用 tmux 会话当前的终端屏幕内容（看实时画面/是否卡住/弹窗）',
      parameters: { type: 'object', properties: {conv_id:{type:'string'}} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_command',
      description:
        '给本项目的 Claude Code 发送一条指令/消息（模拟键入并回车）。改变状态的操作，确认主人意图后再调。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' }, conv_id:{type:'string'} },
        required: ['text'],
      },
    },
  },
];

/** Localize only generated tool instructions; IDs, reasons and actions stay machine protocols. */
export function pmToolSchemas(chinese:boolean) {
 return chinese?TOOL_SCHEMAS.map(tool=>tool.function.name==='workspace_resources'?{...tool,function:{...tool.function,description:'查看本项目的持久化工作区回收记录、保留原因与执行机容量。按已有记录 ID 请求受控重新检查；仅按用户要求固定或取消固定诊断归档。不接受路径、命令、强制删除或其他项目。'}}:tool):TOOL_SCHEMAS;
}

// ---------- 执行 ----------

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  deps: PmToolsDeps,
): Promise<string> {
  switch (name) {
    case 'workspace_resources': {
      const port=deps.workspaceResources;
      if(!port)return JSON.stringify({code:'workspace_resources_unavailable'});
      const action=args.action;
      if(Object.keys(args).some(k=>!['action','job_id'].includes(k))||!['list','recheck','pin','unpin'].includes(String(action)))return JSON.stringify({code:'invalid_arguments'});
      if(action==='list') {
        const facts=port.list(deps.projectId);
        return JSON.stringify({jobs:facts.jobs.slice(0,30).map(j=>({id:j.id,kind:j.kind,workspace_id:j.workspace_id,state:j.state,reason:j.reason,archive_bytes:j.archive_bytes,archive_pinned:j.archive_pinned,archive_prune_state:j.archive_prune_state,archive_prune_reason:j.archive_prune_reason,next_check_ts:j.next_check_ts})),capacity:facts.capacity,policy:facts.policy,more:facts.jobs.length>30});
      }
      if(typeof args.job_id!=='string'||!/^[0-9a-f-]{36}$/.test(args.job_id))return JSON.stringify({code:'invalid_arguments'});
      if(action==='recheck')port.request(deps.projectId,args.job_id);
      else await port.pin(deps.projectId,args.job_id,action==='pin');
      return JSON.stringify({state:action==='recheck'?'queued':'updated',job_id:args.job_id});
    }
    case 'list_sessions': {
      const convs = deps.convs.listByProject(deps.projectId);
      const current = deps.convs.currentConv(deps.projectId);
      const ded = deps.convs.tmuxName(deps.projectId);
      let tmuxLive = false;
      try {
        tmuxLive = (await deps.driver.listSessions()).some((s) => s.name === ded);
      } catch {
        /* 执行机不可达时按未启动展示 */
      }
      const head = `项目专用会话 @${ded}：${tmuxLive ? '运行中' : '未启动'}`;
      if (!convs.length) return `${head}\n（本项目还没有对话）`;
      const lines = convs.map((c, i) => {
        const marks = [c.id === current ? '当前激活' : '', deps.convs.isExecutionConversation?.(deps.projectId,c.id) && c.id!==current ? '工作区执行中' : '', c.archived ? '已归档' : ''].filter(Boolean);
        return `${i + 1}. ${c.label ?? c.id}（${c.id.slice(0, 8)}…${marks.length ? '｜' + marks.join('｜') : ''}）`;
      });
      return `${head}\n${lines.join('\n')}`;
    }

    case 'read_progress': {
      const convId =
        typeof args.conv_id === 'string' && args.conv_id
          ? args.conv_id
          : deps.convs.currentConv(deps.projectId);
      if (!convId) return '本项目当前没有激活的对话';
      // 项目归属硬校验（不能信 LLM 传参，评审 5.3）
      if (!deps.convs.listByProject(deps.projectId).some((c) => c.id === convId)) {
        return `对话 ${convId} 不属于本项目`;
      }
      const path = await deps.locator.locate(convId);
      if (!path) return `对话 ${convId} 还没有输出记录`;
      const msgs = await readRecentMessages(deps.driver, path, READ_PROGRESS_BYTES);
      const lines = msgs.map((message) => fmtChatEvent(message)).filter(Boolean);
      if (!lines.length) return '（最近没有活动）';
      return lines.slice(-READ_PROGRESS_LINES).join('\n');
    }

    case 'capture_pane': {
      const selected=typeof args.conv_id==='string'?args.conv_id:undefined;
      if(selected&&!deps.convs.listByProject(deps.projectId).some(c=>c.id===selected))return '对话不属于本项目';
      const ded = deps.convs.tmuxName(deps.projectId,selected);
      try {
        const p = await deps.driver.capturePane(ded);
        // ANSI 清洗 + 非空尾行（v1 tools.ts:60-61 平移）
        // eslint-disable-next-line no-control-regex
        const clean = p.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        const tail = clean
          .split('\n')
          .filter((l) => l.trim())
          .slice(-CAPTURE_TAIL_LINES)
          .join('\n');
        return tail || '（屏幕为空）';
      } catch {
        return `抓不到会话 ${ded} 的屏幕（可能未启动）`;
      }
    }

    case 'send_command': {
      const text = String(args.text ?? '').trim();
      if (!text) return '不能发送空消息';
      const convId=typeof args.conv_id==='string'?args.conv_id:deps.convs.currentConv(deps.projectId);
      if(convId && (!deps.convs.listByProject(deps.projectId).some(c=>c.id===convId) || deps.convs.isExecutionConversation && !deps.convs.isExecutionConversation(deps.projectId,convId)))return '工作区对话归属失效';
      const ded = deps.convs.tmuxName(deps.projectId,typeof args.conv_id==='string'?args.conv_id:undefined);
      const sessions = await deps.driver.listSessions().catch(() => []);
      const entry = sessions.find((s) => s.name === ded);
      if (!entry) return `本项目专用会话 @${ded} 未启动`;

      // 代理存活门禁（issue #97）：会话在 ≠ 代理在跑。代理退出后窗格里只剩 bash，
      // 盲发等于把 PM 的催办当 shell 命令跑掉（command not found），PM 还以为自己催过了。
      const conv = convId
        ? deps.convs.listByProject(deps.projectId).find((c) => c.id === convId)
        : undefined;
      const pane = await deps.driver.capturePane(ded).catch(() => undefined);
      // 判死硬闸：会话文件最近还在长 = 代理活着（可能只是在跑一条前台命令，屏幕和前台命令
      // 双双像 shell——生产实测靠这两个信号会误杀正在干活的代理）
      const jl = convId ? await deps.locator.locate(convId).catch(() => null) : null;
      const st = jl ? await deps.driver.statPath(jl).catch(() => null) : null;
      const quietMs = st ? Math.max(0, Date.now() - st.mtimeMs) : undefined;
      const live = judgeAgentLiveness({
        agent: conv?.agent ?? 'claude',
        ...(entry.command !== undefined ? { paneCommand: entry.command } : {}),
        ...(pane !== undefined ? { pane } : {}),
        ...(quietMs !== undefined ? { quietMs } : {}),
      });
      if (live === 'shell') {
        // 只重启「我刚判死的那个会话」：模块会话等场景下当前对话可能挂在别的 tmux 上，
        // 名字对不上就只拒发不乱动（宁可少做，也不 kill 无关会话）。
        const convSession = convId ? deps.convs.tmuxName(deps.projectId, convId) : null;
        if (convId && convSession === ded && deps.convs.relaunch) {
          await deps.mutex
            .runExclusive(projectLockKey(deps.projectId), () =>
              deps.mutex.runExclusive(tmuxLockKey(ded), () => deps.convs.relaunch!(convId)),
            )
            .catch(() => {});
          return `没有发送：@${ded} 里的代理已经退出了（窗格只剩 shell），消息发过去会被当 shell 命令执行。已自动重启代理，等它起来后再发一次。`;
        }
        return `没有发送：@${ded} 里的代理已经退出了（窗格只剩 shell）。请先把代理拉起来再发。`;
      }

      // 注入必须经 KeyedMutex：与引擎 kickoff/nudge、web、飞书回调抢同一把 tmuxLockKey（评审 H9）
      await deps.mutex.runExclusive(tmuxLockKey(ded), () => { if(convId && deps.convs.isExecutionConversation && !deps.convs.isExecutionConversation(deps.projectId,convId))throw new Error('工作区输入归属失效');return deps.driver.sendKeys(ded,text); });
      return `已向 @${ded} 发送：${text}`;
    }

    default:
      return `未知工具 ${name}`;
  }
}
