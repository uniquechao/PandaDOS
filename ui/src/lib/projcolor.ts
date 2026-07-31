/**
 * ui/lib/projcolor —— 项目图标「色块 + 首字母」的确定性推导。
 * 同一项目名永远得到同一套配色，稳定可辨；供侧栏 / 首页的项目图标方块复用。
 * 配色走柔和浅底 + 深色前景，和暖色主题不打架（色相由项目名散列而来）。
 */

export interface ProjColor {
  /** 浅底：放图标方块 */
  bg: string;
  /** 深色前景：首字母 / 图标 */
  fg: string;
  /** 中间色：描边 / 阴影 */
  ring: string;
}

/** FNV-1a 散列 → [0,360) 色相（用 Math.imul 走 32 位整数，稳定跨平台）。 */
function hashHue(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/** 首字母：拉丁字母大写；中文/数字/符号取首个字符；空名回退 #。按码位取，兼容 emoji/代理对。 */
export function projInitial(name: string): string {
  const t = (name ?? '').trim();
  if (!t) return '#';
  const ch = [...t][0] ?? '#';
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

/** 从种子（一般传项目名）推导稳定的柔和色板。 */
export function projColor(seed: string): ProjColor {
  const hue = hashHue(seed || 'proj');
  return {
    bg: `hsl(${hue}, 62%, 92%)`,
    fg: `hsl(${hue}, 52%, 38%)`,
    ring: `hsl(${hue}, 58%, 82%)`,
  };
}

/** 便捷合成：图标方块要的一切（首字母 + 配色）。种子用项目名。 */
export function projAvatar(p: { name: string }): ProjColor & { initial: string } {
  return { initial: projInitial(p.name), ...projColor(p.name) };
}
