/**
 * web/routes/greeting —— 项目页欢迎卡的「每日欢迎语」（GET /api/greeting）。
 * 惰性生成：命中 (user, 今天) 返回缓存，未命中调 驱动大模型 生成并落库（core/daily-greeting）。
 * LLM 失败/空 → getOrCreateDailyGreeting 返回 null，这里回退静态兜底文案，端点恒 200。
 * 只 export 路由工厂，注册由 routes/index.ts 统一做（用现有 deps.db / deps.llm）。
 */
import type { Database } from 'bun:sqlite';
import type { LlmClient } from '../../agents/llm';
import { getOrCreateDailyGreeting } from '../../core/daily-greeting';
import { json, type RouteDef } from '../middleware';

/** LLM 不可用/失败时的静态兜底（与前端空闲兜底一致） */
export const GREETING_FALLBACK = '今天也顺顺利利 ✨';

export interface GreetingRoutesDeps {
  db: Database;
  llm: LlmClient;
}

export function greetingRoutes(deps: GreetingRoutesDeps): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/greeting',
      auth: 'user',
      handler: async ({ user }) => {
        const u = user!; // auth:'user' 保证非空
        const text = await getOrCreateDailyGreeting(
          { db: deps.db, llm: deps.llm },
          { id: u.id, username: u.username },
        ).catch(() => null);
        return json({ text: text ?? GREETING_FALLBACK });
      },
    },
  ];
}
