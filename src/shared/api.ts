import type { AlertLevel, OverlaySnapshot, ProviderId } from '../core/types';

export interface UiState {
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

export interface OverlayApi {
  onUpdate(cb: (u: OverlayUpdate) => void): void;
  onOpenAdvice(cb: () => void): void;
  ready(): void;
  resize(height: number): void;
  copy(text: string): void;
  setExpanded(expanded: boolean): void;
  dismiss(a: { provider: ProviderId; chatId: string; level: AlertLevel }): void;
  hide(): void;
  menu(): void;
}
