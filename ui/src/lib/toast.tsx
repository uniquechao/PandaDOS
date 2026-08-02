/**
 * 轻量 toast —— 非阻塞提示，替代刺眼的 alert()。
 * 用法：任意位置调用 toast.success('已保存') / toast.error(msg)；
 * 在应用根挂一个 <Toaster/> 即可（main.tsx）。无 context、无依赖。
 */
import { useEffect, useState } from 'preact/hooks';
import { tr } from '../i18n/runtime';

export type ToastKind = 'success' | 'error' | 'warn' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** 停留时长（ms）；error 默认更久 */
  ttl: number;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let seq = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l([...items]);
}

function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

function push(kind: ToastKind, text: string, ttl?: number): number {
  const id = seq++;
  const life = ttl ?? (kind === 'error' ? 5200 : 3200);
  items = [...items, { id, kind, text: String(text), ttl: life }].slice(-4); // 最多同时 4 条
  emit();
  return id;
}

export const toast = {
  success: (text: string, ttl?: number) => push('success', text, ttl),
  error: (text: string, ttl?: number) => push('error', text, ttl),
  warn: (text: string, ttl?: number) => push('warn', text, ttl),
  info: (text: string, ttl?: number) => push('info', text, ttl),
  dismiss,
};

const ICON: Record<ToastKind, string> = {
  success: '✓',
  error: '⚠',
  warn: '⚠',
  info: 'ℹ',
};

/** 单条：负责到期后先播放退场动画再移除 */
function ToastRow({ item }: { item: ToastItem }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setLeaving(true), item.ttl);
    return () => window.clearTimeout(t);
  }, [item.ttl]);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => dismiss(item.id), 200); // 与 toast-out 时长一致
    return () => window.clearTimeout(t);
  }, [leaving, item.id]);

  return (
    <div class={`toast ${item.kind}${leaving ? ' out' : ''}`} role="status">
      <span class="ic">{ICON[item.kind]}</span>
      <span class="tx">{item.text}</span>
      <button class="tx-x" aria-label={tr('action.close')} onClick={() => setLeaving(true)}>
        ✕
      </button>
    </div>
  );
}

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>([]);
  useEffect(() => {
    listeners.add(setList);
    setList([...items]);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  if (list.length === 0) return null;
  return (
    <div class="toaster" aria-live="polite">
      {list.map((t) => (
        <ToastRow key={t.id} item={t} />
      ))}
    </div>
  );
}
