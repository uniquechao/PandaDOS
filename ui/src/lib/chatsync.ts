/**
 * ui/lib/chatsync —— 对话页「地址栏 ↔ 选中对话」的同步决策（纯函数，便于单测）。
 *
 * 背景（生产事故）：这层同步最初写成两个 effect——一个「地址栏→选中」、一个「选中→地址栏」。
 * 两个 effect 在同一次 commit 里都会跑、都读到同一份旧值，于是一个把 selected 改成 cid、
 * 另一个把地址栏改回 selected，下一帧再反过来一次，永远收敛不了。表现是列表里两条对话同时
 * 高亮、聊天 WS 每帧重连（`key={chat:${selected}}` 一直重挂）、activate/model 请求成百上千条
 * 堆在 pending——生产实测 2.3 分钟 1983 条请求，把控制面和执行机一起拖慢。
 *
 * 所以这里用**优先级**取代两个 effect 的竞争，并且只有一个出口：
 * 1. 地址栏这一帧**真的变了**（返回/前进、粘贴直链、外部跳转）且指向一条存在的对话 → 跟随它；
 * 2. 否则地址栏只是 selected 的镜像，不一致就把 selected 写回地址栏。
 *
 * 关键不变量：`cid` 没变的那一帧绝不回写 `selected`——环就是在那里断开的。
 */

export type ChatSyncAction =
  /** 什么都不用做（已经一致） */
  | { kind: 'none' }
  /** 跟随地址栏切选中对话（调用方还要落 localStorage + activate） */
  | { kind: 'select'; convId: string }
  /** 把当前选中项镜像进地址栏；convId=null → 回到不带 id 的对话页 */
  | { kind: 'nav'; convId: string | null };

export interface ChatSyncInput {
  /** 本帧地址栏里的对话 id（#/p/:pid/chat/:cid） */
  cid: string | undefined;
  /** 上一帧的 cid，用来判断「地址栏这一帧是不是真的变了」 */
  prevCid: string | undefined;
  /** 当前选中的对话 */
  selected: string | null;
  /** 对话列表；null = 还没加载完（此时一律不动，免得抢在初始选中之前抹掉深链） */
  conversationIds: readonly string[] | null;
}

export function resolveChatSync(input: ChatSyncInput): ChatSyncAction {
  const { cid, prevCid, selected, conversationIds } = input;
  if (conversationIds === null) return { kind: 'none' };
  const urlChanged = cid !== prevCid;
  if (urlChanged && cid && cid !== selected && conversationIds.includes(cid)) {
    return { kind: 'select', convId: cid };
  }
  if ((cid ?? null) !== selected) return { kind: 'nav', convId: selected };
  return { kind: 'none' };
}
