import {
  LLM_NOT_CONFIGURED_MESSAGE,
  LlmNotConfiguredError,
} from '../agents/llm';
import { json } from './middleware';

/** 把驱动大模型未配置映射成所有用户入口一致的可操作响应。 */
export function llmErrorResponse(error: unknown): Response | null {
  if (!(error instanceof LlmNotConfiguredError)) return null;
  return json(
    {
      ok: false,
      code: 'llm_not_configured',
      error: LLM_NOT_CONFIGURED_MESSAGE,
    },
    503,
  );
}
