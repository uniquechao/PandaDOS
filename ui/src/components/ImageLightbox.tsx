/**
 * components/ImageLightbox —— 全屏图片灯箱（可复用）。
 *
 * 给定 pid + 项目内相对路径，用 GET /api/projects/:pid/fs/raw?path= 内联渲染 <img>
 * （该端点按扩展名给 image/*，截图落在项目 cwd 内的 .mando/uploads/ 下，直接可服务，
 * 子任务 1 已核实后端无需改动）。
 *
 * 交互：✕ / 点背景（图片以外的空白）/ Esc 关闭；顶栏带下载链接（走 fs/download 强制附件）。
 * 移动端：stage 为可滚动容器（style.css 里 touch-action: pinch-zoom），支持原生双指缩放平移。
 * 挂载期间锁背景滚动，卸载还原。
 *
 * createPortal 挂到 document.body：工作台各层容器的入场动画（fade-in + fill-mode:both）
 * 处于 filling 状态时持续建立层叠上下文，会把子树里 fixed 的 z-index:200 困住，
 * 让 .bhead/.id-head（z-index:5）反压在灯箱之上（issue #79）；传送出去后只与根上下文比大小。
 */
import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';

export function ImageLightbox({
  pid,
  path,
  onClose,
}: {
  pid: number;
  /** 项目 cwd 相对路径（如 .mando/uploads/<子目录>/<名>） */
  path: string;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const q = encodeURIComponent(path);
  const raw = `/api/projects/${pid}/fs/raw?path=${q}`;
  const dl = `/api/projects/${pid}/fs/download?path=${q}`;
  const name = path.split('/').pop() || path;

  // Esc 关闭 + 挂载期间锁背景滚动
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div class="lightbox-bg" role="dialog" aria-modal="true" aria-label={`查看截图 ${name}`}>
      <div class="lightbox-bar">
        <span class="lightbox-name" title={path}>
          🖼 {name}
        </span>
        <a class="lightbox-dl" href={dl} title="下载原图" download>
          ⬇
        </a>
        <button type="button" class="lightbox-x" title="关闭（Esc）" onClick={onClose}>
          ✕
        </button>
      </div>
      <div
        class="lightbox-stage"
        onClick={(e) => {
          // 点图片以外的空白（stage 本身）关闭；点到图片不关
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {!loaded && !failed && <div class="lightbox-hint">加载中…</div>}
        {failed ? (
          <div class="lightbox-hint">
            图片加载失败。
            <a class="btn sm primary" href={dl} download>
              ⬇ 下载查看
            </a>
          </div>
        ) : (
          <img
            class="lightbox-img"
            src={raw}
            alt={name}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
