/** runstream 纯文本小工具（无 JSX，便于单测）。 */

/** 压成单行并截断（折叠态预览用）；空白折叠成单空格。 */
export function firstLine(text: string, n: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 服务端截断标记（issue #288）。气泡流里的正文有两处会被截：
 * core/jsonl 的 brief（`\n…[省略N字]…\n`）与 core/toolfmt 的 clip（行内 `…[省略N字]…`），
 * 两者留下的印子一模一样。命中即说明「这条还有没显示出来的内容」，据此才给出
 * 「查看完整内容」按钮——没被截的内容不该平白多一个按钮。
 *
 * 误判代价可控：正文里真写了这串字，也只是多出一个按钮，点开回源拿到的仍是同一份正文。
 */
const CLIP_MARK_RE = /…\[省略\d+字\]…/;

export function isClipped(text: string | undefined): boolean {
  return text !== undefined && CLIP_MARK_RE.test(text);
}
