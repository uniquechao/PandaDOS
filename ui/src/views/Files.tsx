/**
 * 文件浏览页（项目「文件」页）——VSCode 风格分栏改造：
 *  - 宽屏（useWide ≥960px）：左「可展开文件树」 | 可拖拽分隔条 | 右「编辑/预览」窗口三段布局。
 *    文件树宽度沿用 issuelist 上限 [260,400]，独立持久化（lib/treewidth）。
 *  - 窄屏：保留原「面包屑 + 单层目录列表，点文件进全屏」交互，全屏改用 FileViewer 渲染
 *    （顺带支持图片/网页/PDF 预览，不止文本编辑）。
 * 上传落「当前所在目录」：窄屏=正在浏览的目录 rel；宽屏=当前打开文件的父目录（无则根）。
 * 头部面包屑显示当前打开文件的完整路径。文本读写/预览/下载端点见 web/routes/files.ts。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, uploadWithProgress } from '../lib/api';
import { nav } from '../lib/router';
import { timeAgo } from '../lib/fmt';
import type { FsEntry, FsList, FsUploadResult, Project } from '../lib/types';
import { Loading } from '../components/Loaders';
import { FileTree } from '../components/FileTree';
import { FileViewer } from '../components/FileViewer';
import { ListSplitter } from '../components/ListSplitter';
import { useWide } from '../lib/useWide';
import { useTreeWidth } from '../lib/treewidth';
import { joinChildPath, treeIcon } from '../lib/filetree';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/provider';

function fmtSize(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** 取相对路径的父目录（'a/b/c'→'a/b'；'a'→''；null→''） */
function parentDir(p: string | null): string {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

export function FilesView({ pid }: { pid: number }) {
  const { t } = useI18n();
  const wide = useWide();
  const treeW = useTreeWidth();
  const splitRef = useRef<HTMLDivElement>(null); // .wb-split 容器 ref，供分隔条换算左栏像素宽

  const [project, setProject] = useState<Project | null>(null);
  // 当前打开/选中的文件相对路径（宽窄两态共用）；null = 未选
  const [selected, setSelected] = useState<string | null>(null);
  // 上传成功等外部变更信号：递增以驱动文件树重拉
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(0); // 上传进度 0~100（整数）；lengthComputable=false 时停在 0
  const fileInput = useRef<HTMLInputElement>(null);

  // 窄屏目录浏览态（宽屏走文件树、忽略这些）
  const [rel, setRel] = useState('');
  const [list, setList] = useState<FsList | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api<Project>(`/api/projects/${pid}`).then(setProject).catch(() => {});
  }, [pid]);

  const loadList = (p: string): void => {
    setErr('');
    api<FsList>(`/api/projects/${pid}/fs?path=${encodeURIComponent(p)}`)
      .then((r) => {
        setList(r);
        setRel(r.path);
      })
      .catch((e: Error) => setErr(e.message));
  };

  // 首挂载 / 切项目：重置
  useEffect(() => {
    setSelected(null);
    setList(null);
    loadList('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const enterDir = (name: string): void => {
    setList(null);
    loadList(joinChildPath(rel, name));
  };

  const downloadUrl = (p: string): string =>
    `/api/projects/${pid}/fs/download?path=${encodeURIComponent(p)}`;

  // 上传目标目录：宽屏=当前打开文件父目录（无则根）；窄屏=正在浏览的目录
  const uploadDir = wide ? parentDir(selected) : rel;

  // 上传走 XHR 底座（fetch 拿不到上传进度）：进度实时进 prog，成败都复位 busy/prog
  const uploadFile = async (f: File): Promise<void> => {
    setBusy(true);
    setProg(0);
    try {
      const j = await uploadWithProgress<FsUploadResult>(
        `/api/projects/${pid}/fs/upload?path=${encodeURIComponent(uploadDir)}`,
        f,
        f.name,
        { onProgress: (p) => setProg(Math.round(p.ratio * 100)) },
      );
      toast.success(t('view.uploaded', { name: j.name }));
      if (wide) setReload((n) => n + 1); // 刷新文件树
      else loadList(rel); // 刷新当前目录列表
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      setProg(0);
    }
  };

  // 头部：当前打开文件的完整路径面包屑（只读）
  const openSegs = selected ? selected.split('/') : [];
  const fileCrumbs = selected && (
    <div class="fsbar">
      <span class="crumb-seg mut">📄</span>
      {openSegs.map((s, i) => (
        <span key={i} class="crumb-seg">
          {i > 0 && <span class="mut">/</span>}
          <span class={`crumb${i === openSegs.length - 1 ? ' cur' : ''}`}>{s}</span>
        </span>
      ))}
    </div>
  );

  // 窄屏目录导航面包屑（可点击跳转）
  const segs = rel ? rel.split('/') : [];
  const dirCrumbs = (
    <div class="fsbar">
      <button class="crumb" onClick={() => { setList(null); loadList(''); }}>
        ⌂
      </button>
      {segs.map((s, i) => (
        <span key={i} class="crumb-seg">
          <span class="mut">/</span>
          <button
            class={`crumb${i === segs.length - 1 ? ' cur' : ''}`}
            onClick={() => { setList(null); loadList(segs.slice(0, i + 1).join('/')); }}
          >
            {s}
          </button>
        </span>
      ))}
    </div>
  );

  // 上传按钮是否显示：宽屏恒显示；窄屏仅在目录列表态（未进全屏）显示
  const showUpload = wide || !selected;

  return (
    <div class="fullcol">
      <div class="bhead">
        <div class="bhead-row">
          <button
            class="back"
            onClick={() => (!wide && selected ? setSelected(null) : nav(`/p/${pid}`))}
          >
            ‹
          </button>
          <span class="btitle">{project?.name ?? t('view.projectFallback', { id: pid })} · {t('view.files')}</span>
          <div class="bacts">
            {showUpload && (
              <button class="btn sm fs-up" disabled={busy} onClick={() => fileInput.current?.click()}>
                {busy ? (prog > 0 ? `${prog}%` : t('ui.uploading')) : `⇧ ${t('ui.upload')}`}
                {busy && (
                  <span
                    class="up-prog"
                    role="progressbar"
                    aria-valuenow={prog}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t('ui.uploadingPercent', { percent: prog })}
                  >
                    <i style={{ width: `${prog}%` }} />
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
        {err && <div class="err">{err}</div>}
      </div>

      {/* 头部面包屑：显示当前打开文件路径（宽屏选中时、窄屏进全屏时均显） */}
      {fileCrumbs}

      {wide ? (
        <div class="wb-split" ref={splitRef}>
          <div
            class="wb-list-col"
            style={treeW.width != null ? { width: treeW.width, maxWidth: treeW.width } : undefined}
          >
            <FileTree
              pid={pid}
              selectedPath={selected}
              onSelectFile={setSelected}
              reloadToken={reload}
            />
          </div>
          <ListSplitter containerRef={splitRef} list={treeW} label={t('view.fileTreeWidth')} />
          <div class="wb-main">
            {selected ? (
              <FileViewer key={selected} pid={pid} path={selected} />
            ) : (
              <div class="gd-empty">← {t('view.chooseFile')}</div>
            )}
          </div>
        </div>
      ) : selected ? (
        // 窄屏「点文件进全屏」：整屏 FileViewer
        <div class="wb-list-full">
          <FileViewer key={selected} pid={pid} path={selected} />
        </div>
      ) : (
        // 窄屏目录列表浏览
        <>
          {dirCrumbs}
          <div class="fslist">
            {list === null && !err && <Loading />}
            {list !== null && list.entries.length === 0 && <div class="empty">{t('ui.emptyDirectory')}</div>}
            {list?.truncated && <div class="mut small">{t('view.directoryTooLarge')}</div>}
            {list?.entries.map((e: FsEntry) => (
              <div
                key={e.name}
                class="fsrow"
                onClick={() =>
                  e.type === 'dir' ? enterDir(e.name) : setSelected(joinChildPath(rel, e.name))
                }
              >
                <span class="fsicon">{treeIcon(e)}</span>
                <span class="fsname">{e.name}</span>
                <span class="fsmeta">{e.type === 'dir' ? '' : fmtSize(e.size)}</span>
                <span class="fsmeta">{e.mtimeMs !== null ? timeAgo(e.mtimeMs) : ''}</span>
                {e.type !== 'dir' && (
                  <button
                    class="linkbtn"
                    title={t('ui.download')}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      location.href = downloadUrl(joinChildPath(rel, e.name));
                    }}
                  >
                    ⬇
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <input
        ref={fileInput}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) void uploadFile(f);
        }}
      />
    </div>
  );
}
