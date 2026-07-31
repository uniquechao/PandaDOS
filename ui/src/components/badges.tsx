/** 状态/类别/执行机 徽标 */
import type { ExecutorStatus, IssueCategory, IssueStatus } from '../lib/types';
import { CAT_LABEL, STATUS_LABEL } from '../lib/types';

const STATUS_COLOR: Record<IssueStatus, string> = {
  pending: 'b-gray',
  clarifying: 'b-blue',
  planning: 'b-ai', // AI 执行中
  plan_review: 'b-amber',
  implementing: 'b-ai', // AI 执行中
  testing: 'b-ai', // AI 执行中
  merge_review: 'b-amber',
  merging: 'b-ai', // AI 执行中
  done: 'b-green',
  blocked: 'b-red',
  cancelled: 'b-gray',
};

export function StatusBadge({ status, awaitingClarify }: { status: IssueStatus; awaitingClarify?: boolean }) {
  // 执行中代理在等你澄清：覆盖显示「等待用户澄清」，实心橙高亮（#110）——详情页与工作台列表
  // 都传该 prop：列表上只显「实施中」的话，一条卡在等你的 issue 看着跟正常跑的一模一样。
  if (awaitingClarify) {
    return (
      <span class="badge b-clarify" title="执行中代理在等你回答澄清问题（点进 issue，顶部澄清条回答）">
        ⏳ 等待你澄清
      </span>
    );
  }
  return <span class={`badge ${STATUS_COLOR[status] ?? 'b-gray'}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** waiting_input 派生标记：CC 弹窗在等人工选择（升级卡未处理/菜单滞留），选完自动消失 */
export function WaitingBadge() {
  return (
    <span class="badge b-amber" title="CC 弹窗在等你选择：到执行页处理或点飞书卡片">
      等你选择
    </span>
  );
}

const CAT_COLOR: Record<IssueCategory, string> = {
  task: 'b-green',
  design: 'b-blue',
  debug: 'b-red',
};

export function CatBadge({ cat }: { cat: IssueCategory }) {
  return <span class={`badge ${CAT_COLOR[cat] ?? 'b-gray'}`}>{CAT_LABEL[cat] ?? cat}</span>;
}

/**
 * 当前使用的模型（issue #109）：显示代理写在会话里的原始名（claude-opus-5 / gpt-5.6-sol），
 * 只读展示、不可点击切换。未知（没开跑/探不到）不渲染——不拿默认模型顶替。
 */
export function ModelBadge({ model }: { model: string | null | undefined }) {
  if (!model) return null;
  return (
    <span class="badge b-model mono" title={`当前使用的模型：${model}`}>
      {model}
    </span>
  );
}

export function ExecBadge({ status }: { status: ExecutorStatus }) {
  const cls = status === 'online' ? 'b-green' : status === 'offline' ? 'b-red' : 'b-gray';
  const label = status === 'online' ? '在线' : status === 'offline' ? '离线' : '未知';
  return <span class={`badge ${cls}`}>{label}</span>;
}
