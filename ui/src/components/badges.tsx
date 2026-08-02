/** 状态/类别/执行机 徽标 */
import type { ExecutorStatus, IssueCategory, IssueStatus } from '../lib/types';
import { issueCategoryLabel, issueStatusLabel } from '../lib/labels';
import { useI18n } from '../i18n/provider';

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
  const { t } = useI18n();
  // 执行中代理在等你澄清：覆盖显示「等待用户澄清」，实心橙高亮（#110）——详情页与工作台列表
  // 都传该 prop：列表上只显「实施中」的话，一条卡在等你的 issue 看着跟正常跑的一模一样。
  if (awaitingClarify) {
    return (
      <span class="badge b-clarify" title={t('status.awaitingClarifyHint')}>
        ⏳ {t('status.awaitingClarify')}
      </span>
    );
  }
  return <span class={`badge ${STATUS_COLOR[status] ?? 'b-gray'}`}>{issueStatusLabel(status)}</span>;
}

/** waiting_input 派生标记：CC 弹窗在等人工选择（升级卡未处理/菜单滞留），选完自动消失 */
export function WaitingBadge() {
  const { t } = useI18n();
  return (
    <span class="badge b-amber" title={t('status.waitingChoiceHint')}>
      {t('status.waitingChoice')}
    </span>
  );
}

const CAT_COLOR: Record<IssueCategory, string> = {
  task: 'b-green',
  design: 'b-blue',
  debug: 'b-red',
};

export function CatBadge({ cat }: { cat: IssueCategory }) {
  return <span class={`badge ${CAT_COLOR[cat] ?? 'b-gray'}`}>{issueCategoryLabel(cat)}</span>;
}

/**
 * 当前使用的模型（issue #109）：显示代理写在会话里的原始名（claude-opus-5 / gpt-5.6-sol），
 * 只读展示、不可点击切换。未知（没开跑/探不到）不渲染——不拿默认模型顶替。
 */
export function ModelBadge({ model }: { model: string | null | undefined }) {
  const { t } = useI18n();
  if (!model) return null;
  return (
    <span class="badge b-model mono" title={t('status.modelInUse', { model })}>
      {model}
    </span>
  );
}

export function ExecBadge({ status }: { status: ExecutorStatus }) {
  const { t } = useI18n();
  const cls = status === 'online' ? 'b-green' : status === 'offline' ? 'b-red' : 'b-gray';
  const label = status === 'online' ? t('status.online') : status === 'offline' ? t('status.offline') : t('status.unknown');
  return <span class={`badge ${cls}`}>{label}</span>;
}
