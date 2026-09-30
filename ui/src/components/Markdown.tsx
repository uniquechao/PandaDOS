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
 *
 * 文件路径链接（issue #310）：传了 `paths={{ pid, cwd }}` 时，正文/行内代码/链接目标里落在项目
 * cwd 内的路径会变成文件页深链（点一下直接在「文件」页打开并预览那个文件）。判定见 lib/pathlink，
 * 这里只负责建节点：**不改一个字符**——链接的可见文本永远是原文里那串路径。
 * 有意用 props 逐层透传而不是 context：本组件全是纯函数，单测直接调用即可展开（见 Markdown.test）。
 */
import type { JSX } from 'preact';
import { parseMarkdown, type MdBlock, type MdInline, type MdRow } from '../lib/markdown';
import {
  filesHref,
  isLikelyPath,
  looksLikeFsPath,
  resolveProjectPath,
  splitPathChunks,
  type PathTarget,
} from '../lib/pathlink';
import { tr } from '../i18n/runtime';

/** 正文里做路径链接所需的项目上下文；null/缺省 = 不做链接（如技能页的 SKILL.md） */
export interface ProjectPaths {
  pid: number;
  cwd: string;
}

type Paths = ProjectPaths | null | undefined;

function targetOf(raw: string, paths: Paths): PathTarget | null {
  if (!paths || !paths.cwd) return null;
  return resolveProjectPath(raw, paths.cwd);
}

/** 一个可点的路径：跳到文件页并打开它 */
function PathAnchor({
  paths,
  target,
  raw,
  children,
}: {
  paths: ProjectPaths;
  target: PathTarget;
  raw: string;
  children: JSX.Element | string;
}): JSX.Element {
  return (
    <a
      class="md-path"
      href={filesHref(paths.pid, target)}
      title={tr('ui.openInFiles', { path: raw })}
    >
      {children}
    </a>
  );
}

/**
 * 一段纯文本：切出疑似路径的片段做成链接，其余原样。
 * 没有项目上下文、或一个路径都没认出来时原样返回，连包装节点都不多加。
 */
export function LinkedText({ text, paths }: { text: string; paths?: Paths }): JSX.Element {
  if (!paths || !paths.cwd || !text) return <>{text}</>;
  const chunks = splitPathChunks(text);
  if (!chunks.some((c) => c.path && resolveProjectPath(c.path, paths.cwd))) return <>{text}</>;
  return (
    <>
      {chunks.map((c, i) => {
        const target = c.path ? targetOf(c.path, paths) : null;
        return target && c.path ? (
          <PathAnchor key={i} paths={paths} target={target} raw={c.path}>
            {c.text}
          </PathAnchor>
        ) : (
          c.text
        );
      })}
    </>
  );
}

/**
 * 行内代码：整段恰好是一条项目内路径时让它可点（`src/web/routes/files.ts` 这种写法在
 * AI 正文里比裸路径还常见）。不是路径就还是普通 `<code>`，样式一个字不变。
 */
function CodeInline({ text, paths }: { text: string; paths?: Paths }): JSX.Element {
  const raw = text.trim();
  const target = raw && isLikelyPath(raw) ? targetOf(raw, paths) : null;
  const code = <code>{text}</code>;
  return target && paths ? (
    <PathAnchor paths={paths} target={target} raw={raw}>
      {code}
    </PathAnchor>
  ) : (
    code
  );
}

/**
 * markdown 链接。`[清单](/home/…/audit.html)` 这种「拿本机绝对路径当 href」的写法是 AI 常态：
 *  - 落在项目 cwd 内 → 改指文件页深链（站内跳转，不开新标签页）；
 *  - 看着是本机路径但不在本项目里 → 摘掉 href 只留文字：原样渲染只会得到一个必然 404 的站内链接。
 * 其余（http(s)/mailto/站内路由）照旧。
 */
