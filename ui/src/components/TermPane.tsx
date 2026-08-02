/**
 * components/TermPane —— 可嵌入的终端面板（原 views/Term 的 xterm 主体平移抽取）。
 * xterm.js 接 WS /ws/term/:projectId：binary=终端字节流双向；target 选择 shell、issue 或对话。
 * 客→服 {type:'resize',cols,rows}；服→客 {type:'exit'}。
 * 断线不自动重连（overlay 手动）；onStatus 供宿主在自己的页头显示连接状态。
 * 渲染为 fragment（termbox + 按键条），宿主需是 flex column 容器。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { connectWs, type WsHandle } from '../lib/ws';
import { bindTermTouchScroll, createTermTouchScrollController } from './termTouchScroll';
import { tr } from '../i18n/runtime';

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
          fontFamily: 'Menlo, Consolas, monospace',
          cursorBlink: true,
          scrollback: 5000,
          theme: { background: '#000000', foreground: '#e6e6e6', cursor: '#e6e6e6' },
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

        const dataSub = term.onData((d: string) => {
          if (!disposed) conn.send(enc.encode(d));
        });
        const touchController = createTermTouchScrollController({
          getCellHeight: () => {
            const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
            const screenHeight = screen?.getBoundingClientRect().height ?? 0;
            return term.rows > 0 ? screenHeight / term.rows : 0;
          },
          scrollLines: (lines) => term.scrollLines(lines),
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

  return (
    <>
      <div class="termbox" ref={boxRef}>
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
