/**
 * ui/lib/mockChat —— chat WS 的本地 mock（后端 WS 并行开发中，按契约演练前端）。
 * 打开方式：URL 加 ?mock=1（如 http://host/?mock=1#/p/1/chat）。
 * 行为：连上即发 baseline（几种气泡 + 一个菜单）；text 回显 assistant；
 * select 第一次故意回 stale 再补发新 selection，验证「stale → 刷新菜单」路径。
 */
import type { ChatClientFrame, ChatMessage, ChatSelection } from './types';

export function isMockMode(): boolean {
  return new URLSearchParams(location.search).has('mock');
}

export interface MockHandle {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
}

const BASE_MSGS: ChatMessage[] = [
  { seq: 0, role: 'user', text: '帮我把登录页做出来' },
  { seq: 1, role: 'thinking', text: '先看一下现有路由和鉴权中间件……' },
  { seq: 2, role: 'tool_use', tool: 'Read', input: '{"file_path":"src/web/routes/auth.ts"}' },
  { seq: 3, role: 'tool_result', result: 'POST /api/login → {ok,userId,username,role}\n401 → {ok:false,error}' },
  { seq: 4, role: 'tool_result', result: 'Error: ENOENT no such file', isError: true },
  { seq: 5, role: 'assistant', text: '好的，登录页已经写好了。\n接下来要不要把「记住用户名」也加上？' },
];

const MENU: ChatSelection = {
  options: ['1. 加上（localStorage 存用户名）', '2. 不加，保持极简', '3. 先跳过，之后再说'],
  cursorIndex: 0,
  context: 'Claude 在等你确认：登录页是否加「记住用户名」？',
  sig: 'mock-sig-1',
};

export function createMockChat(onFrame: (raw: string) => void): MockHandle {
  let seq = BASE_MSGS.length;
  let staleOnce = true;
  const timers: number[] = [];
  const emit = (obj: unknown, delay = 0): void => {
    timers.push(window.setTimeout(() => onFrame(JSON.stringify(obj)), delay));
  };
  emit({ type: 'baseline', msgs: BASE_MSGS, hasMore: false, selection: MENU }, 200);
  return {
    send(data) {
      if (typeof data !== 'string') return;
      let f: ChatClientFrame;
      try {
        f = JSON.parse(data) as ChatClientFrame;
      } catch {
        return;
      }
      if (f.type === 'text') {
        // issue #116：带 id 的文本帧先回执（乐观气泡「已送达」），再让真消息回流把它撤掉
        if (f.id) emit({ type: 'ack', id: f.id }, 120);
        emit({ type: 'msg', m: { seq: seq++, role: 'user', text: f.text, off: 10_000 + seq } }, 600);
        emit({ type: 'msg', m: { seq: seq++, role: 'assistant', text: `（mock 回声）收到：${f.text}` } }, 700);
      } else if (f.type === 'key') {
        emit({ type: 'msg', m: { seq: seq++, role: 'tool_result', result: `（mock）已注入按键 ${f.key}` } }, 150);
      } else if (f.type === 'explain') {
        // issue #112：解读按需生成，mock 里也留出「点了要等一下」的手感
        emit(
          {
            type: 'explanation',
            sig: f.sig,
            optionsSig: MENU.options.join('|'),
            text: '（mock 解读）Claude 想确认登录页要不要加「记住用户名」。\n加上会往 localStorage 写用户名，纯前端改动、可随时撤掉，没有不可逆后果。\n建议选 1。',
          },
          900,
        );
      } else if (f.type === 'select') {
        if (staleOnce) {
          staleOnce = false;
          emit({ type: 'stale' }, 150);
          emit({ type: 'selection', sel: { ...MENU, sig: 'mock-sig-2', context: '菜单已刷新（第二次选择将成功）' } }, 900);
        } else {
          emit({ type: 'selection', sel: null }, 100);
          emit({ type: 'msg', m: { seq: seq++, role: 'assistant', text: `（mock）已选第 ${f.index + 1} 项（sig=${f.sig}）` } }, 400);
        }
      }
    },
    close() {
      for (const t of timers) clearTimeout(t);
    },
  };
}
