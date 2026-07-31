/**
 * 项目 issue 聚合小工具（纯函数，供侧栏顶层「项目」聚合角标用）。
 * 口径与 /api/projects/summary 一致：todo/doing/review/blocked 四列未完结数。
 */
import type { ProjectIssueSummary } from './types';

/**
 * 把各项目的未完结 issue 数按列求和。
 * @param sum  GET /api/projects/summary 的 projects 映射（键为项目 id 字符串）
 * @param ids  仅统计这些项目 id（一般传当前可见的活跃项目，排除归档）；缺省则全量求和
 */
export function aggregateSummary(
  sum: Record<string, ProjectIssueSummary>,
  ids?: number[],
): ProjectIssueSummary {
  const total: ProjectIssueSummary = { todo: 0, doing: 0, review: 0, blocked: 0 };
  const keys = ids ? ids.map(String) : Object.keys(sum);
  for (const k of keys) {
    const one = sum[k];
    if (!one) continue;
    total.todo += one.todo;
    total.doing += one.doing;
    total.review += one.review;
    total.blocked += one.blocked;
  }
  return total;
}
