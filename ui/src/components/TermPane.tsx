/**
 * components/TermPane —— 可嵌入的终端面板（原 views/Term 的 xterm 主体平移抽取）。
 * xterm.js 接 WS /ws/term/:projectId：binary=终端字节流双向；target 选择 shell、issue 或对话。
 * 客→服 {type:'resize',cols,rows} / {type:'scroll',direction,lines}；服→客 {type:'exit'}。
 * 断线不自动重连（overlay 手动）；onStatus 供宿主在自己的页头显示连接状态。
 * 渲染为 fragment（termbox + 按键条），宿主需是 flex column 容器。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { connectWs, type WsHandle } from '../lib/ws';
import { bindTermTouchScroll, createTermTouchScrollController } from './termTouchScroll';
import { createTermWheelScrollController } from './termWheelScroll';
import { tr } from '../i18n/runtime';

const MAX_SCROLL_LINES_PER_FRAME = 100;

export function buildTermScrollFrame(lines: number): {
  type: 'scroll';
  direction: 'up' | 'down';
  lines: number;
} | null {
  if (!Number.isFinite(lines)) return null;
  const wholeLines = Math.trunc(lines);
  if (wholeLines === 0) return null;
  return {
    type: 'scroll',
    direction: wholeLines < 0 ? 'up' : 'down',
    lines: Math.min(MAX_SCROLL_LINES_PER_FRAME, Math.abs(wholeLines)),
  };
}

/** 按键条 → 直接写入 pty 的字节 */
const TERM_KEYS: Array<[string, string]> = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['^C', '\x03'],
  ['^D', '\x04'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['⏎', '\r'],
];

export type TermStatus = 'connecting' | 'open' | 'closed' | 'exit';

export type NativeTarget = { kind: 'bash' } | { kind: 'issue'; issueId: number } | { kind: 'conversation'; convId: string };

export function buildTermWsPath(pid: number, target: NativeTarget, cols: number, rows: number): string {
  const params = new URLSearchParams();
  if (target.kind === 'issue') params.set('issue', String(target.issueId));
  if (target.kind === 'conversation') params.set('conv', target.convId);
  params.set('cols', String(cols));
  params.set('rows', String(rows));
  return `/ws/term/${pid}?${params}`;
}

interface TermPaneProps {
  pid: number;
  target: NativeTarget;
  onStatus?: (s: TermStatus) => void;
  closedMessage?: string;
}

