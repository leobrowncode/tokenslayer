import type { AlertLevel, OverlaySnapshot, ProviderId } from '../core/types';

export type OverlayMode = 'taskbar' | 'panel';

export interface UiState {
  mode: OverlayMode;
  expanded: boolean;
  clickThrough: boolean;
  showUndetected: boolean;
  toggleShortcut: string;
  clickThroughShortcut: string;
}

export interface OverlayUpdate {
  snapshot: OverlaySnapshot | null;
  ui: UiState;
}

export type DragPhase = 'start' | 'move' | 'end';

export interface OverlayApi {
  onUpdate(cb: (u: OverlayUpdate) => void): void;
  onOpenAdvice(cb: () => void): void;
  ready(): void;
  resize(width: number, height: number): void;
  /** Moves the window by (dx, dy) screen pixels from where it was at `start`. */
  drag(phase: DragPhase, dx: number, dy: number): void;
  copy(text: string): void;
  setExpanded(expanded: boolean): void;
  dismiss(a: { provider: ProviderId; chatId: string; level: AlertLevel }): void;
  hide(): void;
  menu(): void;
}
