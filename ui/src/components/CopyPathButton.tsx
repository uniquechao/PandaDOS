/**
 * CopyPathButton —— 工作区「复制路径」（issue #388）。
 *
 * 主按钮复制相对当前工作位置的路径；▾ 下拉四项：相对路径 / 执行机绝对路径 / 工作区链接 / 名称。
 * 成功短提示写明复制了哪一种；失败弹出可选中的文本框供手动复制。值由 lib/pathcopy 生成，原样复制。
 */
import { useState } from 'preact/hooks';
import { copyText } from '../lib/clipboard';
import { COPY_KINDS, copyValue, type CopyKind, type CopyTarget } from '../lib/pathcopy';
import { toast } from '../lib/toast';
import { tr } from '../i18n/runtime';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { Modal } from './Modal';

export interface ExecutorLabel {
  name: string;
  local: boolean;
}

const KIND_LABEL: Record<CopyKind, Parameters<typeof tr>[0]> = {
  relative: 'ws.copyRelative',
  absolute: 'ws.copyAbsolute',
  link: 'ws.copyLink',
  name: 'ws.copyName',
};

const KIND_DONE: Record<CopyKind, Parameters<typeof tr>[0]> = {
  relative: 'ws.copiedRelative',
  absolute: 'ws.copiedAbsolute',
  link: 'ws.copiedLink',
  name: 'ws.copiedName',
};

export function linkOrigin(): string {
  return typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`;
}

/** 执行机路径的菜单文案：远程执行机明确标注「执行机路径」及执行机名 */
export function copyKindLabel(kind: CopyKind, executor?: ExecutorLabel | null): string {
  if (kind === 'absolute' && executor && !executor.local) {
    return tr('ws.copyAbsoluteRemote', { executor: executor.name });
  }
  return tr(KIND_LABEL[kind]);
}

/** 复制并提示；失败回调交给调用方弹出可选中文本 */
export async function copyPath(
  kind: CopyKind,
  target: CopyTarget,
  onFail: (value: string) => void,
): Promise<void> {
  const value = copyValue(kind, target, linkOrigin());
  if (await copyText(value)) toast.success(tr(KIND_DONE[kind], { value }));
  else onFail(value);
}

/** 复制失败兜底：只读文本框，聚焦即全选 */
export function CopyFallback({ value, onClose }: { value: string; onClose: () => void }) {
  return (
    <Modal title={tr('ws.copyFailedTitle')} onClose={onClose}>
      <p class="mut small">{tr('ws.copyFailedHint')}</p>
      <input
        class="ws-copy-fallback mono"
        readOnly
        value={value}
        aria-label={tr('ws.copyFailedTitle')}
        ref={(el) => el?.select()}
        onFocus={(e) => e.currentTarget.select()}
      />
    </Modal>
  );
}

/** 菜单项：给行菜单/更多菜单复用（四种复制） */
export function copyMenuItems(
  target: CopyTarget,
  executor: ExecutorLabel | null | undefined,
  onFail: (value: string) => void,
): Array<{ key: string; label: string; onSelect: () => void }> {
  return COPY_KINDS.map((kind) => ({
    key: `copy-${kind}`,
    label: copyKindLabel(kind, executor),
    onSelect: () => void copyPath(kind, target, onFail),
  }));
}

export function CopyPathButton({
  target,
  executor,
  compact = false,
}: {
  target: CopyTarget;
  executor?: ExecutorLabel | null;
  compact?: boolean;
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const sheet = typeof window !== 'undefined' && !window.matchMedia('(min-width: 960px)').matches;
  return (
    <span class="ws-copy">
      <button
        type="button"
        class={`btn sm ws-copy-main${compact ? ' compact' : ''}`}
        title={copyValue('relative', target, linkOrigin())}
        onClick={() => void copyPath('relative', target, setFallback)}
      >
        ⧉ {tr('ws.copyPath')}
      </button>
      <button
        type="button"
        class="btn sm ws-copy-more"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={tr('ws.copyPathOptions')}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
      >
        ▾
      </button>
      {menu && (
        <ActionMenu
          title={copyValue('relative', target, linkOrigin())}
          anchor={menu}
          sheet={sheet}
          onClose={() => setMenu(null)}
          items={copyMenuItems(target, executor, setFallback)}
        />
      )}
      {fallback !== null && <CopyFallback value={fallback} onClose={() => setFallback(null)} />}
    </span>
  );
}
