/** 载入指示：动画 spinner + 骨架屏。替代裸「载入中…」文字，给出更专业的等待反馈。 */

export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span class={`spinner${size === 'md' ? '' : ' ' + size}`} role="status" aria-label="载入中" />;
}

/** 居中一行「转圈 + 文案」，用于列表/页面首屏载入 */
export function Loading({ text = '载入中…' }: { text?: string }) {
  return (
    <div class="loadrow">
      <Spinner />
      <span>{text}</span>
    </div>
  );
}

/** 卡片骨架屏（列表首屏占位，避免布局跳动） */
export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} class="skel-card">
          <div class="skel skel-line" style={{ width: '52%' }} />
          <div class="skel skel-line" style={{ width: '82%' }} />
          <div class="skel skel-line" style={{ width: '36%', height: '10px' }} />
        </div>
      ))}
    </div>
  );
}
