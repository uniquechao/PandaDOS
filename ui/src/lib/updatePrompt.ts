/**
 * ui/lib/updatePrompt —— 懒加载 chunk 失败兜底。
 * 发版后 /assets 里的旧 hash chunk 会被删；旧标签页里 import() 这些 chunk 会拿到 404，
 * 表现为 "Failed to fetch dynamically imported module"。此时弹一条持久、可点的提示，
 * 点「刷新」即 location.reload()，取到新的 index.html（no-cache）与新 chunk。
 * 一次页面加载只弹一次（两处懒加载同时失败也只一条），避免刷屏。
 */
import { tr } from '../i18n/runtime';

let shown = false;

/** 显示"检测到新版本，点此刷新"横幅（幂等：本次页面加载只显示一次）。 */
export function promptReload(): void {
  if (shown || typeof document === 'undefined') return;
  shown = true;

  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'alert');

  const tx = document.createElement('span');
  tx.className = 'update-bar-tx';
  tx.textContent = tr('action.newVersion');
  bar.appendChild(tx);

  const btn = document.createElement('button');
  btn.className = 'update-bar-btn';
  btn.textContent = tr('action.reload');
  btn.onclick = () => location.reload();
  bar.appendChild(btn);

  const x = document.createElement('button');
  x.className = 'update-bar-x';
  x.setAttribute('aria-label', tr('action.close'));
  x.textContent = '✕';
  x.onclick = () => bar.remove();
  bar.appendChild(x);

  document.body.appendChild(bar);
}

/** 懒加载 import() 的 .catch 兜底：记日志 + 弹刷新提示。 */
export function onLazyLoadError(err: unknown): void {
  console.error('[mando] 懒加载组件失败（多半是发版后旧 chunk 失效）：', err);
  promptReload();
}
