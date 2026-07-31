/**
 * ui/lib/seliid —— 看板深链选中 issue 的校验（纯函数，便于单测）。
 *
 * 背景：URL `#/p/:pid/issue/:iid` 里的 iid 可能是失效/跨项目的旧深链（浏览器旧标签/历史/书签）。
 * 若直接把它塞给详情组件，会请求「本项目 + 不属于本项目的 issue」→ 后端 404（每 5s 轮询刷屏）。
 * 这里在 issue 列表加载完后校验 selIid 是否属于本项目：命中→保留；未命中→判 stale、清掉。
 */

export interface ResolvedSel {
  /** 有效选中的 issue id；未命中 / 无 selIid → undefined（调用方回退 defaultIid / null） */
  effectiveIid: number | undefined;
  /** selIid 明确不属于本项目（已加载且列表里没有）→ 需回退并清 URL */
  stale: boolean;
}

/**
 * 校验深链 selIid：
 * - selIid 缺省 → { undefined, false }（原样，走自动选优先项）；
 * - issues 未加载完（loaded=false 或 issues 为 null）→ 暂不判定，保留 selIid、不算 stale（避免误杀有效深链）；
 * - 已加载：命中列表 → 保留；未命中 → { undefined, true }（失效深链，需回退 + 清 URL）。
 */
export function resolveSelIid(
  selIid: number | undefined,
  issues: { id: number }[] | null,
  loaded: boolean,
): ResolvedSel {
  if (selIid == null) return { effectiveIid: undefined, stale: false };
  if (!loaded || issues == null) return { effectiveIid: selIid, stale: false };
  const hit = issues.some((i) => i.id === selIid);
  return hit ? { effectiveIid: selIid, stale: false } : { effectiveIid: undefined, stale: true };
}
