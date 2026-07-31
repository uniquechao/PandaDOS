/**
 * ui/lib/organize —— 模块智能整理的展示/忽略纯函数。
 * 服务端 GET modules/organize 返回 running + 最近一次方案（动作已带模块名快照与 applied
 * 标记）。这里只管两件事：动作 → 人话一行描述；「忽略本批」语义（localStorage 按项目记
 * 方案 ts，同批不再打扰，新方案 ts 更大会重新出现）。
 */

export type OrganizeActionKind = 'create' | 'rename' | 'merge' | 'move';

/** 服务端事件里的一个动作（清洗后形状 + 名称快照 + applied 回放标记） */
export interface OrganizeActionView {
  kind: OrganizeActionKind;
  reason: string;
  applied: boolean;
  // create / rename
  slug?: string;
  displayName?: string;
  agent?: 'claude' | 'codex';
  moduleId?: number;
  moduleName?: string;
  fromSlug?: string;
  // merge
  targetId?: number;
  sourceIds?: number[];
  targetName?: string;
  sourceNames?: string[];
  // move
  issueIds?: number[];
  to?: { moduleId: number } | { slug: string };
  toName?: string;
}

export interface OrganizeStatus {
  running: boolean;
  suggestion: {
    ts: number;
    agent: 'claude' | 'codex';
    moduleCount: number | null;
    actions: OrganizeActionView[];
  } | null;
  failed: { ts: number; reason: string; error?: string } | null;
}

/** 动作类型徽标文案 */
export function actionKindLabel(kind: OrganizeActionKind): string {
  return kind === 'create' ? '新建' : kind === 'rename' ? '改名' : kind === 'merge' ? '合并' : '挪 issue';
}

/** 动作 → 一行人话（模块名用事件里的快照，改名/归档后仍可读） */
export function actionLabel(a: OrganizeActionView): string {
  if (a.kind === 'create') {
    return `新建模块「${a.displayName ?? a.slug ?? '?'}」（${a.slug ?? '?'} · ${a.agent ?? '?'}）`;
  }
  if (a.kind === 'rename') {
    const name = a.moduleName ?? String(a.moduleId ?? '?');
    const base = `「${name}」：${a.fromSlug ?? '?'} → ${a.slug ?? '?'}`;
    return a.displayName && a.displayName !== a.moduleName ? `${base}（显示名改为「${a.displayName}」）` : base;
  }
  if (a.kind === 'merge') {
    const sources = (a.sourceNames ?? a.sourceIds?.map(String) ?? []).map((n) => `「${n}」`).join('');
    return `${sources} 并入「${a.targetName ?? a.targetId ?? '?'}」`;
  }
  const to = a.toName ?? (a.to && 'slug' in a.to ? a.to.slug : undefined) ?? '?';
  const ids = (a.issueIds ?? []).map((id) => `#${id}`).join(' ');
  return `${ids} 挪入「${to}」`;
}

/**
 * 可展示的方案：无方案/同批已忽略/全部已执行 → null。全部执行完即视为本批收尾——
 * 卡片随下一次刷新消失（#89：完成态常驻会永远挂着「0/N 项待确认」，且忽略钮只在
 * 有待确认项时渲染，用户没有任何办法让它消失）。
 */
export function visibleSuggestion(
  status: OrganizeStatus | null,
  dismissedTs: number | null,
): OrganizeStatus['suggestion'] {
  const s = status?.suggestion ?? null;
  if (!s || !s.actions.length) return null;
  if (dismissedTs != null && s.ts <= dismissedTs) return null;
  if (s.actions.every((a) => a.applied)) return null;
  return s;
}

/** 有未处理建议（Board 角标条件）：存在方案、未忽略、且还有未执行项 */
export function hasPendingSuggestion(status: OrganizeStatus | null, dismissedTs: number | null): boolean {
  const s = visibleSuggestion(status, dismissedTs);
  return !!s && s.actions.some((a) => !a.applied);
}

const DISMISS_KEY = 'mando.organizeDismiss';

export function readOrganizeDismissedTs(pid: number): number | null {
  try {
    const raw = localStorage.getItem(`${DISMISS_KEY}.${pid}`);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function dismissOrganizeSuggestion(pid: number, ts: number): void {
  try {
    localStorage.setItem(`${DISMISS_KEY}.${pid}`, String(ts));
  } catch {
    /* 存不上就下次再见——忽略只是降噪，不是数据 */
  }
}
