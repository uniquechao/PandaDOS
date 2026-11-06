import type { ChatMessage } from '../lib/types';

export type Question = Pick<ChatMessage, 'text' | 'off' | 'images' | 'files'>;
export const questionData = new WeakMap<HTMLElement, Question>();

/** 按实际 DOM 顺序选轮次；只在原提问完全离开阅读区顶部时显示，不受摘要或浮层尺寸影响。 */
export function questionAtTop<T extends { top: number; bottom: number }>(
  questions: T[], top: number,
): T | null {
  let current: T | null = null;
  for (const question of questions) {
    if (question.top > top) break;
    current = question;
  }
  return current && current.bottom <= top ? current : null;
}

export function questionAttachments(question: Question): string[] {
  return [...(question.images ?? []), ...(question.files ?? [])]
    .map((path) => path.split('/').pop() || path);
}
