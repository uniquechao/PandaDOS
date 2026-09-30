/**
 * CodeView —— 只读代码视图（行号 + 语法高亮，issue #388）。
 *
 * 安全：token 一律作为文本子节点渲染（preact 自动转义），绝不拼 HTML / 用 dangerouslySetInnerHTML，
 * 文件里的 `<script>`、`onerror=` 之类只会显示为字面文本。
 * 性能：分词结果按 (text, lang) 记忆；超出 lib/highlight 的边界时回落纯文本并提示。
 * 行号用 CSS counter 画在 ::before 里，不进选区，复制出来就是原文。
 */
import { useMemo } from 'preact/hooks';
import { codeLines, type LangId } from '../lib/highlight';
import { useI18n } from '../i18n/provider';

export function CodeView({ text, lang, name }: { text: string; lang: LangId | null; name: string }) {
  const { t } = useI18n();
  const { lines, limited } = useMemo(() => codeLines(text, lang), [text, lang]);
  return (
    <div class="codeview">
      {limited && <div class="ws-mode-note mut small">{t('ws.highlightOff')}</div>}
      <pre class="cv-pre" tabIndex={0} aria-label={t('ws.codeLabel', { name })}>
        <code class={lang ? `lang-${lang}` : undefined}>
          {lines.map((ln, i) => [
            <span class="cv-line" key={i}>
              {ln.map((tok) => (tok.type ? <span class={`tk-${tok.type}`}>{tok.text}</span> : tok.text))}
            </span>,
            i < lines.length - 1 ? '\n' : null,
          ])}
        </code>
      </pre>
    </div>
  );
}
