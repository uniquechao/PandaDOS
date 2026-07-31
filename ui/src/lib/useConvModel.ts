/**
 * 「这条对话现在用的是哪个模型」（issue #109）——只读展示原始名（claude-opus-5 / gpt-5.6-sol），
 * 本期不做点击切换。数据来自 GET /api/projects/:pid/conversations/:convId/model（服务端读会话
 * jsonl 尾窗，见 core/model-probe），探不到就是 null → 调用方整体不显示。
 *
 * convId 为空（issue 还没开跑、没选中对话）不发请求；convId 变化立刻重取并先清空，
 * 避免切换时短暂显示上一条对话的模型。轻量轮询（默认 30s）跟上用户在终端里 `/model` 换模型。
 */
import { useEffect, useState } from 'preact/hooks';
import { api } from './api';

/** 轮询周期：模型不常变，30s 足够跟上；服务端按文件 size 缓存，空转几乎不读盘 */
export const MODEL_POLL_MS = 30_000;

export function fetchConvModel(
  projectId: number,
  convId: string,
): Promise<{ ok: boolean; agent?: string; model: string | null }> {
  return api(`/api/projects/${projectId}/conversations/${encodeURIComponent(convId)}/model`);
}

/** 返回该对话当前模型原始名；未知/未开跑/请求失败 → null（调用方不渲染徽标） */
export function useConvModel(
  projectId: number,
  convId: string | null | undefined,
  pollMs: number = MODEL_POLL_MS,
): string | null {
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    setModel(null);
    if (!convId) return;
    let disposed = false;
    const load = (): void => {
      void fetchConvModel(projectId, convId)
        .then((r) => {
          if (!disposed) setModel(r.model ?? null);
        })
        .catch(() => {
          /* 探测失败保持现状：不因一次网络抖动把徽标抹掉 */
        });
    };
    load();
    const timer = window.setInterval(load, pollMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [projectId, convId, pollMs]);
  return model;
}
