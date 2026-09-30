/**
 * ui/lib/projectCwd —— 「这个项目的 cwd 是什么」的进程内缓存（issue #310）。
 *
 * 对话正文里的路径要换算成文件页链接，就得知道项目 cwd；而消息流里同一 pid 会被
 * RunStream / ConversationSegments 挂很多份，逐个组件各拉一次 `/api/projects/:pid`
 * 会把同一个请求打十几遍。这里按 pid 记一份模块级缓存 + 一条在途 Promise，
 * 无论多少订阅者都只发一次请求；cwd 在项目生命周期里基本不变，无需失效与轮询。
 */
import { useEffect, useState } from 'preact/hooks';
import { api } from './api';
import type { Project } from './types';

const cache = new Map<number, string>();
const inflight = new Map<number, Promise<string>>();

/** 已缓存的 cwd（没有则 undefined）；同步取用，不发请求 */
export function cachedProjectCwd(pid: number): string | undefined {
  return cache.get(pid);
}

/** 取项目 cwd：命中缓存直接给，否则合流到同一条在途请求 */
export function fetchProjectCwd(pid: number): Promise<string> {
  const hit = cache.get(pid);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(pid);
  if (running) return running;
  const p = api<Project>(`/api/projects/${pid}`)
    .then((r) => {
      const cwd = r.cwd ?? '';
      cache.set(pid, cwd);
      inflight.delete(pid);
      return cwd;
    })
    .catch((e: unknown) => {
      inflight.delete(pid); // 失败不写缓存：下次挂载可以重试
      throw e;
    });
  inflight.set(pid, p);
  return p;
}

/** 测试用：清空缓存 */
export function resetProjectCwdCache(): void {
  cache.clear();
  inflight.clear();
}

/** 项目 cwd；未知/取不到 → null（调用方按「不做路径链接」降级，不报错） */
export function useProjectCwd(pid: number | undefined): string | null {
  const [cwd, setCwd] = useState<string | null>(() => (pid === undefined ? null : cache.get(pid) ?? null));
  useEffect(() => {
    if (pid === undefined) {
      setCwd(null);
      return;
    }
    const hit = cache.get(pid);
    setCwd(hit ?? null);
    if (hit !== undefined) return;
    let disposed = false;
    void fetchProjectCwd(pid)
      .then((v) => {
        if (!disposed) setCwd(v);
      })
      .catch(() => {
        /* 取不到就不做路径链接，正文照常显示 */
      });
    return () => {
      disposed = true;
    };
  }, [pid]);
  return cwd;
}
