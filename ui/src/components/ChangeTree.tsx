/**
 * ChangeTree —— issue「改动」tab 的改动文件树（VSCode / GitHub PR 风格）。
 *
 * 输入为 ChangeLeaf 列表，构树逻辑在 lib/changetree（目录优先 + 字典序、单子目录链压缩、
 * 目录聚合文件数/增删行）。目录行可折叠（默认全展开，折叠态存本组件；父层 key 重挂载即重置）；
 * 文件行 = 状态码 + 文件名 + 增删行，点击回调 onOpen(leaf)，selKey 命中高亮（.on）。
 * 缩进/箭头/行样式沿用文件页文件树（.ft-*），树自身微调见 .changetree / .ct-*。
 */
import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { buildChangeTree, type ChangeLeaf, type ChangeNode } from '../lib/changetree';
import { PlusMinus, StatusChip } from '../views/Git';

/** 每层缩进像素（同 FileTree） */
const INDENT = 14;

export function ChangeTree({
  leaves,
  selKey,
  onOpen,
  renderActions,
}: {
  leaves: ChangeLeaf[];
  /** 当前选中叶子的 key（用于高亮）；undefined = 未选 */
  selKey?: string;
  onOpen: (leaf: ChangeLeaf) => void;
  /** 可选文件行操作区；内部会阻止点击冒泡，避免操作按钮同时打开文件。 */
  renderActions?: (leaf: ChangeLeaf) => JSX.Element | null;
}) {
  const tree = useMemo(() => buildChangeTree(leaves), [leaves]);
  // 折叠目录集（键 = 目录完整路径；默认全展开——改动树是有限清单，先看全貌）
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (path: string): void => setCollapsed((c) => ({ ...c, [path]: !c[path] }));

  const renderNodes = (nodes: ChangeNode[], depth: number): JSX.Element[] =>
    nodes.map((n) => {
      const pad = { paddingLeft: `${depth * INDENT + 8}px` };
      if (n.type === 'dir') {
        const open = !collapsed[n.path];
        return (
          <div key={`d:${n.path}`}>
            <div class="ft-row ct-dir" style={pad} title={n.path} onClick={() => toggle(n.path)}>
              <span class={`ft-arrow${open ? ' open' : ''}`}>▸</span>
              <span class="ft-name mono">{n.name}</span>
              <span class="ct-agg mut">{n.files}</span>
              {(n.adds > 0 || n.dels > 0) && <PlusMinus adds={n.adds} dels={n.dels} />}
            </div>
            {open && renderNodes(n.children, depth + 1)}
          </div>
        );
      }
      const on = selKey !== undefined && selKey === n.leaf.key;
      return (
        <div
          key={`f:${n.leaf.key}`}
          class={`ft-row ft-file ct-file${on ? ' on' : ''}`}
          style={pad}
          title={n.leaf.oldPath ? `${n.leaf.oldPath} → ${n.leaf.path}` : n.leaf.path}
          onClick={() => onOpen(n.leaf)}
        >
          <span class="ft-arrow ft-spacer" />
          <StatusChip code={n.leaf.code} />
          <span class="ft-name mono">{n.name}</span>
          <PlusMinus adds={n.leaf.adds} dels={n.leaf.dels} />
          {renderActions && (
            <span class="ct-actions" onClick={(e) => e.stopPropagation()}>
              {renderActions?.(n.leaf)}
            </span>
          )}
        </div>
      );
    });

  if (leaves.length === 0) return null;
  return <div class="changetree">{renderNodes(tree, 0)}</div>;
}
