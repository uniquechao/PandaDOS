/**
 * components/ImageLightbox —— 全屏图片灯箱（可复用）。
 *
 * 默认给定 pid + 项目内相对路径读取 /fs/raw；也可传入受保护的 src/downloadUrl，
 * 供 Git 历史图片等不在当前工作树中的原始字节复用同一灯箱交互。
 * （该端点按扩展名给 image/*，截图落在项目 cwd 内的 .panda/uploads/ 下，直接可服务，
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
import { useI18n } from '../i18n/provider';

interface LightboxBase {
  onClose: () => void;
  ariaLabel?: string;
}

type ImageLightboxProps = LightboxBase & (
  | {
      pid: number;
      /** 项目 cwd 相对路径（如 .panda/uploads/<子目录>/<名>） */
      path: string;
    }
  | {
      src: string;
      downloadUrl: string;
      name: string;
      sourceLabel?: string;
    }
);

export function ImageLightbox(props: ImageLightboxProps) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const projectFile = 'pid' in props;
  const path = projectFile ? props.path : props.sourceLabel ?? props.name;
  const q = projectFile ? encodeURIComponent(props.path) : '';
  const raw = projectFile ? `/api/projects/${props.pid}/fs/raw?path=${q}` : props.src;
  const dl = projectFile ? `/api/projects/${props.pid}/fs/download?path=${q}` : props.downloadUrl;
  const name = projectFile ? props.path.split('/').pop() || props.path : props.name;

  // Esc 关闭 + 挂载期间锁背景滚动
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [props.onClose]);

  return createPortal(
    <div class="lightbox-bg" role="dialog" aria-modal="true" aria-label={props.ariaLabel ?? t('ui.viewScreenshot', { name })}>
      <div class="lightbox-bar">
        <span class="lightbox-name" title={path}>
          🖼 {name}
        </span>
        <a class="lightbox-dl" href={dl} title={t('ui.downloadOriginal')} download>
          ⬇
        </a>
        <button type="button" class="lightbox-x" title={`${t('action.close')} (Esc)`} onClick={props.onClose}>
          ✕
        </button>
      </div>
      <div
        class="lightbox-stage"
        onClick={(e) => {
          // 点图片以外的空白（stage 本身）关闭；点到图片不关
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        {!loaded && !failed && <div class="lightbox-hint">{t('ui.loading')}</div>}
        {failed ? (
          <div class="lightbox-hint">
            {t('ui.imageLoadFailed')}
            <a class="btn sm primary" href={dl} download>
              ⬇ {t('ui.downloadToView')}
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
