export type TermBufferType = 'normal' | 'alternate';

export interface TermWheelEvent {
  deltaY: number;
  /** 0 = pixel, 1 = line, 2 = page，与 WheelEvent.deltaMode 一致。 */
  deltaMode: number;
  preventDefault(): void;
}

export interface TermWheelScrollController {
  /** true 表示继续交给 xterm，false 表示已接管。 */
  onWheel(event: TermWheelEvent, bufferType: TermBufferType): boolean;
}

export function createTermWheelScrollController(options: {
  getCellHeight(): number;
  getPageRows(): number;
  scrollLines(lines: number): void;
}): TermWheelScrollController {
  let pixelRemainder = 0;

  return {
    onWheel(event, bufferType) {
      if (bufferType !== 'alternate') {
        pixelRemainder = 0;
        return true;
      }

      event.preventDefault();
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return false;

      let lines = 0;
      if (event.deltaMode === 1) {
        pixelRemainder = 0;
        lines = Math.trunc(event.deltaY);
      } else if (event.deltaMode === 2) {
        pixelRemainder = 0;
        const rows = Math.max(1, Math.trunc(options.getPageRows()));
        lines = Math.trunc(event.deltaY * rows);
      } else {
        const cellHeight = options.getCellHeight();
        if (!Number.isFinite(cellHeight) || cellHeight <= 0) {
          pixelRemainder = 0;
          lines = Math.sign(event.deltaY);
        } else {
          const pixels = event.deltaY + pixelRemainder;
          lines = Math.trunc(pixels / cellHeight);
          pixelRemainder = pixels - lines * cellHeight;
        }
      }

      if (lines !== 0) options.scrollLines(lines);
      return false;
    },
  };
}
