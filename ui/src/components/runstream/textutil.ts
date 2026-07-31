/** runstream 纯文本小工具（无 JSX，便于单测）。 */

/** 压成单行并截断（折叠态预览用）；空白折叠成单空格。 */
export function firstLine(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
