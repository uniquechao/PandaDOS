/**
 * FileViewer —— 文件页右侧「编辑/预览」窗口（宽屏右栏 / 窄屏全屏共用）。
 *
 * 按 lib/preview.previewKind(path) 分支：
 *   image/html/pdf → 用 /fs/raw 内联预览（图片 <img> / 网页沙箱 <iframe> / PDF 下载提示）；
 *   其余（text 及无/未知扩展名）→ 尝试拉 /fs/file 进**可编辑 textarea**（沿用 Files 页保存逻辑：
 *     PUT 回写 + 脏标记 + 下载）；后端二进制 415 / 超 1MB 413 → 回落「下载提示」。
 * 自带一条工具栏（文件名 + 保存 + 下载）；path 变化即重载。仅接收非空 path（空态由父组件处理）。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import type { FsFile } from '../lib/types';
import { previewKind } from '../lib/preview';
import { Loading } from './Loaders';
import { toast } from '../lib/toast';

interface Edit {
  content: string;
  orig: string;
}

export function FileViewer({ pid, path }: { pid: number; path: string }) {
  const kind = previewKind(path);
  const previewable = kind === 'image' || kind === 'html' || kind === 'pdf';

  const raw = `/api/projects/${pid}/fs/raw?path=${encodeURIComponent(path)}`;
  const dl = `/api/projects/${pid}/fs/download?path=${encodeURIComponent(path)}`;
  const name = path.split('/').pop() ?? path;

  // 编辑态（仅 text/未知扩展名分支用）
  const [edit, setEdit] = useState<Edit | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  // 二进制/超大：不可编辑，回落下载提示
  const [downloadOnly, setDownloadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  // 防竞态：仅接受「最后一次 path」的异步结果
  const reqPath = useRef(path);

  useEffect(() => {
    reqPath.current = path;
    setEdit(null);
    setErr('');
    setDownloadOnly(false);
    if (previewable) {
      setLoading(false);
      return; // 图片/网页/PDF 无需拉文本内容
    }
    setLoading(true);
    api<FsFile>(`/api/projects/${pid}/fs/file?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (reqPath.current !== path) return; // 已切走，丢弃
        setEdit({ content: r.content, orig: r.content });
      })
      .catch((e: unknown) => {
        if (reqPath.current !== path) return;
        // 415 二进制 / 413 超 1MB → 不可编辑，回落下载
        if (e instanceof ApiError && (e.status === 415 || e.status === 413)) {
          setDownloadOnly(true);
        } else {
          setErr(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (reqPath.current === path) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, path]);

  const dirty = edit !== null && edit.content !== edit.orig;

  const save = async (): Promise<void> => {
    if (!edit || busy || !dirty) return;
    setBusy(true);
    try {
      await api(`/api/projects/${pid}/fs/file?path=${encodeURIComponent(path)}`, 'PUT', {
        content: edit.content,
      });
      setEdit({ content: edit.content, orig: edit.content });
      toast.success('已保存');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSave = edit !== null;

  return (
    <div class="fileviewer">
      <div class="fv-bar">
        <span class="fv-name" title={path}>
          {name}
        </span>
        <div class="fv-acts">
          <a class="btn sm" href={dl} title="下载">
            下载
          </a>
          {canSave && (
            <button class="btn sm primary" disabled={!dirty || busy} onClick={save}>
              {busy ? '保存中…' : dirty ? '保存' : '已保存'}
            </button>
          )}
        </div>
      </div>

      <div class="fv-body">
        {kind === 'image' && <img class="fp-img" src={raw} alt={name} />}
        {kind === 'html' && <iframe class="fp-frame" src={raw} sandbox="" title={name} />}
        {kind === 'pdf' && (
          <div class="fp-dl">
            PDF 文件，请下载后查看。
            <a class="btn sm primary" href={dl}>
              ⬇ 下载 PDF
            </a>
          </div>
        )}

        {!previewable && loading && <Loading />}
        {!previewable && err && (
          <div class="fp-dl">
            {err}
            <a class="btn sm primary" href={dl}>
              ⬇ 下载
            </a>
          </div>
        )}
        {!previewable && downloadOnly && (
          <div class="fp-dl">
            该文件无法在线编辑（二进制或超过 1MB）。
            <a class="btn sm primary" href={dl}>
              ⬇ 下载
            </a>
          </div>
        )}
        {!previewable && edit !== null && (
          <div class="fsedit">
            <textarea
              value={edit.content}
              spellcheck={false}
              onInput={(e) => setEdit({ ...edit, content: e.currentTarget.value })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
