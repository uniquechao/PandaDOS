/**
 * FileViewer —— 工作区右侧「文件内容 / 预览 / 编辑」（宽屏右栏 / 窄屏全屏共用，issue #388 扩展）。
 *
 * 按 lib/preview.previewKind(path) 分支：
 *   image → <img>（/fs/raw）；
 *   pdf   → 内嵌预览（/fs/raw，浏览器 PDF 查看器）+ 下载；
 *   html  → 三种打开方式，显式标注当前模式：
 *           · 安全预览：/fs/raw + sandbox="" 的 iframe（无脚本，适合单文件）；
 *           · 完整网页预览：POST /fs/preview 签发短时令牌，iframe 指向隔离预览服务 /preview/<令牌>/<路径>，
 *             相对 CSS/图片/JS 按 HTML 所在目录加载执行；预览文档是 opaque origin，拿不到控制面登录态。
 *             提供重新加载（重新签发令牌）与新窗口打开；
 *           · 源码：同下方代码文件的「高亮查看 / 源码编辑」。
 *   代码 / 脚本 / 配置 / 数据文件（lib/highlight.langOfPath 认得的）→ 默认 CodeView 只读高亮（token 作文本节点渲染，
 *           天然转义；超大回落纯文本），显式切到「源码 / 编辑」才出 textarea；编辑中切回高亮看的是未保存内容。
 *   其余（text / markdown / 未知扩展名）→ 拉 /fs/file 进可编辑 textarea；Markdown 另有「渲染 / 源码」切换。
 *   后端二进制 415 / 超 1MB 413 → 显示类型与大小 + 下载，不假装可编辑。
 * 保存带 baseMtimeMs：文件在打开后被代理或他人改过 → 409，提示重新载入而不是覆盖。
 * 未保存保护：onDirtyChange 通知父级、handleRef 暴露 save()，由父级在切换文件/工作位置/离开前询问
 * 保存 / 放弃 / 继续编辑；另挂 beforeunload 防关页丢稿。文件被移动或删除 → 「文件已移动或不存在」+ 回父目录。
 */
import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import type { FsFile, FsStat } from '../lib/types';
import { extOf, previewKind } from '../lib/preview';
import { langOfPath } from '../lib/highlight';
import { CodeView } from './CodeView';
import { fmtSize } from '../lib/fmt';
import { Loading } from './Loaders';
import { Markdown } from './Markdown';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/provider';

interface Edit {
  content: string;
  orig: string;
  mtimeMs: number | null;
}

/** 父级持有的控制柄：未保存保护用 */
export interface FileViewerHandle {
  dirty: () => boolean;
  save: () => Promise<boolean>;
}

type HtmlMode = 'safe' | 'full' | 'source';

/**
 * 预览页 iframe 的沙箱：允许脚本，但**不给 allow-same-origin**（与服务端 CSP sandbox 双保险）；
 * 也不给 allow-popups / allow-forms，免得页面脚本借弹窗或表单把 URL 里的预览令牌带出去。
 */
export const FULL_PREVIEW_SANDBOX = 'allow-scripts allow-modals allow-downloads';

export function isMarkdownPath(path: string): boolean {
  const e = extOf(path);
  return e === 'md' || e === 'markdown';
}

