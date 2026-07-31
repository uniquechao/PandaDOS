/**
 * ui/lib/gitai —— Git 页 AI 助读封装（POST /api/projects/:pid/git/ai）。
 *
 * 五个动作对应 Git.tsx 上的按钮：
 *   总结提交 / 识别风险 / 解释整条 diff（提交级，挂详情头）、
 *   解释单文件 diff（file-explain，挂 diff 栏头，提交内文件 sha+path、工作区文件 path[+untracked]）、
 *   生成提交信息（commit-message，工作区改动，挂工作区面板）。
 *
 * 成功回 AI 正文字符串；失败由 api() 抛 ApiError（调用侧 toast/内联展示，见子任务 9）。
 */
import { api } from './api';
import { requireGitOperationSuccess } from './gitoperations';
import type { GitAiKind, GitAiReq, GitAiResult } from './types';

/** 统一调用：POST /git/ai → 返回 AI 正文（空则 ''）。非 2xx 由 api 抛 ApiError。 */
export async function gitAi(pid: number, req: GitAiReq): Promise<string> {
  const r = requireGitOperationSuccess(
    await api<GitAiResult>(`/api/projects/${pid}/git/ai`, 'POST', req),
  );
  return r.text ?? '';
}

/** 总结提交（commit-summary） */
export function aiSummarizeCommit(pid: number, sha: string): Promise<string> {
  return gitAi(pid, { kind: 'commit-summary', sha });
}

/** 识别风险（commit-risk） */
export function aiCommitRisk(pid: number, sha: string): Promise<string> {
  return gitAi(pid, { kind: 'commit-risk', sha });
}

/** 解释整条提交 diff（commit-explain） */
export function aiExplainCommit(pid: number, sha: string): Promise<string> {
  return gitAi(pid, { kind: 'commit-explain', sha });
}

/**
 * 解释单文件 diff（file-explain）：
 *  - 提交内文件：{ sha, path[, old] }；
 *  - 工作区文件：{ path[, old][, untracked] }（无 sha）。
 */
export function aiExplainFile(
  pid: number,
  opts: { sha?: string; path: string; old?: string; untracked?: boolean },
): Promise<string> {
  return gitAi(pid, { kind: 'file-explain', ...opts });
}

/** 工作区改动生成提交信息（commit-message） */
export function aiCommitMessage(pid: number): Promise<string> {
  return gitAi(pid, { kind: 'commit-message' });
}

/** kind → 按钮中文标签（UI 复用，避免各处硬编码文案漂移） */
export const GIT_AI_LABEL: Record<GitAiKind, string> = {
  'commit-summary': '总结提交',
  'commit-risk': '识别风险',
  'commit-explain': '解释 Diff',
  'file-explain': '解释 Diff',
  'commit-message': '生成 Commit Message',
};
