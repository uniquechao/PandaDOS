/**
 * ui/lib/pollSummary —— 轮询「Agent 认知总结」后台任务直到收敛。
 * 后端把 POST claude/codex 做成异步（202 running），前端拉 GET /api/projects/:id
 * 直到 summaryStatus 脱离 running（done/error/idle）或超时。onTick 让调用方就地刷新 UI。
 */
import { api } from './api';
import type { Project } from './types';

export interface PollOpts {
  intervalMs?: number;
  maxMs?: number;
  /** 每次拿到最新 Project 时回调（就地刷新简介/状态） */
  onTick?: (p: Project) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询到 summaryStatus 非 running（或超时），返回最新 Project。 */
export async function pollProjectSummary(pid: number, opts: PollOpts = {}): Promise<Project> {
  const interval = opts.intervalMs ?? 3000;
  const deadline = Date.now() + (opts.maxMs ?? 12 * 60 * 1000);
  let p = await api<Project>(`/api/projects/${pid}`);
  opts.onTick?.(p);
  while (p.summaryStatus === 'running' && Date.now() < deadline) {
    await sleep(interval);
    p = await api<Project>(`/api/projects/${pid}`);
    opts.onTick?.(p);
  }
  return p;
}
