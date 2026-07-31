/**
 * web/ws/term —— WS 终端桥（/ws/term/:projectId，Wave3 任务 A）。
 *
 * 帧协议（与 UI 工程师的共同契约）：
 * - binary = 终端字节流双向透传（PTY ↔ xterm.js）；
 * - text JSON 客→服 {type:'resize',cols,rows} → PtyChannel.resize（Ssh 走 channel setWindow）；
 * - text JSON 服→客 {type:'exit'}（PTY 退出，随后关连接）。
 *
 * 生命周期：upgrade 后 open 里 Driver.openPty(`tmux attach -t <session>`)；
 * openPty 在途时客户端输入进 pending 缓冲，就绪后回放；连接关闭回收 PTY（close()）。
 */
import type { ServerWebSocket } from 'bun';
import type { ExecutorDriver, PtyChannel } from '../../executor/driver';
import { TMUX_WIN_COLS, TMUX_WIN_ROWS } from '../../executor/driver';

export interface TermWsData {
  kind: 'term';
  session: string;
  cols: number;
  rows: number;
  driver: ExecutorDriver;
  pty: PtyChannel | null;
  /** openPty 在途时到达的输入（就绪后按序回放） */
  pending: (string | Uint8Array)[];
  closed: boolean;
}

export function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function safeSend(ws: ServerWebSocket<unknown>, data: string | Uint8Array): void {
  try {
    ws.send(data);
  } catch {
    /* 连接已断 */
  }
}

export async function termOpen(ws: ServerWebSocket<TermWsData>): Promise<void> {
  const d = ws.data;
  let pty: PtyChannel;
  // issue #95：会话平时被锁成 220×50（manual），attach 前先把定尺权交还客户端，
  // 否则手机上只能看见窗口左上角一小块；断开时在 termClose 里收回。
  await d.driver.resizeWindow(d.session, null).catch(() => {});
  try {
    // session 已在 upgrade 阶段做 /^[\w.-]+$/ 白名单校验，拼进命令安全
    pty = await d.driver.openPty(`tmux attach -t ${d.session}`, d.cols, d.rows);
  } catch {
    safeSend(ws, JSON.stringify({ type: 'exit' }));
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return;
  }
  if (d.closed) {
    // openPty 在途时客户端已断：立刻回收，不留孤儿 PTY
    pty.close();
    return;
  }
  d.pty = pty;
  pty.onData((chunk) => safeSend(ws, chunk));
  pty.onExit(() => {
    safeSend(ws, JSON.stringify({ type: 'exit' }));
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
  for (const w of d.pending.splice(0)) pty.write(w);
}

export function termMessage(ws: ServerWebSocket<TermWsData>, msg: string | Uint8Array): void {
  const d = ws.data;
  if (typeof msg === 'string') {
    // 控制帧：{type:'resize',cols,rows}
    let j: unknown;
    try {
      j = JSON.parse(msg);
    } catch {
      return; // 文本帧只认 JSON 控制帧，其余丢弃（键盘输入走 binary）
    }
    const f = j as { type?: unknown; cols?: unknown; rows?: unknown };
    if (f.type === 'resize') {
      const cols = clampInt(String(f.cols), d.cols, 20, 400);
      const rows = clampInt(String(f.rows), d.rows, 5, 200);
      d.cols = cols;
      d.rows = rows;
      d.pty?.resize(cols, rows);
    }
    return;
  }
  // binary：终端输入透传
  if (d.pty) d.pty.write(msg);
  else d.pending.push(msg);
}

export function termClose(ws: ServerWebSocket<TermWsData>): void {
  const d = ws.data;
  d.closed = true;
  try {
    d.pty?.close();
  } catch {
    /* ignore */
  }
  d.pty = null;
  // issue #95：detach 后 tmux 不会自己变回来——窗口会一直留在浏览器（常是手机）的尺寸上，
  // 之后 CC 画菜单就矮得连 ❯ 光标行都顶出可视区，抓屏侧整个菜单消失。收回到标称尺寸。
  void d.driver.resizeWindow(d.session, { cols: TMUX_WIN_COLS, rows: TMUX_WIN_ROWS }).catch(() => {});
}
