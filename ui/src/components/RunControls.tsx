/**
 * 运行操作栏——执行现场「对话」模式顶部的常驻控制条（仅 issue 驱动中显示，见 ChatPane）。
 *  - 重试：让 AI 重试刚才失败的步骤（注入提示；可用性/文案在 subtask 7 细化）；
 *  - 终止：取消整个 issue（父层带二次确认）。
 * 纯展示：动作全由父层回调注入。
 */
import type { ComponentChildren } from 'preact';
import { useI18n } from '../i18n/provider';

export function RunControls({
  leading,
  onRetry,
  retryLabel,
  retryEnabled,
  retryHint,
  onTerminate,
  busy,
}: {
  /** 行首内联插槽（如「对话/原生」切换钮）：与运行操作钮合并为同一行 */
  leading?: ComponentChildren;
  onRetry: () => void;
  /** 运行控制文案（随状态变化，如「重试」/「解除阻塞并继续」） */
  retryLabel: string;
  /** 重试是否可点（无失败步骤时禁用） */
  retryEnabled: boolean;
  /** 重试按钮悬浮说明 */
  retryHint?: string;
  onTerminate: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div class="runctl">
      {leading}
      {/* 运行中：#300 起只留呼吸绿点，文字进 title / aria-label——同一行里「重试」「终止」
          已经说明这是运行现场，再写一遍「运行中」是纯占位。读屏仍读得到（role=status）。 */}
      <span class="rc-label" role="status" title={t('ui.runRunning')} aria-label={t('ui.runRunning')} />
      <button
        class="rc-btn"
        disabled={!retryEnabled}
        title={retryHint ?? ''}
        onClick={() => retryEnabled && onRetry()}
      >
        ↻ {retryLabel}
      </button>
      <button class="rc-btn danger" disabled={busy} title={t('ui.terminateIssue')} onClick={onTerminate}>
        ■ {t('ui.terminate')}
      </button>
    </div>
  );
}
