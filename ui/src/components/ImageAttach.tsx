/**
 * 消息附件：选取/粘贴 → 立即上传 → 记 rel path。
 * - 截图走 POST /api/projects/:pid/upload（≤5MB、图片白名单），父组件拿 images 里的 rel 随建 issue 提交。
 * - allowFiles 打开后额外支持任意类型附件（≤20MB，POST .../upload/file），rel 随对话 text 帧 files 提交。
 * 两条都用 uploadWithProgress（XHR）上传，上传中在缩略图/文件条上实时显示进度。
 * 挂载期间监听全局 paste（表单打开时直接 ⌘V/长按粘贴即可）：图片进图片、其余文件进附件。
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { uploadChatFile, uploadImage } from '../lib/api';
import { useI18n } from '../i18n/provider';

export interface AttachedImage {
  /** 本地预览（objectURL） */
  url: string;
  name: string;
  /** 上传成功后的 rel path（cwd 相对）；uploading 时为 null */
  rel: string | null;
  error?: string;
  /** 上传进度 0~1；未知（服务端未给总长）时停在 0，UI 退回转圈 */
  progress?: number;
}

export interface AttachedFile {
  /** 本地一次性标识（同名文件也能各自更新/移除） */
  id: string;
  name: string;
  /** 字节数（本地 File.size，用于展示） */
  size: number;
  /** 上传成功后的 rel path（cwd 相对）；uploading 时为 null */
  rel: string | null;
  error?: string;
  /** 上传进度 0~1 */
  progress?: number;
}

/** 字节数 → 紧凑体积（与文件页 fmtSize 同款：纯符号，不进翻译目录） */
function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** 进度百分比（整数，0~100）；未知进度按 0 */
function pct(p: number | undefined): number {
  return Math.round(Math.max(0, Math.min(1, p ?? 0)) * 100);
}

export function ImageAttach({
  projectId,
  images,
  onChange,
  max = 6,
  compact = false,
  leading,
  trailing,
  allowFiles = false,
  files = [],
  onFilesChange,
  maxFiles = 6,
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
  /** 打开「附文件」（任意类型 ≤20MB）——对话输入区用；需同时传 files/onFilesChange */
  allowFiles?: boolean;
  files?: AttachedFile[];
  onFilesChange?: (updater: (prev: AttachedFile[]) => AttachedFile[]) => void;
  maxFiles?: number;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const anyRef = useRef<HTMLInputElement>(null);
  const hint = t('ui.attachHint', { max });
  const fileHint = t('ui.attachFileHint', { max: maxFiles });

  const addFiles = (picked: FileList | File[] | null): void => {
    const pics = [...(picked ?? [])].filter((f) => f.type && f.type.startsWith('image/'));
    for (const f of pics.slice(0, max)) {
      const url = URL.createObjectURL(f);
      const img: AttachedImage = { url, name: f.name || 'image.png', rel: null, progress: 0 };
      onChange((prev) => (prev.length >= max ? prev : [...prev, img]));
      const patch = (fields: Partial<AttachedImage>): void =>
        onChange((prev) => prev.map((x) => (x === img || x.url === url ? { ...x, ...fields } : x)));
      uploadImage(projectId, f, { onProgress: (p) => patch({ progress: p.ratio }) })
        .then((r) => patch({ rel: r.path, progress: 1 }))
        .catch((e: Error) => patch({ error: e.message }));
    }
  };

  const addAttachments = (picked: FileList | File[] | null): void => {
    if (!allowFiles || !onFilesChange) return;
    const list = [...(picked ?? [])];
    for (const f of list.slice(0, maxFiles)) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item: AttachedFile = { id, name: f.name || 'file', size: f.size, rel: null, progress: 0 };
      onFilesChange((prev) => (prev.length >= maxFiles ? prev : [...prev, item]));
      const patch = (fields: Partial<AttachedFile>): void =>
        onFilesChange((prev) => prev.map((x) => (x.id === id ? { ...x, ...fields } : x)));
      uploadChatFile(projectId, f, { onProgress: (p) => patch({ progress: p.ratio }) })
        .then((r) => patch({ rel: r.path, progress: 1 }))
        .catch((e: Error) => patch({ error: e.message }));
    }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const fl = e.clipboardData?.files;
      if (fl && fl.length > 0) {
        const all = [...fl];
        const pics = all.filter((f) => f.type && f.type.startsWith('image/'));
        // 图片进图片、其余进附件（未开 allowFiles 时其余一律忽略，行为与改动前一致）
        const rest = allowFiles && onFilesChange ? all.filter((f) => !pics.includes(f)) : [];
        if (pics.length > 0 || rest.length > 0) {
          e.preventDefault();
          if (pics.length > 0) addFiles(pics);
          if (rest.length > 0) addAttachments(rest);
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, allowFiles]);

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

  const removeFile = (id: string): void => {
    onFilesChange?.((prev) => prev.filter((x) => x.id !== id));
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
        {allowFiles && onFilesChange && (
          <button
            type="button"
            class="attach-btn"
            title={fileHint}
            onClick={() => anyRef.current?.click()}
          >
            📎 {t('ui.attachFile')}
          </button>
        )}
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
        {allowFiles && onFilesChange && (
          <input
            ref={anyRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              addAttachments(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
        )}
      </div>
      {images.length > 0 && (
        <div class="thumbs">
          {images.map((im, i) => {
            const busy = im.rel === null && !im.error;
            return (
              <div key={im.url} class={`thumb${busy ? ' busy' : ''}`} title={im.error ?? im.name}>
                <img src={im.url} alt={im.name} />
                {busy && (
                  <div
                    class="up-prog"
                    role="progressbar"
                    aria-valuenow={pct(im.progress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t('ui.uploadingPercent', { percent: pct(im.progress) })}
                  >
                    <i style={{ width: `${pct(im.progress)}%` }} />
                  </div>
                )}
                <button
                  type="button"
                  class="thumb-x"
                  aria-label={t('ui.removeScreenshot')}
                  onClick={() => remove(i)}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      {files.length > 0 && (
        <div class="fchips">
          {files.map((f) => {
            const busy = f.rel === null && !f.error;
            return (
              <div key={f.id} class={`fchip${busy ? ' busy' : ''}${f.error ? ' err' : ''}`} title={f.error ?? f.name}>
                <span class="fchip-ico">📎</span>
                <span class="fchip-name">{f.name}</span>
                <span class="fchip-size">{busy ? `${pct(f.progress)}%` : fmtSize(f.size)}</span>
                <button
                  type="button"
                  class="fchip-x"
                  aria-label={t('ui.removeFile')}
                  onClick={() => removeFile(f.id)}
                >
                  ✕
                </button>
                {busy && (
                  <div
                    class="up-prog"
                    role="progressbar"
                    aria-valuenow={pct(f.progress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t('ui.uploadingPercent', { percent: pct(f.progress) })}
                  >
                    <i style={{ width: `${pct(f.progress)}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {images.some((im) => im.error) && (
        <div class="err">{t('ui.someUploadsFailed', { error: images.find((im) => im.error)?.error ?? '' })}</div>
      )}
      {files.some((f) => f.error) && (
        <div class="err">{t('ui.someFileUploadsFailed', { error: files.find((f) => f.error)?.error ?? '' })}</div>
      )}
    </div>
  );
}
