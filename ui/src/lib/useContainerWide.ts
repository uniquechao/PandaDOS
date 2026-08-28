import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** Design workspace breakpoint is based on its actual space after the global sidebar. */
export function useContainerWide(ref: RefObject<HTMLElement>, threshold = 960): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number): void => setWide(width >= threshold);
    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return wide;
}
