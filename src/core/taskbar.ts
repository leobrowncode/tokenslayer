export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TaskbarEdge = 'bottom' | 'top' | 'left' | 'right' | 'none';

/** Band assumed when the taskbar reserves no space (auto-hide, or a desktop without a panel). */
const FALLBACK_BAND = 40;
const EDGE_GAP = 12;

/** The taskbar is whatever part of the display the work area leaves out. */
export function taskbarRect(bounds: Rect, work: Rect): Rect & { edge: TaskbarEdge } {
  const gaps: Array<[TaskbarEdge, number]> = [
    ['bottom', bounds.y + bounds.height - (work.y + work.height)],
    ['top', work.y - bounds.y],
    ['left', work.x - bounds.x],
    ['right', bounds.x + bounds.width - (work.x + work.width)],
  ];
  const [edge, size] = gaps.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (size <= 0) return { edge: 'none', x: bounds.x, y: bounds.y + bounds.height - FALLBACK_BAND, width: bounds.width, height: FALLBACK_BAND };
  switch (edge) {
    case 'bottom':
      return { edge, x: bounds.x, y: work.y + work.height, width: bounds.width, height: size };
    case 'top':
      return { edge, x: bounds.x, y: bounds.y, width: bounds.width, height: size };
    case 'left':
      return { edge, x: bounds.x, y: bounds.y, width: size, height: bounds.height };
    default:
      return { edge, x: work.x + work.width, y: bounds.y, width: size, height: bounds.height };
  }
}

/** Default spot for the strip: vertically centered on a horizontal taskbar, left of the tray area. */
export function stripPosition(bounds: Rect, work: Rect, size: { width: number; height: number }, rightMargin: number): { x: number; y: number } {
  const bar = taskbarRect(bounds, work);
  if (bar.edge === 'left' || bar.edge === 'right') {
    return { x: work.x + work.width - size.width - EDGE_GAP, y: work.y + work.height - size.height - EDGE_GAP };
  }
  const x = Math.max(bar.x, bar.x + bar.width - rightMargin - size.width);
  const y = bar.y + Math.round((bar.height - size.height) / 2);
  return { x, y };
}

/** After a drag, re-centers the strip on a horizontal taskbar if it was dropped onto it. */
export function snapToTaskbar(bounds: Rect, work: Rect, strip: Rect): number {
  const bar = taskbarRect(bounds, work);
  if (bar.edge === 'left' || bar.edge === 'right') return strip.y;
  const center = strip.y + strip.height / 2;
  if (center < bar.y - strip.height || center > bar.y + bar.height + strip.height) return strip.y;
  return bar.y + Math.round((bar.height - strip.height) / 2);
}
