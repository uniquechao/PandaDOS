import type { AgentKind } from './types';

export const CHAT_AGENT_KEY = 'panda.chatAgent';
const conversationKey = (pid: number): string => `panda.chatConversation.${pid}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 浏览器禁止存储或空间不足时，继续使用当前页面状态。
  }
}

/** 只在用户手动选择代理时写入，执行机能力回退不覆盖偏好。 */
export function readChatAgent(): AgentKind {
  return read(CHAT_AGENT_KEY) === 'codex' ? 'codex' : 'claude';
}

export function writeChatAgent(agent: AgentKind): void {
  if (agent === 'claude' || agent === 'codex') write(CHAT_AGENT_KEY, agent);
}

export function readChatConversation(pid: number): string | null {
  return read(conversationKey(pid)) || null;
}

export function writeChatConversation(pid: number, id: string | null): void {
  write(conversationKey(pid), id);
}

/** 列表已经由服务端按最近活跃排序；旧记录失效时沿用该顺序回退。 */
export function restoreChatConversation(pid: number, conversations: readonly { id: string }[]): string | null {
  const remembered = readChatConversation(pid);
  return conversations.find((conversation) => conversation.id === remembered)?.id
    ?? conversations[0]?.id
    ?? null;
}
