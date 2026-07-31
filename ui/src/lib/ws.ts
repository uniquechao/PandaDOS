/**
 * ui/lib/ws —— WebSocket 薄封装：文本/二进制分流 + 自动重连（可关）。
 * chat/term 两视图共用；后端未就绪时表现为「重连中…」，不炸视图。
 */

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsHandle {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
}

export interface WsOpts {
  onText(data: string): void;
  onBinary?(data: ArrayBuffer): void;
  onStatus?(s: WsStatus): void;
  /** >0 = 断线后该毫秒数自动重连；缺省不重连 */
  reconnectMs?: number;
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

export function connectWs(path: string, opts: WsOpts): WsHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: number | undefined;

  const open = (): void => {
    if (closed) return;
    opts.onStatus?.('connecting');
    ws = new WebSocket(wsUrl(path));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => opts.onStatus?.('open');
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') opts.onText(e.data);
      else if (e.data instanceof ArrayBuffer) opts.onBinary?.(e.data);
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      opts.onStatus?.('closed');
      if (opts.reconnectMs && opts.reconnectMs > 0) {
        timer = window.setTimeout(open, opts.reconnectMs);
      }
    };
  };
  open();

  return {
    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    },
  };
}
