/**
 * 截图附件：选取/粘贴 → 立即 POST /api/projects/:pid/upload → 记 rel path。
 * 父组件拿 images 里的 rel 数组随建 issue 提交（issues 路由 images 字段）。
 * 挂载期间监听全局 paste（表单打开时直接 ⌘V/长按粘贴即可）。
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { uploadImage } from '../lib/api';
import { useI18n } from '../i18n/provider';

export interface AttachedImage {
  /** 本地预览（objectURL） */
  url: string;
  name: string;
  /** 上传成功后的 rel path（cwd 相对）；uploading 时为 null */
  rel: string | null;
  error?: string;
}

export function ImageAttach({
  projectId,
  images,
  onChange,
  max = 6,
  compact = false,
  leading,
  trailing,
}: {
  projectId: number;
  images: AttachedImage[];
  onChange: (updater: (prev: AttachedImage[]) => AttachedImage[]) => void;
  max?: number;
  /** 紧凑模式：隐藏行内说明文字（改到按钮 title 悬浮），整行改横向滚动——用于对话输入区与快捷键并排 */
  compact?: boolean;
  /** 行首内联插槽（如连接状态小圆点），在附截图按钮之前 */
  leading?: ComponentChildren;
  /** 附截图按钮右侧的内联插槽（如快捷键条），与按钮同处一行 */
  trailing?: ComponentChildren;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const hint = t('ui.attachHint', { max });

  const addFiles = (files: FileList | File[] | null): void => {
    const pics = [...(files ?? [])].filter((f) => f.type && f.type.startsWith('image/'));
    for (const f of pics.slice(0, max)) {
      const url = URL.createObjectURL(f);
      const img: AttachedImage = { url, name: f.name || 'image.png', rel: null };
      onChange((prev) => (prev.length >= max ? prev : [...prev, img]));
      uploadImage(projectId, f)
        .then((r) => onChange((prev) => prev.map((x) => (x === img || x.url === url ? { ...x, rel: r.path } : x))))
        .catch((e: Error) => onChange((prev) => prev.map((x) => (x === img || x.url === url ? { ...x, error: e.message } : x))));
    }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const fl = e.clipboardData?.files;
      if (fl && fl.length > 0) {
        const pics = [...fl].filter((f) => f.type && f.type.startsWith('image/'));
        if (pics.length > 0) {
          e.preventDefault();
          addFiles(pics);
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const remove = (i: number): void => {
    onChange((prev) => {
      const gone = prev[i];
      if (gone) {
        try {
          URL.revokeObjectURL(gone.url);
        } catch {
          /* noop */
        }
      }
      return prev.filter((_, k) => k !== i);
    });
  };

  return (
    <div class="formcol">
      <div class={`attach-row${compact ? ' attach-row-compact' : ''}`}>
        {leading}
        <button
          type="button"
          class="attach-btn"
          title={compact ? hint : undefined}
          onClick={() => fileRef.current?.click()}
        >
          📷 {t('ui.attachScreenshot')}
        </button>
        {!compact && <span class="attach-hint">{hint}</span>}
        {trailing}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            addFiles(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
      </div>
      {images.length > 0 && (
        <div class="thumbs">
          {images.map((im, i) => (
            <div key={im.url} class={`thumb${im.rel === null && !im.error ? ' busy' : ''}`} title={im.error ?? im.name}>
              <img src={im.url} alt={im.name} />
              <button type="button" class="thumb-x" onClick={() => remove(i)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {images.some((im) => im.error) && (
        <div class="err">{t('ui.someUploadsFailed', { error: images.find((im) => im.error)?.error ?? '' })}</div>
      )}
    </div>
  );
}
