/**
 * web/routes/greeting —— 项目页欢迎卡的「每日欢迎语」（GET /api/greeting）。
 * 当前返回固定欢迎语，端点恒 200。
 * 只 export 路由工厂，注册由 routes/index.ts 统一做（用现有 deps.db / deps.llm）。
 */
import type { Database } from 'bun:sqlite';
import type { LlmClient } from '../../agents/llm';
import { json, type RouteDef } from '../middleware';

export const GREETING_TEXT = 'hello';

/** 保留统一的路由工厂依赖签名；固定欢迎语不会读取 DB 或调用 LLM。 */
export interface GreetingRoutesDeps {
  db: Database;
  llm: LlmClient;
}

export function greetingRoutes(_deps: GreetingRoutesDeps): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/greeting',
      auth: 'user',
      handler: () => json({ text: GREETING_TEXT }),
    },
  ];
}
