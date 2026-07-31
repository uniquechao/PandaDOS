export interface TermTouchPoint {
  clientX: number;
  clientY: number;
}

export interface TermTouchEvent {
  touches: ArrayLike<TermTouchPoint>;
  preventDefault(): void;
}

export interface TermTouchScrollController {
  onTouchStart(event: TermTouchEvent): void;
  onTouchMove(event: TermTouchEvent): void;
  onTouchEnd(): void;
}

const AXIS_LOCK_THRESHOLD_PX = 6;

export function createTermTouchScrollController(options: {
  getCellHeight(): number;
  scrollLines(lines: number): void;
}): TermTouchScrollController {
  let lastY: number | null = null;
  let startX: number | null = null;
  let pixelRemainder = 0;
  let verticalGesture = false;

  const reset = (): void => {
    lastY = null;
    startX = null;
    pixelRemainder = 0;
    verticalGesture = false;
  };

  return {
    onTouchStart(event) {
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      startX = event.touches[0].clientX;
      lastY = event.touches[0].clientY;
      pixelRemainder = 0;
      verticalGesture = false;
    },

    onTouchMove(event) {
      if (lastY === null || event.touches.length !== 1) {
        if (event.touches.length !== 1) reset();
        return;
      }

      const currentX = event.touches[0].clientX;
      const currentY = event.touches[0].clientY;
      if (!verticalGesture) {
        const deltaX = Math.abs(currentX - (startX ?? currentX));
        const deltaY = Math.abs(currentY - lastY);
        if (Math.max(deltaX, deltaY) < AXIS_LOCK_THRESHOLD_PX) return;
        if (deltaX >= deltaY) {
          reset();
          return;
        }
        verticalGesture = true;
      }

      const cellHeight = options.getCellHeight();
      if (!Number.isFinite(cellHeight) || cellHeight <= 0) {
        lastY = currentY;
        pixelRemainder = 0;
        return;
      }

      const pixels = lastY - currentY + pixelRemainder;
      const lines = Math.trunc(pixels / cellHeight);
      lastY = currentY;
      pixelRemainder = pixels - lines * cellHeight;
      event.preventDefault();

      if (lines !== 0) options.scrollLines(lines);
    },

    onTouchEnd() {
      reset();
    },
  };
}

export function bindTermTouchScroll(
  target: HTMLElement,
  controller: TermTouchScrollController,
): () => void {
  const options: AddEventListenerOptions = { passive: false };
  const onTouchStart = (event: TouchEvent): void => controller.onTouchStart(event);
  const onTouchMove = (event: TouchEvent): void => controller.onTouchMove(event);
  const onTouchEnd = (): void => controller.onTouchEnd();

  target.addEventListener('touchstart', onTouchStart, options);
  target.addEventListener('touchmove', onTouchMove, options);
  target.addEventListener('touchend', onTouchEnd, options);
  target.addEventListener('touchcancel', onTouchEnd, options);

  return () => {
    target.removeEventListener('touchstart', onTouchStart, options);
    target.removeEventListener('touchmove', onTouchMove, options);
    target.removeEventListener('touchend', onTouchEnd, options);
    target.removeEventListener('touchcancel', onTouchEnd, options);
  };
}
