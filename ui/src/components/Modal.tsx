/** 通用弹窗：窄屏底部弹出（拇指区），宽屏居中。
 * createPortal 挂到 document.body：避免工作台容器 filling 动画建立的层叠上下文
 * 困住 fixed 遮罩、被 .bhead/.id-head（z-index:5）反压（同 ImageLightbox，issue #79）。 */
import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';

export function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  /** 桌面加宽（列表型面板不挤爆换行）；窄屏仍是底部抽屉，不受影响 */
  wide?: boolean;
  children: ComponentChildren;
}) {
  return createPortal(
    <div
      class="modal-bg"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class={wide ? 'modal wide' : 'modal'}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}
