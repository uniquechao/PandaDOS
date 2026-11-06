import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { RefObject } from 'preact';
import { DetailBody, DetailCtx, type DetailApi } from './runstream/detail';
import { questionAtTop, questionData, type Question } from './questionPosition';
import { ImgThumb } from './ImgThumb';
import { tr } from '../i18n/runtime';
import { isClipped } from './runstream/textutil';

export function StickyQuestion({ listRef, detailApi, scope, pid, onOpenImage }: {
  listRef: RefObject<HTMLDivElement>;
  detailApi: DetailApi;
  scope: string;
  pid: number;
  onOpenImage: (path: string) => void;
}) {
  const [active, setActive] = useState<{ element: HTMLElement; question: Question } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 420 });
  const stripRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    setActive(null);
    setExpanded(false);
    let frame = 0;
    let previous: HTMLElement | null = null;
    const measure = () => {
      frame = 0;
      const top = list.getBoundingClientRect().top;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-user-question]'))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { element, top: rect.top, bottom: rect.bottom };
        });
      const row = questionAtTop(rows, top);
      const element = row?.element ?? null;
      const question = element ? questionData.get(element) : undefined;
      if (element !== previous) setExpanded(false);
      previous = element;
      setActive((old) => old?.element === element && old?.question === question
        ? old : element && question ? { element, question } : null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const observeSizes = () => {
      resize.disconnect();
      resize.observe(list);
      // 工具展开、图片载入及流式正文变化均可能改变提问位置。
      for (const child of Array.from(list.children)) resize.observe(child);
      schedule();
    };
    const mutations = new MutationObserver(observeSizes);
    mutations.observe(list, { childList: true, subtree: true, characterData: true });
    list.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    observeSizes();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      list.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [scope]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const rect = stripRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(440, window.innerWidth - 16);
      setPosition({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        maxHeight: Math.max(32, Math.min(420, window.innerHeight - rect.bottom - 14)),
      });
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !stripRef.current?.contains(event.target)
        && !popupRef.current?.contains(event.target)) setExpanded(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    const resize = new ResizeObserver(place);
    if (stripRef.current?.parentElement) resize.observe(stripRef.current.parentElement);
    place();
    popupRef.current?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      resize.disconnect();
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [expanded]);

  if (!active) return null;
  const images = active.question.images ?? [];
  const files = active.question.files ?? [];
  const close = () => {
    setExpanded(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  return (
    <div ref={stripRef} class="sticky-question-strip"
      style={{ minWidth: 64 + (images.length ? 96 : 0) + (files.length ? 72 : 0) }}>
      <button ref={triggerRef} type="button" class="sticky-question-summary"
        title={tr('ui.showFull')} aria-label={tr('ui.showFull')} aria-expanded={expanded}
        aria-haspopup="dialog" onClick={() => {
          setExpanded(!expanded);
          const { off, text } = active.question;
          const state = detailApi.get(off);
          if (!expanded && off !== undefined && isClipped(text)
            && state?.phase !== 'ready' && state?.phase !== 'loading') {
            detailApi.request(off, { role: 'user' });
          }
        }}>
        {active.question.text && <span class="sticky-question-text">{active.question.text}</span>}
        {images.length > 0 && <span class="sticky-question-attachment">
          <img key={images[0]} class="sticky-question-thumb" src={`/api/projects/${pid}/fs/raw?path=${encodeURIComponent(images[0])}`}
            alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
          <span>{tr('ui.imageCount', { count: images.length })}</span>
        </span>}
        {files.length > 0 && <span class="sticky-question-attachment">
          <span aria-hidden="true">📎</span>{tr('ui.fileCount', { count: files.length })}
        </span>}
        <svg class="sticky-question-chevron" viewBox="0 0 20 20" aria-hidden="true">
          <path d={expanded ? 'm5 12 5-5 5 5' : 'm5 8 5 5 5-5'} />
        </svg>
      </button>
      <button type="button" class="sticky-question-locate" title={tr('ui.locateOriginalQuestion')}
        aria-label={tr('ui.locateOriginalQuestion')} onClick={() => {
          const list = listRef.current;
          if (!list) return;
          setExpanded(false);
          list.scrollTop += active.element.getBoundingClientRect().top - list.getBoundingClientRect().top - 12;
          active.element.focus({ preventScroll: true });
          // Web Animations 自动清理，无持久 class 或定时器影响后续轮次。
          active.element.animate([
            { outline: '2px solid var(--accent)', outlineOffset: '4px' },
            { outline: '2px solid transparent', outlineOffset: '4px' },
          ], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 1600 });
        }}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="5.5" /><circle cx="10" cy="10" r="1.5" />
          <path d="M10 1v3m0 12v3M1 10h3m12 0h3" />
        </svg>
      </button>
      {expanded && createPortal(<div ref={popupRef} class="sticky-question-full" role="dialog"
        aria-label={tr('ui.showFull')} tabIndex={-1} style={position}>
        <div class="sticky-question-full-head">
          <button type="button" title={tr('action.close')} aria-label={tr('action.close')} onClick={close}>✕</button>
        </div>
        <DetailCtx.Provider value={detailApi}>
          {active.question.text && <DetailBody key={`${scope}:${active.question.off}`} text={active.question.text}
            off={active.question.off} role="user" render={(text) => <div>{text}</div>} />}
        </DetailCtx.Provider>
        {images.length > 0 && <div class="rs-msg-imgs">{images.map((path) =>
          <ImgThumb key={path} pid={pid} path={path} onOpen={(path) => {
            setExpanded(false);
            onOpenImage(path);
          }} />,
        )}</div>}
        {files.length > 0 && <div class="rs-msg-files">{files.map((path) =>
          <a key={path} class="rs-file" href={`/api/projects/${pid}/fs/download?path=${encodeURIComponent(path)}`}
            download={path.split('/').pop()}>
            <span aria-hidden="true">📎</span><span class="rs-file-name">{path.split('/').pop()}</span>
          </a>,
        )}</div>}
      </div>, document.body)}
    </div>
  );
}
