/**
 * runstream 展开区的「看全 + 复制」（issue #288）。
 *
 * 气泡流里的正文是服务端截断过的（core/jsonl 的 brief + core/toolfmt 的 clip），流里带全文
 * 会把带宽和内存都撑爆。所以展开区里显示的仍是截断版，另给一个「查看完整内容」按钮——点了
 * 才按 off 发 detail 帧回源那一行拿全文。缓存与请求在 ChatPane 里（一条 WS 一份），这里只经
 * context 取用，免得四个事件组件层层透传。
 *
 * 复制走两条路：按钮（copyText）+ 长按/拖选（展开区一律 user-select:text，见 style.css）。
 * 按钮失败不是死路，提示用户手动选中即可。
 *
 * 复制钮是浮在正文右上角的图标钮（issue #299）：它原先是底部操作条里的一枚带文字药丸钮，
 * 窄屏上几乎必然自己折一行，几十像素的竖向空间白白让给一个不常点的钮。改成浮层后它不再
 * 参与正文排版，「查看完整内容」与说明文案仍留在底部操作条里（那两个是要读的字，不能压在正文上）。
 */
import { createContext } from 'preact';
import type { JSX } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { copyText } from '../../lib/clipboard';
import type { ChatMessage } from '../../lib/types';
import { tr } from '../../i18n/runtime';
import { isClipped } from './textutil';

/** 一条消息（按 off 索引）的回源状态 */
export type DetailState =
  | { phase: 'loading' }
  | { phase: 'error' }
  /** content 已是服务端给到的全文；truncated=true 表示全文本身也超上限、只给了前 total 字里的一段 */
  | { phase: 'ready'; content: string; truncated: boolean; total: number };

export interface DetailApi {
  get(off: number | undefined): DetailState | undefined;
  /** role/tool 是本地已渲染出来的信息，捎给服务端当解析提示（见 ws/chat.ts detail 帧） */
  request(off: number, hint: { role?: ChatMessage['role']; tool?: string }): void;
}

/** null = 没接（如 ConversationSegments 被单独复用时）：只降级掉「查看完整内容」，复制照常 */
export const DetailCtx = createContext<DetailApi | null>(null);

export function useDetailApi(): DetailApi | null {
  return useContext(DetailCtx);
}

/**
 * 复制按钮：无文字的小图标钮（📋 → 成功 ✓ / 失败 ✕），点完短暂显示结果再自己复位
 * （成功/失败都不弹全局提示，就地说清楚）。图标钮的可读名称靠 title/aria-label 给。
 */
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1800);
    return () => clearTimeout(timer);
  }, [state]);
  const label = state === 'ok' ? tr('ui.copied') : state === 'fail' ? tr('ui.copyFailed') : tr('ui.copy');
  return (
    <button
      type="button"
      class={`rs-copy${state === 'ok' ? ' ok' : ''}${state === 'fail' ? ' bad' : ''}`}
      title={label}
      aria-label={label}
      disabled={!text}
      onClick={(e: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
        // 复制按钮常常落在可展开的头/卡片里：别让这一下顺手把卡片折叠了
        e.stopPropagation();
        void copyText(text).then((ok) => setState(ok ? 'ok' : 'fail'));
      }}
    >
      <span class="rs-copy-ic" aria-hidden="true">
        {state === 'ok' ? '✓' : state === 'fail' ? '✕' : '📋'}
      </span>
      {/* 只有失败才把话说全：「请手动选中文本复制」是用户唯一的退路，一个 ✕ 说不清楚；
          浮层展开不会顶动正文，所以这里可以放心铺开一句话 */}
      {state === 'fail' && <span class="rs-copy-tx">{label}</span>}
    </button>
  );
}

/**
 * 展开区的一块正文：渲染（截断版或回源后的全文）+ 右上角浮着的复制钮 + 需要时才出现的
 * 底部操作条（查看完整内容 / 状态说明）。
 * render 是渲染方式的插槽——同一块正文在命令、工具入参、结果、异常里的着色规则各不相同。
 */
export function DetailBody({
  text,
  off,
  role,
  tool,
  render,
  className,
}: {
  text: string;
  /** 该正文所属消息的稳定标识；缺省（老数据无 off）时不提供「查看完整内容」 */
  off?: number;
  role?: ChatMessage['role'];
  tool?: string;
  render: (text: string) => JSX.Element;
  className?: string;
}) {
  const api = useDetailApi();
  const state = api?.get(off);
  const full = state?.phase === 'ready' ? state.content : undefined;
  const shown = full ?? text;
  // 只有「服务端确实截过」且还没拿到全文时才出按钮——没被截的内容不该平白多一个钮
  const canLoad = api !== null && off !== undefined && full === undefined && isClipped(text);
  const loading = state?.phase === 'loading';
  const note = state?.phase === 'error' || (state?.phase === 'ready' && state.truncated);
  // 复制钮已经浮出去了：既没有「查看完整内容」也没有说明文案时，操作条只剩一条空高度
  const showBar = canLoad || note;
  return (
    // full = 已经拿到回源全文：给外层展开区一个 :has() 抓手，好把 max-height 放宽（见 style.css）
    <div class={`rs-body${full !== undefined ? ' full' : ''}${className ? ` ${className}` : ''}`}>
      {/* 零高度定位槽：复制钮浮在正文右上角，不占正文一行（定位规则见 style.css .rs-copy-slot） */}
      <div class="rs-copy-slot">
        <CopyButton text={shown} />
      </div>
      <div class="rs-body-tx">{render(shown)}</div>
      {showBar && (
        <div class="rs-body-bar">
          {canLoad && (
            <button
              type="button"
              class="rs-more"
              disabled={loading}
              onClick={(e: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                api!.request(off!, { ...(role ? { role } : {}), ...(tool ? { tool } : {}) });
              }}
            >
              {loading ? tr('ui.loading') : `⇣ ${tr('ui.showFull')}`}
            </button>
          )}
          {state?.phase === 'error' && <span class="rs-body-note bad">{tr('ui.loadFullFailed')}</span>}
          {state?.phase === 'ready' && state.truncated && (
            <span class="rs-body-note">
              {tr('ui.fullTruncated', { shown: state.content.length, total: state.total })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
