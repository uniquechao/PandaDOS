/** 已登录用户可见的驱动大模型最小状态；不泄露地址、模型或 Key。 */
import type { Database } from 'bun:sqlite';
import { safeLlmConfig } from '../../agents/llm';
import { json, type RouteDef } from '../middleware';

export function llmStatusRoutes(deps: { db: Database }): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/llm-status',
      auth: 'user',
      handler: () => json({ configured: safeLlmConfig(deps.db).configured }),
    },
  ];
}
