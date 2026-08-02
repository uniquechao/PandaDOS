import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import type { DirListing } from '../lib/types';
import { Modal } from './Modal';
import { useI18n } from '../i18n/provider';

export interface ExecutorPreviewConnection {
  name: string;
  host: string;
  port: number;
  sshUser: string;
  keyRef: string;
}

/** 浏览执行机文件系统的目录选择器；权限边界完全由后端响应中的 root 强制。 */
export function DirPicker({
  executorId,
  previewConnection,
  start,
  onClose,
  onPick,
}: {
  executorId?: number;
  previewConnection?: ExecutorPreviewConnection;
  start: string;
  onClose(): void;
  onPick(path: string): void;
}) {
  const { t } = useI18n();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const browse = (path?: string): void => {
    setErr('');
    setListing(null);
    const request =
      executorId !== undefined
        ? api<DirListing>(
            `/api/executors/${executorId}/fs${path !== undefined ? `?path=${encodeURIComponent(path)}` : ''}`,
          )
        : api<DirListing>(
            '/api/admin/executors/preview/fs',
            'POST',
            { ...previewConnection, ...(path !== undefined ? { path } : {}) },
          );
    request
      .then(setListing)
      .catch((e: Error) => {
        setErr(e.message);
        setListing({ ok: false, path: path ?? '', root: '', dirs: [] });
      });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => browse(start.trim() || undefined), []);

  const cur = listing?.path ?? '';
  const root = listing?.root ?? '/';
  const parent = cur.slice(0, Math.max(1, cur.lastIndexOf('/')));
  const canUp = !!cur && cur !== root && cur !== '/';
  const mkdir = async (): Promise<void> => {
    const name = newName.trim();
    if (!name || !cur || busy || executorId === undefined) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ ok: boolean; path: string }>(
        `/api/executors/${executorId}/fs/mkdir`,
        'POST',
        { path: cur, name },
      );
      setNewName('');
      browse(r.path);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('ui.directoryPicker')} onClose={onClose}>
      <div class="formcol">
        <div class="row" style={{ gap: 6, alignItems: 'center' }}>
          <button class="btn sm" disabled={!canUp} onClick={() => browse(parent)}>↑ {t('ui.parentDirectory')}</button>
          <code class="grow" style={{ fontSize: 12, wordBreak: 'break-all' }}>{cur || '…'}</code>
        </div>
        {listing?.missing && <div class="mut small">{t('ui.directoryMissing')}</div>}
        <div class="dir-picker-list">
          {listing === null && !err && <div class="mut small">{t('ui.reading')}</div>}
          {listing && listing.dirs.length === 0 && !listing.missing && (
            <div class="mut small">{t('ui.noSubdirectories')}</div>
          )}
          {listing?.dirs.map((d) => (
            <div
              key={d}
              class="card click"
              style={{ margin: 0, padding: '7px 10px' }}
              onClick={() => browse(cur === '/' ? `/${d}` : `${cur}/${d}`)}
            >
              📁 {d}
            </div>
          ))}
          {listing?.truncated && <div class="mut small">{t('ui.tooManyDirectories')}</div>}
        </div>
        {executorId !== undefined && (
          <div class="row dir-picker-create">
            <input
              class="grow"
              value={newName}
              onInput={(e) => setNewName(e.currentTarget.value)}
              placeholder={t('ui.newDirectoryName')}
              onKeyDown={(e) => e.key === 'Enter' && void mkdir()}
            />
            <button class="btn sm" disabled={!newName.trim() || busy || !cur} onClick={() => void mkdir()}>
              {t('ui.create')}
            </button>
          </div>
        )}
        {err && <div class="err">{err}</div>}
      </div>
      <div class="mbtns">
        <button class="btn" onClick={onClose}>{t('ui.cancel')}</button>
        <button class="btn primary" disabled={!cur} onClick={() => onPick(cur)}>{t('ui.useDirectory')}</button>
      </div>
    </Modal>
  );
}