export function TermPane({ pid, target, onStatus, closedMessage }: TermPaneProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WsHandle | null>(null);
  const pageScrollRef = useRef<(direction: -1 | 1) => void>(() => {});
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [gen, setGen] = useState(0); // +1 = 手动重连（整套重建）
  const targetKey =
    target.kind === 'bash'
      ? 'bash'
      : target.kind === 'issue'
        ? `issue:${target.issueId}`
        : `conversation:${target.convId}`;
  const statusCb = useRef(onStatus);
  statusCb.current = onStatus;

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let disposed = false;
    let disposeTerm = (): void => {};
    const setSt = (s: TermStatus): void => {
      if (disposed) return;
      setStatus(s);
      statusCb.current?.(s);
    };
    void Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed) return;
        const term = new Terminal({
          fontSize: 13,
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          cursorBlink: true,
          scrollback: 5000,
          theme: {
            background: '#1f1f1f',
            foreground: '#f5f5f5',
            cursor: '#ffb629',
            cursorAccent: '#1f1f1f',
            selectionBackground: '#5a461f',
            black: '#1f1f1f',
            brightBlack: '#6b6b68',
            yellow: '#ffb629',
            brightYellow: '#ffe9b3',
            green: '#22c55e',
            blue: '#388bff',
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(box);
        try {
          fit.fit();
        } catch {
          /* 未布局完成时忽略 */
        }

        let exited = false;
        const enc = new TextEncoder();
        const sendResize = (): void => {
          if (disposed) return;
          try {
            fit.fit();
          } catch {
            return;
          }
          conn.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        };

        // 初始尺寸随 URL 带给后端（openPty 直接按此建 pty），open 后的 resize 帧兜底微调
        const conn = connectWs(buildTermWsPath(pid, target, term.cols, term.rows), {
          onText: (raw) => {
            if (disposed) return;
            try {
              const f = JSON.parse(raw) as { type?: string };
              if (f.type === 'exit') {
                exited = true;
                setSt('exit');
                conn.close();
              }
            } catch {
              /* 非 JSON 文本帧忽略 */
            }
          },
          onBinary: (buf) => {
            if (!disposed) term.write(new Uint8Array(buf));
          },
          onStatus: (s) => {
            if (disposed || exited) return;
            setSt(s);
            if (s === 'open') sendResize();
          },
          // 不自动重连：overlay 手动
        });
        wsRef.current = conn;

        const sendTermScroll = (lines: number): void => {
          const frame = buildTermScrollFrame(lines);
          if (!disposed && frame) conn.send(JSON.stringify(frame));
        };
        const sendPageScroll = (direction: -1 | 1): void => {
          sendTermScroll(direction * Math.max(1, term.rows - 1));
        };
        pageScrollRef.current = sendPageScroll;

        const dataSub = term.onData((d: string) => {
          if (!disposed) conn.send(enc.encode(d));
        });
        const wheelController = createTermWheelScrollController({
          getCellHeight: () => {
            const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
            const screenHeight = screen?.getBoundingClientRect().height ?? 0;
            return term.rows > 0 ? screenHeight / term.rows : 0;
          },
          getPageRows: () => Math.max(1, term.rows - 1),
          scrollLines: sendTermScroll,
        });
        term.attachCustomWheelEventHandler((event) =>
          wheelController.onWheel(event, term.buffer.active.type),
        );
        const touchController = createTermTouchScrollController({
          getCellHeight: () => {
            const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
            const screenHeight = screen?.getBoundingClientRect().height ?? 0;
            return term.rows > 0 ? screenHeight / term.rows : 0;
          },
          scrollLines: (lines) => {
            if (term.buffer.active.type === 'alternate') sendTermScroll(lines);
            else term.scrollLines(lines);
          },
        });
        const unbindTouchScroll = term.element
          ? bindTermTouchScroll(term.element, touchController)
          : () => {};
        const ro = new ResizeObserver(() => sendResize());
        ro.observe(box);

        disposeTerm = () => {
          unbindTouchScroll();
          ro.disconnect();
          dataSub.dispose();
          conn.close();
          if (wsRef.current === conn) wsRef.current = null;
          if (pageScrollRef.current === sendPageScroll) pageScrollRef.current = () => {};
          term.dispose();
        };
      })
      .catch(() => {
        if (!disposed) setSt('closed');
      });

    return () => {
      disposed = true;
      disposeTerm();
    };
  }, [pid, targetKey, gen]);

  const writeKey = (bytes: string): void => {
    wsRef.current?.send(new TextEncoder().encode(bytes));
  };

  const sendPageScroll = (direction: -1 | 1): void => pageScrollRef.current(direction);

  return (
    <>
      <div class="termbox" ref={boxRef}>
        <div class="term-scroll-controls">
          <button
            type="button"
            class="term-scroll-btn"
            aria-label={tr('ui.terminalPageUp')}
            title={tr('ui.terminalPageUp')}
            disabled={status !== 'open'}
            onClick={() => sendPageScroll(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            class="term-scroll-btn"
            aria-label={tr('ui.terminalPageDown')}
            title={tr('ui.terminalPageDown')}
            disabled={status !== 'open'}
            onClick={() => sendPageScroll(1)}
          >
            ↓
          </button>
        </div>
        {(status === 'closed' || status === 'exit') && (
          <div class="term-overlay">
            <div>{status === 'closed' ? (closedMessage ?? tr('ui.terminalDisconnected')) : tr('ui.terminalEnded')}</div>
            <button class="btn primary big" onClick={() => setGen((g) => g + 1)}>
              {tr('ui.reconnect')}
            </button>
          </div>
        )}
      </div>
      <div class="termkeys">
        {TERM_KEYS.map(([label, bytes]) => (
          <button key={label} class="ckey" onClick={() => writeKey(bytes)}>
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