export function FileViewer({
  pid,
  path,
  mobile = false,
  onDirtyChange,
  handleRef,
  onSaved,
  onOpenParent,
  toolbar,
  bottomBar,
}: {
  pid: number;
  path: string;
  mobile?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  handleRef?: RefObject<FileViewerHandle | null>;
  /** 保存成功（父级刷新 Git 状态） */
  onSaved?: () => void;
  /** 文件不存在时「回到父目录」 */
  onOpenParent?: () => void;
  /** 头部附加操作（复制路径 / 更多） */
  toolbar?: ComponentChildren;
  /** 手机底部固定操作条附加项（复制路径 / 更多）；编辑/预览切换由本组件放在同一条上 */
  bottomBar?: ComponentChildren;
}) {
  const { t } = useI18n();
  const kind = previewKind(path);
  const markdown = isMarkdownPath(path);
  // 需要拉文本：除图片/PDF 外都拉（HTML 供「源码」模式用，预览本身不依赖它）
  const needsText = kind !== 'image' && kind !== 'pdf';
  const lang = markdown ? null : langOfPath(path);

  const raw = `/api/projects/${pid}/fs/raw?path=${encodeURIComponent(path)}`;
  const dl = `/api/projects/${pid}/fs/download?path=${encodeURIComponent(path)}`;
  const name = path.split('/').pop() ?? path;

  const [edit, setEdit] = useState<Edit | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [missing, setMissing] = useState(false);
  // 二进制/超大：不可编辑，展示类型与大小后下载
  const [downloadOnly, setDownloadOnly] = useState<{ size: number | null; reason: 'binary' | 'large' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [mdMode, setMdMode] = useState<'render' | 'source'>('render');
  const [codeMode, setCodeMode] = useState<'view' | 'edit'>('view');
  const [htmlMode, setHtmlMode] = useState<HtmlMode>('safe');
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [fullErr, setFullErr] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  // 防竞态：仅接受「最后一次 path」的异步结果
  const reqPath = useRef(path);

  const load = (): void => {
    reqPath.current = path;
    setEdit(null);
    setErr('');
    setMissing(false);
    setDownloadOnly(null);
    setConflict(false);
    if (!needsText) {
      setLoading(false);
      // 预览类也要确认文件还在（深链到已移动文件时给出明确提示）
      api<FsStat>(`/api/projects/${pid}/fs/stat?path=${encodeURIComponent(path)}`)
        .then((s) => { if (reqPath.current === path && !s.exists) setMissing(true); })
        .catch(() => {});
      return;
    }
    setLoading(true);
    api<FsFile>(`/api/projects/${pid}/fs/file?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (reqPath.current !== path) return; // 已切走，丢弃
        setEdit({ content: r.content, orig: r.content, mtimeMs: r.mtimeMs ?? null });
      })
      .catch((e: unknown) => {
        if (reqPath.current !== path) return;
        if (e instanceof ApiError && e.status === 404) {
          setMissing(true);
        } else if (e instanceof ApiError && (e.status === 415 || e.status === 413)) {
          // 415 二进制 / 413 超 1MB → 不可编辑，补查大小后回落下载
          const reason = e.status === 415 ? 'binary' : 'large';
          setDownloadOnly({ size: null, reason });
          api<FsStat>(`/api/projects/${pid}/fs/stat?path=${encodeURIComponent(path)}`)
            .then((s) => { if (reqPath.current === path) setDownloadOnly({ size: s.size ?? null, reason }); })
            .catch(() => {});
        } else {
          setErr(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (reqPath.current === path) setLoading(false);
      });
  };

  useEffect(() => {
    load();
    setMdMode('render');
    setCodeMode('view');
    setHtmlMode('safe');
    setFullUrl(null);
    setFullErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, path]);

  const dirty = edit !== null && edit.content !== edit.orig;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // 关页/刷新前的浏览器级兜底
  useEffect(() => {
    if (!dirty) return;
    const on = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, [dirty]);

  const save = async (): Promise<boolean> => {
    if (!edit || busy) return false;
    if (!dirty) return true;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; mtimeMs?: number | null }>(
        `/api/projects/${pid}/fs/file?path=${encodeURIComponent(path)}`,
        'PUT',
        { content: edit.content, ...(edit.mtimeMs !== null ? { baseMtimeMs: edit.mtimeMs } : {}) },
      );
      setEdit({ content: edit.content, orig: edit.content, mtimeMs: r.mtimeMs ?? null });
      setConflict(false);
      setFrameKey((k) => k + 1); // HTML 预览跟着刷新到新内容
      toast.success(t('ui.saved'));
      onSaved?.();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'workspace.file_changed') setConflict(true);
      toast.error(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (handleRef) handleRef.current = { dirty: () => dirty, save };

  // 完整网页预览：切到 full 或「重新加载」时签发新令牌
  const openFull = (): void => {
    setFullErr('');
    setFullUrl(null);
    api<{ ok: boolean; url: string }>(`/api/projects/${pid}/fs/preview?path=${encodeURIComponent(path)}`, 'POST')
      .then((r) => {
        if (reqPath.current !== path) return;
        setFullUrl(r.url);
        setFrameKey((k) => k + 1);
      })
      .catch((e: Error) => { if (reqPath.current === path) setFullErr(e.message); });
  };

  const canSave = edit !== null;
  // 文本区是否在显示：HTML 只在「源码」模式显示
  const textShown = kind !== 'html' || htmlMode === 'source';
  const editable = textShown && edit !== null;
  const showSource = !markdown || mdMode === 'source';
  const codeViewOn = lang !== null && codeMode === 'view';
  // 当前显示的是可输入的编辑器（保存按钮常驻）；其它视图下只在有未保存内容时露出保存
  const inEditor = editable && (markdown ? mdMode === 'source' : !codeViewOn);

  const modeToggle = markdown && edit !== null && (
    <div class="seg ws-seg" role="group" aria-label={t('ws.viewMode')}>
      <button type="button" class={`seg-btn${mdMode === 'render' ? ' on' : ''}`} aria-pressed={mdMode === 'render'} onClick={() => setMdMode('render')}>
        {t('ws.rendered')}
      </button>
      <button type="button" class={`seg-btn${mdMode === 'source' ? ' on' : ''}`} aria-pressed={mdMode === 'source'} onClick={() => setMdMode('source')}>
        {t('ws.sourceEdit')}
      </button>
    </div>
  );

  const codeToggle = lang !== null && editable && (
    <div class="seg ws-seg" role="group" aria-label={t('ws.viewMode')}>
      <button type="button" class={`seg-btn${codeMode === 'view' ? ' on' : ''}`} aria-pressed={codeMode === 'view'} onClick={() => setCodeMode('view')}>
        {t('ws.codeView')}
      </button>
      <button type="button" class={`seg-btn${codeMode === 'edit' ? ' on' : ''}`} aria-pressed={codeMode === 'edit'} onClick={() => setCodeMode('edit')}>
        {t('ws.sourceEdit')}
      </button>
    </div>
  );

  const htmlToggle = kind === 'html' && !missing && (
    <div class="seg ws-seg" role="group" aria-label={t('ws.htmlMode')}>
      <button type="button" class={`seg-btn${htmlMode === 'safe' ? ' on' : ''}`} aria-pressed={htmlMode === 'safe'} onClick={() => setHtmlMode('safe')}>
        {t('ws.htmlSafe')}
      </button>
      <button
        type="button"
        class={`seg-btn${htmlMode === 'full' ? ' on' : ''}`}
        aria-pressed={htmlMode === 'full'}
        onClick={() => {
          setHtmlMode('full');
          openFull();
        }}
      >
        {t('ws.htmlFull')}
      </button>
      <button type="button" class={`seg-btn${htmlMode === 'source' ? ' on' : ''}`} aria-pressed={htmlMode === 'source'} onClick={() => setHtmlMode('source')}>
        {t('ws.htmlSource')}
      </button>
    </div>
  );

  return (
    <div class={`fileviewer${mobile ? ' mobile' : ''}`}>
      <div class="fv-bar">
        <span class="fv-name" title={path}>
          {name}
          {dirty && <span class="fv-dirty" title={t('ws.unsaved')} aria-label={t('ws.unsaved')}> ●</span>}
        </span>
        <div class="fv-acts">
          {!mobile && modeToggle}
          {htmlToggle}
          {!mobile && codeToggle}
          {!mobile && toolbar}
          {!mobile && !missing && (
            <a class="btn sm" href={dl} title={t('ui.download')}>
              {t('ui.download')}
            </a>
          )}
          {canSave && (inEditor || dirty) && (
            <button class="btn sm primary" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? t('ui.saving') : dirty ? t('ui.save') : t('ui.saved')}
            </button>
          )}
        </div>
      </div>

      {conflict && (
        <div class="ws-banner warn" role="alert">
          {t('ws.fileChangedOnDisk')}
          <button class="btn sm" onClick={load}>{t('ws.reloadDiscard')}</button>
        </div>
      )}

      <div class="fv-body">
        {missing && (
          <div class="fp-dl">
            {t('ws.fileMissing')}
            {onOpenParent && (
              <button class="btn sm primary" onClick={onOpenParent}>
                {t('ws.openParent')}
              </button>
            )}
          </div>
        )}
        {!missing && kind === 'image' && <img class="fp-img" src={raw} alt={name} />}
        {!missing && kind === 'html' && htmlMode === 'safe' && (
          <>
            <div class="ws-mode-note mut small">{t('ws.htmlSafeNote')}</div>
            <iframe key={frameKey} class="fp-frame" src={raw} sandbox="" title={name} />
          </>
        )}
        {!missing && kind === 'html' && htmlMode === 'full' && (
          <>
            <div class="ws-mode-note small">
              <span class="badge b-blue">{t('ws.htmlFull')}</span>
              <span class="mut">{t('ws.htmlFullNote')}</span>
              <button class="btn sm" onClick={openFull}>↻ {t('ws.reload')}</button>
              {fullUrl && (
                <a class="btn sm" href={fullUrl} target="_blank" rel="noopener noreferrer">
                  ↗ {t('ws.openNewWindow')}
                </a>
              )}
            </div>
            {fullErr && <div class="err">{fullErr}</div>}
            {!fullUrl && !fullErr && <Loading />}
            {fullUrl && (
              <iframe
                key={frameKey}
                class="fp-frame"
                src={fullUrl}
                sandbox={FULL_PREVIEW_SANDBOX}
                referrerpolicy="no-referrer"
                title={name}
              />
            )}
          </>
        )}
        {!missing && kind === 'pdf' && (
          <iframe class="fp-frame fp-pdf" src={raw} title={name} />
        )}

        {textShown && loading && <Loading />}
        {textShown && err && (
          <div class="fp-dl">
            {err}
            <a class="btn sm primary" href={dl}>
              ⬇ {t('ui.download')}
            </a>
          </div>
        )}
        {textShown && downloadOnly && (
          <div class="fp-dl">
            <div>{downloadOnly.reason === 'binary' ? t('ws.binaryFile') : t('ws.largeFile')}</div>
            <div class="mut small">
              {t('ws.fileTypeSize', { type: extOf(path) || '—', size: downloadOnly.size === null ? '—' : fmtSize(downloadOnly.size) })}
            </div>
            <a class="btn sm primary" href={dl}>
              ⬇ {t('ui.download')}
            </a>
          </div>
        )}
        {editable && markdown && !showSource && (
          <div class="ws-md-render">
            <Markdown text={edit!.content} />
          </div>
        )}
        {editable && showSource && codeViewOn && <CodeView text={edit!.content} lang={lang} name={name} />}
        {editable && showSource && !codeViewOn && (
          <div class="fsedit">
            <textarea
              value={edit!.content}
              spellcheck={false}
              aria-label={t('ws.editorLabel', { name })}
              onInput={(e) => setEdit({ ...edit!, content: e.currentTarget.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          </div>
        )}
      </div>

      {mobile && (
        <div class="ws-bottom-bar">
          {bottomBar}
          {lang !== null && editable && (
            <button type="button" class="btn sm" onClick={() => setCodeMode((m) => (m === 'view' ? 'edit' : 'view'))}>
              {codeMode === 'view' ? t('ws.sourceEdit') : t('ws.codeView')}
            </button>
          )}
          {markdown && edit !== null && (
            <button
              type="button"
              class="btn sm"
              onClick={() => setMdMode((m) => (m === 'render' ? 'source' : 'render'))}
            >
              {mdMode === 'render' ? t('ws.sourceEdit') : t('ws.rendered')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
