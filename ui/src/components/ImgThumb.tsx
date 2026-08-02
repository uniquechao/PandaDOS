/**
 * components/ImgThumb —— 可点缩略图（可复用；原内嵌于 views/IssueDetail.tsx，抽出共享）。
 *
 * 拉 GET /api/projects/:pid/fs/raw?path= 内联渲染，点击调用 onOpen(path) 打开灯箱看原图。
 * 图片加载失败（文件被删/执行机不可达等）时降级回原「🖼 路径」文字 chip，仍可点开（灯箱内给下载兜底）。
 * 传 onRemove 时右上角显示 ✕ 移除按钮（编辑弹窗用）——用同级按钮而非嵌套，避免 button 套 button。
 */
import { useState } from 'preact/hooks';
import { useI18n } from '../i18n/provider';

export function ImgThumb({
  pid,
  path,
  onOpen,
  onRemove,
}: {
  pid: number;
  path: string;
  onOpen: (path: string) => void;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const raw = `/api/projects/${pid}/fs/raw?path=${encodeURIComponent(path)}`;
  return (
    <span class="imgthumb-wrap">
      <button
        type="button"
        class={failed ? 'imgchip' : 'imgthumb'}
        title={path}
        onClick={() => onOpen(path)}
      >
        {failed ? (
          <span>🖼 {path}</span>
        ) : (
          <img src={raw} alt={path} loading="lazy" onError={() => setFailed(true)} />
        )}
      </button>
      {onRemove && (
        <button type="button" class="imgthumb-x" title={t('ui.removeScreenshot')} onClick={onRemove}>
          ✕
        </button>
      )}
    </span>
  );
}
