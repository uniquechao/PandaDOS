/**
 * components/AutoApproveSwitch —— 弹窗「自动批准」档位切换（#108 → #111 改下拉 → #113 Apple pull-down）。
 *
 * 与「对话/原生」切换钮并排长在 .runctl 行里。#111 曾因「自绘绝对定位浮层会被 .runctl
 * 横向滚动裁掉」改用原生 select；#113 为视觉一致改回自绘菜单，但吸取该教训 + #79 约束：
 * 菜单 createPortal 到 document.body、fixed 定位（锚点 getBoundingClientRect 现量），
 * 不受任何祖先 overflow / 层叠上下文影响。点外 / Esc / 滚动 / 改窗口大小都收起；
 * 选中项打 ✓，每档带一行大白话说明（不让人只凭「谨慎/中等/全自动」三个词猜行为）。
 */
import type { JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type { AutoApproveLevel } from '../lib/types';
import { useI18n } from '../i18n/provider';

/** 归一档位：认不出来（老后端没下发这个字段/脏值）时落到 medium，保证收起态一定显示出一档 */
function normalize(v: unknown): AutoApproveLevel {
  return v === 'cautious' || v === 'medium' || v === 'auto' ? v : 'medium';
}

/** 菜单横向位置夹在视口内（锚点贴屏幕右缘时不被切掉）；宽度与 .aa-menu 的 CSS 同步 */
const MENU_W = 264;
function clampX(x: number): number {
  const vw = typeof window === 'undefined' ? 360 : window.innerWidth;
  return Math.min(Math.max(x, 8), Math.max(8, vw - MENU_W - 8));
}

export function AutoApproveSwitch({
  level,
  onChange,
  disabled,
  disabledHint,
}: {
  level: AutoApproveLevel;
  onChange: (level: AutoApproveLevel) => void;
  /** 请求在途/已完成等不可改时置灰 */
  disabled?: boolean;
  /** 置灰原因（写进 title，别让人点不动还不知道为什么） */
  disabledHint?: string;
}): JSX.Element {
  const { t } = useI18n();
  const levels: Array<{ level: AutoApproveLevel; label: string; desc: string }> = [
    { level: 'cautious', label: t('ui.cautious'), desc: t('ui.cautiousDesc') },
    { level: 'medium', label: t('ui.medium'), desc: t('ui.mediumDesc') },
    { level: 'auto', label: t('ui.automatic'), desc: t('ui.automaticDesc') },
  ];
  const cur = normalize(level);
  const curMeta = levels.find((l) => l.level === cur);
  const hint = curMeta ? `${curMeta.label}：${curMeta.desc}` : '';
  // 菜单锚点（fixed 视口坐标；null = 收起）
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const open = menu !== null;

  // 点别处 / Esc / 滚动 / 改窗口大小都收起：fixed 锚定坐标滚一下就过期，干脆关掉（同 ExecProgress 浮层）
  useEffect(() => {
    if (!open) return;
    const close = (): void => setMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const toggle = (e: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation(); // 开菜单的这一下别冒到 document 又把菜单关了
    if (open) {
      setMenu(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: clampX(r.left), y: r.bottom + 6 });
  };

  const pick = (next: AutoApproveLevel): void => {
    setMenu(null);
    if (next !== cur) onChange(next); // 选回当前档不重复发请求
  };

  return (
    <span class="aa-pick">
      <span class="aa-pick-t mut">{t('ui.approval')}</span>
      <button
        class="aa-btn"
        disabled={disabled}
        title={disabled ? (disabledHint ?? t('ui.approvalUnavailable')) : hint}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {curMeta?.label}
        <span class="aa-caret">⌄</span>
      </button>
      {open &&
        createPortal(
          <div
            class="aa-menu"
            role="menu"
            aria-label={t('ui.autoApprovalLevel')}
            style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            {levels.map((l) => (
              <button
                key={l.level}
                class={`aa-item${l.level === cur ? ' on' : ''}`}
                role="menuitemradio"
                aria-checked={l.level === cur}
                onClick={() => pick(l.level)}
              >
                <span class="aa-check">{l.level === cur ? '✓' : ''}</span>
                <span class="aa-item-tx">
                  <span class="aa-item-l">{l.label}</span>
                  <span class="aa-item-d">{l.desc}</span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
