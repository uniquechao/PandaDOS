/**
 * lib/chatMerge —— 对话消息表按稳定标识 off 合并去重（纯函数，可单测）。
 *
 * 三路服务端帧（baseline 末段 / msg 增量 / history 更早）汇进同一张表：
 *  - off = 源行字节 offset(+行内序号)，同一文件位置永远同值 → 据此去重（incoming 覆盖，取最新渲染）；
 *  - 按 off 升序 = 文件字节序 = 时间序，故 history（更早、off 小）自然排到前面、msg（更新、off 大）排到后面；
 *  - 无 off（理论上不会有，后端 tail/readOlder 都挂了；防御性兜底）：无从去重，保序追加到末尾。
 *
 * 不重排 seq——渲染键走 off（见 runstream/index），故 history 前插不会让既有消息键位移、
 * 组件展开态/滚动位置不抖；也天然修掉「重连整表替换 → 缩回末 60 条」（改为合并，已加载的更早历史保留）。
 */
import type { ChatMessage } from './types';

export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byOff = new Map<number, ChatMessage>();
  const noOff: ChatMessage[] = [];
  const add = (m: ChatMessage): void => {
    if (typeof m.off === 'number') byOff.set(m.off, m);
    else noOff.push(m);
  };
  existing.forEach(add);
  incoming.forEach(add);
  const merged = [...byOff.values()].sort((a, b) => a.off! - b.off!);
  return noOff.length ? [...merged, ...noOff] : merged;
}