function LinkInline({ node, paths }: { node: Extract<MdInline, { type: 'link' }>; paths?: Paths }): JSX.Element {
  const kids = <Inlines nodes={node.children} paths={paths} />;
  const target = targetOf(node.href, paths);
  if (target && paths) {
    return (
      <PathAnchor paths={paths} target={target} raw={node.href}>
        {kids}
      </PathAnchor>
    );
  }
  // 没有项目上下文（技能页等）就判不出「在不在项目里」，此时保持原样，不擅自摘链接
  if (paths?.cwd && looksLikeFsPath(node.href)) {
    return (
      <span class="md-path off" title={tr('ui.pathOutsideProject', { path: node.href })}>
        {kids}
      </span>
    );
  }
  return (
    <a href={node.href} target="_blank" rel="noopener noreferrer">
      {kids}
    </a>
  );
}

function Inlines({ nodes, paths }: { nodes: MdInline[]; paths?: Paths }): JSX.Element {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return <LinkedText key={i} text={n.text} paths={paths} />;
          case 'code':
            return <CodeInline key={i} text={n.text} paths={paths} />;
          case 'strong':
            return (
              <strong key={i}>
                <Inlines nodes={n.children} paths={paths} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <Inlines nodes={n.children} paths={paths} />
              </em>
            );
          case 'del':
            return (
              <del key={i}>
                <Inlines nodes={n.children} paths={paths} />
              </del>
            );
          case 'link':
            return <LinkInline key={i} node={n} paths={paths} />;
        }
      })}
    </>
  );
}

function Cells({ row, align, head, paths }: { row: MdRow; align: (string | null)[]; head?: boolean; paths?: Paths }): JSX.Element {
  return (
    <>
      {row.map((cell, i) => {
        const a = align[i];
        const style = a ? { textAlign: a as 'left' | 'center' | 'right' } : undefined;
        return head ? (
          <th key={i} style={style}>
            <Inlines nodes={cell} paths={paths} />
          </th>
        ) : (
          <td key={i} style={style}>
            <Inlines nodes={cell} paths={paths} />
          </td>
        );
      })}
    </>
  );
}

function Block({ block, paths }: { block: MdBlock; paths?: Paths }): JSX.Element {
  switch (block.type) {
    case 'heading': {
      const kids = <Inlines nodes={block.children} paths={paths} />;
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
          <Inlines nodes={block.children} paths={paths} />
        </p>
      );
    case 'list': {
      const items = block.items.map((it, i) => (
        <li key={i} class={it.checked === undefined ? undefined : 'md-task'}>
          {it.checked !== undefined && (
            <input type="checkbox" checked={it.checked} disabled aria-hidden="true" tabIndex={-1} />
          )}
          <Blocks blocks={it.blocks} paths={paths} tight />
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
          <Blocks blocks={block.blocks} paths={paths} />
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
                  <Cells row={block.head} align={block.align} paths={paths} head />
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  <Cells row={r} align={block.align} paths={paths} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'text':
      // 解析层判不准时的退化块：原样纯文本（换行/缩进都留着），路径照样可点
      return (
        <div class="md-raw">
          <LinkedText text={block.text} paths={paths} />
        </div>
      );
  }
}

function Blocks({ blocks, paths, tight }: { blocks: MdBlock[]; paths?: Paths; tight?: boolean }): JSX.Element {
  return (
    <>
      {blocks.map((b, i) =>
        // 列表条目里的独段不另起 <p>，否则每条都多一层行距、列表会变得很松
        tight && b.type === 'paragraph' && blocks.length === 1 ? (
          <Inlines key={i} nodes={b.children} paths={paths} />
        ) : (
          <Block key={i} block={b} paths={paths} />
        ),
      )}
    </>
  );
}

/**
 * 渲染一段 markdown。`className` 追加在 `.md` 之后，便于按场景调排版；
 * `paths` 给了才做文件路径链接（对话气泡传，技能页等不传）。
 */
export function Markdown({
  text,
  className,
  paths,
}: {
  text: string;
  className?: string;
  paths?: Paths;
}): JSX.Element {
  return (
    <div class={className ? `md ${className}` : 'md'}>
      <Blocks blocks={parseMarkdown(text)} paths={paths} />
    </div>
  );
}
