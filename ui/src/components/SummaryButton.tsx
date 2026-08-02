/**
 * SummaryButton —— 「更新简介 / 更新记忆」按钮 + 内联模型选择。
 * 手机端友好：点按钮就地展开一排小按钮选模型（不用桌面悬浮菜单/绝对定位弹层）；
 * 选中即回调并收起。生成中（本地提交或后端 running）时禁用并显示「生成中…」。
 * 默认「更新简介」（SUMMARY_MODELS）；传 models/renderLabel/title 可复用为「更新记忆」等。
 */
import { useState } from 'preact/hooks';
import {
  SUMMARY_MODELS,
  summaryBtnLabel,
  type SummaryMode,
  type SummaryModelOption,
} from '../lib/summaryModes';
import type { SummaryStatus } from '../lib/types';
import { useI18n } from '../i18n/provider';

export function SummaryButton({
  status,
  busy,
  onPick,
  btnClass = 'btn sm',
  models = SUMMARY_MODELS,
  renderLabel = summaryBtnLabel,
  title,
}: {
  status?: SummaryStatus;
  busy: boolean;
  onPick: (mode: SummaryMode) => void;
  btnClass?: string;
  /** 可选模型列表（默认「更新简介」的 llm/claude/codex；「更新记忆」传 MEMORY_MODELS） */
  models?: SummaryModelOption[];
  /** 按钮文案（默认 summaryBtnLabel；「更新记忆」传 memoryBtnLabel） */
  renderLabel?: (status: SummaryStatus | undefined, busy: boolean) => string;
  /** 按钮 title */
  title?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const running = busy || status === 'running';
  const pick = (e: Event, mode: SummaryMode): void => {
    e.stopPropagation();
    setOpen(false);
    onPick(mode);
  };
  return (
    <span class="sumbtn">
      <button
        class={btnClass}
        disabled={running || models.length === 0}
        title={title ?? t('ui.pickSummaryModel')}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {renderLabel(status, busy)}
        {!running && <span class="sumbtn-caret">{open ? ' ▴' : ' ▾'}</span>}
      </button>
      {open && !running && (
        <span class="sumbtn-opts" role="menu">
          {models.map((m) => (
            <button
              key={m.mode}
              class="sumbtn-opt"
              title={m.hint}
              onClick={(e) => pick(e, m.mode)}
            >
              {m.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
