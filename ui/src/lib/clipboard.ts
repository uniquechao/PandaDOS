/**
 * lib/clipboard —— 「复制」按钮的剪贴板写入（issue #288）。
 *
 * 两条路，缺一不可：
 * - `navigator.clipboard.writeText`：现代路径，但只在安全上下文（https / localhost）存在，
 *   且可能被权限策略拒绝（抛异常）。生产走 TLS 能命中，内网 http 直连 8802 调试时没有。
 * - 隐藏 textarea + `document.execCommand('copy')`：老办法，兜住上面拿不到的场合。
 *   元素必须真的在文档里、可 select，故用 fixed + opacity:0 而不是 display:none。
 *
 * 返回是否写成功——由调用方决定提示「已复制 ✓」还是「复制失败，请手动选中文本复制」；
 * 用户本来也能长按/拖选自己复制，所以失败不是死路，只是要说清楚。
 */

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip?.writeText) {
      await clip.writeText(text);
      return true;
    }
  } catch {
    // 非安全上下文 / 权限被拒 / 用户手势已过期——继续走兜底，别在这里判死
  }
  return legacyCopy(text);
}

/** 隐藏 textarea + execCommand('copy')；任何一步不成立即返回 false（绝不抛给调用方） */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', ''); // iOS 上避免弹出软键盘
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari 只认 setSelectionRange
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
  }
}
