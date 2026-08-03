/** Git 二进制图片改动预览：按状态展示新侧、旧侧或前后对照，并复用全屏灯箱。 */
import { useState } from 'preact/hooks';
import { useI18n } from '../i18n/provider';
import { ImageLightbox } from './ImageLightbox';

export interface GitImageUrls {
  old?: string;
  new?: string;
}

/**
 * raw 端点 + 文件元数据 → 应展示的新旧侧 URL。
 * A/? 只有新侧，D 只有旧侧，其余状态展示对照；oldPath 用于重命名前版本。
 */
export function gitImageUrls(
  endpoint: string,
  path: string,
  oldPath: string | undefined,
  code: string,
): GitImageUrls {
  const status = code[0] ?? 'M';
  const query = (side: 'new' | 'old'): string => {
    const q = new URLSearchParams({ path, side });
    if (oldPath) q.set('old', oldPath);
    return `${endpoint}?${q}`;
  };
  return {
    ...(status !== 'D' ? { new: query('new') } : {}),
    ...(status !== 'A' && status !== '?' ? { old: query('old') } : {}),
  };
}

interface Version {
  side: 'old' | 'new';
  url: string;
  path: string;
}

function ImageVersion({ version, onOpen }: { version: Version; onOpen: (version: Version) => void }) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = version.path.split('/').pop() || version.path;
  const label = t(version.side === 'old' ? 'git.imageBefore' : 'git.imageAfter');

  return (
    <section class="git-img-version" aria-label={label}>
      <div class="git-img-version-hd">
        <span class={`git-img-side ${version.side}`}>{label}</span>
        <a
          class="git-img-download"
          href={version.url}
          download={name}
          title={t('git.downloadImage', { name })}
          aria-label={t('git.downloadImage', { name })}
        >
          ↓
        </a>
      </div>
      <div class="git-img-stage">
        {!loaded && !failed && <div class="git-img-state">{t('ui.loading')}</div>}
        {failed ? (
          <div class="git-img-state" role="status">
            <span>{t('ui.imageLoadFailed')}</span>
            <a class="btn sm" href={version.url} download={name}>
              {t('ui.downloadToView')}
            </a>
          </div>
        ) : (
          <button
            type="button"
            class={`git-img-open${loaded ? ' loaded' : ''}`}
            aria-label={t('git.openImage', { name })}
            onClick={() => onOpen(version)}
          >
            <img
              src={version.url}
              alt=""
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          </button>
        )}
      </div>
    </section>
  );
}

export function GitImagePreview({
  path,
  oldPath,
  urls,
}: {
  path: string;
  oldPath?: string;
  urls: GitImageUrls;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Version | null>(null);
  const versions: Version[] = [];
  if (urls.old) versions.push({ side: 'old', url: urls.old, path: oldPath || path });
  if (urls.new) versions.push({ side: 'new', url: urls.new, path });

  return (
    <div class={`git-img-preview${versions.length === 1 ? ' single' : ''}`}>
      {versions.map((version) => (
        <ImageVersion key={`${version.side}:${version.url}`} version={version} onOpen={setOpen} />
      ))}
      {open && (
        <ImageLightbox
          src={open.url}
          downloadUrl={open.url}
          name={open.path.split('/').pop() || open.path}
          sourceLabel={open.path}
          ariaLabel={t('git.viewImage', { name: open.path.split('/').pop() || open.path })}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
