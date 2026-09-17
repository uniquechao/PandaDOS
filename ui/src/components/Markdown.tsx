/**
 * Markdown —— 把 `lib/markdown` 的 AST 渲染成 preact 节点（issue #298）。
 *
 * 铁律：**全部走文本节点，绝不 innerHTML / dangerouslySetInnerHTML**。正文是 AI 直出的，
 * 拼 HTML 字符串就得再配一层消毒；这里节点由 preact 建，正文永远只能当文字出现。
 * 链接的 href 在解析层就过了 `isSafeHref` 白名单，渲染层不再二次判断。
 *
 * 两个和「聊天气泡」强相关的取舍：
 *  - **段落保留软换行**（`.md p { white-space: pre-wrap }`）。标准 markdown 会把段内单换行
 *    折成空格，但聊天里的断行是作者有意排的版，折掉了读起来完全变样。
 *  - **表格一律套横向滚动容器**。手机窄屏放不下 5 列表格，不套容器整个气泡会被撑宽、
 *    连带把消息流顶出横向滚动条。
 */
import type { JSX } from 'preact';
import { parseMarkdown, type MdBlock, type MdInline, type MdRow } from '../lib/markdown';

function Inlines({ nodes }: { nodes: MdInline[] }): JSX.Element {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return n.text;
          case 'code':
            return <code key={i}>{n.text}</code>;
          case 'strong':
            return (
              <strong key={i}>
                <Inlines nodes={n.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={n.children} />
              </em>
            );
          case 'del':
            return (
              <del key={i}>
                <Inlines nodes={n.children} />
              </del>
            );
          case 'link':
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
                <Inlines nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

function Cells({ row, align, head }: { row: MdRow; align: (string | null)[]; head?: boolean }): JSX.Element {
  return (
    <>
      {row.map((cell, i) => {
        const a = align[i];
        const style = a ? { textAlign: a as 'left' | 'center' | 'right' } : undefined;
        return head ? (
          <th key={i} style={style}>
            <Inlines nodes={cell} />
          </th>
        ) : (
          <td key={i} style={style}>
            <Inlines nodes={cell} />
          </td>
        );
      })}
    </>
  );
}

function Block({ block }: { block: MdBlock }): JSX.Element {
  switch (block.type) {
    case 'heading': {
      const kids = <Inlines nodes={block.children} />;
      // 气泡里不该出现真正的 h1 巨标题，层级靠 CSS 收；语义仍按原级别给
      if (block.level === 1) return <h1>{kids}</h1>;
      if (block.level === 2) return <h2>{kids}</h2>;
      if (block.level === 3) return <h3>{kids}</h3>;
      if (block.level === 4) return <h4>{kids}</h4>;
      if (block.level === 5) return <h5>{kids}</h5>;
      return <h6>{kids}</h6>;
    }
    case 'paragraph':
      return (
        <p>
          <Inlines nodes={block.children} />
        </p>
      );
    case 'list': {
      const items = block.items.map((it, i) => (
        <li key={i} class={it.checked === undefined ? undefined : 'md-task'}>
          {it.checked !== undefined && (
            <input type="checkbox" checked={it.checked} disabled aria-hidden="true" tabIndex={-1} />
          )}
          <Blocks blocks={it.blocks} tight />
        </li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'code':
      return (
        <pre>
          <code class={block.lang ? `lang-${block.lang}` : undefined}>{block.text}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote>
          <Blocks blocks={block.blocks} />
        </blockquote>
      );
    case 'hr':
      return <hr />;
    case 'table':
      return (
        // 窄屏放不下就在容器里横滚，绝不撑宽气泡本身
        <div class="md-tablewrap">
          <table class="md-table">
            {block.head && (
              <thead>
                <tr>
                  <Cells row={block.head} align={block.align} head />
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  <Cells row={r} align={block.align} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'text':
      // 解析层判不准时的退化块：原样纯文本（换行/缩进都留着）
      return <div class="md-raw">{block.text}</div>;
  }
}

function Blocks({ blocks, tight }: { blocks: MdBlock[]; tight?: boolean }): JSX.Element {
  return (
    <>
      {blocks.map((b, i) =>
        // 列表条目里的独段不另起 <p>，否则每条都多一层行距、列表会变得很松
        tight && b.type === 'paragraph' && blocks.length === 1 ? (
          <Inlines key={i} nodes={b.children} />
        ) : (
          <Block key={i} block={b} />
        ),
      )}
    </>
  );
}

/** 渲染一段 markdown。`className` 追加在 `.md` 之后，便于按场景调排版。 */
export function Markdown({ text, className }: { text: string; className?: string }): JSX.Element {
  return (
    <div class={className ? `md ${className}` : 'md'}>
      <Blocks blocks={parseMarkdown(text)} />
    </div>
  );
}
